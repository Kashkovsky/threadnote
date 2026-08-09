import {Clock, Effect, Option} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphResolutionProgressCallback,
  type CodeGraphResolutionSummary,
} from './store_models.js';
import {configureConnection} from './store_session.js';
import {type CodeGraphProvenance, type RepositoryIdentity, CodeGraphStoreError} from './types.js';
import {
  ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS,
  activationMode,
  type ActivationResolutionRow,
  assertPersistentBuildOwner,
  assertPersistentMaterializationComplete,
  type CodeGraphWriterGate,
  type PersistedFullReferencePageRow,
  type PersistedFullReferenceTotalsRow,
  PERSISTENT_FULL_RESOLUTION_PAGE_ROWS,
  RESOLUTION_PAGE_ROWS,
  type ResolvableActivationReferenceRow,
  type SnapshotPromotionCapacityPlan,
} from './store_build_core.js';
import {
  adjustPersistedAnalysisResolutionEdges,
  capturePersistedAnalysisResolutionEdges,
  codeGraphPersistedDeltaResolutionPageStatement,
  codeGraphPersistentReferencePageStatement,
  decodePersistedReferenceCandidateRows,
  persistentFullReferencePageTotal,
  persistentReferenceResolutionCapacityBoundary,
} from './store_resolution_core.js';
import {expandTransitiveReexportAliases} from './store_persistent_build.js';
import {activationEdgeId, chunk, lookupDomain, parseLookupKeys, sqlTextOption} from './store_utilities.js';
import {PERSISTENT_FULL_LOOKUP_SUMMARY_BATCH_KEYS, snapshotPromotionLeaseCapacity} from './store_staging_core.js';
import {
  codeGraphWorktreeReconciliationSchemaCompatible,
  markSnapshotLeaseRetirementBaton,
} from './store_reconciliation.js';
import {CODE_GRAPH_SNAPSHOT_ID, validCanonicalTimestamp} from './store_reconciliation_core.js';
import {CodeGraphPromotionCapacityPlanChanged} from './store_internal_models.js';
import {lastStatementChangeCount} from './store_activation_core.js';

/** Exact read-only admission shared by cleanup writers and both health paths. */

/** Fresh facts are written before the durable building snapshot owns its inventory. */

/**
 * Read-only linearization point for Manager's writer-busy fallback. A cached
 * process token is reusable only while the exact active view and the exact
 * unexpired lease coexist in one SQLite snapshot and no exact tombstone does.
 */

/**
 * Adapt copy pages toward a three-second transaction while retaining a wide
 * margin below the 15-second build heartbeat threshold. Growth is limited to
 * 2x per observation so a fast region cannot immediately create an oversized
 * synchronous SQLite statement in the next, denser B-tree region.
 */

/**
 * Copies one final-table partition in bounded keyset transactions. The target
 * snapshot remains `building`, so committed chunks are invisible to normal
 * readers while SQLite can checkpoint and the heartbeat can run between them.
 */

/** @internal Exposed so regression tests can verify the SQLite access plan. */

/**
 * Validate staged edge endpoints in bounded primary-key pages. A single
 * anti-join over a multi-million-row graph can keep SQLite in `step()` long
 * enough for an otherwise healthy owner to approach the stale-build window.
 * Page aggregates preserve the same invariant while giving the status writer
 * a regular heartbeat without hydrating every edge in JavaScript.
 */

/** Reclaim exactly one bounded build-only table page, if one is available. */

/**
 * Durable build-only rows are unreachable as soon as a snapshot is ready,
 * failed, or retired. Reclaim them after publication in independently gated
 * pages: readiness never depends on cleanup, and linked worktrees can write
 * between pages even when a large build left millions of candidate rows.
 */

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */

/**
 * Superseded persistent builds can own repository-sized durable tables. Reclaim
 * their exact identities before the replacement build starts, one transaction
 * at a time. The writer gate is released between pages so linked worktrees can
 * make progress; unlike best-effort detached cleanup, this required path waits
 * through contention until every still-eligible target is gone.
 */

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.

/**
 * Explicit deep-maintenance audit. Normal publication trusts the cumulative
 * counters committed with each resumable batch and never scans every posting.
 * This statement intentionally performs exact counts for tests and operator-
 * initiated evidence collection.
 */

