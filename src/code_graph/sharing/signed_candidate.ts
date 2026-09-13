import {Clock, Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {codeGraphCheckpointAbiInputV1} from '../checkpoint/compatibility.js';
import {codeGraphCheckpointAbiDigestV1} from '../checkpoint/pack.js';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {codeGraphCommittedContentHash} from '../content_identity.js';
import type {CodeGraphStoreShape} from '../store_shape.js';
import type {CodeGraphInventoryFile, CodeGraphSnapshot} from '../types.js';
import {graphShareParseActionKey} from './action.js';
import {readBoundedPrivateBytes, writePrivateJsonFile} from './atomic.js';
import {readVerifiedCasBlobBounded} from './cas.js';
import {
  GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS,
  GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS,
  GRAPH_SHARE_QUEUE_MAXIMUM_BYTES,
} from './contribution.js';
import {SHA256_DIGEST, SHA256_HEX} from './digest.js';
import {graphSharingFailure} from './errors.js';
import {graphSharingLayout} from './layout.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from './oci.js';
import {parseGraphShareParseResult, type GraphShareParseResultV1} from './parse_result.js';
import {lookupGraphShareTrustReceipt} from './trust.js';
import {resolveGraphShareRepositoryClient} from './client_state.js';

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BATCH = /^[0-9a-f]{40}$/u;
const SNAPSHOT = /^cgsn_[0-9a-f]{40}(?:-[a-z0-9]+)*$/u;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_METADATA_READ_BYTES = 4 * 1_024 * 1_024;
const SNAPSHOT_PATH_BATCH = 200;

/** Written before the corresponding raw parser facts become reusable in SQLite. */
export interface GraphSharePendingSignedCandidate {
  readonly actionKey: string;
  readonly batchId: string;
  readonly casRoot: string;
  readonly extractorSet: string;
  readonly organization: string;
  readonly platform: {readonly os: 'darwin' | 'linux' | 'win32'; readonly architecture: 'arm64' | 'x64'};
  readonly profileDigest: string;
  readonly queuedAtMilliseconds: number;
  readonly releaseIdentity: string;
  readonly resultDigest: string;
  readonly resultSize: number;
  readonly semanticDigest: string;
  readonly sourceCommit: string;
}

/** Private producer evidence; sending still requires current authority and a fresh CAS check. */
export interface GraphShareSignedCandidateV2 extends GraphSharePendingSignedCandidate {
  readonly graphAbi: string;
  readonly partialCoverage: boolean;
  readonly resourceLimits: readonly string[];
  readonly snapshotId: string;
}

export interface GraphSharePendingSignedCandidateQueueV1 {
  readonly candidates: readonly GraphSharePendingSignedCandidate[];
  readonly schemaVersion: 1;
}

export interface GraphShareSignedCandidateQueueV2 {
  readonly candidates: readonly GraphShareSignedCandidateV2[];
  readonly schemaVersion: 2;
}

/** The caller must run this before cacheFacts, and must propagate a persistence failure. */
export const persistGraphSharePendingSignedCandidates = Effect.fn('codeGraph.sharing.persistPendingSignedCandidates')(
  function* (input: {
    readonly candidates: readonly GraphSharePendingSignedCandidate[];
    readonly repositoryId: string;
    readonly threadnoteHome: string;
  }) {
    if (input.candidates.length === 0) return {queued: 0};
    if (!SHA256_HEX.test(input.repositoryId) || input.candidates.some(candidate => !validPending(candidate)))
      return yield* graphSharingFailure('Pending signed candidate evidence is invalid.');
    const now = yield* Clock.currentTimeMillis;
    return yield* mutatePrivateQueue(
      pendingCandidateQueuePath,
      input.threadnoteHome,
      input.repositoryId,
      (current: GraphSharePendingSignedCandidateQueueV1) => {
        const next = appendGraphSharePendingSignedCandidates(current, input.candidates, now);
        const previousIds = new Set(
          pruneGraphSharePendingSignedCandidateQueue(current, now).candidates.map(pendingIdentity),
        );
        return {
          next,
          result: {queued: next.candidates.filter(candidate => !previousIds.has(pendingIdentity(candidate))).length},
        };
      },
      parseGraphSharePendingSignedCandidateQueue,
      {candidates: [], schemaVersion: 1},
    );
  },
);

/** Replays durable pending work after any clean ready result, even when this attempt parsed no files. */
export const finalizeGraphShareSignedCandidates = Effect.fn('codeGraph.sharing.finalizeSignedCandidates')(
  function* (input: {
    readonly databasePath: string;
    readonly repositoryId: string;
    readonly skippedFiles: number;
    readonly snapshot: CodeGraphSnapshot;
    readonly store: CodeGraphStoreShape;
    readonly threadnoteHome: string;
  }) {
    const snapshot = input.snapshot;
    if (
      snapshot.state !== 'ready' ||
      snapshot.dirty ||
      snapshot.repositoryId !== input.repositoryId ||
      !SHA256_HEX.test(input.repositoryId) ||
      !Number.isSafeInteger(input.skippedFiles) ||
      input.skippedFiles < 0
    )
      return {examined: 0, queued: 0, verified: 0};
    const pending = yield* readPrivateQueue(
      pendingCandidateQueuePath,
      input.threadnoteHome,
      input.repositoryId,
      parseGraphSharePendingSignedCandidateQueue,
      {candidates: [], schemaVersion: 1},
    );
    if (pending.candidates.length === 0) return {examined: 0, queued: 0, verified: 0};
    const provenance = yield* input.store.snapshotPackProvenance(input.databasePath, snapshot.id);
    if (provenance === undefined) return {examined: pending.candidates.length, queued: 0, verified: 0};
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.repositoryId);
    if (trust?.accessMode !== 'join') return {examined: pending.candidates.length, queued: 0, verified: 0};
    const state = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, trust);
    if (state.contributionMode === 'off') return {examined: pending.candidates.length, queued: 0, verified: 0};
    const graphAbi = codeGraphCheckpointAbiDigestV1(codeGraphCheckpointAbiInputV1(provenance)).digest;
    const cacheIdentities = new Set(provenance.map(pack => pack.cacheIdentity));
    const relevant = pending.candidates.filter(
      candidate =>
        candidate.sourceCommit === snapshot.commit &&
        candidate.batchId === candidate.sourceCommit.slice(0, 40) &&
        candidate.profileDigest === trust.profileDigest &&
        candidate.organization === trust.organization &&
        candidate.casRoot === state.casRoot &&
        cacheIdentities.has(candidate.extractorSet),
    );
    if (relevant.length === 0) return {examined: pending.candidates.length, queued: 0, verified: 0};
    // Parse results, not pending metadata, supply paths. First verify CAS, then batch exact snapshot observations.
    const parsed: Array<{
      readonly candidate: GraphSharePendingSignedCandidate;
      readonly result: GraphShareParseResultV1;
    }> = [];
    for (const candidate of relevant) {
      const result = yield* verifyPendingCasResult(candidate, input.repositoryId).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (result !== undefined) parsed.push({candidate, result});
    }
    if (parsed.length === 0) return {examined: pending.candidates.length, queued: 0, verified: 0};
    const uniquePaths = [...new Set(parsed.map(item => item.result.normalizedPath))];
    const snapshotFiles = new Map<string, CodeGraphInventoryFile>();
    for (let offset = 0; offset < uniquePaths.length; offset += SNAPSHOT_PATH_BATCH) {
      const observed = yield* input.store.effectiveSnapshotFilesByPaths(
        input.databasePath,
        snapshot.id,
        uniquePaths.slice(offset, offset + SNAPSHOT_PATH_BATCH),
      );
      for (const item of observed) if (item.file !== undefined) snapshotFiles.set(item.path, item.file);
    }
    const verified: GraphShareSignedCandidateV2[] = [];
    for (const {candidate, result} of parsed) {
      const file = snapshotFiles.get(result.normalizedPath);
      const objectFormat =
        result.gitBlobId.length === 40 ? 'sha1' : result.gitBlobId.length === 64 ? 'sha256' : undefined;
      if (
        !file ||
        file.source !== 'commit' ||
        objectFormat === undefined ||
        file.contentHash !== result.contentHash ||
        file.contentHash !== codeGraphCommittedContentHash(objectFormat, result.gitBlobId)
      )
        continue;
      const cached = yield* input.store
        .loadCachedFacts(input.databasePath, [file], candidate.extractorSet)
        .pipe(Effect.orElseSucceed(() => undefined));
      const cachedFacts = cached?.facts.get(file.path);
      if (cachedFacts === undefined || canonicalJson(cachedFacts) !== canonicalJson(result.facts)) continue;
      verified.push({
        ...candidate,
        graphAbi,
        partialCoverage: input.skippedFiles > 0,
        resourceLimits: [],
        snapshotId: snapshot.id,
      });
    }
    if (verified.length === 0) return {examined: pending.candidates.length, queued: 0, verified: 0};
    const now = yield* Clock.currentTimeMillis;
    const retained = yield* mutatePrivateQueue(
      signedCandidateQueuePath,
      input.threadnoteHome,
      input.repositoryId,
      (current: GraphShareSignedCandidateQueueV2) => {
        const next = appendGraphShareSignedCandidates(current, verified, now);
        const previousIds = new Set(
          pruneGraphShareSignedCandidateQueue(current, now).candidates.map(candidateIdentity),
        );
        return {
          next,
          result: {
            queued: next.candidates.filter(candidate => !previousIds.has(candidateIdentity(candidate))).length,
            retained: new Set(next.candidates.map(candidateIdentity)),
          },
        };
      },
      parseGraphShareSignedCandidateQueue,
      {candidates: [], schemaVersion: 2},
    );
    const acknowledged = new Set(
      verified.filter(candidate => retained.retained.has(candidateIdentity(candidate))).map(pendingIdentity),
    );
    if (acknowledged.size > 0)
      yield* mutatePrivateQueue(
        pendingCandidateQueuePath,
        input.threadnoteHome,
        input.repositoryId,
        (current: GraphSharePendingSignedCandidateQueueV1) => ({
          next: {
            candidates: current.candidates.filter(candidate => !acknowledged.has(pendingIdentity(candidate))),
            schemaVersion: 1 as const,
          },
          result: undefined,
        }),
        parseGraphSharePendingSignedCandidateQueue,
        {candidates: [], schemaVersion: 1},
      );
    return {examined: pending.candidates.length, queued: retained.queued, verified: verified.length};
  },
);

