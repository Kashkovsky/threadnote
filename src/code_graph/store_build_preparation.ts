import {Clock, Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {isCodeGraphReferenceWithinCandidateBudget} from './fact_budget.js';
import {compareCodeUnits} from './ordering.js';
import {type CodeGraphDirectPersistentCapacityProtector, type CodeGraphStagingBatch} from './store_models.js';
import {configureConnection, configureReconstructibleBuildDurability} from './store_session.js';
import {
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  type RepositoryIdentity,
  CodeGraphStoreError,
} from './types.js';
import {type CodeGraphWorkspace} from './languages/types.js';
import {
  ACTIVATION_FILE_BATCH_ROWS,
  ACTIVATION_REFERENCE_BATCH_ROWS,
  type ActivationStagingObserver,
  assertPersistentBuildOwner,
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  type CodeGraphWriterGate,
  isPersistedIncrementalResolutionClosure,
  persistedIncrementalProjectFilesMatch,
  persistedIncrementalSurfaceMatches,
  persistentBoundTextBytes,
  persistentFullInventoryCapacityBoundary,
  prepareAnalysisResolutionTables,
  type PreparedPersistedFullFactBatch,
  type PreparedPersistedFullWorkspace,
  preparePersistedFullResolutionViews,
  registerPersistentMaterializationPlan,
  type SnapshotPromotionCapacityPlan,
  stageActivationEdges,
  stageActivationFiles,
  stageActivationSymbols,
  stageActivationSymbolTerms,
} from './store_build_core.js';
import {clearSnapshotOwnedRows} from './store_cleanup_core.js';
import {chunk, sortedBy, symbolTerms, uniqueBy} from './store_utilities.js';
import {type CodeGraphSqlQueryStatement} from './store_visualization_sql.js';
import {
  normalizedReexportProvenance,
  prepareActivationTables,
  snapshotPromotionLeaseCapacity,
  stageActivationReferences,
} from './store_staging_core.js';
import {promotionRemovedSnapshotId, stagePersistedFullFacts} from './store_resolution_core.js';
import {selectReusableBaseReceipt} from './store_queries.js';

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */

/**
 * Superseded persistent builds can own repository-sized durable tables. Reclaim
 * their exact identities before the replacement build starts, one transaction
 * at a time. The writer gate is released between pages so linked worktrees can
 * make progress; unlike best-effort detached cleanup, this required path waits
 * through contention until every still-eligible target is gone.
 */

const preparePersistedFullActivation = Effect.fn('codeGraph.preparePersistedFullActivation')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  expectedBatchCount?: number,
  ownerToken?: string,
  writerGate?: CodeGraphWriterGate,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  if (ownerToken === undefined) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent full-build ownership is required.'));
  }
  // Persistent full builds keep repository-sized facts in durable tables.
  // Their connection-private tables are bounded to one resolution page, so
  // retaining those small B-trees in memory avoids temp-file pager and journal
  // I/O without risking repository-proportional RSS.
  yield* sql.unsafe('PRAGMA temp_store = MEMORY');
  yield* configureReconstructibleBuildDurability(sql);
  yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
  const snapshots = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT state FROM snapshots WHERE id = ${snapshotId} LIMIT 1
  `;
  const state = snapshots[0]?.state;
  if (state === undefined) {
    return yield* Effect.fail(new CodeGraphStoreError(`Building snapshot ${snapshotId} is unavailable.`));
  }
  if (state === 'ready' || state === 'retired') {
    return yield* Effect.fail(new CodeGraphStoreError(`Snapshot ${snapshotId} cannot be materialized from ${state}.`));
  }
  if (state === 'failed') {
    // A caught failure is explicitly discarded. A process interruption leaves
    // the snapshot in `building`, whose committed batch receipts are resumed.
    yield* clearSnapshotOwnedRows(sql, snapshotId, runWrite, ownerToken);
    yield* runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* sql`
          UPDATE snapshots
          SET state = 'building', file_count = 0, symbol_count = 0, edge_count = 0,
              completed_at = NULL, failure_summary = NULL
          WHERE id = ${snapshotId} AND state = 'failed'
        `;
        }),
      ),
    );
  }
  if (expectedBatchCount !== undefined) {
    if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization batch count is invalid.'));
    }
    const planCapacity: CodeGraphDirectPersistentCapacityBoundary = {
      finalFactBytes: 0,
      operation: 'register persistent code graph materialization plan',
      rowCount: 2,
    };
    const planTransaction = runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* registerPersistentMaterializationPlan(sql, snapshotId, ownerToken, expectedBatchCount);
        }),
      ),
    );
    yield* persistentCapacityProtector ? persistentCapacityProtector(planCapacity, planTransaction) : planTransaction;
    const stale = yield* sql<{readonly count: number}>`
      SELECT COUNT(*) AS count
      FROM building_materialization_batches
      WHERE snapshot_id = ${snapshotId} AND batch_index >= ${expectedBatchCount}
    `;
    if (Number(stale[0]?.count ?? 0) > 0) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persisted full-build batch receipts no longer match the inventory.'),
      );
    }
  }

  for (const batch of chunk(
    sortedBy(files, file => file.path),
    ACTIVATION_FILE_BATCH_ROWS,
  )) {
    const inventoryCapacity = persistentFullInventoryCapacityBoundary(snapshotId, batch);
    const inventoryTransaction = runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* sql.unsafe(
            `INSERT OR IGNORE INTO snapshot_files (
             snapshot_id, path, content_hash, language, mode, size, source
           ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            batch.flatMap(file => [
              snapshotId,
              file.path,
              file.contentHash,
              file.language,
              file.mode,
              file.size,
              file.source,
            ]),
          );
          const rows = yield* sql.unsafe<{
            readonly content_hash: string;
            readonly language: string;
            readonly mode: string;
            readonly path: string;
            readonly size: number;
            readonly source: CodeGraphInventoryFile['source'];
          }>(
            `SELECT path, content_hash, language, mode, size, source
           FROM snapshot_files
           WHERE snapshot_id = ? AND path IN (${batch.map(() => '?').join(', ')})`,
            [snapshotId, ...batch.map(file => file.path)],
          );
          const stored = new Map(rows.map(row => [row.path, row]));
          const mismatch = batch.find(file => {
            const row = stored.get(file.path);
            return (
              row === undefined ||
              row.content_hash !== file.contentHash ||
              row.language !== file.language ||
              row.mode !== file.mode ||
              Number(row.size) !== file.size ||
              row.source !== file.source
            );
          });
          if (mismatch) {
            return yield* Effect.fail(
              new CodeGraphStoreError(`Persisted full-build inventory changed at ${mismatch.path}.`),
            );
          }
        }),
      ),
    );
    yield* persistentCapacityProtector
      ? persistentCapacityProtector(inventoryCapacity, inventoryTransaction)
      : inventoryTransaction;
    yield* Effect.yieldNow;
  }
  const fileCounts = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ${snapshotId}
  `;
  if (Number(fileCounts[0]?.count ?? -1) !== files.length) {
    return yield* Effect.fail(new CodeGraphStoreError('Persisted full-build inventory contains stale extra files.'));
  }

  // Only the resolution cursor remains connection-private. All repository-sized
  // surfaces are durable and keyed by the still-invisible building snapshot.
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_resolved_reference_batch (
      old_edge_id TEXT PRIMARY KEY,
      new_edge_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL
    ) WITHOUT ROWID
  `);
  // Durable lookup rows are keyed by lookup key, while references are paged by
  // edge id. Materialize both bounded page views so resolution can scan lookup
  // keys in index order instead of issuing tens of thousands of effectively
  // random probes into a multi-gigabyte lookup B-tree.
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_resolution_reference_page (
      edge_id TEXT PRIMARY KEY,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL,
      relation TEXT NOT NULL,
      source_id TEXT
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_resolution_candidate_page (
      lookup_key TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      PRIMARY KEY (lookup_key, edge_id, tier)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_resolution_lookup_page (
      lookup_key TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      symbol_count INTEGER NOT NULL,
      minimum_symbol_id TEXT,
      maximum_symbol_id TEXT,
      exported_symbol_count INTEGER NOT NULL,
      minimum_exported_symbol_id TEXT,
      maximum_exported_symbol_id TEXT,
      PRIMARY KEY (lookup_key, resolution_domain)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM activation_resolution_reference_page');
  yield* sql.unsafe('DELETE FROM activation_resolution_candidate_page');
  yield* sql.unsafe('DELETE FROM activation_resolution_lookup_page');
  yield* prepareAnalysisResolutionTables(sql);
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql`
    INSERT INTO activation_state (key, value)
    VALUES ('mode', 'persisted-full'), ('snapshot_id', ${snapshotId}), ('owner_token', ${ownerToken})
  `;
  yield* preparePersistedFullResolutionViews(sql);
});

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.

function preparePersistedFullWorkspace(
  snapshotId: string,
  workspace: CodeGraphWorkspace,
): PreparedPersistedFullWorkspace {
  const workspaces = workspace.workspaces.map(scope => ({
    diagnosticsJson: JSON.stringify(scope.diagnostics),
    scope,
  }));
  const projects = workspace.projects.map(project => ({
    diagnosticsJson: JSON.stringify(project.diagnostics),
    languagesJson: JSON.stringify(project.languages),
    project,
    sourceRootsJson: JSON.stringify(project.sourceRoots),
    workspaceRootsJson: JSON.stringify(project.workspaceRoots),
  }));
  let finalFactBytes = 0;
  let rowCount = 0;
  for (const entry of workspaces) {
    const {scope} = entry;
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      scope.id,
      scope.buildSystem,
      scope.name,
      scope.root,
      scope.provenance,
      entry.diagnosticsJson,
    ]);
    rowCount = saturatingCapacityAdd(rowCount, 1);
  }
  for (const entry of projects) {
    const {project} = entry;
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      project.id,
      project.workspaceId,
      project.buildSystem,
      project.kind,
      project.name,
      project.root,
      project.resolutionDomain,
      entry.languagesJson,
      entry.sourceRootsJson,
      entry.workspaceRootsJson,
      project.provenance,
      entry.diagnosticsJson,
    ]);
    rowCount = saturatingCapacityAdd(rowCount, 1);
    for (const dependency of project.dependencyDetails) {
      finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
        snapshotId,
        project.id,
        dependency.targetId,
        dependency.provenance,
        dependency.evidence,
      ]);
      rowCount = saturatingCapacityAdd(rowCount, 1);
    }
  }
  return {
    capacity: {finalFactBytes, operation: 'stage persistent code graph workspace', rowCount},
    projects,
    workspaces,
  };
}

