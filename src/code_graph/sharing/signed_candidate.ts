import {Clock, Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {codeGraphCheckpointAbiInputV1} from '../checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../checkpoint/pack.js';
import type {CodeGraphStoreShape} from '../store_shape.js';
import type {CodeGraphSnapshot} from '../types.js';
import {readJsonFile, writePrivateJsonFile} from './atomic.js';
import {
  GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS,
  GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS,
  GRAPH_SHARE_QUEUE_MAXIMUM_BYTES,
} from './contribution.js';
import {SHA256_DIGEST, SHA256_HEX} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingLayout} from './layout.js';

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BATCH = /^[0-9a-f]{40}$/u;
const SNAPSHOT = /^cgsn_[0-9a-f]{40}(?:-[a-z0-9]+)*$/u;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const MAX_PENDING = GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS;

/** Immutable CAS identity captured in the producing parser callback. No graph-wide claims exist yet. */
export interface GraphSharePendingSignedCandidate {
  readonly actionKey: string;
  readonly batchId: string;
  readonly casRoot: string;
  readonly extractorSet: string;
  readonly resultDigest: string;
  readonly resultSize: number;
  readonly semanticDigest: string;
  readonly sourceCommit: string;
}

/** Private producer evidence. The sender must verify CAS bytes and current authorization before signing. */
export interface GraphShareSignedCandidateV1 extends GraphSharePendingSignedCandidate {
  readonly graphAbi: string;
  readonly partialCoverage: boolean;
  readonly platform: {readonly os: 'darwin' | 'linux' | 'win32'; readonly architecture: 'arm64' | 'x64'};
  readonly queuedAtMilliseconds: number;
  readonly releaseIdentity: string;
  readonly resourceLimits: readonly string[];
  readonly snapshotId: string;
}

export interface GraphShareSignedCandidateQueueV1 {
  readonly candidates: readonly GraphShareSignedCandidateV1[];
  readonly schemaVersion: 1;
}

export function makeGraphShareSignedCandidateCollector() {
  const pending: GraphSharePendingSignedCandidate[] = [];
  return {
    capture(candidate: GraphSharePendingSignedCandidate): void {
      if (!validPending(candidate)) return;
      const identity = pendingIdentity(candidate);
      if (pending.some(item => pendingIdentity(item) === identity)) return;
      pending.push({...candidate});
      if (pending.length > MAX_PENDING) pending.shift();
    },
    snapshot(): readonly GraphSharePendingSignedCandidate[] {
      return pending.map(item => ({...item}));
    },
  };
}

/** This is called only after an exact clean snapshot is ready and inventory has completed. */
export const finalizeGraphShareSignedCandidates = Effect.fn('codeGraph.sharing.finalizeSignedCandidates')(
  function* (input: {
    readonly candidates: readonly GraphSharePendingSignedCandidate[];
    readonly databasePath: string;
    readonly repositoryId: string;
    readonly releaseIdentity: string;
    readonly skippedFiles: number;
    readonly snapshot: CodeGraphSnapshot;
    readonly store: CodeGraphStoreShape;
    readonly threadnoteHome: string;
    readonly platform: {readonly os: string; readonly architecture: string};
  }) {
    if (input.candidates.length === 0) return {queued: 0};
    const snapshot = input.snapshot;
    if (
      snapshot.state !== 'ready' ||
      snapshot.dirty ||
      snapshot.repositoryId !== input.repositoryId ||
      !SHA256_HEX.test(input.repositoryId) ||
      !Number.isSafeInteger(input.skippedFiles) ||
      input.skippedFiles < 0 ||
      !RELEASE.test(input.releaseIdentity) ||
      input.releaseIdentity === 'unknown' ||
      !validPlatform(input.platform) ||
      input.candidates.some(candidate => !validPending(candidate) || candidate.sourceCommit !== snapshot.commit)
    )
      return {queued: 0};
    const provenance = yield* input.store.snapshotPackProvenance(input.databasePath, snapshot.id);
    if (provenance === undefined) return {queued: 0};
    const activeCacheIdentities = new Set(provenance.map(pack => pack.cacheIdentity));
    if (input.candidates.some(candidate => !activeCacheIdentities.has(candidate.extractorSet))) return {queued: 0};
    const graphAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(provenance)).digest;
    const now = yield* Clock.currentTimeMillis;
    const finalized = input.candidates.map(
      candidate =>
        ({
          ...candidate,
          graphAbi,
          partialCoverage: input.skippedFiles > 0,
          platform: input.platform as GraphShareSignedCandidateV1['platform'],
          queuedAtMilliseconds: now,
          releaseIdentity: input.releaseIdentity,
          resourceLimits: [],
          snapshotId: snapshot.id,
        }) satisfies GraphShareSignedCandidateV1,
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = signedCandidateQueuePath(path, input.threadnoteHome, input.repositoryId);
    yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
    return yield* withExclusiveFileLock(
      fs,
      `${target}.lock`,
      {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 30_000},
      Effect.gen(function* () {
        let existing: GraphShareSignedCandidateQueueV1 = {candidates: [], schemaVersion: 1};
        if (yield* fs.exists(target)) {
          if (Number((yield* fs.stat(target)).size) > 4 * 1_024 * 1_024)
            return yield* graphSharingFailure('Signed candidate queue exceeds the metadata read limit.');
          existing = parseGraphShareSignedCandidateQueue(yield* readJsonFile(target));
        }
        const next = appendGraphShareSignedCandidates(existing, finalized, now);
        if (JSON.stringify(next) !== JSON.stringify(existing)) yield* writePrivateJsonFile(target, next);
        const prior = new Set(pruneGraphShareSignedCandidateQueue(existing, now).candidates.map(candidateIdentity));
        return {queued: next.candidates.filter(candidate => !prior.has(candidateIdentity(candidate))).length};
      }),
    );
  },
);