const verifyPendingCasResult = Effect.fn('codeGraph.sharing.verifyPendingCasResult')(function* (
  candidate: GraphSharePendingSignedCandidate,
  repositoryId: string,
) {
  const bytes = yield* readVerifiedCasBlobBounded(candidate.casRoot, candidate.resultDigest, candidate.resultSize);
  if (bytes.byteLength !== candidate.resultSize || bytes.byteLength > GRAPH_SHARE_HTTP_CAS_MAX_BYTES)
    return yield* graphSharingFailure('Pending signed result CAS size is invalid.');
  const result = yield* Effect.try({
    try: () => parseGraphShareParseResult(JSON.parse(new TextDecoder().decode(bytes))),
    catch: () => graphSharingFailure('Pending signed result CAS is invalid.'),
  });
  if (
    new TextDecoder().decode(bytes) !== canonicalJson(result) ||
    result.repositoryId !== repositoryId ||
    result.actionKey !== candidate.actionKey ||
    result.extractorSet !== candidate.extractorSet ||
    result.semanticDigest !== candidate.semanticDigest ||
    graphShareParseActionKey({
      contentHash: result.contentHash,
      extractorSet: result.extractorSet,
      languageAndRole: result.languageAndRole,
      normalizedPath: result.normalizedPath,
      repositoryId,
    }) !== result.actionKey
  )
    return yield* graphSharingFailure('Pending signed result does not match producer identity.');
  return result;
});

