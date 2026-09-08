import {Clock, Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {readBoundedPrivateBytes, writePrivateJsonFile} from './atomic.js';
import type {GraphControlClientScope, GraphControlCredential} from './control_credentials.js';
import {sha256Digest, sha256HexFromDigest, SHA256_DIGEST, SHA256_HEX} from './digest.js';
import {graphSharingFailure, type GraphSharingError} from './errors.js';
import {graphSharingLayout} from './layout.js';

const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const Worker = Schema.Struct({
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  principalId: Digest,
  profileDigest: Digest,
  repositoryId: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  schemaVersion: Schema.Literal(1),
  workerId: Schema.String.check(Schema.isPattern(/^gw_[0-9a-f]{32}$/u)),
});
const State = Schema.Struct({
  identity: Digest,
  operationId: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u)),
  schemaVersion: Schema.Literal(1),
  worker: Schema.optionalKey(Worker),
});
const STRICT = {onExcessProperty: 'error'} as const;
export type GraphControlClientWorker = typeof Worker.Type;

interface EnrollmentClient<E, R> {
  readonly credentials: {readonly load: Effect.Effect<GraphControlCredential, E, R>};
  readonly request: <GuardE = never, GuardR = never>(
    method: 'POST',
    pathname: string,
    body: unknown,
    isAuthorized?: Effect.Effect<boolean, GuardE, GuardR>,
  ) => Effect.Effect<
    {
      readonly status: number;
      readonly body: unknown;
      readonly credential: GraphControlCredential;
    },
    E | GraphSharingError | GuardE,
    R | GuardR
  >;
}

export const enrollGraphControlClient = Effect.fn('codeGraph.sharing.enrollControlClient')(function* <E, R>(input: {
  readonly home: string;
  readonly scope: GraphControlClientScope;
  readonly client: EnrollmentClient<E, R>;
  readonly isAuthorized?: Effect.Effect<boolean, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(graphSharingLayout(path, input.home).root, 'client-enrollments');
  const target = path.join(directory, sha256HexFromDigest(sha256Digest(JSON.stringify(input.scope))) + '.json');
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    target + '.lock',
    {
      heartbeatIntervalMilliseconds: 10_000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 60_000,
      waitTimeoutMilliseconds: 2_000,
    },
    Effect.gen(function* () {
      if (input.isAuthorized !== undefined && !(yield* input.isAuthorized))
        return yield* graphSharingFailure('Graph worker enrollment is no longer authorized.');
      const credential = yield* input.client.credentials.load;
      let state: typeof State.Type | undefined;
      if (yield* fs.exists(target)) {
        const bytes = yield* readBoundedPrivateBytes(target, 8192);
        const text = yield* Effect.try({
          try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
          catch: () => graphSharingFailure('Graph client enrollment state is invalid.'),
        });
        state = yield* Schema.decodeEffect(
          Schema.fromJsonString(State),
          STRICT,
        )(text).pipe(Effect.mapError(() => graphSharingFailure('Graph client enrollment state is invalid.')));
      }
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      if (state?.identity === credential.identity && state.worker !== undefined) {
        if (!matchesWorker(state.worker, input.scope, credential.principalId))
          return yield* graphSharingFailure('Graph client enrollment state has a different authority.');
        if (state.worker.expiresAt > now + 15) {
          if (input.isAuthorized !== undefined && !(yield* input.isAuthorized))
            return yield* graphSharingFailure('Graph worker enrollment is no longer authorized.');
          return state.worker;
        }
      }
      if (state === undefined || state.identity !== credential.identity || state.worker !== undefined) {
        state = {
          identity: credential.identity,
          operationId: yield* (yield* Crypto.Crypto).randomUUIDv4,
          schemaVersion: 1,
        };
        yield* writePrivateJsonFile(target, state);
      }
      const response = yield* input.client.request(
        'POST',
        '/v1/enroll',
        {
          idempotencyKey: state.operationId,
          profileDigest: input.scope.profileDigest,
          repositoryId: input.scope.repositoryId,
        },
        input.isAuthorized,
      );
      const worker = yield* Schema.decodeUnknownEffect(
        Worker,
        STRICT,
      )(response.body).pipe(Effect.mapError(() => graphSharingFailure('Graph worker enrollment response is invalid.')));
      const atCommit = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      if (
        (response.status !== 200 && response.status !== 201) ||
        response.credential.identity !== credential.identity ||
        !matchesWorker(worker, input.scope, credential.principalId) ||
        worker.expiresAt <= atCommit + 15 ||
        worker.expiresAt > atCommit + 3660 ||
        (input.isAuthorized !== undefined && !(yield* input.isAuthorized))
      )
        return yield* graphSharingFailure('Graph worker enrollment response is outside its authority.');
      yield* writePrivateJsonFile(target, {...state, worker});
      return worker;
    }),
  );
});

function matchesWorker(worker: GraphControlClientWorker, scope: GraphControlClientScope, principalId: string): boolean {
  return (
    worker.principalId === principalId &&
    worker.repositoryId === scope.repositoryId &&
    worker.profileDigest === scope.profileDigest
  );
}
