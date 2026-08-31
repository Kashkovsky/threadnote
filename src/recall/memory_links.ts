import {Effect, FileSystem} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {sha256HexSync} from '../crypto/sha256.js';
import {parseMemoryDocument, type MemoryRelation, type MemoryRelationType} from '../memory/document.js';
import {isMemoryId, memoryIdFromIdentityAlias} from '../memory/identity_alias.js';
import {parseResourceId} from '../storage/resource-id.js';
import {recallCandidateIsEligible, type RecallEligibilityPolicy} from './eligibility.js';
import {recallEligibilityPredicate} from './index_eligibility.js';
import {combineRecallSqlPredicates, recallUriMatchesScopes, recallUriScopePredicate} from './index_scope.js';

export const MAX_INDEXED_MEMORY_LINKS_PER_SOURCE = 64;

export type RecallMemoryLinkOrigin = 'evidence' | 'references' | 'relation' | 'supersedes';

export interface IndexedRecallMemoryLink {
  readonly relationOrdinal: number;
  readonly relationOrigin: RecallMemoryLinkOrigin;
  readonly relationType: MemoryRelationType;
  readonly sourceMemoryId: string;
  /** Stable identity selectors use this field directly. Legacy locators are resolved during refresh. */
  readonly targetMemoryId: string;
  /** Present for every legacy canonical URI, including when its current target resolves. */
  readonly targetLocatorDigest: string;
}

export interface IndexedRecallMemoryLinkProjection {
  readonly links: readonly IndexedRecallMemoryLink[];
  readonly truncated: boolean;
}

export interface RecallMemoryLinkSeed {
  readonly memoryId: string;
  readonly requestedOrdinal: number;
}

export interface RecallMemoryLinkMatch {
  readonly direction: 'incoming' | 'outgoing';
  readonly relationOrdinal: number;
  readonly relationOrigin: RecallMemoryLinkOrigin;
  readonly relationType: MemoryRelationType;
  readonly requestedOrdinal: number;
  readonly sourceMemoryId: string;
  readonly sourceUri: string;
  readonly targetMemoryId?: string;
}

