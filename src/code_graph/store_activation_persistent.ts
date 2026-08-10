import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {saturatingCapacityAdd, type CodeGraphDirectPersistentCapacityBoundary} from './disk_capacity.js';
import {
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  type CodeGraphActivationProgressCallback,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphReusableBaseReceiptInput,
} from './store_models.js';
import {LEGACY_BUILDING_REFERENCES_V3_TABLE} from './store_schema_contracts.js';
import {configureConnection, configurePublicationDurability, tableExists} from './store_session.js';
import {type CodeGraphSnapshot, type RepositoryIdentity, CodeGraphStoreError} from './types.js';
import {
  analysisEdgeAggregateFromRow,
  analysisSymbolAggregateFromRow,
  codeGraphAnalysisSummaryDigest,
  type PersistedAnalysisEdgeRow,
  type PersistedAnalysisSymbolRow,
  selectAnalysisSummary,
} from './store_analysis.js';
import {type CodeGraphActivationLease, type SnapshotRow} from './store_internal_models.js';
import {snapshotFromRow} from './store_rows.js';
import {sqlTextOption, upsertRepository} from './store_utilities.js';
import {
  activationProgressObserver,
  type ActivationProgressObserver,
  type CodeGraphEdgeEndpoint,
  COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS,
  copyPersistentActivationRows,
  countPersistedFullReuseRows,
  dropPersistedFullResolutionViews,
  materializeCleanSnapshotAnalysisSummary,
  materializeOverlaySnapshotAnalysisSummary,
  nextPersistentActivationBatchRows,
  PERSISTENT_ACTIVATION_COPY_SPECS,
  PERSISTENT_ACTIVATION_ENDPOINT_VALIDATION_PAGE_ROWS,
  type PersistentActivationCopyResult,
} from './store_activation_core.js';
import {clearCompactLexicalSnapshotRows, purgeSnapshotTerms} from './store_cleanup_core.js';
import {copyActivationCompactLexicalFacts} from './store_staging_core.js';
import {
  assertPersistentBuildOwner,
  assertPersistentMaterializationComplete,
  type CodeGraphWriterGate,
  type CompactLexicalFormatReceipt,
  publishCompactLexicalFormat,
  recordCompactLexicalFormat,
  validatedCompactLexicalReceipt,
} from './store_build_core.js';
import {associateSnapshotFileShards} from './store_cache.js';
import {insertActivationLease, recordSnapshotExtractorGeneration} from './store_maintenance_core.js';
import {type CodeGraphSqlQueryStatement} from './store_visualization_sql.js';
import {selectReusableBaseReceipt} from './store_queries.js';
import {
  materializeSnapshotComponentEdgeAggregates,
  selectPersistedSnapshotComponentEdges,
} from './store_component_aggregates.js';

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

const recordSnapshotAnalysisReceipt = Effect.fn('codeGraph.recordSnapshotAnalysisReceipt')(function* (
  sql: SqlClient.SqlClient,
  snapshot: CodeGraphSnapshot,
) {
  const invalidHistogram = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM snapshot_analysis_edge_histogram
    WHERE snapshot_id = ${snapshot.id} AND count <= 0
  `;
  if (Number(invalidHistogram[0]?.count ?? 0) > 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph analysis histogram contains invalid counts.'));
  }
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      sql<PersistedAnalysisSymbolRow>`
        SELECT language, kind, count FROM snapshot_analysis_symbol_counts
        WHERE snapshot_id = ${snapshot.id} ORDER BY language, kind
      `,
      sql<PersistedAnalysisEdgeRow>`
        SELECT provenance, relation, count, confidence_invalid, confidence_total,
          lowest_confidence, confidence_high, confidence_medium, confidence_low,
          unresolved_endpoint_count, self_loop_count, review_finding_count
        FROM snapshot_analysis_edge_counts
        WHERE snapshot_id = ${snapshot.id} ORDER BY provenance, relation
      `,
    ],
    {concurrency: 1},
  );
  const symbols = symbolRows.map(analysisSymbolAggregateFromRow);
  const edges = edgeRows.map(analysisEdgeAggregateFromRow);
  const symbolCount = symbols.reduce((total, row) => total + row.count, 0);
  const edgeCount = edges.reduce((total, row) => total + row.count, 0);
  if (symbolCount !== snapshot.symbolCount || edgeCount !== snapshot.edgeCount) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph analysis totals do not match the snapshot (${symbolCount}/${snapshot.symbolCount} symbols, ` +
          `${edgeCount}/${snapshot.edgeCount} edges).`,
      ),
    );
  }
  yield* sql`
    INSERT INTO snapshot_analysis_summary_receipts (
      snapshot_id, version, symbol_count, edge_count, digest, created_at
    ) VALUES (
      ${snapshot.id}, 1, ${symbolCount}, ${edgeCount},
      ${codeGraphAnalysisSummaryDigest(symbols, edges)}, ${new Date().toISOString()}
    )
    ON CONFLICT(snapshot_id) DO UPDATE SET
      version = excluded.version,
      symbol_count = excluded.symbol_count,
      edge_count = excluded.edge_count,
      digest = excluded.digest,
      created_at = excluded.created_at
  `;
});

