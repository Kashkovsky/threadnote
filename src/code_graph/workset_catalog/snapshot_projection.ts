import {Cause, Effect, Option, Result} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {sha256HexSync} from '../../crypto/sha256.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../store_build_core.js';
import {effectiveSnapshotParameters, effectiveSymbolsCte} from '../store_query_core.js';
import type {CodeGraphStoreShape} from '../store_shape.js';
import type {CodeGraphSnapshot} from '../types.js';
import {createCodeGraphWorksetRoutingProjection} from './projection.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogSpanV1,
  type CodeGraphWorksetRoutingProjectionV1,
  type CodeGraphWorksetRoutingSymbolV1,
  type CodeGraphWorksetRoutingTermV1,
} from './types.js';

const DEFAULT_PAGE_SIZE = 256;
const MAXIMUM_PAGE_SIZE = 512;
const DEFAULT_LEASE_MILLISECONDS = 2 * 60_000;
const MINIMUM_LEASE_MILLISECONDS = 30_000;
const MAXIMUM_LEASE_MILLISECONDS = 10 * 60_000;
const MAXIMUM_LOOKUP_JSON_BYTES = 256 * 1_024;
const MAXIMUM_SPAN_JSON_BYTES = 4 * 1_024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface CodeGraphReadySnapshotRoutingProjectionInputV1 {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly leaseDurationMilliseconds?: number;
  readonly pageSize?: number;
  readonly repositoryId: string;
  /** When omitted, project the active ready snapshot for `worktreeId`. */
  readonly snapshotId?: string;
  readonly worktreeId: string;
}

export interface CodeGraphReadySnapshotRoutingProjectionStatsV1 {
  readonly componentCount: number;
  readonly dependencyCount: number;
  readonly lookupKeysOmitted: number;
  readonly lookupKeysObserved: number;
  readonly pagesRead: number;
  readonly symbolsRead: number;
  readonly termsOmitted: number;
  readonly termsObserved: number;
}

export interface CodeGraphReadySnapshotRoutingProjectionBuildV1 {
  readonly projection: CodeGraphWorksetRoutingProjectionV1;
  readonly stats: CodeGraphReadySnapshotRoutingProjectionStatsV1;
}

interface SnapshotProjectionRow {
  readonly base_snapshot_id: unknown;
  readonly commit_id: unknown;
  readonly dirty: unknown;
  readonly edge_count: unknown;
  readonly extractor_set: unknown;
  readonly graph_content_id: unknown;
  readonly overlay_fingerprint: unknown;
  readonly repository_id: unknown;
  readonly snapshot_id: unknown;
  readonly symbol_count: unknown;
}

interface ExtractorGenerationRow {
  readonly generation: unknown;
}

interface CountRow {
  readonly count: unknown;
}

interface SymbolProjectionRow {
  readonly exported: unknown;
  readonly id: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly lookup_keys_json: unknown;
  readonly name: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly span_json: unknown;
}

interface LookupProjectionRow {
  readonly lookup_key: unknown;
  readonly symbol_id: unknown;
}

interface TermProjectionRow {
  readonly symbol_id: unknown;
  readonly term: unknown;
  readonly weight: unknown;
}

interface AnalysisReceiptRow {
  readonly digest: unknown;
  readonly edge_count: unknown;
  readonly symbol_count: unknown;
  readonly version: unknown;
}

interface ComponentReceiptRow {
  readonly digest: unknown;
  readonly edge_count: unknown;
  readonly row_count: unknown;
  readonly version: unknown;
}

interface LexicalReceiptRow {
  readonly format_version: unknown;
  readonly posting_count: unknown;
  readonly snapshot_id: unknown;
  readonly symbol_count: unknown;
  readonly term_count: unknown;
}

interface MutableProjectionStats {
  componentCount: number;
  dependencyCount: number;
  lookupKeysOmitted: number;
  lookupKeysObserved: number;
  pagesRead: number;
  symbolsRead: number;
  termsOmitted: number;
  termsObserved: number;
}