/**
 * Explicit deep-maintenance audit. Normal publication trusts the cumulative
 * counters committed with each resumable batch and never scans every posting.
 * This statement intentionally performs exact counts for tests and operator-
 * initiated evidence collection.
 */
export function codeGraphCompactLexicalDeepAuditStatement(snapshotId: string): CodeGraphSqlQueryStatement {
  return {
    parameters: [snapshotId],
    text: `SELECT
      format.posting_count AS expected_posting_count,
      format.symbol_count AS expected_symbol_count,
      format.term_count AS expected_term_count,
      (SELECT COUNT(*) FROM lexical_compact_postings AS posting
       WHERE posting.snapshot_key = compact.snapshot_key) AS posting_count,
      (SELECT COUNT(*) FROM lexical_compact_symbols AS symbol
       WHERE symbol.snapshot_key = compact.snapshot_key) AS symbol_count,
      (SELECT COUNT(*) FROM lexical_compact_terms AS term
       WHERE term.snapshot_key = compact.snapshot_key) AS term_count
    FROM lexical_storage_formats AS format
    JOIN lexical_compact_snapshots AS compact ON compact.snapshot_id = format.snapshot_id
    WHERE format.snapshot_id = ?
      AND format.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
    LIMIT 1`,
  };
}

function preparePersistedFullFactCapacity(batches: readonly CodeGraphStagingBatch[]): {
  readonly batches: readonly PreparedPersistedFullFactBatch[];
  readonly capacity: CodeGraphDirectPersistentCapacityBoundary;
} {
  let finalFactBytes = 0;
  let validFactBytes = true;
  let rowCount = 0;
  const prepared: PreparedPersistedFullFactBatch[] = [];
  for (const batch of batches) {
    if (batch.finalFactBytes === undefined || !Number.isSafeInteger(batch.finalFactBytes) || batch.finalFactBytes < 0) {
      validFactBytes = false;
    } else {
      finalFactBytes = saturatingCapacityAdd(finalFactBytes, batch.finalFactBytes);
    }
    const boundedReferences = sortedBy(
      batch.references.filter(isCodeGraphReferenceWithinCandidateBudget),
      reference => reference.edgeId,
    );
    const lookupRows = batch.symbols.reduce(
      (total, symbol) => saturatingCapacityAdd(total, symbol.lookupKeys?.length ?? 0),
      0,
    );
    const termsBySymbol = new Map<CodeGraphSymbol, readonly (readonly [string, number])[]>();
    let termPostings = 0;
    for (const symbol of batch.symbols) {
      const terms = termsBySymbol.get(symbol) ?? symbolTerms(symbol);
      termsBySymbol.set(symbol, terms);
      // Count each staged occurrence even if malformed caller input repeats
      // the same object identity. The later primary-key failure must never be
      // preceded by an under-sized capacity boundary.
      termPostings = saturatingCapacityAdd(termPostings, terms.length);
    }
    const reexportsByReferenceBatch = [...chunk(boundedReferences, ACTIVATION_REFERENCE_BATCH_ROWS)].map(references =>
      [
        ...uniqueBy(references.flatMap(normalizedReexportProvenance), reexport =>
          [reexport.sourcePath, reexport.localName, reexport.targetPath, reexport.importedName].join('\0'),
        ),
      ].sort(
        (left, right) =>
          compareCodeUnits(left.sourcePath, right.sourcePath) ||
          compareCodeUnits(left.localName, right.localName) ||
          compareCodeUnits(left.targetPath, right.targetPath) ||
          compareCodeUnits(left.importedName, right.importedName),
      ),
    );
    const reexportRows = reexportsByReferenceBatch.reduce(
      (total, reexports) => saturatingCapacityAdd(total, reexports.length),
      0,
    );
    rowCount = saturatingCapacityAdd(
      rowCount,
      // Durable symbols and their compact lexical dictionary rows.
      saturatingCapacityMultiply(batch.symbols.length, 2),
      lookupRows,
      // One compact-snapshot row may be attempted for each logical batch.
      1,
      // Every posting writes one posting row and can introduce at most one
      // compact term row.
      saturatingCapacityMultiply(termPostings, 2),
      batch.edges.length,
      boundedReferences.length,
      reexportRows,
      // Analysis symbol/histogram groups cannot exceed their source rows.
      batch.symbols.length,
      batch.edges.length,
      // Analysis receipt, materialization receipt, and lexical counter.
      3,
    );
    prepared.push({batch, boundedReferences, reexportsByReferenceBatch, symbolTerms: termsBySymbol});
  }
  return {
    batches: prepared,
    capacity: {
      finalFactBytes: validFactBytes ? finalFactBytes : Number.NaN,
      operation: 'stage persistent code graph facts',
      rowCount,
    },
  };
}

