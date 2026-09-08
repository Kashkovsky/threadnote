import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Result, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'effect/testing/FastCheck';
import {SystemInfo} from '../../src/effect/system.js';
import {
  enrollGraphControlWorker,
  graphWorkerEnrollmentStatePath,
  readGraphWorkerEnrollmentRequest,
} from '../../src/code_graph/sharing/control_enrollment.js';
import {parseGraphControlPolicy} from '../../src/code_graph/sharing/control_authorization.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {graphSharingFailure} from '../../src/code_graph/sharing/errors.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const layer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const fixture = Effect.fn('test.graphEnrollmentFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-enrollment-'});
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const policy = parseGraphControlPolicy({
    audience: 'https://graph.example.test',
    issuer: 'https://id.example.test/',
    jwksUrl: 'https://id.example.test/jwks',
    organization: 'acme',
    repositoryId: 'a'.repeat(64),
    profileDigest: sha256Digest('profile'),
    schemaVersion: 1,
    grants: ['private-a', 'private-b'].map(subject => ({expiresAt: now + 600, scopes: ['graph:contribute'], subject})),
  });
  const principal = {
    expiresAt: now + 300,
    issuer: policy.issuer,
    subject: 'private-a',
    scopes: new Set(['graph:contribute']),
  };
  const request = {idempotencyKey: 'same-key', repositoryId: policy.repositoryId, profileDigest: policy.profileDigest};
  const input = {home, initialPolicy: policy, principal, readCurrentPolicy: Effect.succeed(policy), request};
  return {
    fs,
    home,
    now,
    policy,
    principal,
    request,
    input,
    target: yield* graphWorkerEnrollmentStatePath(home, policy),
  };
});