/**
 * Derive a compact workset routing projection from one active ready snapshot.
 *
 * The snapshot is leased before the read-only session opens. The session reads
 * only routing metadata and keyset-pages symbol rows; source bodies,
 * documentation, signatures, and file contents are never selected.
 */
export const buildCodeGraphReadySnapshotRoutingProjection = Effect.fn(
  'codeGraphWorksetCatalog.buildReadySnapshotProjection',
)(function* (store: CodeGraphStoreShape, input: CodeGraphReadySnapshotRoutingProjectionInputV1) {
  const normalized = yield* normalizeInput(input);
  const selected = yield* store
    .readySnapshot(normalized.databasePath, normalized.worktreeId)
    .pipe(Effect.mapError(cause => storage('Unable to select a ready code graph snapshot.', cause)));
  if (!selected) {
    return yield* Effect.fail(missing('No active ready code graph snapshot exists for this worktree.'));
  }
  if (normalized.snapshotId !== undefined && selected.id !== normalized.snapshotId) {
    return yield* Effect.fail(missing('The requested ready snapshot is not active for this worktree.'));
  }
  if (selected.repositoryId !== normalized.repositoryId || selected.state !== 'ready') {
    return yield* Effect.fail(corrupt('The active ready snapshot has inconsistent repository provenance.'));
  }
  if (selected.symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
    return yield* Effect.fail(
      invalid('The ready snapshot has more symbols than one routing projection can represent.'),
    );
  }

  const lease = yield* store
    .acquireSnapshotLease(normalized.databasePath, selected.id, normalized.leaseDurationMilliseconds)
    .pipe(Effect.mapError(cause => storage('Unable to lease the ready code graph snapshot.', cause)));
  return yield* store.withSession(normalized.databasePath, readProjection(selected, normalized), {readOnly: true}).pipe(
    Effect.mapError(cause =>
      cause instanceof CodeGraphWorksetCatalogError
        ? cause
        : storage('Unable to read the ready code graph routing surface.', cause),
    ),
    Effect.ensuring(store.releaseSnapshotLease(normalized.databasePath, lease).pipe(Effect.catch(() => Effect.void))),
  );
});