// A sampled 232k-file graph resolved a 5,000-reference page with roughly 80k
// candidate matches in less than four seconds once persistent writes bypassed
// row triggers. Keep connection-private/delta pages conservative, while clean
// full-build pages are independently bounded by reference count, candidate
// count, and encoded payload bytes before their lookup tiers are decoded.

/** @internal Exposed so property tests can verify all three page bounds. */

/** @internal Exposed so regression tests can verify the SQLite access plan. */

/**
 * Resolves TypeScript barrel topology once from durable provenance, then seeds
 * exact scoped aliases before the general reference scan. Deep chains therefore
 * do not require one repository-wide unresolved pass per barrel. Seed pages,
 * a bounded closure result, and the ordinary writer fence keep this optional
 * acceleration from becoming a repository-size rejection or an unbounded write.
 * Pages whose branching closure exceeds the budget safely fall back to the
 * existing reference resolver.
 */

const resolveActivationReferences = Effect.fn('codeGraph.resolveActivationReferences')(function* (
  onProgress?: CodeGraphResolutionProgressCallback,
  writerGate?: CodeGraphWriterGate,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* Clock.currentTimeMillis;
  const mode = yield* activationMode(sql);
  if (mode?.mode === 'persisted-full') {
    yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
    yield* assertPersistentMaterializationComplete(sql, mode.snapshotId, mode.ownerToken);
  }
  const persistentFull = mode?.mode === 'persisted-full' ? mode : undefined;
  const pageRows = persistentFull ? PERSISTENT_FULL_RESOLUTION_PAGE_ROWS : RESOLUTION_PAGE_ROWS;
  const persistedBaseSnapshotId = mode?.mode === 'persisted-delta' ? mode.baseSnapshotId : undefined;
  let aliasesDiscovered = 0;
  let matchingMilliseconds = 0;
  let pagesCompleted = 0;
  let passesCompleted = 0;
  let referencesExamined = 0;
  let resolved = 0;
  let transactionMilliseconds = 0;
  const preparationCountStartedAt = yield* Clock.currentTimeMillis;
  const preparationCountRows = persistentFull
    ? yield* sql<PersistedFullReferenceTotalsRow>`
        SELECT COUNT(*) AS count,
          COALESCE(SUM(candidate_count), 0) AS candidate_count,
          COALESCE(SUM(candidate_payload_bytes), 0) AS payload_bytes
        FROM building_references
        WHERE snapshot_id = ${persistentFull.snapshotId}
      `
    : yield* sql<PersistedFullReferenceTotalsRow>`
        SELECT COUNT(*) AS count, 0 AS candidate_count, 0 AS payload_bytes
        FROM activation_references
      `;
  const preparationReferencesTotal = Number(preparationCountRows[0]?.count ?? 0);
  const preparationPageTotal = persistentFull
    ? persistentFullReferencePageTotal(preparationCountRows[0] ?? {candidate_count: 0, count: 0, payload_bytes: 0})
    : Math.ceil(preparationReferencesTotal / pageRows);
  matchingMilliseconds += (yield* Clock.currentTimeMillis) - preparationCountStartedAt;
  const reportPreparation = (aliases: number) =>
    Effect.gen(function* () {
      if (onProgress === undefined) return;
      const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - startedAt;
      yield* onProgress({
        aliasesDiscovered: aliases,
        elapsedMilliseconds,
        matchingMilliseconds,
        pageCompleted: 0,
        pageTotal: preparationPageTotal,
        pagesCompleted: 0,
        pass: 1,
        referencesCompleted: 0,
        referencesExamined: 0,
        referencesTotal: preparationReferencesTotal,
        resolved: 0,
        transactionMilliseconds: 0,
      });
    });
  // Report before any closure work, then once per bounded alias seed page. A
  // large re-export surface must not leave the build heartbeat and CLI silent
  // while resolution is actively preparing lookup aliases.
  yield* reportPreparation(0);
  yield* Effect.yieldNow;
  const aliasExpansionStartedAt = yield* Clock.currentTimeMillis;
  aliasesDiscovered += yield* expandTransitiveReexportAliases(
    sql,
    mode,
    writerGate,
    persistentCapacityProtector,
    onProgress === undefined ? undefined : aliases => reportPreparation(aliases),
  );
  matchingMilliseconds += (yield* Clock.currentTimeMillis) - aliasExpansionStartedAt;
  for (;;) {
    const countStartedAt = yield* Clock.currentTimeMillis;
    const countRows = persistentFull
      ? yield* sql<PersistedFullReferenceTotalsRow>`
          SELECT COUNT(*) AS count,
            COALESCE(SUM(candidate_count), 0) AS candidate_count,
            COALESCE(SUM(candidate_payload_bytes), 0) AS payload_bytes
          FROM building_references
          WHERE snapshot_id = ${persistentFull.snapshotId}
        `
      : yield* sql<PersistedFullReferenceTotalsRow>`
          SELECT COUNT(*) AS count, 0 AS candidate_count, 0 AS payload_bytes
          FROM activation_references
        `;
    const referencesTotal = Number(countRows[0]?.count ?? 0);
    matchingMilliseconds += (yield* Clock.currentTimeMillis) - countStartedAt;
    if (referencesTotal === 0) break;
    const pass = passesCompleted + 1;
    let pageTotal = persistentFull
      ? persistentFullReferencePageTotal(countRows[0] ?? {candidate_count: 0, count: 0, payload_bytes: 0})
      : Math.ceil(referencesTotal / pageRows);
    let cursor = '';
    let pageCompleted = 0;
    let referencesCompleted = 0;
    let resolvedInPass = 0;
    let aliasesInPass = 0;
    yield* onProgress?.({
      aliasesDiscovered,
      elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
      matchingMilliseconds,
      pageCompleted,
      pageTotal,
      pagesCompleted,
      pass,
      referencesCompleted,
      referencesExamined,
      referencesTotal,
      resolved,
      transactionMilliseconds,
    }) ?? Effect.void;
    yield* Effect.yieldNow;
    for (;;) {
      const pageStartedAt = yield* Clock.currentTimeMillis;
      let persistentPage = Option.none<readonly PersistedFullReferencePageRow[]>();
      if (persistentFull) {
        const statement = codeGraphPersistentReferencePageStatement(persistentFull.snapshotId, cursor);
        persistentPage = Option.some(
          yield* sql.unsafe<PersistedFullReferencePageRow>(statement.text, statement.parameters),
        );
      }
      const pending = Option.isSome(persistentPage)
        ? persistentPage.value
        : yield* sql.unsafe<{readonly edge_id: string}>(
            `SELECT edge_id
             FROM activation_references
             WHERE edge_id > ?
             ORDER BY edge_id
             LIMIT ${pageRows}`,
            [cursor],
          );
      if (pending.length === 0) break;
      const batchEnd = pending.at(-1)!.edge_id;
      if (persistentFull && Option.isSome(persistentPage)) {
        yield* sql.unsafe('DELETE FROM activation_resolution_reference_page');
        yield* sql.unsafe('DELETE FROM activation_resolution_candidate_page');
        yield* sql.unsafe('DELETE FROM activation_resolution_lookup_page');
        yield* sql.unsafe(
          `INSERT INTO activation_resolution_reference_page (
             edge_id, resolution_domain, exported_only, relation, source_id
           )
           SELECT reference.edge_id, reference.resolution_domain, reference.exported_only,
             edge.relation, edge.source_id
           FROM building_references AS reference
           CROSS JOIN edges AS edge
             ON edge.snapshot_id = reference.snapshot_id AND edge.id = reference.edge_id
           WHERE reference.snapshot_id = ?
             AND reference.edge_id > ? AND reference.edge_id <= ?
             AND edge.target_id IS NULL
           ORDER BY reference.edge_id`,
          [persistentFull.snapshotId, cursor, batchEnd],
        );
        yield* Effect.yieldNow;
        const candidateRows = yield* decodePersistedReferenceCandidateRows(persistentPage.value);
        for (const candidateBatch of chunk(candidateRows, ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS)) {
          yield* sql.unsafe(
            `INSERT INTO activation_resolution_candidate_page (lookup_key, edge_id, tier)
             VALUES ${candidateBatch.map(() => '(?, ?, ?)').join(', ')}`,
            candidateBatch.flat(),
          );
        }
        yield* Effect.yieldNow;
        // Aggregate each requested lookup set once. Joining the edge-ordered
        // candidate surface directly to snapshot_symbol_lookup multiplied hot
        // names (for example language constructors) for every reference and
        // turned a 5,000-reference page into minutes of random B-tree reads.
        // The lookup-key-first page makes the durable scan sequential and the
        // summary bounds all later work by page candidates, not raw fan-out.
        let lookupCursor = '';
        for (;;) {
          const requestedLookupKeys = yield* sql.unsafe<{readonly lookup_key: string}>(
            `SELECT lookup_key
             FROM activation_resolution_candidate_page
             WHERE lookup_key > ?
             GROUP BY lookup_key
             ORDER BY lookup_key
             LIMIT ${PERSISTENT_FULL_LOOKUP_SUMMARY_BATCH_KEYS}`,
            [lookupCursor],
          );
          if (requestedLookupKeys.length === 0) break;
          yield* sql.unsafe(
            `WITH requested(lookup_key) AS (
               VALUES ${requestedLookupKeys.map(() => '(?)').join(', ')}
             )
             INSERT INTO activation_resolution_lookup_page (
               lookup_key, resolution_domain, symbol_count,
               minimum_symbol_id, maximum_symbol_id,
               exported_symbol_count,
               minimum_exported_symbol_id, maximum_exported_symbol_id
             )
             SELECT lookup.lookup_key, lookup.resolution_domain,
               COUNT(*), MIN(lookup.symbol_id), MAX(lookup.symbol_id),
               SUM(CASE WHEN lookup.exported = 1 THEN 1 ELSE 0 END),
               MIN(CASE WHEN lookup.exported = 1 THEN lookup.symbol_id END),
               MAX(CASE WHEN lookup.exported = 1 THEN lookup.symbol_id END)
             FROM requested
             CROSS JOIN snapshot_symbol_lookup AS lookup
             WHERE lookup.snapshot_id = ? AND lookup.lookup_key = requested.lookup_key
             GROUP BY lookup.lookup_key, lookup.resolution_domain
             ORDER BY lookup.lookup_key, lookup.resolution_domain`,
            [...requestedLookupKeys.map(row => row.lookup_key), persistentFull.snapshotId],
          );
          lookupCursor = requestedLookupKeys.at(-1)!.lookup_key;
          yield* onProgress?.({
            aliasesDiscovered,
            elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
            matchingMilliseconds: matchingMilliseconds + (yield* Clock.currentTimeMillis) - pageStartedAt,
            pageCompleted,
            pageTotal,
            pagesCompleted,
            pass,
            referencesCompleted,
            referencesExamined,
            referencesTotal,
            resolved,
            transactionMilliseconds,
          }) ?? Effect.void;
          yield* Effect.yieldNow;
        }
      }
      const candidateTable = persistentFull ? 'building_reference_candidates' : 'activation_reference_candidates';
      const referenceTable = persistentFull ? 'building_references' : 'activation_references';
      const edgeTable = persistentFull ? 'edges' : 'activation_edges';
      const resolvedLookupTable = persistentFull ? 'snapshot_symbol_lookup' : 'activation_symbol_lookup';
      const resolvedSymbolTable = persistentFull ? 'symbols' : 'activation_symbols';
      const referenceSnapshotJoin = persistentFull ? 'reference.snapshot_id = ? AND' : '';
      const edgeSnapshotJoin = persistentFull ? 'edge.snapshot_id = ? AND' : '';
      const lookupSnapshotJoin = persistentFull ? 'lookup.snapshot_id = ? AND' : '';
      const candidateSnapshotWhere = persistentFull ? 'candidate.snapshot_id = ? AND' : '';
      const symbolSnapshotJoin = persistentFull ? 'symbol.snapshot_id = ? AND' : '';
      const candidateMatchesCtes = persistentFull
        ? `candidate_options AS (
            SELECT candidate.edge_id, candidate.tier, candidate.lookup_key,
              reference.relation, reference.source_id,
              CASE WHEN reference.exported_only = 1
                THEN lookup.exported_symbol_count ELSE lookup.symbol_count END AS symbol_count,
              CASE WHEN reference.exported_only = 1
                THEN lookup.minimum_exported_symbol_id ELSE lookup.minimum_symbol_id END AS minimum_symbol_id,
              CASE WHEN reference.exported_only = 1
                THEN lookup.maximum_exported_symbol_id ELSE lookup.maximum_symbol_id END AS maximum_symbol_id
            FROM activation_resolution_candidate_page AS candidate
            JOIN activation_resolution_reference_page AS reference
              ON reference.edge_id = candidate.edge_id
            JOIN activation_resolution_lookup_page AS lookup
              ON lookup.lookup_key = candidate.lookup_key
             AND lookup.resolution_domain = reference.resolution_domain
          ),
          filtered_candidates AS (
            SELECT edge_id, tier, lookup_key,
              symbol_count - CASE
                WHEN relation = 'overrides' AND source_id IS NOT NULL
                  AND (source_id = minimum_symbol_id OR source_id = maximum_symbol_id)
                THEN 1 ELSE 0
              END AS remaining_count,
              CASE
                WHEN symbol_count = 1 THEN minimum_symbol_id
                WHEN relation = 'overrides' AND symbol_count = 2 AND source_id = minimum_symbol_id
                  THEN maximum_symbol_id
                WHEN relation = 'overrides' AND symbol_count = 2 AND source_id = maximum_symbol_id
                  THEN minimum_symbol_id
                ELSE minimum_symbol_id
              END AS symbol_id
            FROM candidate_options
          ),
          candidate_matches AS (
            SELECT edge_id, tier, symbol_id,
              CASE WHEN remaining_count > 1 THEN 1 ELSE 0 END AS ambiguous
            FROM filtered_candidates
            WHERE remaining_count > 0 AND symbol_id IS NOT NULL
          )`
        : `candidate_matches AS (
            SELECT DISTINCT
              candidate.edge_id,
              candidate.tier,
              lookup.symbol_id,
              0 AS ambiguous
            FROM ${candidateTable} AS candidate
            CROSS JOIN ${referenceTable} AS reference
              ON ${referenceSnapshotJoin} reference.edge_id = candidate.edge_id
            CROSS JOIN ${edgeTable} AS edge
              ON ${edgeSnapshotJoin} edge.id = candidate.edge_id AND edge.target_id IS NULL
            CROSS JOIN ${resolvedLookupTable} AS lookup
              ON ${lookupSnapshotJoin} lookup.lookup_key = candidate.lookup_key
             AND lookup.resolution_domain = reference.resolution_domain
             AND (reference.exported_only = 0 OR lookup.exported = 1)
             AND (edge.relation <> 'overrides' OR lookup.symbol_id IS NOT edge.source_id)
            WHERE ${candidateSnapshotWhere} candidate.edge_id > ? AND candidate.edge_id <= ?
          )`;
      const rows = persistedBaseSnapshotId
        ? yield* (() => {
            const statement = codeGraphPersistedDeltaResolutionPageStatement(persistedBaseSnapshotId, cursor, batchEnd);
            return sql.unsafe<ResolvableActivationReferenceRow>(statement.text, statement.parameters);
          })()
        : yield* sql.unsafe<ResolvableActivationReferenceRow>(
            `
        WITH
        ${candidateMatchesCtes},
        first_tiers AS (
          SELECT edge_id, MIN(tier) AS tier
          FROM candidate_matches
          GROUP BY edge_id
        ),
        unique_candidates AS (
          SELECT match.edge_id, MIN(match.symbol_id) AS symbol_id
          FROM candidate_matches AS match
          JOIN first_tiers AS first
            ON first.edge_id = match.edge_id AND first.tier = match.tier
          GROUP BY match.edge_id
          HAVING MAX(match.ambiguous) = 0 AND COUNT(DISTINCT match.symbol_id) = 1
        )
        SELECT
          edge.*,
          reference.alias_lookup_keys_json,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        CROSS JOIN ${edgeTable} AS edge ON ${edgeSnapshotJoin} edge.id = candidate.edge_id
        CROSS JOIN ${referenceTable} AS reference
          ON ${referenceSnapshotJoin} reference.edge_id = candidate.edge_id
        CROSS JOIN ${resolvedSymbolTable} AS symbol ON ${symbolSnapshotJoin} symbol.id = candidate.symbol_id
        ORDER BY candidate.edge_id
        LIMIT ${pageRows}
        `,
            [
              ...(persistentFull ? [] : [cursor, batchEnd]),
              ...(persistentFull
                ? [persistentFull.snapshotId, persistentFull.snapshotId, persistentFull.snapshotId]
                : []),
            ],
          );
      matchingMilliseconds += (yield* Clock.currentTimeMillis) - pageStartedAt;
      cursor = batchEnd;
      const resolutions: ActivationResolutionRow[] = [];
      const aliases: Array<readonly [string, string, string, number, 'alias', string, string]> = [];
      for (const row of rows) {
        const provenance: CodeGraphProvenance =
          row.provenance === 'declared' ? 'declared' : row.relation === 'documents' ? 'syntactic' : 'resolved';
        const relation =
          row.relation === 'extends' && ['interface', 'protocol'].includes(row.symbol_kind)
            ? 'implements'
            : row.relation;
        resolutions.push({
          confidence: provenance === 'declared' || provenance === 'resolved' ? 1 : row.confidence,
          newEdgeId: activationEdgeId(
            Option.getOrUndefined(sqlTextOption(row.source_id)),
            row.source_name,
            relation,
            row.target_symbol_id,
            row.target_symbol_name,
            provenance,
            row.evidence_path,
          ),
          oldEdgeId: row.id,
          provenance,
          relation,
          targetId: row.target_symbol_id,
          targetName: row.target_symbol_name,
        });
        for (const alias of parseLookupKeys(row.alias_lookup_keys_json)) {
          aliases.push([
            alias,
            row.target_symbol_id,
            lookupDomain(alias, Option.getOrUndefined(sqlTextOption(row.symbol_resolution_domain))),
            row.symbol_exported,
            'alias',
            row.id,
            row.evidence_path,
          ]);
        }
      }
      aliasesInPass += aliases.length;
      aliasesDiscovered += aliases.length;
      if (rows.length > 0) {
        const transactionStartedAt = yield* Clock.currentTimeMillis;
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            if (mode?.mode === 'persisted-full') {
              yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
            }
            yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
            for (const batch of chunk(resolutions, 400)) {
              yield* sql.unsafe(
                `INSERT INTO activation_resolved_reference_batch (
                old_edge_id, new_edge_id, relation, target_id, target_name, provenance, confidence
              ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                batch.flatMap(row => [
                  row.oldEdgeId,
                  row.newEdgeId,
                  row.relation,
                  row.targetId,
                  row.targetName,
                  row.provenance,
                  row.confidence,
                ]),
              );
            }
            if (mode?.mode === 'persisted-full') {
              yield* capturePersistedAnalysisResolutionEdges(sql, mode.snapshotId);
            }
            for (const batch of chunk(aliases, 500)) {
              if (persistentFull) {
                yield* sql.unsafe(
                  `INSERT OR IGNORE INTO snapshot_symbol_lookup (
                     snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
                     provenance, evidence_edge_id, evidence_path
                   ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                  batch.flatMap(row => [persistentFull.snapshotId, ...row]),
                );
              } else {
                yield* sql.unsafe(
                  `INSERT OR IGNORE INTO activation_symbol_lookup (
                     lookup_key, symbol_id, resolution_domain, exported,
                     provenance, evidence_edge_id, evidence_path
                   ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                  batch.flat(),
                );
              }
            }
            if (persistentFull) {
              yield* sql.unsafe(
                `INSERT OR REPLACE INTO edges (
                   snapshot_id, id, source_id, source_name, relation, target_id, target_name,
                   provenance, confidence, evidence_path, evidence_span_json
                 )
                 SELECT
                   ?, resolution.new_edge_id, edge.source_id, edge.source_name,
                   resolution.relation, resolution.target_id, resolution.target_name,
                   resolution.provenance, resolution.confidence,
                   edge.evidence_path, edge.evidence_span_json
                 FROM activation_resolved_reference_batch AS resolution
                 CROSS JOIN edges AS edge
                   ON edge.snapshot_id = ? AND edge.id = resolution.old_edge_id
                 ORDER BY resolution.new_edge_id`,
                [persistentFull.snapshotId, persistentFull.snapshotId],
              );
              yield* sql.unsafe(
                `DELETE FROM edges
                 WHERE snapshot_id = ?
                   AND id IN (
                     SELECT old_edge_id
                     FROM activation_resolved_reference_batch
                     WHERE old_edge_id <> new_edge_id
                   )
                   AND id NOT IN (SELECT new_edge_id FROM activation_resolved_reference_batch)`,
                [persistentFull.snapshotId],
              );
              yield* adjustPersistedAnalysisResolutionEdges(sql, persistentFull.snapshotId);
              // The compact candidate payload is owned by this reference row,
              // so one bounded delete retires both after a successful page.
              yield* sql.unsafe(
                `DELETE FROM building_references
                 WHERE snapshot_id = ?
                   AND edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)`,
                [persistentFull.snapshotId],
              );
            } else {
              yield* sql.unsafe(`
                INSERT OR REPLACE INTO activation_edges (
                  id, source_id, source_name, relation, target_id, target_name, provenance,
                  confidence, evidence_path, evidence_span_json
                )
                SELECT
                  resolution.new_edge_id,
                  edge.source_id,
                  edge.source_name,
                  resolution.relation,
                  resolution.target_id,
                  resolution.target_name,
                  resolution.provenance,
                  resolution.confidence,
                  edge.evidence_path,
                  edge.evidence_span_json
                FROM activation_resolved_reference_batch AS resolution
                JOIN activation_edges AS edge ON edge.id = resolution.old_edge_id
              `);
              yield* sql.unsafe(`
                DELETE FROM activation_edges
                WHERE id IN (
                  SELECT old_edge_id
                  FROM activation_resolved_reference_batch
                  WHERE old_edge_id <> new_edge_id
                )
                  AND id NOT IN (SELECT new_edge_id FROM activation_resolved_reference_batch)
              `);
              yield* sql.unsafe(`
                DELETE FROM activation_reference_candidates
                WHERE edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)
              `);
              yield* sql.unsafe(`
                DELETE FROM activation_references
                WHERE edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)
              `);
            }
          }),
        );
        const gatedTransaction = mode?.mode === 'persisted-full' && writerGate ? writerGate(transaction) : transaction;
        yield* persistentCapacityProtector
          ? persistentCapacityProtector(
              persistentReferenceResolutionCapacityBoundary(
                mode?.mode === 'persisted-full' ? mode.snapshotId : (persistedBaseSnapshotId ?? 'temporary'),
                rows,
                resolutions,
                aliases,
                mode?.mode !== 'persisted-full',
              ),
              gatedTransaction,
            )
          : gatedTransaction;
        transactionMilliseconds += (yield* Clock.currentTimeMillis) - transactionStartedAt;
      }
      resolvedInPass += rows.length;
      resolved += rows.length;
      pageCompleted += 1;
      // Aggregate candidate/byte ceilings normally predict the exact page
      // count. Pathological alternating payload shapes can require more pages;
      // grow the denominator before emitting so persisted status remains valid
      // without a repository-wide boundary pre-scan.
      pageTotal = Math.max(pageTotal, pageCompleted);
      pagesCompleted += 1;
      referencesCompleted += pending.length;
      referencesExamined += pending.length;
      yield* onProgress?.({
        aliasesDiscovered,
        elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
        matchingMilliseconds,
        pageCompleted,
        pageTotal,
        pagesCompleted,
        pass,
        referencesCompleted,
        referencesExamined,
        referencesTotal,
        resolved,
        transactionMilliseconds,
      }) ?? Effect.void;
      // Reference resolution is synchronous SQLite work. Yield after every
      // bounded page so the independent build heartbeat and observers cannot
      // be starved for the duration of an entire repository-sized pass.
      yield* Effect.yieldNow;
    }
    passesCompleted += 1;
    if (resolvedInPass === 0 || aliasesInPass === 0) break;
  }
  return {
    aliasesDiscovered,
    elapsedMilliseconds: (yield* Clock.currentTimeMillis) - startedAt,
    matchingMilliseconds,
    pagesCompleted,
    passesCompleted,
    referencesExamined,
    resolved,
    transactionMilliseconds,
  } satisfies CodeGraphResolutionSummary;
});

const promoteSnapshot = Effect.fn('codeGraph.promoteSnapshot')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
  capacity: SnapshotPromotionCapacityPlan,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph promotion authority schema is unavailable.'));
      }
      const candidate = yield* sql<{
        readonly generation: number | null;
        readonly id: string;
        readonly minimum_generation: number;
      }>`
        SELECT snapshot.id, generation.generation,
          CAST(minimum.value AS INTEGER) AS minimum_generation
        FROM snapshots AS snapshot
        JOIN schema_metadata AS minimum ON minimum.key = 'minimum_extractor_generation'
        LEFT JOIN snapshot_extractor_generations AS generation ON generation.snapshot_id = snapshot.id
        WHERE snapshot.id = ${snapshotId} AND snapshot.state = 'ready'
        LIMIT 1
      `;
      if (!candidate[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} cannot be promoted.`));
      }
      if (
        candidate[0].generation === null ||
        Number(candidate[0].generation) < Number(candidate[0].minimum_generation)
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Ready snapshot ${snapshotId} was built by an incompatible extractor generation.`),
        );
      }
      const active = yield* sql.unsafe<{readonly snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN snapshot_id ELSE NULL END AS snapshot_id
         FROM active_snapshots WHERE worktree_id = ? LIMIT 2`,
        [identity.worktreeId],
      );
      const displacedSnapshotId = active[0]?.snapshot_id;
      if (
        active.length > 1 ||
        (displacedSnapshotId !== undefined &&
          (typeof displacedSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(displacedSnapshotId)))
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph active view authority is invalid.'));
      }
      const removed = yield* sql.unsafe<{
        readonly expected_snapshot_id: unknown;
        readonly removed_at: unknown;
      }>(
        `SELECT
           CASE WHEN typeof(expected_snapshot_id) = 'text'
                      AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
             THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
           CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
             THEN removed_at ELSE NULL END AS removed_at
         FROM removed_views WHERE worktree_id = ? LIMIT 2`,
        [identity.worktreeId],
      );
      const removedSnapshotId = removed[0]?.expected_snapshot_id;
      const removedAt = removed[0]?.removed_at;
      if (
        removed.length > 1 ||
        (removedSnapshotId !== undefined &&
          (typeof removedSnapshotId !== 'string' ||
            !CODE_GRAPH_SNAPSHOT_ID.test(removedSnapshotId) ||
            typeof removedAt !== 'string' ||
            !validCanonicalTimestamp(removedAt)))
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
      }
      const observedLeaseCapacity = yield* snapshotPromotionLeaseCapacity(
        sql,
        typeof removedSnapshotId === 'string' ? [snapshotId, removedSnapshotId] : [snapshotId],
        yield* Clock.currentTimeMillis,
      );
      if (
        observedLeaseCapacity.rows > capacity.maximumLeaseRows ||
        observedLeaseCapacity.factBytes > capacity.maximumLeaseFactBytes
      ) {
        return yield* Effect.fail(new CodeGraphPromotionCapacityPlanChanged());
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
        VALUES (${identity.worktreeId}, ${snapshotId}, ${capacity.activatedAt})
        ON CONFLICT(worktree_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          activated_at = excluded.activated_at
      `;
      // Only a current promotion contract may make this worktree visible
      // again. Mixed-version writers can still publish active_snapshots, but
      // the durable tombstone keeps those pointers hidden until this delete.
      if (typeof removedSnapshotId === 'string') {
        if (removedSnapshotId !== snapshotId) {
          yield* markSnapshotLeaseRetirementBaton(sql, removedSnapshotId, now);
        }
        yield* sql`
          DELETE FROM removed_view_cleanup
          WHERE worktree_id = ${identity.worktreeId}
            AND expected_snapshot_id = ${removedSnapshotId}
            AND removed_at = ${removedAt as string}
        `;
        yield* sql`
          DELETE FROM removed_views
          WHERE worktree_id = ${identity.worktreeId}
            AND expected_snapshot_id = ${removedSnapshotId}
            AND removed_at = ${removedAt as string}
        `;
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority changed.'));
        }
      }
      // A lease acquired by ID may precede promotion. Once its snapshot owns
      // an active pointer, its final release must reclaim that view after it is
      // displaced just like a lease acquired while the pointer was active.
      yield* markSnapshotLeaseRetirementBaton(sql, snapshotId, now);
      if (displacedSnapshotId === undefined || displacedSnapshotId === snapshotId) return 0;
      yield* sql`
        UPDATE snapshots AS candidate
        SET state = 'retired'
        WHERE candidate.id = ${displacedSnapshotId}
          AND candidate.state = 'ready'
          AND NOT EXISTS (
            SELECT 1 FROM active_snapshots AS active
            WHERE active.snapshot_id = candidate.id
              AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active.worktree_id
                  AND removed.expected_snapshot_id = active.snapshot_id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = candidate.id AND lease.expires_at > ${now}
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshots AS child WHERE child.base_snapshot_id = candidate.id
          )
      `;
      return yield* lastStatementChangeCount(sql);
    }),
  );
});

export {resolveActivationReferences, promoteSnapshot};
