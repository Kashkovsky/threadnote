import {Clock, Context, Effect, FileSystem, Path, Schema, Stream} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {CommandExecutor, runCommandEffect} from '../../effect/command.js';
import {SystemInfo} from '../../effect/system.js';
import type {AccessTokenClaims} from '../../oauth/access_token.js';
import {parseGraphShareFrontierPointer} from './artifacts.js';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {readBoundedPrivateBytes, readJsonFile, writeDurablePrivateJsonFile, writePrivateJsonFile} from './atomic.js';
import {withCoordinatorStateLock} from './coordinator_lock.js';
import {type GraphControlPolicy} from './control_authorization.js';
import {GraphControlEnrollmentError, requireGraphControlWorker} from './control_enrollment.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES} from './control_protocol.js';
import {sha256Digest, sha256HexFromDigest} from './digest.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from './errors.js';
import {graphSharingFrontierPointerPath, graphSharingLayout} from './layout.js';
import {readAuthenticatedGraphShareFrontier} from './frontier_acceptance.js';
import {graphShareCommitIsAncestor, GRAPH_SHARE_GIT_OBJECT_ID} from './git.js';
import type {GraphShareEnrollment, GraphShareProfileV1} from './profile.js';
import {graphShareRegistryPublicationScope} from './registry_publication.js';
import {makeGraphShareRegistryReader} from './registry_reader.js';
import {verifyGraphWorkerResultAnnouncement, type GraphWorkerResultAnnouncement} from './worker_announcement.js';
import {
  graphWorkerAdmissionArchiveSummaries,
  graphWorkerAdmissionReceiptSummary,
  parkGraphWorkerAdmissionReceipts,
  readGraphWorkerAdmissionArchive,
  retireGraphWorkerAdmissionArchive,
  type GraphWorkerAdmissionArchive,
  type GraphWorkerAdmissionArchiveSelection,
  type ReceiptSummary,
} from './worker_admission_archive.js';
import {
  admitGraphWorkerAnnouncement,
  emptyGraphWorkerAdmissionStore,
  GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES,
  graphWorkerAdmissionQuarantineForSummaries,
  mergeGraphWorkerAdmissionReceipts,
  parseGraphWorkerAdmissionBytes,
  retireGraphWorkerAdmissionsForPublishedSource,
  retireGraphWorkerAdmissionsForPublishedSources,
} from './worker_admission_state.js';
import {
  readGraphWorkerResultArtifact,
  type GraphWorkerResultAuthority,
  type GraphWorkerResultVerificationAuthority,
} from './worker_result.js';
import {graphWorkerRegistryForProfile} from './worker_registry_upload.js';

const LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
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
  readonly enrollment: GraphShareEnrollment;
  readonly home: string;
  readonly initialPolicy: GraphControlPolicy;
  readonly principal: AccessTokenClaims;
  readonly profile: GraphShareProfileV1;
  readonly repoRoot: string;
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
        const prior = yield* readAdmissionView(target, input.initialPolicy, {
          kind: 'operation',
          operationId: body.idempotencyKey,
        });
        const receipt = prior.view.receipts.find(item => item.announcement.body.idempotencyKey === body.idempotencyKey);
        if (receipt === undefined) return undefined;
        const currentWorker = yield* requireWorker();
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (
          currentWorker.signingPublicKey !== authority.signingPublicKey ||
          currentWorker.principalId !== authority.principalId ||
          currentWorker.expiresAt <= now
        )
          return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
        const disposition = yield* sourceDisposition(input, receipt.sourceCommit).pipe(
          Effect.provideService(CommandExecutor, input.commandExecutor),
        );
        if (disposition !== undefined) return {status: disposition, idempotencyKey: body.idempotencyKey};
        return admitGraphWorkerAnnouncement(singletonReceiptStore(receipt), {
          announcement: signed,
          authority: {...authority, graphAbi: receipt.graphAbi, expiresAt: currentWorker.expiresAt},
          nowSeconds: now,
          sourceCommit: receipt.sourceCommit,
        });
      }),
    ),
  );
  if (replay !== undefined) {
    if (
      replay.status === 'duplicate' ||
      replay.status === 'operation-conflict' ||
      replay.status === 'stale-source' ||
      replay.status === 'source-unavailable'
    )
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
        let current = yield* readAdmissionView(target, input.initialPolicy, {
          kind: 'operation',
          operationId: body.idempotencyKey,
        });
        const currentWorker = yield* requireWorker();
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (
          currentWorker.signingPublicKey !== authority.signingPublicKey ||
          currentWorker.principalId !== authority.principalId ||
          currentWorker.expiresAt <= now
        )
          return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
        const disposition = yield* sourceDisposition(input, claims.sourceCommit).pipe(
          Effect.provideService(CommandExecutor, input.commandExecutor),
        );
        if (disposition !== undefined) return {status: disposition, idempotencyKey: body.idempotencyKey};
        const stored = current.view.receipts.find(
          item => item.announcement.body.idempotencyKey === body.idempotencyKey,
        );
        if (stored !== undefined)
          return admitGraphWorkerAnnouncement(singletonReceiptStore(stored), {
            announcement: signed,
            authority: {...authority, graphAbi: claims.graphAbi, expiresAt: currentWorker.expiresAt},
            nowSeconds: now,
            sourceCommit: claims.sourceCommit,
          });
        const admission = {
          announcement: signed,
          authority: {
            ...authority,
            graphAbi: claims.graphAbi,
            expiresAt: currentWorker.expiresAt,
          } satisfies GraphWorkerResultAuthority,
          nowSeconds: now,
          sourceCommit: claims.sourceCommit,
        };
        let outcome = admitGraphWorkerAnnouncement(current.hot, admission);
        let publishedSource: string | undefined;
        while (
          outcome.status === 'capacity-exceeded' ||
          ('receipt' in outcome &&
            new TextEncoder().encode(`${JSON.stringify(outcome.store)}\n`).byteLength >
              GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES)
        ) {
          publishedSource ??= yield* publishedSourceCommit(input);
          const group = oldestParkableSource(current.hot, claims.sourceCommit, publishedSource);
          if (group === undefined) return {status: 'capacity-exceeded' as const, store: current.hot};
          const parked = yield* parkGraphWorkerAdmissionReceipts(
            target,
            input.initialPolicy,
            current.archive,
            group.sourceCommit,
            group.receipts,
          );
          if (parked.status === 'capacity-exceeded') return {status: 'capacity-exceeded' as const, store: current.hot};
          const remaining = current.hot.receipts.filter(receipt => receipt.sourceCommit !== group.sourceCommit);
          const hot = {
            ...mergeGraphWorkerAdmissionReceipts(remaining, []),
            archiveStarted: true as const,
            schemaVersion: 2 as const,
          };
          yield* writeDurablePrivateJsonFile(target, hot).pipe(
            Effect.mapError(() => graphSharingUnavailable('Graph worker admissions could not be parked.')),
          );
          current = {
            archive: parked.archive,
            hot,
            view: mergeAdmissionView(hot.receipts, parked.archive, input.initialPolicy),
          };
          outcome = admitGraphWorkerAnnouncement(current.hot, admission);
        }
        if (outcome.status === 'accepted' || outcome.status === 'quarantined') {
          yield* writePrivateJsonFile(target, outcome.store).pipe(
            Effect.mapError(() => graphSharingUnavailable('Graph worker admission state could not be committed.')),
          );
          const merged = yield* Effect.try({
            try: () => mergeAdmissionView(outcome.store.receipts, current.archive, input.initialPolicy),
            catch: () => graphSharingUnavailable('Graph worker admission copies conflict.'),
          });
          if (
            merged.quarantine.some(item => item.repositoryId === body.repositoryId && item.actionKey === body.actionKey)
          )
            return {...outcome, status: 'quarantined' as const};
        }
        return outcome;
      }),
    ),
  );
});