function readProjection(selected: CodeGraphSnapshot, input: NormalizedProjectionInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* selectProjectionSnapshot(sql, selected.id, input.repositoryId, input.worktreeId);
    validateSelectedSnapshot(before, selected);
    const baseSnapshotId = optionalText(before.base_snapshot_id, 'base snapshot identity');
    const extractorGeneration = yield* selectExtractorGeneration(sql, selected.id);
    const componentCount = yield* selectCount(
      sql,
      'SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ?',
      [selected.id],
      'workspace component count',
    );
    const dependencyCount = yield* selectCount(
      sql,
      'SELECT COUNT(*) AS count FROM workspace_component_dependencies WHERE snapshot_id = ?',
      [selected.id],
      'workspace dependency count',
    );
    const analysisReceipt = yield* selectAnalysisReceipt(sql, selected.id);
    const componentReceipt = yield* selectComponentReceipt(sql, selected.id);
    const lexicalReceipts = yield* selectLexicalReceipts(sql, selected.id, baseSnapshotId);
    const expectedSymbolCount = safeCount(before.symbol_count, 'snapshot symbol count');
    validateOptionalReceipts(
      analysisReceipt,
      componentReceipt,
      lexicalReceipts,
      expectedSymbolCount,
      safeCount(before.edge_count, 'snapshot edge count'),
    );
    if (expectedSymbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
      return yield* Effect.fail(
        invalid('The ready snapshot has more symbols than one routing projection can represent.'),
      );
    }

    const stats: MutableProjectionStats = {
      componentCount,
      dependencyCount,
      lookupKeysOmitted: 0,
      lookupKeysObserved: 0,
      pagesRead: 0,
      symbolsRead: 0,
      termsOmitted: 0,
      termsObserved: 0,
    };
    const symbols: CodeGraphWorksetRoutingSymbolV1[] = [];
    let afterNodeId = '';
    for (;;) {
      const page = yield* selectSymbolPage(sql, selected.id, baseSnapshotId, afterNodeId, input.pageSize);
      if (page.length === 0) break;
      stats.pagesRead += 1;
      const nodeIds = page.map(row => requiredText(row.id, 'symbol identity'));
      const lookupRows = yield* selectLookupRows(sql, selected.id, baseSnapshotId, nodeIds);
      const termRows = yield* selectTermRows(sql, selected.id, baseSnapshotId, nodeIds);
      const lookupBySymbol = groupLookupRows(lookupRows);
      const termsBySymbol = groupTermRows(termRows);

      for (const row of page) {
        const nodeId = requiredText(row.id, 'symbol identity');
        const intrinsicLookupKeys = decodeLookupKeys(row.lookup_keys_json);
        const routedLookupKeys = selectLookupKeys(intrinsicLookupKeys, lookupBySymbol.get(nodeId) ?? [], stats);
        const routedTerms = selectTerms(termsBySymbol.get(nodeId) ?? [], stats);
        symbols.push({
          exported: booleanInteger(row.exported, 'symbol exported state'),
          kind: requiredText(row.kind, 'symbol kind'),
          language: requiredText(row.language, 'symbol language'),
          lookupKeys: routedLookupKeys,
          name: requiredText(row.name, 'symbol name'),
          nodeId,
          ...(row.package_name === null ? {} : {packageName: requiredText(row.package_name, 'symbol package name')}),
          path: requiredText(row.path, 'symbol path'),
          qualifiedName: requiredText(row.qualified_name, 'symbol qualified name'),
          span: decodeSpan(row.span_json),
          terms: routedTerms,
        });
      }
      stats.symbolsRead += page.length;
      afterNodeId = nodeIds.at(-1)!;
      if (page.length < input.pageSize) break;
      yield* Effect.yieldNow;
    }
    if (symbols.length !== expectedSymbolCount || symbols.length !== selected.symbolCount) {
      return yield* Effect.fail(
        corrupt('The effective routing symbol count does not match the ready snapshot receipt.'),
      );
    }

    const after = yield* selectProjectionSnapshot(sql, selected.id, input.repositoryId, input.worktreeId);
    if (!sameSnapshotProjectionRow(before, after)) {
      return yield* Effect.fail(corrupt('The active ready snapshot changed while its routing projection was read.'));
    }
    const snapshotDigest = readySnapshotProjectionDigest({
      baseSnapshotId,
      commitId: requiredText(before.commit_id, 'snapshot commit identity'),
      componentCount,
      dependencyCount,
      dirty: booleanInteger(before.dirty, 'snapshot dirty state'),
      extractorGeneration,
      extractorSet: requiredText(before.extractor_set, 'snapshot extractor set'),
      graphContentId: optionalText(before.graph_content_id, 'graph content identity'),
      lookupKeysObserved: stats.lookupKeysObserved,
      overlayFingerprint: optionalText(before.overlay_fingerprint, 'snapshot overlay fingerprint'),
      repositoryId: input.repositoryId,
      snapshotId: selected.id,
      symbolCount: symbols.length,
      termsObserved: stats.termsObserved,
    });
    const projection = yield* Effect.try({
      try: () =>
        createCodeGraphWorksetRoutingProjection({
          checkoutId: input.checkoutId,
          commitId: requiredText(before.commit_id, 'snapshot commit identity'),
          componentCount,
          extractorGeneration,
          projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
          repositoryId: input.repositoryId,
          snapshotDigest,
          snapshotId: selected.id,
          symbols,
          worktreeId: input.worktreeId,
        }),
      catch: cause => corrupt('The ready snapshot contains an invalid routing projection surface.', cause),
    });
    return {projection, stats: {...stats}};
  }).pipe(
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      const failure = Cause.findErrorOption(cause);
      if (Option.isSome(failure)) return Effect.fail(failure.value);
      const defect = Cause.findDefect(cause);
      if (Result.isSuccess(defect) && defect.success instanceof CodeGraphWorksetCatalogError) {
        return Effect.fail(defect.success);
      }
      return Effect.fail(corrupt('The ready snapshot routing surface could not be decoded.', Cause.squash(cause)));
    }),
  );
}

