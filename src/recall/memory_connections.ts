import {Clock, Effect} from 'effect';
import {
  MEMORY_RELATION_TYPES,
  isMemoryRelationType,
  type MemoryRecord,
  type MemoryRelationType,
} from '../memory/document.js';
import {memoryIdFromIdentityAlias} from '../memory/identity_alias.js';
import {parseResourceId, resourceIdIsManagedMemoryNamespace} from '../storage/resource-id.js';
import type {MemoryStatus} from '../types.js';
import {recallCandidateIsEligible, type RecallEligibilityPolicy} from './eligibility.js';
import {loadRecallIndexData, loadRecallMemoryLinks, recallUriMatchesScopes} from './index.js';
import type {RecallMemoryLinkMatch} from './memory_links.js';
import {recallMemoryContentHash, type RecallCandidate} from './rank.js';

export const MAX_RECALL_MEMORY_REFS = 8;
export const MAX_RECALL_MEMORY_CONNECTIONS = 8;

export type RecallMemoryPremiseState = 'conflicted' | 'current' | 'historical' | 'unresolved';
export type RecallMemoryConnectionDirection = 'incoming' | 'outgoing';
export type RecallMemoryConnectionResolution = 'conflicted' | 'resolved' | 'unresolved';

export interface RecallMemoryConnectionInput {
  readonly memoryRefs: readonly string[];
  readonly relationTypes?: readonly string[];
}

export interface ParsedRecallMemoryConnectionInput {
  readonly memoryRefs: readonly string[];
  readonly relationTypes?: readonly MemoryRelationType[];
}