const stagePersistedFullFactBatches = Effect.fn('codeGraph.stagePersistedFullFactBatches')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  batches: readonly CodeGraphStagingBatch[],
  observerForBatch: (batchIndex: number) => ActivationStagingObserver,
  prepared?: readonly PreparedPersistedFullFactBatch[],
) {
  if (batches.length === 0) return;
  if (
    prepared &&
    (prepared.length !== batches.length || prepared.some((entry, index) => entry.batch !== batches[index]))
  ) {
    return yield* Effect.fail(
      new CodeGraphStoreError('Prepared persistent materialization batches no longer match staged batches.'),
    );
  }
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    if (!Number.isSafeInteger(batch.batchIndex) || batch.batchIndex < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization batch identity is invalid.'));
    }
    if (index > 0 && batch.batchIndex !== batches[index - 1]!.batchIndex + 1) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent materialization transaction batches must be contiguous.'),
      );
    }
  }

  const observers = new Map<number, ActivationStagingObserver>();
  const observer = (batchIndex: number) => {
    const existing = observers.get(batchIndex);
    if (existing) return existing;
    const created = observerForBatch(batchIndex);
    observers.set(batchIndex, created);
    return created;
  };
  const commitBatch = batches[batches.length - 1]!;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index]!;
        yield* stagePersistedFullFacts(
          sql,
          snapshotId,
          ownerToken,
          batch.batchIndex,
          batch.symbols,
          batch.edges,
          batch.references,
          observer(batch.batchIndex),
          true,
          prepared?.[index],
        );
      }
      // The physical commit belongs to the group, not to every logical
      // receipt. Attach its timing to the final receipt so per-stage evidence
      // cannot count later batch work once for every earlier observer.
      yield* observer(commitBatch.batchIndex)('committing', 0, true);
    }),
  );
  yield* observer(commitBatch.batchIndex)('committed', 0, true);
});

