import {Clock, Context, Effect, FileSystem, Path, Schema, Stream} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {CommandExecutor} from '../../effect/command.js';
import type {AccessTokenClaims} from '../../oauth/access_token.js';
import {parseGraphShareFrontierPointer} from './artifacts.js';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {readBoundedPrivateBytes, readJsonFile, writePrivateJsonFile} from './atomic.js';
import {withCoordinatorStateLock} from './coordinator_lock.js';
import {type GraphControlPolicy} from './control_authorization.js';
import {GraphControlEnrollmentError, requireGraphControlWorker} from './control_enrollment.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES} from './control_protocol.js';
import {sha256Digest, sha256HexFromDigest} from './digest.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from './errors.js';
import {graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {readAuthenticatedGraphShareFrontier} from './frontier_acceptance.js';
import type {GraphShareEnrollmentV1, GraphShareProfileV1} from './profile.js';
import {graphShareRegistryPublicationScope} from './registry_publication.js';
import {makeGraphShareRegistryReader} from './registry_reader.js';
import {verifyGraphWorkerResultAnnouncement, type GraphWorkerResultAnnouncement} from './worker_announcement.js';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
  GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES,
  parseGraphWorkerAdmissionBytes,
  retireGraphWorkerAdmissionsForPublishedSource,
} from './worker_admission_state.js';
import {
  readGraphWorkerResultArtifact,
  type GraphWorkerResultAuthority,
  type GraphWorkerResultVerificationAuthority,
} from './worker_result.js';
import {graphWorkerRegistryForProfile} from './worker_registry_upload.js';

const LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 2_000,
} as const;

export const readGraphControlWorkerResultRequest = Effect.fn('codeGraph.sharing.readWorkerResultRequest')(function* <
  E,
  R,
>(stream: Stream.Stream<Uint8Array, E, R>) {
  const collected = yield* Stream.runFoldEffect(
    stream,
    () => ({bytes: new Uint8Array(GRAPH_SHARE_CONTROL_MAX_BODY_BYTES), length: 0}),
    (collected, chunk) =>
      Effect.gen(function* () {
        if (collected.length + chunk.byteLength > collected.bytes.byteLength)
          return yield* graphSharingFailure('Graph worker result request exceeds the body limit.');
        collected.bytes.set(chunk, collected.length);
        collected.length += chunk.byteLength;
        return collected;
      }),
  );
  return yield* Effect.try({
    try: () =>
      JSON.parse(
        new TextDecoder('utf-8', {fatal: true}).decode(collected.bytes.subarray(0, collected.length)),
      ) as unknown,
    catch: () => graphSharingFailure('Graph worker result request is invalid.'),
  });
});

