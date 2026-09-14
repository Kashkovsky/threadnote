import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../../crypto/sha256.js';
import {readBoundedPrivateBytes, writeDurablePrivateJsonFile} from './atomic.js';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import type {GraphControlPolicy} from './control_authorization.js';
import {sha256Digest, SHA256_DIGEST} from './digest.js';
import {graphSharingUnavailable} from './errors.js';
import {
  GRAPH_WORKER_ADMISSION_MAX_RECEIPTS,
  GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES,
  mergeGraphWorkerAdmissionReceipts,
  parseGraphWorkerAdmissionReceiptPage,
  type GraphWorkerAdmissionReceiptV2,
} from './worker_admission_state.js';

export const GRAPH_WORKER_ADMISSION_ARCHIVE_MAX_RECEIPTS = 32_768;
export const GRAPH_WORKER_ADMISSION_ARCHIVE_MAX_BYTES = 128 * 1_024 * 1_024;
const MAX_SEGMENTS = 8_192;
const MAX_MANIFEST_BYTES = 16 * 1_024 * 1_024;
const MAX_SEGMENT_BYTES = GRAPH_WORKER_ADMISSION_MAX_STATE_BYTES + 4_096;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HEX = /^[0-9a-f]{64}$/u;
const SEGMENT_FILE = /^[0-9a-f]{64}\.json$/u;
const SEGMENT_TEMP_FILE = /^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/u;

interface Segment {
  readonly bytes: number;
  readonly count: number;
  readonly digest: string;
  readonly receipts: readonly ReceiptSummary[];
  readonly sourceCommit: string;
}

export interface ReceiptSummary {
  readonly actionKey: string;
  readonly announcementDigest: string;
  readonly graphAbi: string;
  readonly operationId: string;
  readonly receiptDigest: string;
  readonly semanticDigest: string;
}

interface Manifest {
  readonly contentDigest: string;
  readonly schemaVersion: 1;
  readonly scopeDigest: string;
  readonly segments: readonly Segment[];
}

export interface GraphWorkerAdmissionArchive {
  readonly manifest: Manifest;
  readonly receipts: readonly GraphWorkerAdmissionReceiptV2[];
  readonly verifiedSegments: ReadonlySet<string>;
}

export type GraphWorkerAdmissionArchiveSelection =
  | {readonly kind: 'all' | 'index'}
  | {readonly kind: 'operation'; readonly operationId: string}
  | {readonly kind: 'source'; readonly sourceCommit: string}
  | {readonly kind: 'sources'; readonly sourceCommits: ReadonlySet<string>};

const manifestPath = (hotPath: string) => `${hotPath}.archive.json`;
const segmentDirectory = (hotPath: string) => `${hotPath}.archive.d`;

export function graphWorkerAdmissionArchivePaths(hotPath: string) {
  return {manifest: manifestPath(hotPath), segments: segmentDirectory(hotPath)};
}

function scopeDigest(policy: GraphControlPolicy) {
  return sha256Digest(
    canonicalJson([
      policy.issuer,
      policy.audience,
      policy.jwksUrl,
      policy.organization,
      policy.repositoryId,
      policy.profileDigest,
    ]),
  );
}

function emptyManifest(policy: GraphControlPolicy): Manifest {
  return makeManifest(scopeDigest(policy), []);
}

function makeManifest(scope: string, segments: readonly Segment[]): Manifest {
  const content = {schemaVersion: 1 as const, scopeDigest: scope, segments};
  return {...content, contentDigest: sha256Digest(canonicalJson(content))};
}

export function graphWorkerAdmissionReceiptSummary(receipt: GraphWorkerAdmissionReceiptV2): ReceiptSummary {
  return {
    actionKey: receipt.announcement.body.actionKey,
    announcementDigest: receipt.announcementDigest,
    graphAbi: receipt.graphAbi,
    operationId: receipt.announcement.body.idempotencyKey,
    receiptDigest: sha256Digest(canonicalJson(receipt)),
    semanticDigest: receipt.announcement.body.semanticDigest,
  };
}

export function graphWorkerAdmissionArchiveSummaries(manifest: Manifest) {
  return manifest.segments.flatMap(segment =>
    segment.receipts.map(receipt => ({...receipt, sourceCommit: segment.sourceCommit})),
  );
}