const ensureReadySnapshotAnalysisSummary = Effect.fn('codeGraph.ensureReadySnapshotAnalysisSummary')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  // Treat a receipt as complete only when its compact rows still reproduce the
  // recorded totals and digest. A crashed beta or manual database recovery can
  // otherwise leave a plausible receipt that makes every later writer skip the
  // repair while readers repeatedly fall back to the expensive raw scan.
  const existing = yield* selectAnalysisSummary(snapshotId);
  const existingComponentEdges = yield* selectPersistedSnapshotComponentEdges(snapshotId);
  if (Option.isSome(existing) && Option.isSome(existingComponentEdges)) return false;
  const rows = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1`;
  if (!rows[0]) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  const snapshot = snapshotFromRow(rows[0]);
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
  if (Option.isNone(existing)) {
    if (baseSnapshotId) {
      const baseSummary = yield* selectAnalysisSummary(baseSnapshotId);
      if (Option.isNone(baseSummary)) {
        const baseRows = yield* sql<SnapshotRow>`
          SELECT * FROM snapshots WHERE id = ${baseSnapshotId} AND state = 'ready' LIMIT 1
        `;
        const base = baseRows[0];
        if (!base || Option.isSome(sqlTextOption(base.base_snapshot_id))) {
          return yield* Effect.fail(
            new CodeGraphStoreError(
              'Nested legacy overlays require a clean code graph rebuild before summary backfill.',
            ),
          );
        }
        const baseSnapshot = snapshotFromRow(base);
        yield* materializeCleanSnapshotAnalysisSummary(sql, baseSnapshot);
        yield* recordSnapshotAnalysisReceipt(sql, baseSnapshot);
      }
      yield* materializeOverlaySnapshotAnalysisSummary(sql, snapshot, baseSnapshotId);
    } else {
      yield* materializeCleanSnapshotAnalysisSummary(sql, snapshot);
    }
    yield* recordSnapshotAnalysisReceipt(sql, snapshot);
  }
  if (Option.isNone(existingComponentEdges)) yield* materializeSnapshotComponentEdgeAggregates(sql, snapshot.id);
  return true;
});

const activateCleanStagedSnapshot = Effect.fn('codeGraph.activateCleanStagedSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  validatedEdges: number,
  reusableBaseReceipt: CodeGraphReusableBaseReceiptInput | undefined,
  promotionLease: Option.Option<CodeGraphActivationLease>,
  observe: ActivationProgressObserver,
) {
  const existing = yield* sql<{readonly started_at: string}>`
    SELECT started_at FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
  `;
  const startedAt = existing[0]?.started_at ?? new Date().toISOString();
  yield* clearCompactLexicalSnapshotRows(sql, snapshot.id);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* upsertRepository(sql, identity);
      yield* purgeSnapshotTerms(sql, snapshot.id);
      yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
      yield* sql`
        INSERT INTO snapshots (
          id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
          dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
        ) VALUES (
          ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
          ${snapshot.graphContentId ?? snapshot.id}, NULL, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
          ${snapshot.overlayFingerprint ?? null},
          'building', ${snapshot.fileCount}, ${snapshot.symbolCount}, ${snapshot.edgeCount}, ${startedAt}, NULL
        )
      `;
    }),
  );
  yield* observe('copying-workspace', 'started');
  const copiedWorkspaceScopes = yield* copyPersistentActivationRows(
    sql,
    snapshot.id,
    PERSISTENT_ACTIVATION_COPY_SPECS.workspaceScopes,
    'copying-workspace',
    observe,
  );
  const copiedWorkspaceComponents = yield* copyPersistentActivationRows(
    sql,
    snapshot.id,
    PERSISTENT_ACTIVATION_COPY_SPECS.workspaceComponents,
    'copying-workspace',
    observe,
    copiedWorkspaceScopes.rows,
  );
  const copiedWorkspaceDependencies = yield* copyPersistentActivationRows(
    sql,
    snapshot.id,
    PERSISTENT_ACTIVATION_COPY_SPECS.workspaceDependencies,
    'copying-workspace',
    observe,
    copiedWorkspaceScopes.rows + copiedWorkspaceComponents.rows,
  );
  yield* observe(
    'copying-workspace',
    'completed',
    copiedWorkspaceScopes.rows + copiedWorkspaceComponents.rows + copiedWorkspaceDependencies.rows,
  );

  yield* observe('copying-files', 'started');
  const copiedFiles = yield* copyPersistentActivationRows(
    sql,
    snapshot.id,
    PERSISTENT_ACTIVATION_COPY_SPECS.files,
    'copying-files',
    observe,
  );
  yield* observe('copying-files', 'completed', copiedFiles.rows);
  if (copiedFiles.rows !== snapshot.fileCount) {
    return yield* Effect.fail(new CodeGraphStoreError('Staged file count does not match the ready snapshot.'));
  }
  yield* observe('copying-symbols', 'started');
  const copiedSymbols = yield* copyPersistentActivationRows(
    sql,
    snapshot.id,
    PERSISTENT_ACTIVATION_COPY_SPECS.symbols,
    'copying-symbols',
    observe,
  );
  yield* observe('copying-symbols', 'completed', copiedSymbols.rows);
  if (copiedSymbols.rows !== snapshot.symbolCount) {
    return yield* Effect.fail(new CodeGraphStoreError('Staged symbol count does not match the ready snapshot.'));
  }
  yield* observe('copying-terms', 'started');
  const copiedTerms = yield* copyActivationCompactLexicalFacts(sql, snapshot.id, 'all');
  yield* observe('copying-terms', 'completed', copiedTerms.postingCount);
  if (copiedTerms.symbolCount !== snapshot.symbolCount) {
    return yield* Effect.fail(new CodeGraphStoreError('Compact lexical symbol count does not match the snapshot.'));
  }
  yield* observe('copying-edges', 'started');
  const copiedEdges = yield* copyPersistentActivationRows(
    sql,
    snapshot.id,
    PERSISTENT_ACTIVATION_COPY_SPECS.edges,
    'copying-edges',
    observe,
  );
  yield* observe('copying-edges', 'completed', copiedEdges.rows);
  if (copiedEdges.rows !== snapshot.edgeCount || copiedEdges.rows !== validatedEdges) {
    return yield* Effect.fail(new CodeGraphStoreError('Staged edge count does not match the ready snapshot.'));
  }
  let copiedLookupKeys: PersistentActivationCopyResult = {rows: 0, talliedRows: 0};
  let copiedReexports: PersistentActivationCopyResult = {rows: 0, talliedRows: 0};
  if (!snapshot.dirty && reusableBaseReceipt) {
    yield* observe('copying-lookup-keys', 'started');
    copiedLookupKeys = yield* copyPersistentActivationRows(
      sql,
      snapshot.id,
      PERSISTENT_ACTIVATION_COPY_SPECS.lookupKeys,
      'copying-lookup-keys',
      observe,
    );
    yield* observe('copying-lookup-keys', 'completed', copiedLookupKeys.rows);
    yield* observe('copying-reexports', 'started');
    copiedReexports = yield* copyPersistentActivationRows(
      sql,
      snapshot.id,
      PERSISTENT_ACTIVATION_COPY_SPECS.reexports,
      'copying-reexports',
      observe,
    );
    yield* observe('copying-reexports', 'completed', copiedReexports.rows);
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* recordCompactLexicalFormat(sql, snapshot.id, copiedTerms, copiedTerms.postingCount, snapshot.symbolCount);
      yield* associateSnapshotFileShards(sql, snapshot, reusableBaseReceipt);
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
      if (!snapshot.dirty && reusableBaseReceipt) {
        yield* sql`
          INSERT INTO snapshot_reuse_receipts (
            snapshot_id, format_version, resolution_surface_version, extractor_set,
            workspace_fingerprint, file_set_fingerprint, lookup_count, alias_count,
            reexport_count, created_at
          )
          VALUES (
            ${snapshot.id}, ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, 1, ${snapshot.extractorSet},
            ${reusableBaseReceipt.workspaceFingerprint}, ${reusableBaseReceipt.fileSetFingerprint},
            ${copiedLookupKeys.rows}, ${copiedLookupKeys.talliedRows}, ${copiedReexports.rows},
            ${new Date().toISOString()}
          )
        `;
      }
      yield* insertActivationLease(sql, snapshot.id, promotionLease);
      yield* observe('recording-completion', 'started');
      yield* sql`
        UPDATE snapshots
        SET state = 'ready', completed_at = ${new Date().toISOString()}
        WHERE id = ${snapshot.id} AND state = 'building'
      `;
      yield* observe('recording-completion', 'completed', 1);
      yield* observe('committing-snapshot', 'started');
    }),
  );
  yield* observe('committing-snapshot', 'completed');
  yield* observe('checkpointing-snapshot', 'started');
  // The ready snapshot is durable in the committed WAL. Avoid a repository-
  // sized synchronous checkpoint here; the configured auto-checkpoint policy
  // has already checkpointed safe pages between bounded copy transactions.
  yield* observe('checkpointing-snapshot', 'completed');
  yield* sql`
    INSERT OR REPLACE INTO activation_state (key, value)
    VALUES ('snapshot_id', ${snapshot.id})
  `;
});

/** @internal Exposed so regression tests can verify the SQLite access plan. */
export function codeGraphPersistedEndpointValidationPageStatement(
  snapshotId: string,
  endpoint: CodeGraphEdgeEndpoint,
  cursor: Option.Option<string>,
  pageRows = PERSISTENT_ACTIVATION_ENDPOINT_VALIDATION_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const column = endpoint === 'source' ? 'source_id' : 'target_id';
  const index = endpoint === 'source' ? 'edges_source' : 'edges_target';
  const cursorPredicate = Option.isSome(cursor) ? `AND edge.${column} > ?` : '';
  return {
    parameters: [snapshotId, ...Option.toArray(cursor), pageRows, snapshotId],
    text: `WITH raw_page AS MATERIALIZED (
       SELECT edge.${column} AS symbol_id
       FROM edges AS edge INDEXED BY ${index}
       WHERE edge.snapshot_id = ?
         AND edge.${column} IS NOT NULL
         ${cursorPredicate}
       ORDER BY edge.${column}
       LIMIT ?
     ),
     endpoint_page AS (
       SELECT raw_page.symbol_id
       FROM raw_page
       GROUP BY raw_page.symbol_id
     )
     SELECT
       COALESCE((SELECT MAX(symbol_id) FROM raw_page), '') AS cursor,
       COALESCE(MIN(CASE WHEN symbol.id IS NULL THEN endpoint_page.symbol_id END), '') AS invalid_symbol_id,
       (SELECT COUNT(*) FROM raw_page) AS raw_rows,
       COUNT(*) AS rows_examined
     FROM endpoint_page
     LEFT JOIN symbols AS symbol INDEXED BY sqlite_autoindex_symbols_1
       ON symbol.snapshot_id = ? AND symbol.id = endpoint_page.symbol_id`,
  };
}

function persistedEndpointEdgeStatement(
  snapshotId: string,
  endpoint: CodeGraphEdgeEndpoint,
  symbolId: string,
): CodeGraphSqlQueryStatement {
  const column = endpoint === 'source' ? 'source_id' : 'target_id';
  const index = endpoint === 'source' ? 'edges_source' : 'edges_target';
  return {
    parameters: [snapshotId, symbolId],
    text: `SELECT edge.id
      FROM edges AS edge INDEXED BY ${index}
      WHERE edge.snapshot_id = ? AND edge.${column} = ?
      ORDER BY edge.relation, edge.id
      LIMIT 1`,
  };
}

/**
 * Validate staged edge endpoints in bounded primary-key pages. A single
 * anti-join over a multi-million-row graph can keep SQLite in `step()` long
 * enough for an otherwise healthy owner to approach the stale-build window.
 * Page aggregates preserve the same invariant while giving the status writer
 * a regular heartbeat without hydrating every edge in JavaScript.
 */

const validatePersistedFullEdgeSymbols = Effect.fn('codeGraph.validatePersistedFullEdgeSymbols')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  observe: ActivationProgressObserver,
) {
  // Edge IDs are content hashes and therefore random with respect to their
  // endpoints. Validate bounded raw pages in the existing endpoint indexes,
  // deduplicating only inside each page before probing the symbol primary key.
  // Advancing past the last validated endpoint may skip further duplicate
  // occurrences, which is safe because endpoint existence is set membership.
  let examined = 0;
  for (const endpoint of ['source', 'target'] as const) {
    let cursor = Option.none<string>();
    for (;;) {
      const statement = codeGraphPersistedEndpointValidationPageStatement(snapshotId, endpoint, cursor);
      const rows = yield* sql.unsafe<{
        readonly cursor: string;
        readonly invalid_symbol_id: string;
        readonly raw_rows: number;
        readonly rows_examined: number;
      }>(statement.text, statement.parameters);
      const page = rows[0];
      const rawRows = Number(page?.raw_rows ?? 0);
      const rowsExamined = Number(page?.rows_examined ?? 0);
      if (
        !Number.isSafeInteger(rawRows) ||
        rawRows < 0 ||
        !Number.isSafeInteger(rowsExamined) ||
        rowsExamined < 0 ||
        rowsExamined > rawRows
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Persistent edge validation returned an invalid row count.'));
      }
      if (page?.invalid_symbol_id) {
        const edgeStatement = persistedEndpointEdgeStatement(snapshotId, endpoint, page.invalid_symbol_id);
        const edgeRows = yield* sql.unsafe<{readonly id: string}>(edgeStatement.text, edgeStatement.parameters);
        const edgeId = edgeRows[0]?.id;
        return yield* Effect.fail(
          new CodeGraphStoreError(
            edgeId
              ? `Code graph edge ${edgeId} references a missing symbol (${endpoint} endpoint ${page.invalid_symbol_id}).`
              : `Code graph ${endpoint} endpoint ${page.invalid_symbol_id} references a missing symbol.`,
          ),
        );
      }
      if (rawRows === 0) break;
      if (typeof page?.cursor !== 'string' || (Option.isSome(cursor) && page.cursor <= cursor.value)) {
        return yield* Effect.fail(new CodeGraphStoreError('Persistent edge validation cursor did not advance.'));
      }
      cursor = Option.some(page.cursor);
      examined += rowsExamined;
      yield* observe('validating-input', 'progress', examined);
      if (rawRows < PERSISTENT_ACTIVATION_ENDPOINT_VALIDATION_PAGE_ROWS) break;
    }
  }
  const countRows = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM edges WHERE snapshot_id = ${snapshotId}
  `;
  const edgeCount = Number(countRows[0]?.count ?? -1);
  if (!Number.isSafeInteger(edgeCount) || edgeCount < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent edge validation returned an invalid edge count.'));
  }
  return edgeCount;
});