export interface RecallMemoryPremiseEvidence {
  readonly activeSupersederCount?: number;
  readonly identityConflict?: boolean;
  readonly resolved: boolean;
  readonly status?: MemoryStatus;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface RecallMemoryPremiseReceiptV1 {
  readonly memoryId?: string;
  readonly requestedOrdinal: number;
  readonly requestedRef: string;
  readonly state: RecallMemoryPremiseState;
  readonly uri?: string;
}

export interface RecallMemoryConnectionReceiptV1 {
  readonly currentness: RecallMemoryPremiseState;
  readonly direction: RecallMemoryConnectionDirection;
  readonly distance: 1;
  readonly neighborMemoryId?: string;
  readonly neighborUri?: string;
  readonly origin: 'evidence' | 'references' | 'relation' | 'supersedes';
  readonly relationOrdinal: number;
  readonly relationType: MemoryRelationType;
  readonly requestedOrdinal: number;
  readonly resolution: RecallMemoryConnectionResolution;
  readonly sourceMemoryId?: string;
  readonly sourceUri?: string;
  readonly targetMemoryId?: string;
  readonly targetUri?: string;
}

export interface RecallMemoryConnectionCoverageV1 {
  readonly connectionCount: number;
  readonly premiseCount: number;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly truncatedSeedOrdinals?: readonly number[];
  readonly version: 1;
}

export interface RecallMemoryConnectionDiagnostics {
  readonly canonicalMismatches: number;
  readonly canonicalRereads: number;
  readonly rawLinkRows: number;
  readonly refreshRepairs: number;
  readonly truncatedSeedOrdinals: readonly number[];
}

export interface RecallMemoryConnectionsResult {
  readonly candidates: readonly RecallCandidate[];
  readonly connections: readonly RecallMemoryConnectionReceiptV1[];
  readonly coverage: RecallMemoryConnectionCoverageV1;
  readonly diagnostics: RecallMemoryConnectionDiagnostics;
  readonly premises: readonly RecallMemoryPremiseReceiptV1[];
}

export interface RetrieveRecallMemoryConnectionsInput<R> extends RecallMemoryConnectionInput {
  readonly allowedUriScopes: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeHistorical?: boolean;
  readonly limit?: number;
  readonly now?: Date;
  readonly readRecords: (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], unknown, R>;
}

interface RecallMemoryConnectionsConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

interface ResolvedConnection {
  readonly candidate?: RecallCandidate;
  readonly memoryId?: string;
  readonly receipt: RecallMemoryConnectionReceiptV1;
}

const CONNECTION_RECEIPT_LIMIT = 32;
const RELATION_PRIORITY: Readonly<Record<MemoryRelationType, number>> = {
  depends_on: 1,
  evidence_for: 0,
  references: 3,
  related_to: 4,
  supersedes: 2,
};

/**
 * Parse the explicit connection-recall controls before any index or filesystem
 * work. Identity aliases and canonical managed-memory URIs are the only valid
 * premise forms; arbitrary resources must not become graph traversal roots.
 */
export function parseRecallMemoryConnectionInput(
  input: RecallMemoryConnectionInput,
): ParsedRecallMemoryConnectionInput {
  const memoryRefs = uniqueStrings(input.memoryRefs, 'memory reference');
  if (memoryRefs.length === 0) throw new Error('Recall memory connections require at least one memory reference.');
  if (memoryRefs.length > MAX_RECALL_MEMORY_REFS) {
    throw new Error(`Recall memory connections accept at most ${MAX_RECALL_MEMORY_REFS} memory references.`);
  }
  for (const ref of memoryRefs) {
    let canonicalUri: string;
    try {
      canonicalUri = parseResourceId(ref).canonicalUri;
    } catch {
      throw new Error(`Invalid memory reference: ${ref}`);
    }
    if (memoryIdFromIdentityAlias(canonicalUri) === undefined && !resourceIdIsManagedMemoryNamespace(canonicalUri)) {
      throw new Error(`Recall memory reference must identify a managed memory: ${ref}`);
    }
  }

  const relationTypes = input.relationTypes
    ? uniqueStrings(input.relationTypes, 'memory relation type').map(value => {
        if (!isMemoryRelationType(value)) {
          throw new Error(
            `Unknown memory relation type "${value}". Expected one of: ${MEMORY_RELATION_TYPES.join(', ')}.`,
          );
        }
        return value;
      })
    : undefined;

  return {
    memoryRefs,
    ...(relationTypes && relationTypes.length > 0 ? {relationTypes: [...relationTypes].sort(compareCodeUnits)} : {}),
  };
}

/** Currentness is evidence-derived and deliberately independent of ranking freshness. */
export function classifyRecallMemoryPremiseState(
  evidence: RecallMemoryPremiseEvidence,
  now: Date,
): RecallMemoryPremiseState {
  if (!evidence.resolved) return 'unresolved';
  if (evidence.identityConflict || (evidence.activeSupersederCount ?? 0) > 1) return 'conflicted';
  if ((evidence.status ?? 'active') !== 'active') return 'historical';
  if (!dateWindowContains(now, evidence.validFrom, evidence.validTo)) return 'historical';
  if ((evidence.activeSupersederCount ?? 0) === 1) return 'historical';
  return 'current';
}

/**
 * Resolve explicit premises and their verified, authorized, direct neighbors.
 * The index is only a selector: canonical records decide identity, edge
 * existence, lifecycle, and whether a receipt may claim current authority.
 */
export const retrieveRecallMemoryConnections = Effect.fn('recall.retrieveMemoryConnections')(function* <R>(
  config: RecallMemoryConnectionsConfig,
  input: RetrieveRecallMemoryConnectionsInput<R>,
) {
  const parsed = parseRecallMemoryConnectionInput(input);
  if (input.allowedUriScopes.length === 0) {
    throw new Error('Recall memory connections require at least one authorized URI scope.');
  }
  const now = input.now ?? new Date(yield* Clock.currentTimeMillis);
  const limit = boundedConnectionResultLimit(input.limit);
  const requestedCanonicalUris = parsed.memoryRefs
    .map(ref => parseResourceId(ref).canonicalUri)
    .filter(ref => memoryIdFromIdentityAlias(ref) === undefined && recallUriMatchesScopes(ref, input.allowedUriScopes));
  const requestedRecords = yield* input.readRecords(requestedCanonicalUris);
  const requestedRecordByUri = new Map(
    requestedRecords.filter(record => authorizedRecord(record, input)).map(record => [record.uri, record] as const),
  );
  const requestedMemoryIds = parsed.memoryRefs.flatMap(ref => {
    const aliasId = memoryIdFromIdentityAlias(ref);
    if (aliasId) return [aliasId];
    const record = requestedRecordByUri.get(parseResourceId(ref).canonicalUri);
    return record?.metadata.memoryId ? [record.metadata.memoryId] : [];
  });
  const premiseIndex =
    requestedMemoryIds.length === 0
      ? undefined
      : yield* loadRecallIndexData(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          memoryIds: requestedMemoryIds,
          validateNow: true,
        });
  const premiseCandidatesById = groupCandidatesByMemoryId(premiseIndex?.candidates ?? []);
  const premiseCandidateUris = [...new Set((premiseIndex?.candidates ?? []).flatMap(candidateUrisForRead))];
  const premiseLiveRecords = premiseCandidateUris.length === 0 ? [] : yield* input.readRecords(premiseCandidateUris);
  const verifiedPremises = verifyLiveRecallCandidates(premiseIndex?.candidates ?? [], premiseLiveRecords, input);
  const premiseSeeds = parsed.memoryRefs.flatMap((ref, requestedOrdinal) => {
    const requestedUri = parseResourceId(ref).canonicalUri;
    const memoryId =
      memoryIdFromIdentityAlias(requestedUri) ?? requestedRecordByUri.get(requestedUri)?.metadata.memoryId;
    return memoryId && verifiedPremises.liveCandidateById.has(memoryId) && !verifiedPremises.conflictIds.has(memoryId)
      ? [{memoryId, requestedOrdinal}]
      : [];
  });

  let canonicalMismatches = 0;
  let canonicalRereads = requestedCanonicalUris.length + premiseCandidateUris.length;
  let rawLinkRows = 0;
  let refreshRepairs = 0;
  let truncatedSeedOrdinals: readonly number[] = [];
  const rawLinks =
    premiseSeeds.length === 0
      ? []
      : yield* loadRecallMemoryLinks(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          limit: 64,
          memorySeeds: premiseSeeds,
          onCanonicalMismatch: count => {
            canonicalMismatches += count;
          },
          onCanonicalReread: count => {
            canonicalRereads += count;
          },
          onRawRows: count => {
            rawLinkRows += count;
          },
          onRefreshRepair: () => {
            refreshRepairs += 1;
          },
          onSearchTruncated: ordinals => {
            truncatedSeedOrdinals = [...new Set([...truncatedSeedOrdinals, ...ordinals])].sort((a, b) => a - b);
          },
          relationTypes: parsed.relationTypes,
        });
  const linkedMemoryIds = rawLinks.flatMap(link => [link.sourceMemoryId, link.targetMemoryId].filter(isString));
  const allMemoryIds = [...new Set([...requestedMemoryIds, ...linkedMemoryIds])];
  const index =
    allMemoryIds.length === 0
      ? undefined
      : yield* loadRecallIndexData(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          memoryIds: allMemoryIds,
          validateNow: true,
        });
  const candidateUris = [...new Set((index?.candidates ?? []).flatMap(candidateUrisForRead))];
  canonicalRereads += candidateUris.length;
  const liveRecords = candidateUris.length === 0 ? [] : yield* input.readRecords(candidateUris);
  const verifiedCandidates = verifyLiveRecallCandidates(index?.candidates ?? [], liveRecords, input);
  const liveCandidateById = verifiedCandidates.liveCandidateById;
  const conflictIds = verifiedCandidates.conflictIds;
  const finalPremiseSeeds = premiseSeeds.filter(
    seed => liveCandidateById.has(seed.memoryId) && !conflictIds.has(seed.memoryId),
  );
  const finalPremiseIdByOrdinal = new Map(
    finalPremiseSeeds.map(seed => [seed.requestedOrdinal, seed.memoryId] as const),
  );
  const verifiedRawLinks = rawLinks.filter(link => {
    const premiseId = finalPremiseIdByOrdinal.get(link.requestedOrdinal);
    return (
      premiseId !== undefined &&
      (link.direction === 'outgoing' ? link.sourceMemoryId === premiseId : link.targetMemoryId === premiseId)
    );
  });
  const verifiedLinkedMemoryIds = verifiedRawLinks.flatMap(link =>
    [link.sourceMemoryId, link.targetMemoryId].filter(isString),
  );

  const currentnessIds = [...new Set([...finalPremiseSeeds.map(seed => seed.memoryId), ...verifiedLinkedMemoryIds])];
  const supersederLinks =
    currentnessIds.length === 0
      ? []
      : yield* loadRecallMemoryLinks(config, {
          allowedUriScopes: input.allowedUriScopes,
          eligibility: input.eligibility,
          includeInactive: true,
          limit: 64,
          memorySeeds: currentnessIds.map((memoryId, requestedOrdinal) => ({memoryId, requestedOrdinal})),
          onCanonicalMismatch: count => {
            canonicalMismatches += count;
          },
          onCanonicalReread: count => {
            canonicalRereads += count;
          },
          onRawRows: count => {
            rawLinkRows += count;
          },
          onRefreshRepair: () => {
            refreshRepairs += 1;
          },
          relationTypes: ['supersedes'],
        });
  const missingSupersederIds = [
    ...new Set(
      supersederLinks
        .filter(link => link.direction === 'incoming')
        .map(link => link.sourceMemoryId)
        .filter(memoryId => !liveCandidateById.has(memoryId) && !conflictIds.has(memoryId)),
    ),
  ];
  if (missingSupersederIds.length > 0) {
    const supersederIndex = yield* loadRecallIndexData(config, {
      allowedUriScopes: input.allowedUriScopes,
      eligibility: input.eligibility,
      includeInactive: true,
      memoryIds: missingSupersederIds,
      validateNow: true,
    });
    const supersederUris = [...new Set(supersederIndex.candidates.flatMap(candidateUrisForRead))];
    canonicalRereads += supersederUris.length;
    const supersederRecords = supersederUris.length === 0 ? [] : yield* input.readRecords(supersederUris);
    const verifiedSuperseders = verifyLiveRecallCandidates(supersederIndex.candidates, supersederRecords, input);
    for (const memoryId of verifiedSuperseders.conflictIds) {
      conflictIds.add(memoryId);
      liveCandidateById.delete(memoryId);
    }
    for (const [memoryId, candidate] of verifiedSuperseders.liveCandidateById) {
      if (!conflictIds.has(memoryId)) liveCandidateById.set(memoryId, candidate);
    }
  }
  const activeSupersedersByTarget = new Map<string, Set<string>>();
  for (const link of supersederLinks) {
    if (link.direction !== 'incoming' || !link.targetMemoryId) continue;
    const source = liveCandidateById.get(link.sourceMemoryId);
    if (!source || conflictIds.has(link.sourceMemoryId) || !candidateIsCurrentlyActive(source, now)) continue;
    const sources = activeSupersedersByTarget.get(link.targetMemoryId) ?? new Set<string>();
    sources.add(link.sourceMemoryId);
    activeSupersedersByTarget.set(link.targetMemoryId, sources);
  }
  const stateForId = (memoryId: string | undefined): RecallMemoryPremiseState => {
    if (!memoryId) return 'unresolved';
    if (conflictIds.has(memoryId)) return 'conflicted';
    const candidate = liveCandidateById.get(memoryId);
    if (!candidate) return 'unresolved';
    return classifyRecallMemoryPremiseState(
      {
        activeSupersederCount: activeSupersedersByTarget.get(memoryId)?.size ?? 0,
        identityConflict: candidate.identityConflict,
        resolved: true,
        status: candidate.status,
        validFrom: candidate.validFrom,
        validTo: candidate.validTo,
      },
      now,
    );
  };

  const premises = parsed.memoryRefs.map((requestedRef, requestedOrdinal): RecallMemoryPremiseReceiptV1 => {
    const canonicalRef = parseResourceId(requestedRef).canonicalUri;
    const memoryId =
      memoryIdFromIdentityAlias(canonicalRef) ?? requestedRecordByUri.get(canonicalRef)?.metadata.memoryId;
    const candidate = memoryId ? liveCandidateById.get(memoryId) : undefined;
    const requestedCandidate = memoryId ? premiseCandidatesById.get(memoryId)?.[0] : undefined;
    return {
      ...(memoryId ? {memoryId} : {}),
      requestedOrdinal,
      requestedRef: canonicalRef,
      state: stateForId(memoryId),
      ...((candidate?.uri ?? requestedCandidate?.uri) ? {uri: candidate?.uri ?? requestedCandidate?.uri} : {}),
    };
  });

  const resolvedConnections = verifiedRawLinks.flatMap(link =>
    resolveConnection(link, liveCandidateById, conflictIds, stateForId),
  );
  const fairConnections = fairConnectionOrder(deduplicateResolvedConnections(resolvedConnections));
  const selectedCandidates: RecallCandidate[] = [];
  const selectedIds = new Set<string>();
  for (const connection of fairConnections) {
    if (!connection.memoryId || !connection.candidate || selectedIds.has(connection.memoryId)) continue;
    const state = connection.receipt.currentness;
    if (state === 'conflicted' || state === 'unresolved') continue;
    if (state === 'historical' && input.includeHistorical !== true) continue;
    selectedIds.add(connection.memoryId);
    selectedCandidates.push(connection.candidate);
    if (selectedCandidates.length >= limit) break;
  }
  const selectedConnections = fairConnections
    .filter(
      connection =>
        connection.receipt.resolution !== 'resolved' ||
        (connection.memoryId !== undefined && selectedIds.has(connection.memoryId)),
    )
    .slice(0, CONNECTION_RECEIPT_LIMIT)
    .map(connection => connection.receipt);
  const truncated =
    truncatedSeedOrdinals.length > 0 ||
    fairConnections.length > selectedConnections.length ||
    selectedIds.size <
      new Set(
        fairConnections.flatMap(connection =>
          connection.memoryId && connection.receipt.resolution === 'resolved' ? [connection.memoryId] : [],
        ),
      ).size;
  return {
    candidates: selectedCandidates,
    connections: selectedConnections,
    coverage: {
      connectionCount: selectedConnections.length,
      premiseCount: premises.length,
      resultCount: selectedCandidates.length,
      truncated,
      ...(truncatedSeedOrdinals.length > 0 ? {truncatedSeedOrdinals} : {}),
      version: 1,
    },
    diagnostics: {
      canonicalMismatches,
      canonicalRereads,
      rawLinkRows,
      refreshRepairs,
      truncatedSeedOrdinals,
    },
    premises,
  } satisfies RecallMemoryConnectionsResult;
});