export function signedCandidateQueuePath(path: Path.Path, home: string, repositoryId: string): string {
  return path.join(graphSharingLayout(path, home).root, 'signed-candidates', `${repositoryId}.json`);
}

export function appendGraphShareSignedCandidates(
  queue: GraphShareSignedCandidateQueueV1,
  additions: readonly GraphShareSignedCandidateV1[],
  now: number,
): GraphShareSignedCandidateQueueV1 {
  const retained = pruneGraphShareSignedCandidateQueue(queue, now).candidates;
  const seen = new Set(retained.map(candidateIdentity));
  const candidates = [...retained];
  for (const candidate of additions) {
    if (!validCandidate(candidate)) continue;
    const identity = candidateIdentity(candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({...candidate, platform: {...candidate.platform}, resourceLimits: [...candidate.resourceLimits]});
  }
  return pruneGraphShareSignedCandidateQueue({candidates, schemaVersion: 1}, now);
}

export function pruneGraphShareSignedCandidateQueue(
  queue: GraphShareSignedCandidateQueueV1,
  now: number,
): GraphShareSignedCandidateQueueV1 {
  let candidates = queue.candidates
    .map(item => ({...item, queuedAtMilliseconds: Math.min(now, item.queuedAtMilliseconds)}))
    .filter(item => item.queuedAtMilliseconds >= now - GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS)
    .slice(-GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS);
  let result: GraphShareSignedCandidateQueueV1 = {candidates, schemaVersion: 1};
  while (
    candidates.length > 0 &&
    new TextEncoder().encode(JSON.stringify(result)).byteLength > GRAPH_SHARE_QUEUE_MAXIMUM_BYTES
  ) {
    candidates = candidates.slice(1);
    result = {candidates, schemaVersion: 1};
  }
  return result;
}

export function parseGraphShareSignedCandidateQueue(value: unknown): GraphShareSignedCandidateQueueV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.candidates))
    throw graphSharingFailure('Signed candidate queue is invalid.');
  if (
    value.candidates.length > GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS ||
    value.candidates.some(item => !validCandidate(item))
  )
    throw graphSharingFailure('Signed candidate queue contains invalid producer evidence.');
  if (Object.keys(value).sort().join(',') !== 'candidates,schemaVersion')
    throw graphSharingFailure('Signed candidate queue has unsupported fields.');
  return value as unknown as GraphShareSignedCandidateQueueV1;
}

function validPending(value: unknown): value is GraphSharePendingSignedCandidate {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(',') ===
      'actionKey,batchId,casRoot,extractorSet,resultDigest,resultSize,semanticDigest,sourceCommit' &&
    typeof value.actionKey === 'string' &&
    SHA256_HEX.test(value.actionKey) &&
    typeof value.batchId === 'string' &&
    BATCH.test(value.batchId) &&
    typeof value.casRoot === 'string' &&
    value.casRoot.length > 0 &&
    value.casRoot.length <= 4096 &&
    typeof value.extractorSet === 'string' &&
    SHA256_HEX.test(value.extractorSet) &&
    typeof value.resultDigest === 'string' &&
    SHA256_DIGEST.test(value.resultDigest) &&
    typeof value.resultSize === 'number' &&
    Number.isSafeInteger(value.resultSize) &&
    value.resultSize > 0 &&
    typeof value.semanticDigest === 'string' &&
    SHA256_DIGEST.test(value.semanticDigest) &&
    typeof value.sourceCommit === 'string' &&
    COMMIT.test(value.sourceCommit)
  );
}

function validCandidate(value: unknown): value is GraphShareSignedCandidateV1 {
  if (!isRecord(value)) return false;
  const {
    graphAbi,
    partialCoverage,
    platform,
    queuedAtMilliseconds,
    releaseIdentity,
    resourceLimits,
    snapshotId,
    ...pending
  } = value;
  return (
    validPending(pending) &&
    Object.keys(value).length === 15 &&
    typeof graphAbi === 'string' &&
    SHA256_HEX.test(graphAbi) &&
    typeof partialCoverage === 'boolean' &&
    validPlatform(platform) &&
    typeof queuedAtMilliseconds === 'number' &&
    Number.isSafeInteger(queuedAtMilliseconds) &&
    queuedAtMilliseconds >= 0 &&
    typeof releaseIdentity === 'string' &&
    RELEASE.test(releaseIdentity) &&
    Array.isArray(resourceLimits) &&
    resourceLimits.length === 0 &&
    typeof snapshotId === 'string' &&
    SNAPSHOT.test(snapshotId)
  );
}

function validPlatform(value: unknown): value is GraphShareSignedCandidateV1['platform'] {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(',') === 'architecture,os' &&
    (value.os === 'darwin' || value.os === 'linux' || value.os === 'win32') &&
    (value.architecture === 'arm64' || value.architecture === 'x64')
  );
}

function pendingIdentity(value: GraphSharePendingSignedCandidate): string {
  return JSON.stringify([value.actionKey, value.resultDigest, value.sourceCommit, value.semanticDigest]);
}

function candidateIdentity(value: GraphShareSignedCandidateV1): string {
  return JSON.stringify([
    pendingIdentity(value),
    value.casRoot,
    value.graphAbi,
    value.releaseIdentity,
    value.partialCoverage,
    value.snapshotId,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