interface NormalizedProjectionInput {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly leaseDurationMilliseconds: number;
  readonly pageSize: number;
  readonly repositoryId: string;
  readonly snapshotId?: string;
  readonly worktreeId: string;
}

function normalizeInput(
  input: CodeGraphReadySnapshotRoutingProjectionInputV1,
): Effect.Effect<NormalizedProjectionInput, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: () => {
      if (!SHA256_HEX.test(input.checkoutId)) throw invalid('Workset projection checkout identity is invalid.');
      if (!SHA256_HEX.test(input.repositoryId)) throw invalid('Workset projection repository identity is invalid.');
      if (!SHA256_HEX.test(input.worktreeId)) throw invalid('Workset projection worktree identity is invalid.');
      if (
        typeof input.databasePath !== 'string' ||
        input.databasePath.length === 0 ||
        input.databasePath.includes('\0')
      ) {
        throw invalid('Workset projection database path is invalid.');
      }
      if (
        input.snapshotId !== undefined &&
        (input.snapshotId.length === 0 || input.snapshotId.length > 256 || input.snapshotId.includes('\0'))
      ) {
        throw invalid('Workset projection snapshot identity is invalid.');
      }
      const pageSize = boundedInteger(input.pageSize, DEFAULT_PAGE_SIZE, 1, MAXIMUM_PAGE_SIZE, 'page size');
      const leaseDurationMilliseconds = boundedInteger(
        input.leaseDurationMilliseconds,
        DEFAULT_LEASE_MILLISECONDS,
        MINIMUM_LEASE_MILLISECONDS,
        MAXIMUM_LEASE_MILLISECONDS,
        'lease duration',
      );
      return {
        checkoutId: input.checkoutId,
        databasePath: input.databasePath,
        leaseDurationMilliseconds,
        pageSize,
        repositoryId: input.repositoryId,
        ...(input.snapshotId === undefined ? {} : {snapshotId: input.snapshotId}),
        worktreeId: input.worktreeId,
      };
    },
    catch: cause =>
      cause instanceof CodeGraphWorksetCatalogError
        ? cause
        : invalid('Workset routing projection input is invalid.', cause),
  });
}

function selectProjectionSnapshot(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  repositoryId: string,
  worktreeId: string,
) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<SnapshotProjectionRow>(
      `SELECT snapshot.id AS snapshot_id, snapshot.repository_id, snapshot.commit_id,
              snapshot.graph_content_id, snapshot.base_snapshot_id, snapshot.extractor_set,
              snapshot.dirty, snapshot.overlay_fingerprint, snapshot.symbol_count,
              snapshot.edge_count
       FROM active_snapshots AS active
       JOIN snapshots AS snapshot ON snapshot.id = active.snapshot_id
       WHERE active.worktree_id = ?
         AND active.snapshot_id = ?
         AND snapshot.repository_id = ?
         AND snapshot.state = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM removed_views AS removed
           WHERE removed.worktree_id = active.worktree_id
             AND removed.expected_snapshot_id = active.snapshot_id
         )
       LIMIT 2`,
      [worktreeId, snapshotId, repositoryId],
    );
    if (rows.length !== 1) {
      return yield* Effect.fail(missing('The selected snapshot is no longer an active ready worktree view.'));
    }
    return rows[0]!;
  });
}

function validateSelectedSnapshot(row: SnapshotProjectionRow, selected: CodeGraphSnapshot): void {
  if (
    requiredText(row.snapshot_id, 'snapshot identity') !== selected.id ||
    requiredText(row.repository_id, 'repository identity') !== selected.repositoryId ||
    requiredText(row.commit_id, 'snapshot commit identity') !== selected.commit ||
    safeCount(row.symbol_count, 'snapshot symbol count') !== selected.symbolCount ||
    safeCount(row.edge_count, 'snapshot edge count') !== selected.edgeCount ||
    booleanInteger(row.dirty, 'snapshot dirty state') !== selected.dirty
  ) {
    throw corrupt('The leased snapshot metadata changed before projection began.');
  }
}

