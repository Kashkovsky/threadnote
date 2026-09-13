import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Layer, Redacted} from 'effect';
import {TestClock} from 'effect/testing';
import {
  enrollGraphControlClient,
  prepareGraphControlWorkerIdentity,
} from '../../src/code_graph/sharing/client_enrollment.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingUnavailable} from '../../src/code_graph/sharing/errors.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {SystemInfo} from '../../src/effect/system.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

const scope = {
  coordinatorUrl: 'https://graph.example.test/team',
  organization: 'acme',
  profileDigest: sha256Digest('profile'),
  repositoryId: 'a'.repeat(64),
};
const fixture = Effect.fn('test.clientEnrollment.fixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-client-enrollment-'});
  let principal = 'first';
  let calls = 0;
  let lostAcknowledgement = false;
  const operations = new Map<string, {expiresAt: number; workerId: string}>();
  const requests: {idempotencyKey: string; signingPublicKey?: string}[] = [];
  const credential = () => ({
    authorization: Redacted.make('Bearer synthetic-private-token'),
    expiresAt: 9_999_999_999,
    identity: sha256Digest(principal),
    principalId: sha256Digest('principal:' + principal),
  });
  const client = {
    credentials: {load: Effect.sync(credential)},
    request: (_method: 'GET' | 'POST', pathname: string, body?: unknown) =>
      Effect.gen(function* () {
        calls++;
        expect(pathname).toBe('/v1/enroll');
        const request = body as {
          idempotencyKey: string;
          repositoryId: string;
          profileDigest: string;
          signingPublicKey?: string;
        };
        expect(request.repositoryId).toBe(scope.repositoryId);
        expect(request.profileDigest).toBe(scope.profileDigest);
        requests.push({idempotencyKey: request.idempotencyKey, signingPublicKey: request.signingPublicKey});
        const operation = principal + ':' + request.idempotencyKey;
        let worker = operations.get(operation);
        if (worker === undefined) {
          worker = {
            expiresAt: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 3600,
            workerId: 'gw_' + (operations.size + 1).toString(16).padStart(32, '0'),
          };
          operations.set(operation, worker);
        }
        if (lostAcknowledgement) {
          lostAcknowledgement = false;
          return yield* graphSharingUnavailable('Synthetic lost acknowledgement.');
        }
        const current = credential();
        return {
          status: 201,
          credential: current,
          body: {
            ...worker,
            ...(request.signingPublicKey === undefined ? {} : {signingPublicKey: request.signingPublicKey}),
            principalId: current.principalId,
            profileDigest: scope.profileDigest,
            repositoryId: scope.repositoryId,
            schemaVersion: 1,
          },
        };
      }),
  };
  return {
    home,
    client,
    operations,
    requests,
    calls: () => calls,
    switchPrincipal: () => {
      principal = 'second';
    },
    loseAcknowledgement: () => {
      lostAcknowledgement = true;
    },
    enroll: () => enrollGraphControlClient({home, scope, client}),
  };
});