function validManifest(value: unknown, policy: GraphControlPolicy): value is Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'contentDigest,schemaVersion,scopeDigest,segments' ||
    record.schemaVersion !== 1 ||
    record.scopeDigest !== scopeDigest(policy) ||
    !Array.isArray(record.segments) ||
    record.segments.length > MAX_SEGMENTS ||
    record.contentDigest !==
      sha256Digest(
        canonicalJson({
          schemaVersion: record.schemaVersion,
          scopeDigest: record.scopeDigest,
          segments: record.segments,
        }),
      )
  )
    return false;
  let count = 0;
  let bytes = 0;
  const digests = new Set<string>();
  const operations = new Set<string>();
  for (const candidate of record.segments) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const segment = candidate as Record<string, unknown>;
    if (
      Object.keys(segment).sort().join(',') !== 'bytes,count,digest,receipts,sourceCommit' ||
      typeof segment.digest !== 'string' ||
      !HEX.test(segment.digest) ||
      digests.has(segment.digest) ||
      typeof segment.sourceCommit !== 'string' ||
      !OID.test(segment.sourceCommit) ||
      typeof segment.count !== 'number' ||
      !Number.isSafeInteger(segment.count) ||
      segment.count < 1 ||
      segment.count > GRAPH_WORKER_ADMISSION_MAX_RECEIPTS ||
      typeof segment.bytes !== 'number' ||
      !Number.isSafeInteger(segment.bytes) ||
      segment.bytes < 1 ||
      segment.bytes > MAX_SEGMENT_BYTES ||
      !Array.isArray(segment.receipts) ||
      segment.receipts.length !== segment.count
    )
      return false;
    for (const candidateReceipt of segment.receipts) {
      if (typeof candidateReceipt !== 'object' || candidateReceipt === null || Array.isArray(candidateReceipt))
        return false;
      const summary = candidateReceipt as Record<string, unknown>;
      if (
        Object.keys(summary).sort().join(',') !==
          'actionKey,announcementDigest,graphAbi,operationId,receiptDigest,semanticDigest' ||
        typeof summary.operationId !== 'string' ||
        !SHA256_DIGEST.test(summary.operationId) ||
        operations.has(summary.operationId) ||
        typeof summary.receiptDigest !== 'string' ||
        !SHA256_DIGEST.test(summary.receiptDigest) ||
        typeof summary.actionKey !== 'string' ||
        !HEX.test(summary.actionKey) ||
        typeof summary.announcementDigest !== 'string' ||
        !SHA256_DIGEST.test(summary.announcementDigest) ||
        typeof summary.graphAbi !== 'string' ||
        !HEX.test(summary.graphAbi) ||
        typeof summary.semanticDigest !== 'string' ||
        !SHA256_DIGEST.test(summary.semanticDigest)
      )
        return false;
      operations.add(summary.operationId);
    }
    digests.add(segment.digest);
    count += segment.count;
    bytes += segment.bytes;
  }
  return count <= GRAPH_WORKER_ADMISSION_ARCHIVE_MAX_RECEIPTS && bytes <= GRAPH_WORKER_ADMISSION_ARCHIVE_MAX_BYTES;
}