function selectExtractorGeneration(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<ExtractorGenerationRow>(
      'SELECT generation FROM snapshot_extractor_generations WHERE snapshot_id = ? LIMIT 2',
      [snapshotId],
    );
    if (rows.length !== 1) {
      return yield* Effect.fail(corrupt('The ready snapshot has no unique extractor-generation receipt.'));
    }
    const generation = safeCount(rows[0]!.generation, 'extractor generation');
    if (generation < 1) return yield* Effect.fail(corrupt('The ready snapshot extractor generation is invalid.'));
    return generation;
  });
}

function selectCount(sql: SqlClient.SqlClient, statement: string, parameters: readonly unknown[], label: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<CountRow>(statement, parameters);
    if (rows.length !== 1) return yield* Effect.fail(corrupt(`The ${label} is unavailable.`));
    return safeCount(rows[0]!.count, label);
  });
}

function selectSymbolPage(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  afterNodeId: string,
  limit: number,
) {
  return sql.unsafe<SymbolProjectionRow>(
    `${effectiveSymbolsCte()}
     SELECT id, kind, name, qualified_name, path, language, lookup_keys_json,
            package_name, exported, span_json
     FROM effective_symbols
     WHERE id > ?
     ORDER BY id
     LIMIT ?`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), afterNodeId, limit],
  );
}

function selectLookupRows(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
) {
  if (nodeIds.length === 0) return Effect.succeed([] as readonly LookupProjectionRow[]);
  const requested = nodeIds.map(() => '(?)').join(', ');
  return sql.unsafe<LookupProjectionRow>(
    `WITH requested(symbol_id) AS (VALUES ${requested}),
     effective_lookup AS (
       SELECT lookup.symbol_id, lookup.lookup_key
       FROM snapshot_symbol_lookup AS lookup
       JOIN requested ON requested.symbol_id = lookup.symbol_id
       WHERE lookup.snapshot_id = ?
       UNION ALL
       SELECT lookup.symbol_id, lookup.lookup_key
       FROM snapshot_symbol_lookup AS lookup
       JOIN requested ON requested.symbol_id = lookup.symbol_id
       WHERE lookup.snapshot_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM symbols AS overrides
           WHERE overrides.snapshot_id = ? AND overrides.id = lookup.symbol_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_symbol_deletions AS deletions
           WHERE deletions.snapshot_id = ? AND deletions.symbol_id = lookup.symbol_id
         )
     )
     SELECT symbol_id, lookup_key FROM effective_lookup
     ORDER BY symbol_id, lookup_key`,
    [...nodeIds, snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId],
  );
}