describe('automatic graph client enrollment', () => {
  effectIt.effect(
    'automatically persists a signing identity through lost acknowledgements and rotates it for a different principal',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let authorized = true;
        const prepare = () =>
          prepareGraphControlWorkerIdentity({
            home: f.home,
            scope,
            client: f.client,
            isAuthorized: Effect.sync(() => authorized),
          });
        f.loseAcknowledgement();
        expect((yield* Effect.result(prepare()))._tag).toBe('Failure');
        const first = yield* prepare();
        expect(first.worker.signingPublicKey).toBe(first.signer.publicKey);
        expect((yield* prepare()).worker).toEqual(first.worker);
        expect(f.calls()).toBe(2);
        expect(f.operations.size).toBe(1);
        expect(f.requests).toHaveLength(2);
        expect(f.requests[0]).toEqual(f.requests[1]);
        expect(f.requests[0].signingPublicKey).toBe(first.signer.publicKey);
        expect(yield* first.stillAuthorized).toBe(true);
        f.switchPrincipal();
        expect(yield* first.stillAuthorized).toBe(false);
        const other = yield* prepare();
        expect(other.signer.publicKey).not.toBe(first.signer.publicKey);
        expect(other.worker.principalId).not.toBe(first.worker.principalId);
        authorized = false;
        expect(yield* other.stillAuthorized).toBe(false);
        expect((yield* Effect.result(prepare()))._tag).toBe('Failure');
        expect(f.calls()).toBe(3);
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('enrolls and replays a signing identity separately from unsigned or rotated-key enrollment', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const unsigned = yield* f.enroll();
      const enroll = (signingPublicKey: string) =>
        enrollGraphControlClient({home: f.home, scope, client: f.client, signingPublicKey});
      const first = yield* enroll('a'.repeat(64));
      expect(first.signingPublicKey).toBe('a'.repeat(64));
      expect(first.workerId).not.toBe(unsigned.workerId);
      expect((yield* enroll('a'.repeat(64))).workerId).toBe(first.workerId);
      expect(f.calls()).toBe(2);
      const second = yield* enroll('b'.repeat(64));
      expect(second.workerId).not.toBe(first.workerId);
      expect(second.signingPublicKey).toBe('b'.repeat(64));
      expect(f.calls()).toBe(3);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('does not return a cached worker after authorization is revoked during credential loading', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.enroll();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let authorized = true;
      const client = {
        ...f.client,
        credentials: {
          load: Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
            return yield* f.client.credentials.load;
          }),
        },
      };
      const enrollment = yield* enrollGraphControlClient({
        home: f.home,
        scope,
        client,
        isAuthorized: Effect.sync(() => authorized),
      }).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      authorized = false;
      yield* Deferred.succeed(resume, undefined);
      expect((yield* Fiber.join(enrollment))._tag).toBe('Failure');
      expect(f.calls()).toBe(1);
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('replays a persisted operation after a lost acknowledgement and caches its worker', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        f.loseAcknowledgement();
        expect((yield* Effect.result(f.enroll()))._tag).toBe('Failure');
        expect(f.operations.size).toBe(1);
        const enrolled = yield* enrollGraphControlClient({home: f.home, scope, client: f.client});
        expect(f.operations.size).toBe(1);
        expect((yield* f.enroll()).workerId).toBe(enrolled.workerId);
        expect(f.calls()).toBe(2);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('serializes concurrent sessions and never reuses another principal enrollment', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const enrolled = yield* Effect.forEach(Array.from({length: 8}), () => f.enroll(), {concurrency: 8});
        expect(new Set(enrolled.map(worker => worker.workerId)).size).toBe(1);
        expect(f.calls()).toBe(1);
        f.switchPrincipal();
        const second = yield* f.enroll();
        expect(second.workerId).not.toBe(enrolled[0].workerId);
        expect(second.principalId).not.toBe(enrolled[0].principalId);
        expect(f.operations.size).toBe(2);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('refreshes an expiring worker automatically and refuses a foreign response', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.enroll();
      yield* TestClock.adjust(3_590_000);
      expect((yield* f.enroll()).workerId).not.toBe(first.workerId);
      const foreign = {
        ...f.client,
        request: (...args: Parameters<typeof f.client.request>) =>
          f.client
            .request(...args)
            .pipe(
              Effect.map(response => ({...response, body: {...response.body, principalId: sha256Digest('foreign')}})),
            ),
      };
      f.switchPrincipal();
      expect((yield* Effect.result(enrollGraphControlClient({home: f.home, scope, client: foreign})))._tag).toBe(
        'Failure',
      );
    }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('renews a signed-result worker before the five-minute admission deadline', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* enrollGraphControlClient({
        home: f.home,
        scope,
        client: f.client,
        minimumValiditySeconds: 330,
      });
      yield* TestClock.adjust(3_300_000);
      const renewed = yield* enrollGraphControlClient({
        home: f.home,
        scope,
        client: f.client,
        minimumValiditySeconds: 330,
      });
      expect(renewed.workerId).not.toBe(first.workerId);
      expect(f.calls()).toBe(2);
    }).pipe(provideTestLayer(layer)),
  );
});