function resolveConnection(
  link: RecallMemoryLinkMatch,
  liveCandidateById: ReadonlyMap<string, RecallCandidate>,
  conflictIds: ReadonlySet<string>,
  stateForId: (memoryId: string | undefined) => RecallMemoryPremiseState,
): readonly ResolvedConnection[] {
  const neighborMemoryId = link.direction === 'outgoing' ? link.targetMemoryId : link.sourceMemoryId;
  if (
    link.direction === 'outgoing' &&
    link.targetMemoryId &&
    !liveCandidateById.has(link.targetMemoryId) &&
    !conflictIds.has(link.targetMemoryId)
  ) {
    return [];
  }
  const candidate = neighborMemoryId ? liveCandidateById.get(neighborMemoryId) : undefined;
  const currentness = stateForId(neighborMemoryId);
  const resolution: RecallMemoryConnectionResolution =
    neighborMemoryId !== undefined && conflictIds.has(neighborMemoryId)
      ? 'conflicted'
      : neighborMemoryId === undefined || candidate === undefined
        ? 'unresolved'
        : 'resolved';
  const source = liveCandidateById.get(link.sourceMemoryId);
  const target = link.targetMemoryId ? liveCandidateById.get(link.targetMemoryId) : undefined;
  return [
    {
      ...(candidate ? {candidate} : {}),
      ...(neighborMemoryId ? {memoryId: neighborMemoryId} : {}),
      receipt: {
        currentness,
        direction: link.direction,
        distance: 1,
        ...(neighborMemoryId ? {neighborMemoryId} : {}),
        ...(candidate ? {neighborUri: candidate.uri} : {}),
        origin: link.relationOrigin,
        relationOrdinal: link.relationOrdinal,
        relationType: link.relationType,
        requestedOrdinal: link.requestedOrdinal,
        resolution,
        sourceMemoryId: link.sourceMemoryId,
        sourceUri: source?.uri ?? link.sourceUri,
        ...(link.targetMemoryId ? {targetMemoryId: link.targetMemoryId} : {}),
        ...(target ? {targetUri: target.uri} : {}),
      },
    },
  ];
}