function selectTermRows(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
) {
  if (nodeIds.length === 0) return Effect.succeed([] as readonly TermProjectionRow[]);
  const requested = nodeIds.map(() => '(?)').join(', ');
  const baseId = baseSnapshotId ?? '';
  return sql.unsafe<TermProjectionRow>(
    `WITH requested(symbol_id) AS (VALUES ${requested}),
     effective_terms AS (
       SELECT legacy.symbol_id, legacy.term, legacy.weight
       FROM symbol_terms AS legacy
       JOIN requested ON requested.symbol_id = legacy.symbol_id
       WHERE legacy.snapshot_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM lexical_storage_formats AS storage
           WHERE storage.snapshot_id = legacy.snapshot_id
         )
       UNION ALL
       SELECT compact_symbol.symbol_id, compact_term.term, posting.weight
       FROM lexical_compact_snapshots AS compact_snapshot
       JOIN lexical_storage_formats AS storage
         ON storage.snapshot_id = compact_snapshot.snapshot_id
        AND storage.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
       JOIN lexical_compact_terms AS compact_term
         ON compact_term.snapshot_key = compact_snapshot.snapshot_key
       JOIN lexical_compact_postings AS posting
         ON posting.snapshot_key = compact_snapshot.snapshot_key
        AND posting.term_key = compact_term.term_key
       JOIN lexical_compact_symbols AS compact_symbol
         ON compact_symbol.snapshot_key = compact_snapshot.snapshot_key
        AND compact_symbol.symbol_key = posting.symbol_key
       JOIN requested ON requested.symbol_id = compact_symbol.symbol_id
       WHERE compact_snapshot.snapshot_id = ?
       UNION ALL
       SELECT legacy.symbol_id, legacy.term, legacy.weight
       FROM symbol_terms AS legacy
       JOIN requested ON requested.symbol_id = legacy.symbol_id
       WHERE legacy.snapshot_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM lexical_storage_formats AS storage
           WHERE storage.snapshot_id = legacy.snapshot_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM symbols AS overrides
           WHERE overrides.snapshot_id = ? AND overrides.id = legacy.symbol_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_symbol_deletions AS deletions
           WHERE deletions.snapshot_id = ? AND deletions.symbol_id = legacy.symbol_id
         )
       UNION ALL
       SELECT compact_symbol.symbol_id, compact_term.term, posting.weight
       FROM lexical_compact_snapshots AS compact_snapshot
       JOIN lexical_storage_formats AS storage
         ON storage.snapshot_id = compact_snapshot.snapshot_id
        AND storage.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
       JOIN lexical_compact_terms AS compact_term
         ON compact_term.snapshot_key = compact_snapshot.snapshot_key
       JOIN lexical_compact_postings AS posting
         ON posting.snapshot_key = compact_snapshot.snapshot_key
        AND posting.term_key = compact_term.term_key
       JOIN lexical_compact_symbols AS compact_symbol
         ON compact_symbol.snapshot_key = compact_snapshot.snapshot_key
        AND compact_symbol.symbol_key = posting.symbol_key
       JOIN requested ON requested.symbol_id = compact_symbol.symbol_id
       WHERE compact_snapshot.snapshot_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM symbols AS overrides
           WHERE overrides.snapshot_id = ? AND overrides.id = compact_symbol.symbol_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_symbol_deletions AS deletions
           WHERE deletions.snapshot_id = ? AND deletions.symbol_id = compact_symbol.symbol_id
         )
     )
     SELECT symbol_id, term, MAX(weight) AS weight
     FROM effective_terms
     GROUP BY symbol_id, term
     ORDER BY symbol_id, weight DESC, term`,
    [...nodeIds, snapshotId, snapshotId, baseId, snapshotId, snapshotId, baseId, snapshotId, snapshotId],
  );
}

function selectAnalysisReceipt(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<AnalysisReceiptRow>(
      `SELECT version, symbol_count, edge_count, digest
       FROM snapshot_analysis_summary_receipts WHERE snapshot_id = ? LIMIT 2`,
      [snapshotId],
    );
    if (rows.length > 1) return yield* Effect.fail(corrupt('The snapshot analysis receipt is not unique.'));
    return rows[0] ? normalizedAnalysisReceipt(rows[0]) : undefined;
  });
}

function selectComponentReceipt(sql: SqlClient.SqlClient, snapshotId: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<ComponentReceiptRow>(
      `SELECT version, row_count, edge_count, digest
       FROM snapshot_component_edge_aggregate_receipts WHERE snapshot_id = ? LIMIT 2`,
      [snapshotId],
    );
    if (rows.length > 1) return yield* Effect.fail(corrupt('The snapshot component receipt is not unique.'));
    return rows[0] ? normalizedComponentReceipt(rows[0]) : undefined;
  });
}

function selectLexicalReceipts(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<LexicalReceiptRow>(
      `SELECT snapshot_id, format_version, posting_count, symbol_count, term_count
       FROM lexical_storage_formats
       WHERE snapshot_id IN (?, ?)
       ORDER BY snapshot_id`,
      [snapshotId, baseSnapshotId ?? ''],
    );
    return rows.map(row => ({
      formatVersion: safeCount(row.format_version, 'lexical format version'),
      postingCount: safeCount(row.posting_count, 'lexical posting count'),
      snapshotId: requiredText(row.snapshot_id, 'lexical snapshot identity'),
      symbolCount: safeCount(row.symbol_count, 'lexical symbol count'),
      termCount: safeCount(row.term_count, 'lexical term count'),
    }));
  });
}