export function pendingCandidateQueuePath(path: Path.Path, home: string, repositoryId: string): string {
  return path.join(graphSharingLayout(path, home).root, 'signed-pending', `${repositoryId}.json`);
}

export function signedCandidateQueuePath(path: Path.Path, home: string, repositoryId: string): string {
  return path.join(graphSharingLayout(path, home).root, 'signed-candidates', `${repositoryId}.json`);
}

export function appendGraphSharePendingSignedCandidates(
  queue: GraphSharePendingSignedCandidateQueueV1,
  additions: readonly GraphSharePendingSignedCandidate[],
  now: number,
): GraphSharePendingSignedCandidateQueueV1 {
  const retained = pruneGraphSharePendingSignedCandidateQueue(queue, now).candidates;
  const seen = new Set(retained.map(pendingIdentity));
  const candidates = [...retained];
  for (const candidate of additions) {
    if (!validPending(candidate) || seen.has(pendingIdentity(candidate))) continue;
    seen.add(pendingIdentity(candidate));
    candidates.push({...candidate, platform: {...candidate.platform}});
  }
  return pruneGraphSharePendingSignedCandidateQueue({candidates, schemaVersion: 1}, now);
}

export function appendGraphShareSignedCandidates(
  queue: GraphShareSignedCandidateQueueV2,
  additions: readonly GraphShareSignedCandidateV2[],
  now: number,
): GraphShareSignedCandidateQueueV2 {
  const retained = pruneGraphShareSignedCandidateQueue(queue, now).candidates;
  const seen = new Set(retained.map(candidateIdentity));
  const candidates = [...retained];
  for (const candidate of additions) {
    if (!validCandidate(candidate) || seen.has(candidateIdentity(candidate))) continue;
    seen.add(candidateIdentity(candidate));
    candidates.push({...candidate, platform: {...candidate.platform}, resourceLimits: []});
  }
  return pruneGraphShareSignedCandidateQueue({candidates, schemaVersion: 2}, now);
}