describe('principal-owned graph worker enrollment', () => {
  effectIt.effect('stops reading an oversized streamed body before consuming its tail', () =>
    Effect.gen(function* () {
      let consumedTail = false;
      const stream = Stream.concat(
        Stream.make(new Uint8Array(65_537)),
        Stream.fromEffect(
          Effect.sync(() => {
            consumedTail = true;
            return new Uint8Array(1);
          }),
        ),
      );
      expect(Result.isFailure(yield* readGraphWorkerEnrollmentRequest(stream).pipe(Effect.result))).toBe(true);
      expect(consumedTail).toBe(false);
    }),
  );

  effectIt.effect.prop(
    'decodes the same bounded request across arbitrary stream chunk boundaries',
    {sizes: FC.array(FC.integer({min: 1, max: 40}), {maxLength: 30})},
    ({sizes}) =>
      Effect.gen(function* () {
        const request = {
          idempotencyKey: 'clé-🔐',
          repositoryId: 'a'.repeat(64),
          profileDigest: sha256Digest('profile'),
        };
        const bytes = new TextEncoder().encode(JSON.stringify(request));
        const chunks: Uint8Array[] = [];
        let offset = 0;
        for (const size of sizes) {
          chunks.push(bytes.slice(offset, offset + size));
          offset = Math.min(bytes.length, offset + size);
        }
        chunks.push(bytes.slice(offset));
        expect(yield* readGraphWorkerEnrollmentRequest(Stream.fromIterable(chunks))).toEqual(request);
      }),
    {fastCheck: {numRuns: 50}},
  );

  effectIt.effect('persists one identity under concurrent replay and stores no raw caller identity or key', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const responses = yield* Effect.forEach(Array.from({length: 12}), () => enrollGraphControlWorker(f.input), {
          concurrency: 12,
        });
        expect(responses.filter(response => response.created)).toHaveLength(1);
        expect(new Set(responses.map(response => response.body.workerId)).size).toBe(1);
        expect(responses[0].body.expiresAt).toBeLessThanOrEqual(f.now + 600);
        const body = yield* f.fs.readFileString(f.target);
        expect(JSON.parse(body).records).toHaveLength(1);
        expect(body).not.toContain('private-a');
        expect(body).not.toContain('same-key');
        expect((yield* enrollGraphControlWorker({...f.input})).body).toEqual(responses[0].body);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect.prop(
    'replay identity remains isolated by principal and operation key',
    {operations: FC.array(FC.tuple(FC.boolean(), FC.integer({min: 0, max: 5})), {minLength: 1, maxLength: 12})},
    ({operations}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const f = yield* fixture();
          const expected = new Map<string, string>();
          for (const [other, key] of operations) {
            const subject = other ? 'private-b' : 'private-a';
            const result = yield* enrollGraphControlWorker({
              ...f.input,
              principal: {...f.principal, subject},
              request: {...f.request, idempotencyKey: String(key)},
            });
            const identity = `${subject}:${key}`;
            if (expected.has(identity)) {
              expect(result.created).toBe(false);
              expect(result.body.workerId).toBe(expected.get(identity));
            } else {
              expect(result.created).toBe(true);
              expect([...expected.values()]).not.toContain(result.body.workerId);
              expected.set(identity, result.body.workerId);
            }
          }
          expect(JSON.parse(yield* f.fs.readFileString(f.target)).records).toHaveLength(expected.size);
        }).pipe(provideTestLayer(layer)),
      ),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('rejects a grant revoked during state preparation without persisting an identity', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        let reads = 0;
        const result = yield* enrollGraphControlWorker({
          ...f.input,
          readCurrentPolicy: Effect.sync(() => (++reads === 1 ? f.policy : {...f.policy, grants: []})),
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* f.fs.exists(f.target)).toBe(false);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('denies corrupt state instead of resetting it and caps each principal without breaking replay', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* enrollGraphControlWorker(f.input);
        for (let key = 1; key < 32; key++)
          yield* enrollGraphControlWorker({...f.input, request: {...f.request, idempotencyKey: String(key)}});
        expect(
          Result.isFailure(
            yield* enrollGraphControlWorker({...f.input, request: {...f.request, idempotencyKey: 'over-limit'}}).pipe(
              Effect.result,
            ),
          ),
        ).toBe(true);
        expect((yield* enrollGraphControlWorker(f.input)).body).toEqual(first.body);
        yield* f.fs.writeFileString(f.target, '{"invalid":true}');
        expect(Result.isFailure(yield* enrollGraphControlWorker(f.input).pipe(Effect.result))).toBe(true);
        expect(yield* f.fs.readFileString(f.target)).toBe('{"invalid":true}');
      }).pipe(provideTestLayer(layer)),
    ),
  );
  effectIt.effect('bounds total active identities and replaces expired records without extending a replay', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = yield* enrollGraphControlWorker(f.input);
        const saved = JSON.parse(yield* f.fs.readFileString(f.target));
        const original = saved.records[0];
        saved.records = [
          original,
          ...Array.from({length: 1023}, (_, index) => ({
            ...original,
            operationId: sha256Digest(`operation-${index}`),
            principalId: sha256Digest(`principal-${index}`),
            workerId: `gw_${index.toString(16).padStart(32, '0')}`,
          })),
        ];
        yield* f.fs.writeFileString(f.target, JSON.stringify(saved));
        const before = yield* f.fs.readFileString(f.target);
        expect(
          Result.isFailure(
            yield* enrollGraphControlWorker({
              ...f.input,
              request: {...f.request, idempotencyKey: 'new-operation'},
            }).pipe(Effect.result),
          ),
        ).toBe(true);
        expect(yield* f.fs.readFileString(f.target)).toBe(before);
        expect((yield* enrollGraphControlWorker(f.input)).body).toEqual(first.body);
        yield* f.fs.writeFileString(
          f.target,
          JSON.stringify({
            ...saved,
            records: saved.records.map((record: Record<string, unknown>) => ({...record, expiresAt: f.now - 1})),
          }),
        );
        const renewed = yield* enrollGraphControlWorker(f.input);
        expect(renewed.created).toBe(true);
        expect(renewed.body.workerId).not.toBe(first.body.workerId);
        expect(JSON.parse(yield* f.fs.readFileString(f.target)).records).toHaveLength(1);
      }).pipe(provideTestLayer(layer)),
    ),
  );

  effectIt.effect('does not acknowledge a failed durable commit', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const f = yield* fixture();
        const broken = {
          ...f.fs,
          rename: (from: string, to: string) =>
            to === f.target ? Effect.fail(graphSharingFailure('Synthetic persistence failure')) : f.fs.rename(from, to),
        };
        const failed = yield* enrollGraphControlWorker(f.input).pipe(
          Effect.provideService(FileSystem.FileSystem, broken),
          Effect.result,
        );
        expect(Result.isFailure(failed)).toBe(true);
        expect(yield* f.fs.exists(f.target)).toBe(false);
        expect((yield* enrollGraphControlWorker(f.input)).created).toBe(true);
      }).pipe(provideTestLayer(layer)),
    ),
  );
});