function groupLookupRows(rows: readonly LookupProjectionRow[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const nodeId = requiredText(row.symbol_id, 'lookup symbol identity');
    const values = grouped.get(nodeId) ?? [];
    values.push(requiredText(row.lookup_key, 'symbol lookup key'));
    grouped.set(nodeId, values);
  }
  return grouped;
}

function groupTermRows(rows: readonly TermProjectionRow[]): Map<string, CodeGraphWorksetRoutingTermV1[]> {
  const grouped = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
  for (const row of rows) {
    const nodeId = requiredText(row.symbol_id, 'term symbol identity');
    const term = requiredText(row.term, 'symbol routing term');
    const weight = finiteNumber(row.weight, 'symbol routing term weight');
    const values = grouped.get(nodeId) ?? [];
    values.push({term, weight});
    grouped.set(nodeId, values);
  }
  return grouped;
}

function selectLookupKeys(
  intrinsic: readonly string[],
  resolved: readonly string[],
  stats: MutableProjectionStats,
): readonly string[] {
  const intrinsicKeys = [...new Set(intrinsic)].sort(compareText);
  const intrinsicSet = new Set(intrinsicKeys);
  const aliasKeys = [...new Set(resolved)].filter(key => !intrinsicSet.has(key)).sort(compareText);
  const all = [...intrinsicKeys, ...aliasKeys];
  stats.lookupKeysObserved += all.length;
  stats.lookupKeysOmitted += Math.max(0, all.length - CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol);
  return all.slice(0, CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol);
}

function selectTerms(
  terms: readonly CodeGraphWorksetRoutingTermV1[],
  stats: MutableProjectionStats,
): readonly CodeGraphWorksetRoutingTermV1[] {
  const unique = new Map<string, number>();
  for (const term of terms) unique.set(term.term, Math.max(unique.get(term.term) ?? 0, term.weight));
  const ranked = [...unique]
    .map(([term, weight]) => ({term, weight}))
    .sort((left, right) => right.weight - left.weight || compareText(left.term, right.term));
  stats.termsObserved += ranked.length;
  stats.termsOmitted += Math.max(0, ranked.length - CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol);
  return ranked.slice(0, CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol);
}

function decodeLookupKeys(value: unknown): readonly string[] {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_LOOKUP_JSON_BYTES) {
    throw corrupt('A ready snapshot symbol has an invalid lookup-key surface.');
  }
  const parsed = parseJson(value, 'symbol lookup-key surface');
  if (!Array.isArray(parsed)) throw corrupt('A ready snapshot symbol has an invalid lookup-key surface.');
  return parsed.map(candidate => requiredText(candidate, 'symbol lookup key'));
}

function decodeSpan(value: unknown): CodeGraphWorksetCatalogSpanV1 {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAXIMUM_SPAN_JSON_BYTES) {
    throw corrupt('A ready snapshot symbol has an invalid evidence span.');
  }
  const parsed = parseJson(value, 'symbol evidence span');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corrupt('A ready snapshot symbol has an invalid evidence span.');
  }
  const record = parsed as Record<string, unknown>;
  return {
    column: safeCount(record.column, 'symbol span column'),
    endColumn: safeCount(record.endColumn, 'symbol span end column'),
    endLine: safeCount(record.endLine, 'symbol span end line'),
    line: safeCount(record.line, 'symbol span line'),
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw corrupt(`The ${label} is not valid JSON.`, cause);
  }
}

function normalizedAnalysisReceipt(row: AnalysisReceiptRow) {
  return {
    digest: requiredText(row.digest, 'analysis receipt digest'),
    edgeCount: safeCount(row.edge_count, 'analysis edge count'),
    symbolCount: safeCount(row.symbol_count, 'analysis symbol count'),
    version: safeCount(row.version, 'analysis receipt version'),
  };
}