function deduplicateResolvedConnections(connections: readonly ResolvedConnection[]): readonly ResolvedConnection[] {
  const selected = new Map<string, ResolvedConnection>();
  for (const connection of connections) {
    const receipt = connection.receipt;
    const key = [
      receipt.requestedOrdinal,
      receipt.direction,
      receipt.sourceMemoryId,
      receipt.neighborMemoryId ?? '',
      receipt.relationType,
      receipt.origin,
      receipt.relationOrdinal,
    ].join('\u0000');
    const current = selected.get(key);
    if (!current || compareCodeUnits(receipt.sourceUri ?? '', current.receipt.sourceUri ?? '') < 0) {
      selected.set(key, connection);
    }
  }
  return [...selected.values()];
}

function fairConnectionOrder(connections: readonly ResolvedConnection[]): readonly ResolvedConnection[] {
  const lanes = new Map<number, ResolvedConnection[]>();
  for (const connection of connections) {
    const ordinal = connection.receipt.requestedOrdinal;
    lanes.set(ordinal, [...(lanes.get(ordinal) ?? []), connection]);
  }
  for (const lane of lanes.values()) lane.sort(compareResolvedConnections);
  const ordered: ResolvedConnection[] = [];
  const ordinals = [...lanes.keys()].sort((a, b) => a - b);
  for (let rank = 0; ; rank += 1) {
    let appended = false;
    for (const ordinal of ordinals) {
      const connection = lanes.get(ordinal)?.[rank];
      if (!connection) continue;
      ordered.push(connection);
      appended = true;
    }
    if (!appended) return ordered;
  }
}