/** Reclaim exactly one bounded build-only table page, if one is available. */

/**
 * Durable build-only rows are unreachable as soon as a snapshot is ready,
 * failed, or retired. Reclaim them after publication in independently gated
 * pages: readiness never depends on cleanup, and linked worktrees can write
 * between pages even when a large build left millions of candidate rows.
 */
const drainCompletedPersistentBuildRows = Effect.fn('codeGraph.drainCompletedPersistentBuildRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string | undefined,
  writerGate?: CodeGraphWriterGate,
  maximumPagesPerTable = Number.POSITIVE_INFINITY,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  let totalDeleted = 0;
  for (const spec of COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    let batchRows: number = spec.batchRows;
    let pages = 0;
    for (;;) {
      const startedAt = performance.now();
      const deleted = yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            const key = `(${spec.keyColumns.join(', ')})`;
            yield* sql.unsafe(
              `DELETE FROM ${spec.table}
             WHERE ${key} IN (
               SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               FROM ${spec.table} AS candidate
               JOIN snapshots AS snapshot ON snapshot.id = candidate.snapshot_id
               WHERE snapshot.state <> 'building'
                 AND (? IS NULL OR candidate.snapshot_id = ?)
               ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               LIMIT ?
             )`,
              [snapshotId ?? null, snapshotId ?? null, batchRows],
            );
            const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
            return Number(changes[0]?.count ?? 0);
          }),
        ),
      );
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return yield* Effect.fail(new CodeGraphStoreError('Completed build cleanup returned an invalid count.'));
      }
      if (deleted === 0) break;
      totalDeleted += deleted;
      pages += 1;
      const transactionMilliseconds = Math.max(0, performance.now() - startedAt);
      batchRows = nextPersistentActivationBatchRows(batchRows, transactionMilliseconds, spec.maximumBatchRows);
      yield* Effect.yieldNow;
      if (pages >= maximumPagesPerTable) break;
    }
  }
  let remaining = false;
  for (const spec of COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    const rows = yield* sql.unsafe<{readonly present: number}>(
      `SELECT EXISTS(
         SELECT 1
         FROM ${spec.table} AS candidate
         JOIN snapshots AS snapshot ON snapshot.id = candidate.snapshot_id
         WHERE snapshot.state <> 'building'
           AND (? IS NULL OR candidate.snapshot_id = ?)
         LIMIT 1
       ) AS present`,
      [snapshotId ?? null, snapshotId ?? null],
    );
    if (Number(rows[0]?.present ?? 0) !== 0) {
      remaining = true;
      break;
    }
  }
  return {deleted: totalDeleted, remaining};
});