export function pruneGraphSharePendingSignedCandidateQueue(
  queue: GraphSharePendingSignedCandidateQueueV1,
  now: number,
): GraphSharePendingSignedCandidateQueueV1 {
  return pruneQueue(queue, now);
}

export function pruneGraphShareSignedCandidateQueue(
  queue: GraphShareSignedCandidateQueueV2,
  now: number,
): GraphShareSignedCandidateQueueV2 {
  return pruneQueue(queue, now);
}

function pruneQueue<T extends {readonly queuedAtMilliseconds: number}, V extends 1 | 2>(
  queue: {readonly candidates: readonly T[]; readonly schemaVersion: V},
  now: number,
): {readonly candidates: readonly T[]; readonly schemaVersion: V} {
  let candidates = queue.candidates
    .map(item => ({...item, queuedAtMilliseconds: Math.min(now, item.queuedAtMilliseconds)}))
    .filter(item => item.queuedAtMilliseconds >= now - GRAPH_SHARE_QUEUE_MAXIMUM_AGE_MILLISECONDS)
    .slice(-GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS);
  let result = {...queue, candidates};
  while (
    candidates.length > 0 &&
    new TextEncoder().encode(JSON.stringify(result)).byteLength > GRAPH_SHARE_QUEUE_MAXIMUM_BYTES
  ) {
    candidates = candidates.slice(1);
    result = {...queue, candidates};
  }
  return result;
}

export function parseGraphSharePendingSignedCandidateQueue(value: unknown): GraphSharePendingSignedCandidateQueueV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS ||
    value.candidates.some(candidate => !validPending(candidate)) ||
    Object.keys(value).sort().join(',') !== 'candidates,schemaVersion'
  )
    throw graphSharingFailure('Pending signed candidate queue is invalid.');
  return value as unknown as GraphSharePendingSignedCandidateQueueV1;
}

export function parseGraphShareSignedCandidateQueue(value: unknown): GraphShareSignedCandidateQueueV2 {
  // The pre-release v1 private queue lacked producer profile authority and cannot be signed safely.
  // Treat it as empty so the first verified v2 append replaces it atomically.
  if (isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.candidates))
    return {candidates: [], schemaVersion: 2};
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > GRAPH_SHARE_QUEUE_MAXIMUM_ANNOUNCEMENTS ||
    value.candidates.some(candidate => !validCandidate(candidate)) ||
    Object.keys(value).sort().join(',') !== 'candidates,schemaVersion'
  )
    throw graphSharingFailure('Signed candidate queue is invalid.');
  return value as unknown as GraphShareSignedCandidateQueueV2;
}