/** Only the exact unpublished HEAD of the publisher's trusted checkout can enter admission state. */
const sourceDisposition = Effect.fn('codeGraph.sharing.workerSourceDisposition')(function* (
  input: {
    readonly casRoot: string;
    readonly enrollment: GraphShareEnrollment;
    readonly home: string;
    readonly profile: GraphShareProfileV1;
    readonly repoRoot: string;
  },
  sourceCommit: string,
) {
  const published = yield* publishedSourceCommit(input);
  if (sourceCommit === published) return 'stale-source' as const;
  const system = yield* SystemInfo;
  const head = yield* runCommandEffect('git', ['-C', input.repoRoot, 'rev-parse', 'HEAD'], {
    allowFailure: true,
    env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
    maxOutputBytes: 128,
    timeoutMs: 10_000,
  }).pipe(Effect.mapError(() => graphSharingUnavailable('Publisher source checkout is unavailable.')));
  const currentHead = head.stdout.trim();
  if (head.exitCode !== 0 || !GRAPH_SHARE_GIT_OBJECT_ID.test(currentHead))
    return yield* graphSharingUnavailable('Publisher source checkout is unavailable.');
  if (sourceCommit !== currentHead) {
    // An intermediate commit behind HEAD is not safely retired until a signed
    // canonical frontier has actually included that source.
    if (yield* graphShareCommitIsAncestor(input.repoRoot, sourceCommit, published)) return 'stale-source' as const;
    return 'source-unavailable' as const;
  }
  if (!(yield* graphShareCommitIsAncestor(input.repoRoot, published, sourceCommit)))
    return 'source-unavailable' as const;
  return undefined;
});