/** Admit only signed, original worker bytes. Publishing still requires source recomputation. */
export const admitGraphControlWorkerResult = Effect.fn('codeGraph.sharing.admitControlWorkerResult')(function* <
  E,
  R,
>(input: {
  readonly announcement: unknown;
  readonly casRoot: string;
  readonly commandExecutor: Context.Service.Shape<typeof CommandExecutor>;
  readonly enrollment: GraphShareEnrollmentV1;
  readonly home: string;
  readonly initialPolicy: GraphControlPolicy;
  readonly principal: AccessTokenClaims;
  readonly profile: GraphShareProfileV1;
  readonly readCurrentPolicy: Effect.Effect<GraphControlPolicy, E, R>;
}) {
  const workerRegistry = yield* Effect.try({
    try: () =>
      graphWorkerRegistryForProfile(input.profile, {
        profileDigest: input.initialPolicy.profileDigest,
        repositoryId: input.initialPolicy.repositoryId,
      }),
    catch: () => graphSharingFailure('Worker registry is outside its enrolled scope.'),
  });
  const announcement = structuredClone(input.announcement) as GraphWorkerResultAnnouncement;
  const workerId = announcement?.body?.workerId;
  if (typeof workerId !== 'string' || !/^gw_[0-9a-f]{32}$/u.test(workerId))
    return yield* graphSharingFailure('Graph worker result request is invalid.');
  const requireWorker = () =>
    requireGraphControlWorker({
      home: input.home,
      initialPolicy: input.initialPolicy,
      principal: input.principal,
      readCurrentPolicy: input.readCurrentPolicy,
      workerId,
    }).pipe(
      Effect.mapError(error =>
        Schema.is(GraphSharingError)(error) ? graphSharingUnavailable('Graph worker authority is unavailable.') : error,
      ),
    );
  const worker = yield* requireWorker();
  if (worker.signingPublicKey === undefined) return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
  const authority: GraphWorkerResultVerificationAuthority = {
    expiresAt: worker.expiresAt,
    principalId: worker.principalId,
    profileDigest: input.initialPolicy.profileDigest,
    repositoryId: input.initialPolicy.repositoryId,
    signingPublicKey: worker.signingPublicKey,
    workerId: worker.workerId,
  };
  const body = yield* verifyGraphWorkerResultAnnouncement(announcement, authority);
  const signed = {...announcement, body};
  const path = yield* Path.Path;
  const target = yield* graphWorkerAdmissionStatePath(input.home, input.initialPolicy);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  const replay = yield* withCoordinatorStateLock(
    {threadnoteHome: input.home},
    withExclusiveFileLock(
      fs,
      `${target}.lock`,
      LOCK_OPTIONS,
      Effect.gen(function* () {
        const prior = yield* readAdmissionState(target, input.initialPolicy);
        const receipt = prior.receipts.find(item => item.announcement.body.idempotencyKey === body.idempotencyKey);
        if (receipt === undefined) return undefined;
        if ((yield* publishedSourceCommit(input)) === receipt.sourceCommit) return {status: 'stale-source' as const};
        const currentWorker = yield* requireWorker();
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (
          currentWorker.signingPublicKey !== authority.signingPublicKey ||
          currentWorker.principalId !== authority.principalId ||
          currentWorker.expiresAt <= now
        )
          return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
        return admitGraphWorkerAnnouncement(prior, {
          announcement: signed,
          authority: {...authority, graphAbi: receipt.graphAbi, expiresAt: currentWorker.expiresAt},
          nowSeconds: now,
          sourceCommit: receipt.sourceCommit,
        });
      }),
    ),
  );
  if (replay !== undefined) {
    if (replay.status === 'duplicate' || replay.status === 'operation-conflict' || replay.status === 'stale-source')
      return replay;
    return yield* graphSharingUnavailable('Graph worker admission replay is invalid.');
  }
  const result = yield* Effect.gen(function* () {
    const reader = yield* makeGraphShareRegistryReader(workerRegistry).pipe(
      Effect.mapError(() => graphSharingUnavailable('Worker registry is unavailable.')),
    );
    return yield* readGraphWorkerResultArtifact(reader, body.resultManifestDigest, authority);
  }).pipe(Effect.provideService(CommandExecutor, input.commandExecutor));
  const claims = result.attestation.claims;
  if (
    body.actionKey !== claims.actionKey ||
    body.attestationDigest !== result.attestationDigest ||
    body.batchId !== claims.batchId ||
    body.principalId !== claims.principalId ||
    body.profileDigest !== claims.profileDigest ||
    body.repositoryId !== claims.repositoryId ||
    body.resultManifestDigest !== result.manifestDigest ||
    body.semanticDigest !== claims.semanticDigest ||
    body.workerId !== claims.workerId
  )
    return yield* graphSharingFailure('Graph worker result announcement does not match its signed artifact.');
  // The artifact verifier checks the signed full sourceCommit and its batch prefix.
  return yield* withCoordinatorStateLock(
    {threadnoteHome: input.home},
    withExclusiveFileLock(
      fs,
      `${target}.lock`,
      LOCK_OPTIONS,
      Effect.gen(function* () {
        const current = yield* readAdmissionState(target, input.initialPolicy);
        if ((yield* publishedSourceCommit(input)) === claims.sourceCommit) return {status: 'stale-source' as const};
        const currentWorker = yield* requireWorker();
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (
          currentWorker.signingPublicKey !== authority.signingPublicKey ||
          currentWorker.principalId !== authority.principalId ||
          currentWorker.expiresAt <= now
        )
          return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
        const outcome = admitGraphWorkerAnnouncement(current, {
          announcement: signed,
          authority: {
            ...authority,
            graphAbi: claims.graphAbi,
            expiresAt: currentWorker.expiresAt,
          } satisfies GraphWorkerResultAuthority,
          nowSeconds: now,
          sourceCommit: claims.sourceCommit,
        });
        if (outcome.status === 'accepted' || outcome.status === 'quarantined') {
          const bytes = new TextEncoder().encode(JSON.stringify(outcome.store));
          if (bytes.byteLength > GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES)
            return yield* graphSharingUnavailable('Graph worker admission state is at capacity.');
          yield* writePrivateJsonFile(target, outcome.store).pipe(
            Effect.mapError(() => graphSharingUnavailable('Graph worker admission state could not be committed.')),
          );
        }
        return outcome;
      }),
    ),
  );
});