const preparePersistedIncrementalActivation = Effect.fn('codeGraph.preparePersistedIncrementalActivation')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
  options: {
    readonly deletedPaths?: readonly string[];
    readonly resolutionClosure?: 'changed' | 'full' | 'project';
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const resolutionClosure = options.resolutionClosure ?? 'changed';
  if (!isPersistedIncrementalResolutionClosure(resolutionClosure)) return false;
  const deletedPaths = [...new Set(options.deletedPaths ?? [])];
  if (
    (files.length === 0 && (resolutionClosure !== 'full' || deletedPaths.length === 0)) ||
    facts.length !== files.length
  ) {
    return false;
  }
  const paths = new Set(files.map(file => file.path));
  const factPaths = new Set(facts.map(file => file.path));
  if (
    paths.size !== files.length ||
    factPaths.size !== facts.length ||
    factPaths.size !== paths.size ||
    [...paths].some(path => !factPaths.has(path))
  ) {
    return false;
  }
  if (deletedPaths.some(path => paths.has(path))) return false;
  if (!(yield* selectReusableBaseReceipt(baseSnapshotId))) return false;

  yield* prepareActivationTables(sql);
  const incrementalPaths = [...paths, ...deletedPaths].sort();
  for (const batch of chunk(incrementalPaths, ACTIVATION_FILE_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO activation_incremental_paths (path)
       VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
  }
  yield* stageActivationFiles(sql, files);
  const symbols = facts.flatMap(file => file.symbols);
  yield* stageActivationSymbols(sql, symbols);
  yield* stageActivationSymbolTerms(sql, symbols);
  yield* stageActivationEdges(
    sql,
    facts.flatMap(file => file.edges),
  );
  yield* stageActivationReferences(
    sql,
    facts.flatMap(file => file.references ?? []),
  );
  const safe =
    resolutionClosure === 'changed'
      ? yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId)
      : resolutionClosure === 'project'
        ? yield* persistedIncrementalProjectFilesMatch(sql, baseSnapshotId)
        : true;
  if (!safe) {
    yield* prepareActivationTables(sql);
    return false;
  }
  yield* sql`
    INSERT INTO activation_state (key, value)
    VALUES
      ('mode', 'persisted-delta'),
      ('base_snapshot_id', ${baseSnapshotId}),
      ('resolution_closure', ${resolutionClosure})
  `;
  return true;
});