/** Read the authenticated local pointer under the coordinator lock, which serializes its promotion. */
const publishedSourceCommit = Effect.fn('codeGraph.sharing.publishedWorkerSourceCommit')(function* (input: {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollment;
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

const readHotAdmissionState = Effect.fn('codeGraph.sharing.readWorkerAdmissionState')(function* (
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

const readAdmissionView = Effect.fn('codeGraph.sharing.readWorkerAdmissionView')(function* (
  target: string,
  policy: GraphControlPolicy,
  selection: GraphWorkerAdmissionArchiveSelection = {kind: 'all'},
) {
  const hot = yield* readHotAdmissionState(target, policy);
  const archive = yield* readGraphWorkerAdmissionArchive(target, policy, selection, hot.archiveStarted === true).pipe(
    Effect.mapError(() => graphSharingUnavailable('Graph worker admission archive is unavailable.')),
  );
  const view = yield* Effect.try({
    try: () => mergeAdmissionView(hot.receipts, archive, policy),
    catch: () => graphSharingUnavailable('Graph worker admission copies conflict.'),
  });
  return {archive, hot, view};
});

function mergeAdmissionView(
  hot: ReturnType<typeof emptyGraphWorkerAdmissionStore>['receipts'],
  archive: GraphWorkerAdmissionArchive,
  policy: GraphControlPolicy,
) {
  const selected = mergeGraphWorkerAdmissionReceipts(hot, archive.receipts);
  const summaries = new Map<string, ReceiptSummary & {readonly sourceCommit: string}>();
  for (const receipt of hot) {
    const summary = {...graphWorkerAdmissionReceiptSummary(receipt), sourceCommit: receipt.sourceCommit};
    summaries.set(summary.operationId, summary);
  }
  for (const summary of graphWorkerAdmissionArchiveSummaries(archive.manifest)) {
    const prior = summaries.get(summary.operationId);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(summary))
      throw new Error('Conflicting graph worker admission receipt summaries.');
    summaries.set(summary.operationId, summary);
  }
  return {
    receipts: selected.receipts,
    quarantine: graphWorkerAdmissionQuarantineForSummaries(
      [...summaries.values()].map(summary => ({...summary, repositoryId: policy.repositoryId})),
    ),
  };
}

function singletonReceiptStore(receipt: ReturnType<typeof emptyGraphWorkerAdmissionStore>['receipts'][number]) {
  return {...mergeGraphWorkerAdmissionReceipts([receipt], []), schemaVersion: 2 as const};
}

function oldestParkableSource(
  hot: ReturnType<typeof emptyGraphWorkerAdmissionStore>,
  currentSource: string,
  publishedSource: string,
) {
  const groups = new Map<string, typeof hot.receipts>();
  for (const receipt of hot.receipts) {
    if (receipt.sourceCommit === currentSource || receipt.sourceCommit === publishedSource) continue;
    groups.set(receipt.sourceCommit, [...(groups.get(receipt.sourceCommit) ?? []), receipt]);
  }
  return [...groups.entries()]
    .map(([sourceCommit, receipts]) => ({sourceCommit, receipts}))
    .sort(
      (left, right) =>
        Math.min(...left.receipts.map(receipt => receipt.admittedAt)) -
          Math.min(...right.receipts.map(receipt => receipt.admittedAt)) ||
        (left.sourceCommit < right.sourceCommit ? -1 : 1),
    )[0];
}

function countCoveredReceipts(
  hot: ReturnType<typeof emptyGraphWorkerAdmissionStore>['receipts'],
  archive: GraphWorkerAdmissionArchive,
  covered: ReadonlySet<string>,
) {
  return new Set([
    ...hot
      .filter(receipt => covered.has(receipt.sourceCommit))
      .map(receipt => receipt.announcement.body.idempotencyKey),
    ...graphWorkerAdmissionArchiveSummaries(archive.manifest)
      .filter(receipt => covered.has(receipt.sourceCommit))
      .map(receipt => receipt.operationId),
  ]).size;
}

/** Read a strictly bounded, policy-scoped signed admission store for canonical publication. */
export const readGraphWorkerAdmissionStore = Effect.fn('codeGraph.sharing.readWorkerAdmissionStore')(function* (
  home: string,
  policy: GraphControlPolicy,
  sourceCommit?: string,
) {
  return (yield* readAdmissionView(
    yield* graphWorkerAdmissionStatePath(home, policy),
    policy,
    sourceCommit === undefined ? {kind: 'all'} : {kind: 'source', sourceCommit},
  )).view;
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
      const current = yield* readAdmissionView(target, policy, {kind: 'source', sourceCommit});
      const next = yield* Effect.try({
        try: () => retireGraphWorkerAdmissionsForPublishedSource(current.hot, sourceCommit),
        catch: () => graphSharingFailure('Published worker receipt source is invalid.'),
      });
      yield* retireGraphWorkerAdmissionArchive(target, current.archive, new Set([sourceCommit]));
      if (next !== current.hot) yield* writeDurablePrivateJsonFile(target, next);
      return {retired: countCoveredReceipts(current.hot.receipts, current.archive, new Set([sourceCommit]))};
    }),
  );
});

/** Caller holds the coordinator lock. The signed pointer, not the mutable HEAD, determines safe retirement. */
export const retireGraphWorkerAdmissionsCoveredByPublishedSourceLocked = Effect.fn(
  'codeGraph.sharing.retireWorkerAdmissionsCoveredByPublishedSourceLocked',
)(function* (
  input: {
    readonly casRoot: string;
    readonly enrollment: GraphShareEnrollment;
    readonly home: string;
    readonly profile: GraphShareProfileV1;
    readonly repoRoot: string;
  },
  policy: GraphControlPolicy,
) {
  const published = yield* publishedSourceCommit(input);
  const target = yield* graphWorkerAdmissionStatePath(input.home, policy);
  const snapshot = yield* readAdmissionView(target, policy, {kind: 'index'});
  const covered = new Set([published]);
  const sources = [
    ...new Set([
      ...snapshot.hot.receipts.map(receipt => receipt.sourceCommit),
      ...snapshot.archive.manifest.segments.map(segment => segment.sourceCommit),
    ]),
  ].filter(source => source !== published);
  const ancestors = yield* Effect.forEach(
    sources,
    source => graphShareCommitIsAncestor(input.repoRoot, source, published),
    {concurrency: 8},
  );
  for (const [index, source] of sources.entries()) if (ancestors[index]) covered.add(source);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    `${target}.lock`,
    LOCK_OPTIONS,
    Effect.gen(function* () {
      const current = yield* readAdmissionView(target, policy, {kind: 'sources', sourceCommits: covered});
      // Admission also holds the coordinator lock, so the read used for ancestry
      // cannot gain a new source before this mutation lock is acquired.
      if (
        canonicalJson(current.hot) !== canonicalJson(snapshot.hot) ||
        canonicalJson(current.archive.manifest) !== canonicalJson(snapshot.archive.manifest)
      )
        return yield* graphSharingUnavailable('Graph worker admissions changed during published-source retirement.');
      const next = yield* Effect.try({
        try: () => retireGraphWorkerAdmissionsForPublishedSources(current.hot, covered),
        catch: () => graphSharingFailure('Published worker receipt source is invalid.'),
      });
      yield* retireGraphWorkerAdmissionArchive(target, current.archive, covered);
      if (next !== current.hot) yield* writeDurablePrivateJsonFile(target, next);
      return {retired: countCoveredReceipts(current.hot.receipts, current.archive, covered)};
    }),
  );
});