function validateOptionalReceipts(
  analysis: ReturnType<typeof normalizedAnalysisReceipt> | undefined,
  component: ReturnType<typeof normalizedComponentReceipt> | undefined,
  lexical: readonly {
    readonly formatVersion: number;
    readonly postingCount: number;
    readonly snapshotId: string;
    readonly symbolCount: number;
    readonly termCount: number;
  }[],
  symbolCount: number,
  edgeCount: number,
): void {
  if (
    analysis !== undefined &&
    (analysis.version !== 1 ||
      !SHA256_HEX.test(analysis.digest) ||
      analysis.symbolCount !== symbolCount ||
      analysis.edgeCount !== edgeCount)
  ) {
    throw corrupt('The ready snapshot analysis receipt is inconsistent.');
  }
  if (component !== undefined && (component.version !== 1 || !SHA256_HEX.test(component.digest))) {
    throw corrupt('The ready snapshot component receipt is inconsistent.');
  }
  if (lexical.some(receipt => receipt.formatVersion !== CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION)) {
    throw corrupt('The ready snapshot lexical receipt is incompatible.');
  }
}

function normalizedComponentReceipt(row: ComponentReceiptRow) {
  return {
    digest: requiredText(row.digest, 'component receipt digest'),
    edgeCount: safeCount(row.edge_count, 'component edge count'),
    rowCount: safeCount(row.row_count, 'component row count'),
    version: safeCount(row.version, 'component receipt version'),
  };
}

function readySnapshotProjectionDigest(input: {
  readonly baseSnapshotId: string | undefined;
  readonly commitId: string;
  readonly componentCount: number;
  readonly dependencyCount: number;
  readonly dirty: boolean;
  readonly extractorGeneration: number;
  readonly extractorSet: string;
  readonly graphContentId: string | undefined;
  readonly lookupKeysObserved: number;
  readonly overlayFingerprint: string | undefined;
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly symbolCount: number;
  readonly termsObserved: number;
}): string {
  return sha256HexSync(
    JSON.stringify([
      'threadnote-ready-code-graph-routing-source-v1',
      input.repositoryId,
      input.snapshotId,
      input.graphContentId ?? null,
      input.baseSnapshotId ?? null,
      input.commitId,
      input.dirty ? 1 : 0,
      input.overlayFingerprint ?? null,
      input.extractorSet,
      input.extractorGeneration,
      input.symbolCount,
      input.componentCount,
      input.dependencyCount,
      input.lookupKeysObserved,
      input.termsObserved,
    ]),
  );
}

function sameSnapshotProjectionRow(left: SnapshotProjectionRow, right: SnapshotProjectionRow): boolean {
  return (
    left.snapshot_id === right.snapshot_id &&
    left.repository_id === right.repository_id &&
    left.commit_id === right.commit_id &&
    left.graph_content_id === right.graph_content_id &&
    left.base_snapshot_id === right.base_snapshot_id &&
    left.extractor_set === right.extractor_set &&
    left.dirty === right.dirty &&
    left.overlay_fingerprint === right.overlay_fingerprint &&
    left.symbol_count === right.symbol_count &&
    left.edge_count === right.edge_count
  );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw corrupt(`The ${label} is invalid.`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredText(value, label);
}

function safeCount(value: unknown, label: string): number {
  const count = typeof value === 'bigint' ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw corrupt(`The ${label} is invalid.`);
  }
  return count;
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw corrupt(`The ${label} is invalid.`);
  return number;
}

function booleanInteger(value: unknown, label: string): boolean {
  const integer = typeof value === 'bigint' ? Number(value) : value;
  if (integer !== 0 && integer !== 1) throw corrupt(`The ${label} is invalid.`);
  return integer === 1;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`Workset projection ${label} is invalid.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('invalid-input', message, cause === undefined ? undefined : {cause});
}

function missing(message: string): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('missing', message);
}

function corrupt(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('corrupt', message, cause === undefined ? undefined : {cause});
}

function storage(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('storage', message, cause === undefined ? undefined : {cause});
}