export const readGraphWorkerAdmissionArchive = Effect.fn('codeGraph.sharing.readWorkerAdmissionArchive')(function* (
  hotPath: string,
  policy: GraphControlPolicy,
  selection: GraphWorkerAdmissionArchiveSelection = {kind: 'all'},
  archiveRequired = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestFile = manifestPath(hotPath);
  const directory = segmentDirectory(hotPath);
  if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
    return yield* graphSharingUnavailable('Graph worker admission archive directory is invalid.');
  if (!(yield* fs.exists(manifestFile))) {
    if (archiveRequired) return yield* graphSharingUnavailable('Graph worker admission archive manifest is missing.');
    if ((yield* fs.exists(directory)) && (yield* fs.readDirectory(directory)).length > 0)
      return yield* graphSharingUnavailable('Graph worker admission archive manifest is missing.');
    const empty: GraphWorkerAdmissionArchive = {
      manifest: emptyManifest(policy),
      receipts: [],
      verifiedSegments: new Set(),
    };
    return empty;
  }
  const bytes = yield* readBoundedPrivateBytes(manifestFile, MAX_MANIFEST_BYTES).pipe(
    Effect.mapError(() => graphSharingUnavailable('Graph worker admission archive manifest is unavailable.')),
  );
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown,
    catch: () => graphSharingUnavailable('Graph worker admission archive manifest is invalid.'),
  });
  if (!validManifest(value, policy))
    return yield* graphSharingUnavailable('Graph worker admission archive manifest is invalid.');
  yield* Effect.forEach(
    value.segments,
    segment =>
      Effect.gen(function* () {
        const target = path.join(directory, `${segment.digest}.json`);
        if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option)))
          return yield* graphSharingUnavailable('Graph worker admission archive segment is invalid.');
        const info = yield* fs
          .stat(target)
          .pipe(
            Effect.mapError(() => graphSharingUnavailable('Graph worker admission archive segment is unavailable.')),
          );
        if (info.type !== 'File' || Number(info.size) !== segment.bytes)
          return yield* graphSharingUnavailable('Graph worker admission archive segment is invalid.');
      }),
    {concurrency: 16, discard: true},
  );
  const receipts: GraphWorkerAdmissionReceiptV2[] = [];
  const verifiedSegments = new Set<string>();
  for (const segment of value.segments) {
    if (
      selection.kind === 'index' ||
      (selection.kind === 'source' && segment.sourceCommit !== selection.sourceCommit) ||
      (selection.kind === 'sources' && !selection.sourceCommits.has(segment.sourceCommit)) ||
      (selection.kind === 'operation' &&
        !segment.receipts.some(receipt => receipt.operationId === selection.operationId))
    )
      continue;
    const segmentFile = path.join(directory, `${segment.digest}.json`);
    const content = yield* readBoundedPrivateBytes(segmentFile, MAX_SEGMENT_BYTES).pipe(
      Effect.mapError(() => graphSharingUnavailable('Graph worker admission archive segment is unavailable.')),
    );
    if (content.byteLength !== segment.bytes || sha256HexSync(content) !== segment.digest)
      return yield* graphSharingUnavailable('Graph worker admission archive segment is invalid.');
    verifiedSegments.add(segment.digest);
    const page = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(content)) as unknown,
      catch: () => graphSharingUnavailable('Graph worker admission archive segment is invalid.'),
    });
    if (typeof page !== 'object' || page === null || Array.isArray(page))
      return yield* graphSharingUnavailable('Graph worker admission archive segment is invalid.');
    const record = page as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'receipts,schemaVersion,sourceCommit' ||
      record.schemaVersion !== 1 ||
      record.sourceCommit !== segment.sourceCommit
    )
      return yield* graphSharingUnavailable('Graph worker admission archive segment is invalid.');
    const parsed = yield* Effect.try({
      try: () => parseGraphWorkerAdmissionReceiptPage(record.receipts),
      catch: () => graphSharingUnavailable('Graph worker admission archive receipts are invalid.'),
    });
    if (
      parsed.length !== segment.count ||
      parsed.some(
        (receipt, index) =>
          canonicalJson(graphWorkerAdmissionReceiptSummary(receipt)) !== canonicalJson(segment.receipts[index]),
      ) ||
      parsed.some(
        receipt =>
          receipt.sourceCommit !== segment.sourceCommit ||
          receipt.announcement.body.repositoryId !== policy.repositoryId ||
          receipt.announcement.body.profileDigest !== policy.profileDigest,
      )
    )
      return yield* graphSharingUnavailable('Graph worker admission archive scope is invalid.');
    receipts.push(...parsed);
  }
  yield* Effect.try({
    try: () => {
      if (mergeGraphWorkerAdmissionReceipts([], receipts).receipts.length !== receipts.length)
        throw new Error('Duplicate archive receipts.');
    },
    catch: () => graphSharingUnavailable('Graph worker admission archive receipts conflict.'),
  });
  const archive: GraphWorkerAdmissionArchive = {manifest: value, receipts, verifiedSegments};
  return archive;
});