export interface RecallMemoryLinkQueryOptions {
  readonly allowedUriScopes?: readonly string[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  readonly memorySeeds: readonly RecallMemoryLinkSeed[];
  readonly onCanonicalMismatch?: (count: number) => void;
  /** @internal Reports every attempted canonical source reread after the bounded SQL selection. */
  readonly onCanonicalReread?: (count: number) => void;
  /** @internal Reports bounded SQL selector rows, including the one-row truncation probe. */
  readonly onRawRows?: (count: number) => void;
  readonly onSearchTruncated?: (seedOrdinals: readonly number[]) => void;
  readonly relationTypes?: readonly MemoryRelationType[];
}

interface RecallMemoryLinkSelectionRow {
  readonly relation_ordinal: number;
  readonly relation_origin: RecallMemoryLinkOrigin;
  readonly relation_type: MemoryRelationType;
  readonly source_memory_id: string;
  readonly source_path: string;
  readonly source_uri: string;
  readonly target_locator_digest: string;
  readonly target_memory_id: string;
}

interface RecallMemoryLinkRankedMatch extends RecallMemoryLinkMatch {
  readonly laneRank: number;
}

const RECALL_MEMORY_LINK_CANONICAL_BACKFILL_FACTOR = 4;

interface OriginRelation extends MemoryRelation {
  readonly ordinal: number;
  readonly origin: RecallMemoryLinkOrigin;
}

/** Project canonical metadata into privacy-safe, rebuildable memory-edge selectors. */
export function deriveIndexedRecallMemoryLinks(
  memory: ReturnType<typeof parseMemoryDocument>,
): IndexedRecallMemoryLinkProjection {
  if (!memory) return {links: [], truncated: false};
  const sourceMemoryId = isMemoryId(memory.metadata.memoryId ?? '') ? memory.metadata.memoryId! : '';
  // Preserve explicit authoring and supersession before lower-priority legacy
  // provenance so a noisy imported header cannot starve currentness evidence.
  const relations: OriginRelation[] = [
    ...(memory.metadata.supersedes
      ? [{ordinal: 0, origin: 'supersedes' as const, type: 'supersedes' as const, uri: memory.metadata.supersedes}]
      : []),
    ...(memory.metadata.relations ?? []).map((relation, ordinal) => ({
      ...relation,
      ordinal,
      origin: 'relation' as const,
    })),
    ...(memory.metadata.references ?? []).map((uri, ordinal) => ({
      ordinal,
      origin: 'references' as const,
      type: 'references' as const,
      uri,
    })),
    ...(memory.metadata.evidence ?? []).flatMap((uri, ordinal) =>
      uri.startsWith('threadnote://')
        ? [{ordinal, origin: 'evidence' as const, type: 'evidence_for' as const, uri}]
        : [],
    ),
  ];
  const projected = relations.flatMap(relation => {
    let uri: string;
    try {
      uri = parseResourceId(relation.uri).canonicalUri;
    } catch {
      return [];
    }
    const targetMemoryId = memoryIdFromIdentityAlias(uri);
    return [
      {
        relationOrdinal: relation.ordinal,
        relationOrigin: relation.origin,
        relationType: relation.type,
        sourceMemoryId,
        targetLocatorDigest: targetMemoryId === undefined ? memoryLinkLocatorDigest(uri) : '',
        targetMemoryId: targetMemoryId ?? '',
      } satisfies IndexedRecallMemoryLink,
    ];
  });
  const selected = projected.slice(0, MAX_INDEXED_MEMORY_LINKS_PER_SOURCE);
  return {
    links: selected,
    truncated: projected.length > selected.length,
  };
}

/** Domain separation prevents these private locator hashes from being confused with other selectors. */
export function memoryLinkLocatorDigest(uri: string): string {
  const canonicalUri = parseResourceId(uri).canonicalUri;
  return sha256HexSync(JSON.stringify({kind: 'memory-link-locator', uri: canonicalUri, version: 1}));
}

/**
 * Select exact one-hop rows through the source/target indexes, then prove each
 * row against its canonical source document before it can reach a caller.
 */
export const selectRecallMemoryLinks = Effect.fn('recall.selectMemoryLinks')(function* (
  sql: SqlClient.SqlClient,
  options: RecallMemoryLinkQueryOptions,
) {
  const seeds = normalizeMemoryLinkSeeds(options.memorySeeds);
  const limit = boundedRecallMemoryLinkLimit(options.limit);
  if (seeds.length === 0 || limit === 0) return [] satisfies readonly RecallMemoryLinkMatch[];
  const scanLimit = limit * RECALL_MEMORY_LINK_CANONICAL_BACKFILL_FACTOR;
  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('document', options.allowedUriScopes),
    recallEligibilityPredicate('document', options.eligibility),
  );
  const relationPredicate = options.relationTypes?.length
    ? `AND memory_link.relation_type IN (${options.relationTypes.map(() => '?').join(', ')})`
    : '';
  const relationParams = options.relationTypes ?? [];
  const inactivePredicate =
    options.includeInactive === true
      ? '1 = 1'
      : "COALESCE(json_extract(document.candidate_json, '$.status'), 'active') = 'active'";
  const selected: RecallMemoryLinkRankedMatch[] = [];
  const truncatedSeeds = new Set<number>();
  let canonicalMismatchCount = 0;
  let canonicalRereadCount = 0;
  let rawRowCount = 0;
  const fs = yield* FileSystem.FileSystem;

  for (const seed of seeds) {
    for (const direction of ['outgoing', 'incoming'] as const) {
      const selectorColumn = direction === 'outgoing' ? 'source_memory_id' : 'target_memory_id';
      const rows = yield* sql.unsafe<RecallMemoryLinkSelectionRow>(
        `SELECT
           memory_link.source_memory_id,
           memory_link.target_memory_id,
           memory_link.target_locator_digest,
           memory_link.relation_type,
           memory_link.relation_origin,
           memory_link.relation_ordinal,
           document.uri AS source_uri,
           document.source_path
         FROM memory_links AS memory_link
         INNER JOIN documents AS document ON document.id = memory_link.source_document_id
         WHERE memory_link.${selectorColumn} = ?
           ${relationPredicate}
           AND ${scope.sql}
           AND ${inactivePredicate}
         ORDER BY
           memory_link.relation_type COLLATE BINARY,
           document.uri COLLATE BINARY,
           memory_link.relation_origin COLLATE BINARY,
           memory_link.relation_ordinal,
           memory_link.target_memory_id COLLATE BINARY,
           memory_link.target_locator_digest COLLATE BINARY
         LIMIT ?`,
        [seed.memoryId, ...relationParams, ...scope.params, scanLimit + 1],
      );
      rawRowCount += rows.length;
      if (rows.length > scanLimit) truncatedSeeds.add(seed.requestedOrdinal);
      const boundedRows = rows.slice(0, scanLimit);
      canonicalRereadCount += boundedRows.length;
      const verified = yield* Effect.forEach(
        boundedRows,
        row =>
          fs.readFileString(row.source_path).pipe(
            Effect.map(content => {
              const memory = parseMemoryDocument(row.source_uri, content);
              if (!canonicalMemoryLinkSourceMatches(row.source_uri, memory, options)) return undefined;
              const link = deriveIndexedRecallMemoryLinks(memory).links.find(candidate =>
                indexedMemoryLinkMatchesRow(candidate, row),
              );
              if (!link) return undefined;
              return {
                direction,
                relationOrdinal: row.relation_ordinal,
                relationOrigin: row.relation_origin,
                relationType: row.relation_type,
                requestedOrdinal: seed.requestedOrdinal,
                sourceMemoryId: row.source_memory_id,
                sourceUri: row.source_uri,
                ...(row.target_memory_id ? {targetMemoryId: row.target_memory_id} : {}),
              } satisfies RecallMemoryLinkMatch;
            }),
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        {concurrency: 4},
      );
      canonicalMismatchCount += verified.length - verified.filter(Boolean).length;
      selected.push(
        ...verified
          .filter((match): match is RecallMemoryLinkMatch => match !== undefined)
          .map((match, laneRank) => ({...match, laneRank})),
      );
    }
  }

  if (canonicalMismatchCount > 0) options.onCanonicalMismatch?.(canonicalMismatchCount);
  if (canonicalRereadCount > 0) options.onCanonicalReread?.(canonicalRereadCount);
  if (rawRowCount > 0) options.onRawRows?.(rawRowCount);
  if (truncatedSeeds.size > 0) options.onSearchTruncated?.([...truncatedSeeds].sort((a, b) => a - b));
  return selected
    .sort(
      (left, right) =>
        left.laneRank - right.laneRank ||
        left.requestedOrdinal - right.requestedOrdinal ||
        compareText(left.direction, right.direction) ||
        compareText(left.relationType, right.relationType) ||
        compareText(left.sourceUri, right.sourceUri) ||
        left.relationOrdinal - right.relationOrdinal,
    )
    .slice(0, limit)
    .map(({laneRank: _laneRank, ...match}) => match);
});

function canonicalMemoryLinkSourceMatches(
  uri: string,
  memory: ReturnType<typeof parseMemoryDocument>,
  options: RecallMemoryLinkQueryOptions,
): memory is NonNullable<ReturnType<typeof parseMemoryDocument>> {
  return (
    memory !== undefined &&
    isMemoryId(memory.metadata.memoryId ?? '') &&
    (options.includeInactive === true || memory.metadata.status === 'active') &&
    recallUriMatchesScopes(uri, options.allowedUriScopes) &&
    (options.eligibility === undefined || recallCandidateIsEligible(options.eligibility, memory.metadata))
  );
}

function indexedMemoryLinkMatchesRow(link: IndexedRecallMemoryLink, row: RecallMemoryLinkSelectionRow): boolean {
  return (
    link.sourceMemoryId === row.source_memory_id &&
    link.relationType === row.relation_type &&
    link.relationOrigin === row.relation_origin &&
    link.relationOrdinal === row.relation_ordinal &&
    (row.target_locator_digest
      ? link.targetLocatorDigest === row.target_locator_digest
      : link.targetMemoryId === row.target_memory_id)
  );
}

function normalizeMemoryLinkSeeds(seeds: readonly RecallMemoryLinkSeed[]): readonly RecallMemoryLinkSeed[] {
  const selected = new Map<string, RecallMemoryLinkSeed>();
  for (const seed of seeds) {
    if (!isMemoryId(seed.memoryId) || !Number.isSafeInteger(seed.requestedOrdinal) || seed.requestedOrdinal < 0)
      continue;
    const current = selected.get(seed.memoryId);
    if (!current || seed.requestedOrdinal < current.requestedOrdinal) selected.set(seed.memoryId, seed);
  }
  return [...selected.values()].sort(
    (left, right) => left.requestedOrdinal - right.requestedOrdinal || compareText(left.memoryId, right.memoryId),
  );
}

function boundedRecallMemoryLinkLimit(limit: number | undefined): number {
  if (limit === undefined) return 8;
  if (!Number.isFinite(limit)) return 0;
  return Math.min(64, Math.max(0, Math.floor(limit)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