const replaceStagedModifiedFiles = Effect.fn('codeGraph.replaceStagedModifiedFiles')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const staged = yield* sql<{readonly value: string}>`
    SELECT value FROM activation_state WHERE key = 'snapshot_id' LIMIT 1
  `;
  if (staged[0]?.value !== baseSnapshotId || files.length === 0 || facts.length !== files.length) return false;
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length || facts.some(file => !paths.has(file.path))) return false;
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
  for (const batch of chunk([...paths], ACTIVATION_FILE_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO activation_incremental_paths (path)
       VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
  }
  const existing = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM activation_files AS file
    JOIN activation_incremental_paths AS changed ON changed.path = file.path
  `;
  if (Number(existing[0]?.count ?? 0) !== files.length) {
    yield* sql.unsafe('DELETE FROM activation_incremental_paths');
    return false;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`
        DELETE FROM activation_reference_candidates
        WHERE edge_id IN (
          SELECT edge.id
          FROM activation_edges AS edge
          JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_references
        WHERE edge_id IN (
          SELECT edge.id
          FROM activation_edges AS edge
          JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_edges
        WHERE evidence_path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_symbol_terms
        WHERE symbol_id IN (
          SELECT symbol.id
          FROM activation_symbols AS symbol
          JOIN activation_incremental_paths AS changed ON changed.path = symbol.path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_symbols
        WHERE path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_files
        WHERE path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* stageActivationFiles(sql, files);
      const symbols = facts.flatMap(file => file.symbols);
      yield* stageActivationSymbols(sql, symbols);
      yield* stageActivationSymbolTerms(sql, symbols);
      yield* stageActivationEdges(
        sql,
        facts.flatMap(file => file.edges),
      );
      yield* stageActivationReferences(
        sql,
        facts.flatMap(file => file.references ?? []),
      );
      yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
      yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
      yield* sql.unsafe('DELETE FROM activation_state');
    }),
  );
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
  return true;
});