function compareResolvedConnections(left: ResolvedConnection, right: ResolvedConnection): number {
  const stateRank: Readonly<Record<RecallMemoryPremiseState, number>> = {
    current: 0,
    historical: 1,
    conflicted: 2,
    unresolved: 3,
  };
  return (
    stateRank[left.receipt.currentness] - stateRank[right.receipt.currentness] ||
    RELATION_PRIORITY[left.receipt.relationType] - RELATION_PRIORITY[right.receipt.relationType] ||
    compareCodeUnits(left.memoryId ?? '', right.memoryId ?? '') ||
    compareCodeUnits(left.receipt.direction, right.receipt.direction) ||
    left.receipt.relationOrdinal - right.receipt.relationOrdinal
  );
}

function groupCandidatesByMemoryId(
  candidates: readonly RecallCandidate[],
): ReadonlyMap<string, readonly RecallCandidate[]> {
  const grouped = new Map<string, RecallCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.memoryId) continue;
    grouped.set(candidate.memoryId, [...(grouped.get(candidate.memoryId) ?? []), candidate]);
  }
  return grouped;
}

function verifyLiveRecallCandidates<R>(
  candidates: readonly RecallCandidate[],
  records: readonly MemoryRecord[],
  input: RetrieveRecallMemoryConnectionsInput<R>,
): {
  readonly conflictIds: Set<string>;
  readonly liveCandidateById: Map<string, RecallCandidate>;
} {
  const candidatesById = groupCandidatesByMemoryId(candidates);
  const liveById = groupLiveRecordsByMemoryId(records.filter(record => authorizedRecord(record, input)));
  const liveCandidateById = new Map<string, RecallCandidate>();
  const conflictIds = new Set<string>();
  for (const [memoryId, indexedCandidates] of candidatesById) {
    const liveRecords = liveById.get(memoryId) ?? [];
    const contentHashes = new Set(liveRecords.map(record => recallMemoryContentHash(record.body)));
    if (indexedCandidates.some(candidate => candidate.identityConflict) || contentHashes.size > 1) {
      conflictIds.add(memoryId);
      continue;
    }
    const candidate = indexedCandidates.find(indexed =>
      liveRecords.some(
        record =>
          candidateUrisForRead(indexed).includes(record.uri) &&
          indexed.contentHash === recallMemoryContentHash(record.body),
      ),
    );
    if (candidate) liveCandidateById.set(memoryId, candidate);
  }
  return {conflictIds, liveCandidateById};
}