/** Read the authenticated local pointer under the coordinator lock, which serializes its promotion. */
const publishedSourceCommit = Effect.fn('codeGraph.sharing.publishedWorkerSourceCommit')(function* (input: {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollmentV1;
  readonly home: string;
  readonly profile: GraphShareProfileV1;
}) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, input.home, input.casRoot);
  const pointer = parseGraphShareFrontierPointer(
    yield* readJsonFile(graphSharingFrontierPointerPath(path, layout.frontiersRoot, input.enrollment.repositoryId)),
  );
  const scope = yield* Effect.try({
    try: () => graphShareRegistryPublicationScope(input),
    catch: () => graphSharingFailure('Worker result enrollment is invalid.'),
  });
  return (yield* readAuthenticatedGraphShareFrontier(input.casRoot, scope, pointer)).sourceCommit;
});

export const graphWorkerAdmissionStatePath = Effect.fn('codeGraph.sharing.workerAdmissionStatePath')(function* (
  home: string,
  policy: GraphControlPolicy,
) {
  const path = yield* Path.Path;
  const authority = sha256Digest(
    canonicalJson([
      policy.issuer,
      policy.audience,
      policy.jwksUrl,
      policy.organization,
      policy.repositoryId,
      policy.profileDigest,
    ]),
  );
  return path.join(
    graphSharingLayout(path, home).root,
    'control',
    'admissions',
    `${sha256HexFromDigest(authority)}.json`,
  );
});

const readAdmissionState = Effect.fn('codeGraph.sharing.readWorkerAdmissionState')(function* (
  target: string,
  policy: GraphControlPolicy,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(target))) return emptyGraphWorkerAdmissionStore();
  const bytes = yield* readBoundedPrivateBytes(target, GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES).pipe(
    Effect.mapError(() => graphSharingUnavailable('Graph worker admission state is unavailable.')),
  );
  const parsed = yield* Effect.try({
    try: () => parseGraphWorkerAdmissionBytes(bytes),
    catch: () => graphSharingUnavailable('Graph worker admission state is invalid.'),
  });
  if (
    parsed.receipts.some(
      receipt =>
        receipt.announcement.body.repositoryId !== policy.repositoryId ||
        receipt.announcement.body.profileDigest !== policy.profileDigest,
    )
  )
    return yield* graphSharingUnavailable('Graph worker admission state does not match its scope.');
  return parsed;
});

/** Read a strictly bounded, policy-scoped signed admission store for canonical publication. */
export const readGraphWorkerAdmissionStore = Effect.fn('codeGraph.sharing.readWorkerAdmissionStore')(function* (
  home: string,
  policy: GraphControlPolicy,
) {
  return yield* readAdmissionState(yield* graphWorkerAdmissionStatePath(home, policy), policy);
});

/** Called after durable pointer promotion, while the caller holds the coordinator lock. */
export const retireGraphWorkerAdmissionsForPublishedSourceLocked = Effect.fn(
  'codeGraph.sharing.retireWorkerAdmissionsForPublishedSourceLocked',
)(function* (home: string, policy: GraphControlPolicy, sourceCommit: string) {
  const target = yield* graphWorkerAdmissionStatePath(home, policy);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    `${target}.lock`,
    LOCK_OPTIONS,
    Effect.gen(function* () {
      const current = yield* readAdmissionState(target, policy);
      const next = yield* Effect.try({
        try: () => retireGraphWorkerAdmissionsForPublishedSource(current, sourceCommit),
        catch: () => graphSharingFailure('Published worker receipt source is invalid.'),
      });
      if (next !== current) yield* writePrivateJsonFile(target, next);
      return {retired: current.receipts.length - next.receipts.length};
    }),
  );
});