const prepareSnapshotPromotionCapacity = Effect.fn('codeGraph.prepareSnapshotPromotionCapacity')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const removedSnapshotId = yield* promotionRemovedSnapshotId(sql, identity.worktreeId);
  const leaseCapacity = yield* snapshotPromotionLeaseCapacity(
    sql,
    removedSnapshotId === undefined ? [snapshotId] : [snapshotId, removedSnapshotId],
    now,
  );
  const activatedAt = new Date().toISOString();
  const fixedFactBytes = persistentBoundTextBytes(0, [identity.worktreeId, snapshotId, activatedAt, 'retired']);
  return {
    activatedAt,
    boundary: {
      finalFactBytes: saturatingCapacityAdd(fixedFactBytes, leaseCapacity.factBytes),
      operation: 'promote ready code graph snapshot',
      // One pointer upsert, one exact tombstone delete, one cleanup-epoch
      // delete, every currently observed incoming lease flag, at most one
      // removed-view lease baton, and at most one exact
      // displaced-leaf retirement.
      // Non-leaf history remains routine maintenance because proving a whole
      // descendant closure is not transaction-bounded.
      rowCount: saturatingCapacityAdd(leaseCapacity.rows, 4),
    },
    maximumLeaseFactBytes: leaseCapacity.factBytes,
    maximumLeaseRows: leaseCapacity.rows,
  } satisfies SnapshotPromotionCapacityPlan;
});

export {
  preparePersistedFullActivation,
  preparePersistedFullWorkspace,
  preparePersistedFullFactCapacity,
  stagePersistedFullFactBatches,
  preparePersistedIncrementalActivation,
  replaceStagedModifiedFiles,
  prepareSnapshotPromotionCapacity,
};