export const parkGraphWorkerAdmissionReceipts = Effect.fn('codeGraph.sharing.parkWorkerAdmissions')(function* (
  hotPath: string,
  policy: GraphControlPolicy,
  archive: GraphWorkerAdmissionArchive,
  sourceCommit: string,
  receipts: readonly GraphWorkerAdmissionReceiptV2[],
) {
  if (receipts.length === 0 || receipts.some(receipt => receipt.sourceCommit !== sourceCommit))
    return yield* graphSharingUnavailable('Graph worker admission parking source is invalid.');
  const summaries = graphWorkerAdmissionArchiveSummaries(archive.manifest);
  const existing = new Set(summaries.map(receipt => receipt.operationId));
  if (receipts.some(receipt => existing.has(receipt.announcement.body.idempotencyKey))) {
    const prior = yield* readGraphWorkerAdmissionArchive(hotPath, policy, {kind: 'source', sourceCommit});
    const byOperation = new Map(
      prior.receipts.map(receipt => [receipt.announcement.body.idempotencyKey, receipt] as const),
    );
    if (
      receipts.some(receipt => {
        const archived = byOperation.get(receipt.announcement.body.idempotencyKey);
        return (
          existing.has(receipt.announcement.body.idempotencyKey) &&
          (archived === undefined || canonicalJson(archived) !== canonicalJson(receipt))
        );
      })
    )
      return yield* graphSharingUnavailable('Graph worker admission copies conflict.');
  }
  const additions = receipts.filter(receipt => !existing.has(receipt.announcement.body.idempotencyKey));
  if (additions.length === 0) return {status: 'parked' as const, archive};
  const segmentValue = {receipts: additions, schemaVersion: 1, sourceCommit};
  const bytes = new TextEncoder().encode(`${JSON.stringify(segmentValue)}\n`);
  const segment: Segment = {
    bytes: bytes.byteLength,
    count: additions.length,
    digest: sha256HexSync(bytes),
    receipts: additions.map(graphWorkerAdmissionReceiptSummary),
    sourceCommit,
  };
  const next = makeManifest(archive.manifest.scopeDigest, [...archive.manifest.segments, segment]);
  if (bytes.byteLength > MAX_SEGMENT_BYTES || !validManifest(next, policy))
    return {status: 'capacity-exceeded' as const};
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(next)}\n`);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) return {status: 'capacity-exceeded' as const};
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(segmentDirectory(hotPath), `${segment.digest}.json`);
  const manifestFile = manifestPath(hotPath);
  if (!(yield* fs.exists(manifestFile))) yield* writeDurablePrivateJsonFile(manifestFile, archive.manifest);
  yield* removeOrphanSegments(hotPath, archive.manifest);
  if (yield* fs.exists(target)) {
    const prior = yield* readBoundedPrivateBytes(target, MAX_SEGMENT_BYTES);
    if (sha256HexSync(prior) !== segment.digest)
      return yield* graphSharingUnavailable('Graph worker admission archive segment is invalid.');
  } else yield* writeDurablePrivateJsonFile(target, segmentValue);
  yield* writeDurablePrivateJsonFile(manifestFile, next);
  return {
    status: 'parked' as const,
    archive: {
      manifest: next,
      receipts: [...archive.receipts, ...additions],
      verifiedSegments: new Set([...archive.verifiedSegments, segment.digest]),
    },
  };
});

const removeOrphanSegments = Effect.fn('codeGraph.sharing.removeWorkerAdmissionArchiveOrphans')(function* (
  hotPath: string,
  manifest: Manifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = segmentDirectory(hotPath);
  if (!(yield* fs.exists(directory))) return;
  const names = yield* fs.readDirectory(directory);
  if (names.length > MAX_SEGMENTS * 2)
    return yield* graphSharingUnavailable('Graph worker admission archive directory is over capacity.');
  const active = new Set(manifest.segments.map(segment => `${segment.digest}.json`));
  for (const name of names) {
    if (active.has(name)) continue;
    if (!(SEGMENT_FILE.test(name) || SEGMENT_TEMP_FILE.test(name)))
      return yield* graphSharingUnavailable('Graph worker admission archive directory is invalid.');
    yield* fs
      .remove(path.join(directory, name), {force: true})
      .pipe(Effect.mapError(() => graphSharingUnavailable('Graph worker admission archive could not reclaim space.')));
  }
});

export const retireGraphWorkerAdmissionArchive = Effect.fn('codeGraph.sharing.retireWorkerAdmissionArchive')(function* (
  hotPath: string,
  archive: GraphWorkerAdmissionArchive,
  covered: ReadonlySet<string>,
) {
  const removed = archive.manifest.segments.filter(segment => covered.has(segment.sourceCommit));
  if (removed.length === 0) return {retired: 0};
  if (removed.some(segment => !archive.verifiedSegments.has(segment.digest)))
    return yield* graphSharingUnavailable('Graph worker admission archive retirement is unverified.');
  const next = makeManifest(
    archive.manifest.scopeDigest,
    archive.manifest.segments.filter(segment => !covered.has(segment.sourceCommit)),
  );
  yield* writeDurablePrivateJsonFile(manifestPath(hotPath), next);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const segment of removed)
    yield* fs.remove(path.join(segmentDirectory(hotPath), `${segment.digest}.json`), {force: true}).pipe(Effect.ignore);
  return {retired: removed.reduce((total, segment) => total + segment.count, 0)};
});