function groupLiveRecordsByMemoryId(records: readonly MemoryRecord[]): ReadonlyMap<string, readonly MemoryRecord[]> {
  const grouped = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const memoryId = record.metadata.memoryId;
    if (!memoryId) continue;
    grouped.set(memoryId, [...(grouped.get(memoryId) ?? []), record]);
  }
  return grouped;
}

function candidateUrisForRead(candidate: RecallCandidate): readonly string[] {
  return [candidate.uri, ...(candidate.equivalentUris ?? [])];
}

function authorizedRecord<R>(record: MemoryRecord, input: RetrieveRecallMemoryConnectionsInput<R>): boolean {
  return (
    recallUriMatchesScopes(record.uri, input.allowedUriScopes) &&
    (input.eligibility === undefined || recallCandidateIsEligible(input.eligibility, record.metadata))
  );
}

function candidateIsCurrentlyActive(candidate: RecallCandidate, now: Date): boolean {
  return (candidate.status ?? 'active') === 'active' && dateWindowContains(now, candidate.validFrom, candidate.validTo);
}

function boundedConnectionResultLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RECALL_MEMORY_CONNECTIONS;
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_RECALL_MEMORY_CONNECTIONS, Math.max(0, Math.floor(value)));
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function dateWindowContains(now: Date, validFrom: string | undefined, validTo: string | undefined): boolean {
  const nowTime = now.getTime();
  const from = validFrom === undefined ? undefined : Date.parse(validFrom);
  const to = validTo === undefined ? undefined : Date.parse(validTo);
  if (from !== undefined && (!Number.isFinite(from) || nowTime < from)) return false;
  if (to !== undefined && (!Number.isFinite(to) || nowTime > to)) return false;
  return true;
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) throw new Error(`Recall ${label} must not be empty.`);
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