function validPending(value: unknown): value is GraphSharePendingSignedCandidate {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(',') ===
      'actionKey,batchId,casRoot,extractorSet,organization,platform,profileDigest,queuedAtMilliseconds,releaseIdentity,resultDigest,resultSize,semanticDigest,sourceCommit' &&
    typeof value.actionKey === 'string' &&
    SHA256_HEX.test(value.actionKey) &&
    typeof value.batchId === 'string' &&
    BATCH.test(value.batchId) &&
    typeof value.casRoot === 'string' &&
    value.casRoot.length > 0 &&
    value.casRoot.length <= 4096 &&
    typeof value.extractorSet === 'string' &&
    SHA256_HEX.test(value.extractorSet) &&
    typeof value.organization === 'string' &&
    ORGANIZATION.test(value.organization) &&
    validPlatform(value.platform) &&
    typeof value.profileDigest === 'string' &&
    SHA256_DIGEST.test(value.profileDigest) &&
    typeof value.queuedAtMilliseconds === 'number' &&
    Number.isSafeInteger(value.queuedAtMilliseconds) &&
    value.queuedAtMilliseconds >= 0 &&
    typeof value.releaseIdentity === 'string' &&
    RELEASE.test(value.releaseIdentity) &&
    value.releaseIdentity !== 'unknown' &&
    typeof value.resultDigest === 'string' &&
    SHA256_DIGEST.test(value.resultDigest) &&
    typeof value.resultSize === 'number' &&
    Number.isSafeInteger(value.resultSize) &&
    value.resultSize > 0 &&
    value.resultSize <= GRAPH_SHARE_HTTP_CAS_MAX_BYTES &&
    typeof value.semanticDigest === 'string' &&
    SHA256_DIGEST.test(value.semanticDigest) &&
    typeof value.sourceCommit === 'string' &&
    COMMIT.test(value.sourceCommit) &&
    value.batchId === value.sourceCommit.slice(0, 40)
  );
}

function validCandidate(value: unknown): value is GraphShareSignedCandidateV2 {
  if (!isRecord(value)) return false;
  const {graphAbi, partialCoverage, resourceLimits, snapshotId, ...pending} = value;
  return (
    validPending(pending) &&
    Object.keys(value).length === 17 &&
    typeof graphAbi === 'string' &&
    SHA256_HEX.test(graphAbi) &&
    typeof partialCoverage === 'boolean' &&
    Array.isArray(resourceLimits) &&
    resourceLimits.length === 0 &&
    typeof snapshotId === 'string' &&
    SNAPSHOT.test(snapshotId)
  );
}

function validPlatform(value: unknown): value is GraphSharePendingSignedCandidate['platform'] {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(',') === 'architecture,os' &&
    (value.os === 'darwin' || value.os === 'linux' || value.os === 'win32') &&
    (value.architecture === 'arm64' || value.architecture === 'x64')
  );
}

function pendingIdentity(value: GraphSharePendingSignedCandidate): string {
  return JSON.stringify([
    value.actionKey,
    value.resultDigest,
    value.sourceCommit,
    value.semanticDigest,
    value.casRoot,
    value.profileDigest,
    value.organization,
    value.releaseIdentity,
  ]);
}

function candidateIdentity(value: GraphShareSignedCandidateV2): string {
  return JSON.stringify([pendingIdentity(value), value.graphAbi, value.partialCoverage, value.snapshotId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPrivateQueue<T>(
  locate: typeof pendingCandidateQueuePath,
  home: string,
  repositoryId: string,
  parse: (value: unknown) => T,
  empty: T,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = locate(path, home, repositoryId);
    if (!(yield* fs.exists(target))) return empty;
    const bytes = yield* readBoundedPrivateBytes(target, MAX_METADATA_READ_BYTES);
    return yield* Effect.try({
      try: () => parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))),
      catch: () => graphSharingFailure('Signed candidate metadata is invalid.'),
    });
  });
}

function mutatePrivateQueue<T extends {readonly candidates: readonly unknown[]}, A>(
  locate: typeof pendingCandidateQueuePath,
  home: string,
  repositoryId: string,
  update: (current: T) => {readonly next: T; readonly result: A},
  parse: (value: unknown) => T,
  empty: T,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = locate(path, home, repositoryId);
    yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
    return yield* withExclusiveFileLock(
      fs,
      `${target}.lock`,
      {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 30_000},
      Effect.gen(function* () {
        const current = yield* readPrivateQueue(locate, home, repositoryId, parse, empty);
        const {next, result} = update(current);
        if (JSON.stringify(next) !== JSON.stringify(current)) yield* writePrivateJsonFile(target, next);
        return result;
      }),
    );
  });
}