const activatePersistedFullSnapshot = Effect.fn('codeGraph.activatePersistedFullSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  ownerToken: string,
  reusableBaseReceipt: CodeGraphReusableBaseReceiptInput | undefined,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
  onProgress?: CodeGraphActivationProgressCallback,
  writerGate?: CodeGraphWriterGate,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  const observe = activationProgressObserver(onProgress);
  yield* configureConnection(sql);
  yield* assertPersistentBuildOwner(sql, snapshot.id, ownerToken);
  yield* observe('validating-input', 'started');
  if (snapshot.baseSnapshotId !== undefined) {
    return yield* Effect.fail(
      new CodeGraphStoreError('Persistent full activation only accepts self-contained snapshots.'),
    );
  }
  if (snapshot.dirty && reusableBaseReceipt !== undefined) {
    return yield* Effect.fail(new CodeGraphStoreError('Dirty snapshots cannot publish a reusable clean-base receipt.'));
  }
  const stateRows = yield* sql<{
    readonly repository_id: string;
    readonly state: CodeGraphSnapshot['state'];
  }>`SELECT repository_id, state FROM snapshots WHERE id = ${snapshot.id} LIMIT 1`;
  if (stateRows[0]?.state !== 'building' || stateRows[0]?.repository_id !== identity.repositoryId) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent full-build snapshot is not active.'));
  }
  yield* assertPersistentMaterializationComplete(sql, snapshot.id, ownerToken);
  const validatedEdges = yield* validatePersistedFullEdgeSymbols(sql, snapshot.id, observe);
  if (validatedEdges !== snapshot.edgeCount) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent edge count does not match the ready snapshot.'));
  }
  const counts = yield* sql<{
    readonly completed_batches: number;
    readonly files: number;
    readonly postings: number;
    readonly symbols: number;
    readonly terms: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM snapshot_files WHERE snapshot_id = ${snapshot.id}) AS files,
      completed_batch_count AS completed_batches,
      posting_count AS postings,
      symbol_count AS symbols,
      term_count AS terms
    FROM building_lexical_counters
    WHERE snapshot_id = ${snapshot.id}
    LIMIT 1
  `;
  if (
    Number(counts[0]?.files ?? -1) !== snapshot.fileCount ||
    Number(counts[0]?.symbols ?? -1) !== snapshot.symbolCount ||
    Number(counts[0]?.completed_batches ?? -1) < 0
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent full-build fact counts do not match the snapshot.'));
  }
  const compactLexicalReceipt = {
    postingCount: Number(counts[0]?.postings ?? -1),
    symbolCount: Number(counts[0]?.symbols ?? -1),
    termCount: Number(counts[0]?.terms ?? -1),
  } satisfies CompactLexicalFormatReceipt;
  if (
    [compactLexicalReceipt.postingCount, compactLexicalReceipt.symbolCount, compactLexicalReceipt.termCount].some(
      count => !Number.isSafeInteger(count) || count < 0,
    )
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent compact lexical row count is invalid.'));
  }
  const reuseRows = reusableBaseReceipt
    ? yield* countPersistedFullReuseRows(sql, snapshot.id, observe)
    : {aliasCount: 0, lookupCount: 0, reexportCount: 0};
  yield* validatedCompactLexicalReceipt(
    compactLexicalReceipt,
    compactLexicalReceipt.postingCount,
    snapshot.symbolCount,
  );
  yield* observe('validating-input', 'progress', compactLexicalReceipt.postingCount);
  yield* observe('validating-input', 'completed', snapshot.fileCount + snapshot.symbolCount + snapshot.edgeCount);

  yield* configurePublicationDurability(sql);
  yield* observe('recording-completion', 'started');
  yield* observe('committing-snapshot', 'started');
  const publicationCapacity: CodeGraphDirectPersistentCapacityBoundary = {
    finalFactBytes: 0,
    operation: 'publish persistent code graph snapshot',
    // File-shard association can publish one row per inventory file. The six
    // fixed rows conservatively cover lexical/extractor/reuse/lease receipts,
    // the ready-state update, and build-owner deletion.
    rowCount:
      Number.isSafeInteger(snapshot.fileCount) && snapshot.fileCount >= 0
        ? saturatingCapacityAdd(snapshot.fileCount, 6)
        : Number.NaN,
  };
  let readyTransactionStartedAt = 0;
  const readyTransaction = Effect.suspend(() => {
    readyTransactionStartedAt = performance.now();
    return runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshot.id, ownerToken);
          yield* assertPersistentMaterializationComplete(sql, snapshot.id, ownerToken);
          yield* publishCompactLexicalFormat(sql, snapshot.id, compactLexicalReceipt);
          yield* associateSnapshotFileShards(sql, snapshot, reusableBaseReceipt);
          yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
          if (reusableBaseReceipt) {
            yield* sql`
          INSERT INTO snapshot_reuse_receipts (
            snapshot_id, format_version, resolution_surface_version, extractor_set,
            workspace_fingerprint, file_set_fingerprint, lookup_count, alias_count,
            reexport_count, created_at
          ) VALUES (
            ${snapshot.id}, ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, 1, ${snapshot.extractorSet},
            ${reusableBaseReceipt.workspaceFingerprint}, ${reusableBaseReceipt.fileSetFingerprint},
            ${reuseRows.lookupCount}, ${reuseRows.aliasCount}, ${reuseRows.reexportCount},
            ${new Date().toISOString()}
          )
        `;
          }
          yield* insertActivationLease(sql, snapshot.id, promotionLease);
          const completed = yield* sql<{readonly id: string}>`
        UPDATE snapshots
        SET state = 'ready', file_count = ${snapshot.fileCount}, symbol_count = ${snapshot.symbolCount},
          edge_count = ${snapshot.edgeCount}, completed_at = ${new Date().toISOString()}, failure_summary = NULL
        WHERE id = ${snapshot.id}
          AND state = 'building'
          AND EXISTS (
            SELECT 1
            FROM snapshot_build_owners
            WHERE snapshot_id = ${snapshot.id} AND owner_token = ${ownerToken}
          )
        RETURNING id
      `;
          if (!completed[0]) {
            return yield* Effect.fail(new CodeGraphStoreError('Persistent full-build promotion lost ownership.'));
          }
          yield* sql`
        DELETE FROM snapshot_build_owners
        WHERE snapshot_id = ${snapshot.id} AND owner_token = ${ownerToken}
      `;
        }),
      ),
    );
  });
  yield* persistentCapacityProtector
    ? persistentCapacityProtector(publicationCapacity, readyTransaction)
    : readyTransaction;
  const readyTransactionMilliseconds = Math.max(0, performance.now() - readyTransactionStartedAt);
  yield* observe('recording-completion', 'completed', 1, readyTransactionMilliseconds);
  yield* observe('committing-snapshot', 'completed', undefined, readyTransactionMilliseconds);
  // Connection-private cleanup is not part of the publication contract. A
  // fresh connection drops these TEMP objects automatically; a long-lived
  // session attempts cleanup but cannot turn an already-ready snapshot into a
  // reported indexing failure.
  yield* dropPersistedFullResolutionViews(sql).pipe(Effect.ignore);
});

const activateCleanSnapshotAlias = Effect.fn('codeGraph.activateCleanSnapshotAlias')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  baseSnapshotId: string,
) {
  yield* configureConnection(sql);
  if (snapshot.dirty || snapshot.baseSnapshotId !== baseSnapshotId) {
    return yield* Effect.fail(new CodeGraphStoreError('Clean snapshot alias has the wrong base snapshot.'));
  }
  const baseRows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots
    WHERE id = ${baseSnapshotId} AND repository_id = ${snapshot.repositoryId}
      AND extractor_set = ${snapshot.extractorSet} AND state = 'ready'
      AND dirty = 0 AND base_snapshot_id IS NULL
    LIMIT 1
  `;
  const base = baseRows[0];
  if (
    !base ||
    Number(base.file_count) !== snapshot.fileCount ||
    Number(base.symbol_count) !== snapshot.symbolCount ||
    Number(base.edge_count) !== snapshot.edgeCount ||
    !(yield* selectReusableBaseReceipt(baseSnapshotId))
  ) {
    return yield* Effect.fail(new CodeGraphStoreError(`Reusable clean base ${baseSnapshotId} is unavailable.`));
  }
  const baseGraphContentId = Option.getOrUndefined(sqlTextOption(base.graph_content_id)) ?? base.id;
  if (snapshot.graphContentId !== undefined && snapshot.graphContentId !== baseGraphContentId) {
    return yield* Effect.fail(new CodeGraphStoreError('Clean snapshot alias has different graph content.'));
  }
  const prior = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshot.id} LIMIT 1`;
  if (prior[0]?.state === 'ready') {
    const existing = snapshotFromRow(prior[0]);
    if (
      existing.baseSnapshotId === baseSnapshotId &&
      existing.commit === snapshot.commit &&
      existing.repositoryId === snapshot.repositoryId &&
      existing.extractorSet === snapshot.extractorSet &&
      (existing.graphContentId ?? existing.id) === (snapshot.graphContentId ?? baseGraphContentId) &&
      !existing.dirty
    ) {
      return;
    }
    return yield* Effect.fail(
      new CodeGraphStoreError(`Snapshot alias ${snapshot.id} already has incompatible content.`),
    );
  }
  const completedAt = new Date().toISOString();
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* upsertRepository(sql, identity);
      yield* purgeSnapshotTerms(sql, snapshot.id);
      yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
      yield* sql`
        INSERT INTO snapshots (
          id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
          dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
          started_at, completed_at
        ) VALUES (
          ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
          ${snapshot.graphContentId ?? baseGraphContentId}, ${baseSnapshotId}, ${snapshot.extractorSet},
          0, NULL, 'ready', ${snapshot.fileCount},
          ${snapshot.symbolCount}, ${snapshot.edgeCount}, ${completedAt}, ${completedAt}
        )
      `;
      yield* sql`
        INSERT INTO workspace_scopes (
          snapshot_id, id, build_system, name, root, provenance, diagnostics_json
        )
        SELECT ${snapshot.id}, id, build_system, name, root, provenance, diagnostics_json
        FROM workspace_scopes WHERE snapshot_id = ${baseSnapshotId}
      `;
      yield* sql`
        INSERT INTO workspace_components (
          snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
          languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
        )
        SELECT ${snapshot.id}, id, workspace_id, build_system, kind, name, root, resolution_domain,
          languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
        FROM workspace_components WHERE snapshot_id = ${baseSnapshotId}
      `;
      yield* sql`
        INSERT INTO workspace_component_dependencies (
          snapshot_id, source_component_id, target_component_id, provenance, evidence
        )
        SELECT ${snapshot.id}, source_component_id, target_component_id, provenance, evidence
        FROM workspace_component_dependencies WHERE snapshot_id = ${baseSnapshotId}
      `;
      yield* sql`
        INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
        SELECT ${snapshot.id}, path, shard_id
        FROM snapshot_file_shards WHERE snapshot_id = ${baseSnapshotId}
      `;
      yield* sql`INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (${snapshot.id})`;
      yield* publishCompactLexicalFormat(sql, snapshot.id, {postingCount: 0, symbolCount: 0, termCount: 0});
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
    }),
  );
});

export {
  recordSnapshotAnalysisReceipt,
  activateCleanStagedSnapshot,
  persistedEndpointEdgeStatement,
  validatePersistedFullEdgeSymbols,
  drainCompletedPersistentBuildRows,
  ensureReadySnapshotAnalysisSummary,
  activatePersistedFullSnapshot,
  activateCleanSnapshotAlias,
};
