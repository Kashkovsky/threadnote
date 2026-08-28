import {Effect, Option} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  type CodeGraphActivationProgressCallback,
  type CodeGraphLanguagePackProvenance,
  type CodeGraphReusableBaseReceiptInput,
} from './store_models.js';
import {encodeCodeGraphInventoryReuseReceipt} from './inventory_reuse.js';
import {configureConnection} from './store_session.js';
import {type CodeGraphSnapshot, type RepositoryIdentity, CodeGraphStoreError} from './types.js';
import {type CodeGraphActivationLease} from './store_internal_models.js';
import {
  activationProgressObserver,
  lastStatementChangeCount,
  persistedIncrementalFactCounts,
  validateStagedEdgeSymbols,
} from './store_activation_core.js';
import {
  type CompactLexicalFormatReceipt,
  isPersistedIncrementalResolutionClosure,
  persistedIncrementalProjectFilesMatch,
  persistedIncrementalSurfaceMatches,
  recordCompactLexicalFormat,
  validatedCompactLexicalCount,
} from './store_build_core.js';
import {activateCleanStagedSnapshot} from './store_activation_persistent.js';
import {clearCompactLexicalSnapshotRows, purgeSnapshotTerms} from './store_cleanup_core.js';
import {upsertRepository} from './store_utilities.js';
import {copyActivationCompactLexicalFacts} from './store_staging_core.js';
import {identifyChangedSymbols} from './store_resolution_core.js';
import {associateSnapshotFileShards, inheritSnapshotFileShards} from './store_cache.js';
import {insertActivationLease, recordSnapshotExtractorGeneration} from './store_maintenance_core.js';
import {selectReusableBaseReceipt} from './store_queries.js';
import {recordSnapshotPackProvenance} from './store_pack_provenance.js';
import {
  persistedIncrementalEdgeDeletionsStatement,
  persistedIncrementalFileDeletionsStatement,
  persistedIncrementalSymbolDeletionsStatement,
} from './store_incremental_plan.js';

const recordLayeredSnapshotInventoryReceipt = Effect.fn('codeGraph.recordLayeredSnapshotInventoryReceipt')(function* (
  sql: SqlClient.SqlClient,
  snapshot: CodeGraphSnapshot,
  receipt: CodeGraphReusableBaseReceiptInput,
  createdAt: string,
) {
  yield* sql`
      INSERT INTO snapshot_reuse_receipts (
        snapshot_id, format_version, resolution_surface_version, extractor_set,
        workspace_fingerprint, file_set_fingerprint, lookup_count, alias_count,
        reexport_count, inventory_receipt_json, created_at
      ) VALUES (
        ${snapshot.id}, ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}, ${snapshot.extractorSet},
        ${receipt.workspaceFingerprint}, ${receipt.fileSetFingerprint}, 0, 0, 0,
        ${encodeCodeGraphInventoryReuseReceipt(receipt.inventory)}, ${createdAt}
      )
    `;
});

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

const activateStagedSnapshot = Effect.fn('codeGraph.activateStagedSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
  onProgress?: CodeGraphActivationProgressCallback,
  snapshotPackProvenance?: readonly CodeGraphLanguagePackProvenance[],
) {
  const observe = activationProgressObserver(onProgress);
  yield* observe('validating-input', 'started');
  let activated = false;
  let compactLexicalReceipt: CompactLexicalFormatReceipt = {postingCount: 0, symbolCount: 0, termCount: 0};
  const baseSnapshotId = snapshot.baseSnapshotId;
  if (baseSnapshotId) {
    const base = yield* sql<{readonly id: string}>`
      SELECT id FROM snapshots WHERE id = ${baseSnapshotId} AND state = 'ready' LIMIT 1
    `;
    if (!base[0]) {
      return yield* Effect.fail(
        new CodeGraphStoreError(`Base snapshot ${baseSnapshotId} is not ready for a dirty overlay.`),
      );
    }
  }
  const validatedEdges = yield* validateStagedEdgeSymbols(sql, observe);
  if (validatedEdges !== snapshot.edgeCount) {
    return yield* Effect.fail(new CodeGraphStoreError('Staged edge count does not match the ready snapshot.'));
  }
  if (!baseSnapshotId) {
    const ready = yield* sql<{readonly id: string}>`
      SELECT id FROM snapshots WHERE id = ${snapshot.id} AND state = 'ready' LIMIT 1
    `;
    if (!ready[0]) {
      yield* observe('validating-input', 'completed', validatedEdges);
      yield* activateCleanStagedSnapshot(
        sql,
        identity,
        snapshot,
        validatedEdges,
        reusableBaseReceipt,
        promotionLease,
        observe,
        snapshotPackProvenance,
      );
      return;
    }
  }
  const stagedCounts = yield* sql<{
    readonly edges: number;
    readonly files: number;
    readonly lookup_keys: number;
    readonly reexports: number;
    readonly symbols: number;
    readonly terms: number;
    readonly workspace_rows: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM activation_edges) AS edges,
      (SELECT COUNT(*) FROM activation_files) AS files,
      (SELECT COUNT(*) FROM activation_symbol_lookup) AS lookup_keys,
      (SELECT COUNT(*) FROM activation_reexport_provenance) AS reexports,
      (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      (SELECT COUNT(*) FROM activation_symbol_terms) AS terms,
      (SELECT COUNT(*) FROM activation_workspace_scopes)
        + (SELECT COUNT(*) FROM activation_workspace_components)
        + (SELECT COUNT(*) FROM activation_workspace_dependencies)
        + (SELECT COUNT(*) FROM activation_workspace_external_dependencies)
        + (SELECT COUNT(*) FROM activation_monikers) AS workspace_rows
  `;
  const counts = stagedCounts[0];
  if (
    !counts ||
    Number(counts.files) !== snapshot.fileCount ||
    Number(counts.symbols) !== snapshot.symbolCount ||
    Number(counts.edges) !== snapshot.edgeCount ||
    Number(counts.edges) !== validatedEdges
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Staged code graph counts do not match the ready snapshot.'));
  }
  yield* observe('validating-input', 'completed', counts.files + counts.symbols + counts.edges);
  const priorSnapshot = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT state FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
  `;
  if (priorSnapshot[0]?.state !== 'ready') {
    yield* clearCompactLexicalSnapshotRows(sql, snapshot.id);
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* upsertRepository(sql, identity);
      const existing = yield* sql<{
        readonly started_at: string;
        readonly state: CodeGraphSnapshot['state'];
      }>`
        SELECT state, started_at FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
      `;
      if (existing[0]?.state !== 'ready') {
        const startedAt = existing[0]?.started_at ?? new Date().toISOString();
        yield* purgeSnapshotTerms(sql, snapshot.id);
        yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
        yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.graphContentId ?? snapshot.id}, ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet},
            ${snapshot.dirty ? 1 : 0},
            ${snapshot.overlayFingerprint ?? null}, 'building', ${snapshot.fileCount}, ${snapshot.symbolCount},
            ${snapshot.edgeCount},
            ${startedAt}, NULL
          )
        `;
        activated = true;
        yield* observe('copying-workspace', 'started');
        yield* sql`
          INSERT INTO workspace_scopes (
            snapshot_id, id, build_system, name, root, provenance, diagnostics_json
          )
          SELECT ${snapshot.id}, id, build_system, name, root, provenance, diagnostics_json
          FROM activation_workspace_scopes
        `;
        yield* sql`
          INSERT INTO workspace_components (
            snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          )
          SELECT ${snapshot.id}, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          FROM activation_workspace_components
        `;
        yield* sql`
          INSERT INTO workspace_component_dependencies (
            snapshot_id, source_component_id, target_component_id, provenance, evidence
          )
          SELECT ${snapshot.id}, source_component_id, target_component_id, provenance, evidence
          FROM activation_workspace_dependencies
        `;
        yield* sql`
          INSERT INTO workspace_external_dependencies (
            snapshot_id, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
            version_constraint, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
            version_constraint, evidence_path, evidence_span_json
          FROM activation_workspace_external_dependencies
        `;
        yield* sql`
          INSERT INTO code_graph_monikers (
            snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
            package_name, package_version, import_path, qualified_name, component_id,
            symbol_id, dependency_kind, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, id, version, scheme, role, kind, resolution_domain, identity,
            package_name, package_version, import_path, qualified_name, component_id,
            symbol_id, dependency_kind, evidence_path, evidence_span_json
          FROM activation_monikers
        `;
        yield* observe('copying-workspace', 'completed', Number(counts.workspace_rows));
        if (!baseSnapshotId) {
          yield* observe('copying-files', 'started');
          yield* sql`
            INSERT INTO snapshot_files (
              snapshot_id, path, content_hash, raw_content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, path, content_hash, raw_content_hash, language, mode, size, source
            FROM activation_files
          `;
          yield* observe('copying-files', 'completed', Number(counts.files));
          yield* observe('copying-symbols', 'started');
          yield* sql`
            INSERT INTO symbols (
              snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
              arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported, signature,
              documentation, span_json
            )
            SELECT ${snapshot.id}, id, content_hash, kind, name, qualified_name, path, language,
              arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported, signature,
              documentation, span_json
            FROM activation_symbols
          `;
          yield* observe('copying-symbols', 'completed', Number(counts.symbols));
          yield* observe('copying-terms', 'started');
          const compact = yield* copyActivationCompactLexicalFacts(sql, snapshot.id, 'all');
          compactLexicalReceipt = compact;
          yield* observe('copying-terms', 'completed', compact.postingCount);
          yield* observe('copying-edges', 'started');
          yield* sql`
            INSERT INTO edges (
              snapshot_id, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            )
            SELECT ${snapshot.id}, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            FROM activation_edges
          `;
          yield* observe('copying-edges', 'completed', Number(counts.edges));
        } else {
          yield* identifyChangedSymbols(sql, baseSnapshotId);
          yield* observe('copying-files', 'started');
          yield* sql`
            INSERT INTO snapshot_files (
              snapshot_id, path, content_hash, raw_content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, current.path, current.content_hash, current.raw_content_hash, current.language,
              current.mode, current.size, current.source
            FROM activation_files AS current
            LEFT JOIN snapshot_files AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
            WHERE base.path IS NULL
               OR base.content_hash IS NOT current.content_hash
               OR base.raw_content_hash IS NOT current.raw_content_hash
               OR base.language IS NOT current.language
               OR base.mode IS NOT current.mode
               OR base.size IS NOT current.size
               OR base.source IS NOT current.source
          `;
          const changedFiles = yield* lastStatementChangeCount(sql);
          yield* sql`
            INSERT INTO snapshot_file_deletions (snapshot_id, path)
            SELECT ${snapshot.id}, base.path
            FROM snapshot_files AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_files AS current WHERE current.path = base.path)
          `;
          const deletedFiles = yield* lastStatementChangeCount(sql);
          yield* observe('copying-files', 'completed', changedFiles + deletedFiles);
          yield* observe('copying-symbols', 'started');
          yield* sql`
            INSERT INTO symbols (
              snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
              arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported, signature,
              documentation, span_json
            )
            SELECT ${snapshot.id}, current.id, current.content_hash, current.kind, current.name,
              current.qualified_name, current.path, current.language, current.arity,
              current.lookup_keys_json, current.resolution_domain, current.resolution_scope_id, current.package_name,
              current.exported, current.signature, current.documentation, current.span_json
            FROM activation_symbols AS current
            JOIN activation_changed_symbol_ids AS changed ON changed.id = current.id
          `;
          const changedSymbols = yield* lastStatementChangeCount(sql);
          yield* sql`
            INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id)
            SELECT ${snapshot.id}, base.id
            FROM symbols AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id)
          `;
          const deletedSymbols = yield* lastStatementChangeCount(sql);
          yield* observe('copying-symbols', 'completed', changedSymbols + deletedSymbols);
          yield* observe('copying-terms', 'started');
          const compact = yield* copyActivationCompactLexicalFacts(sql, snapshot.id, 'changed');
          compactLexicalReceipt = compact;
          yield* observe('copying-terms', 'completed', compact.postingCount);
          yield* observe('copying-edges', 'started');
          yield* sql`
            INSERT INTO edges (
              snapshot_id, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            )
            SELECT ${snapshot.id}, current.id, current.source_id, current.source_name,
              current.relation, current.target_id, current.target_name, current.provenance,
              current.confidence, current.evidence_path, current.evidence_span_json
            FROM activation_edges AS current
            LEFT JOIN edges AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
            WHERE base.id IS NULL
               OR base.source_id IS NOT current.source_id
               OR base.source_name IS NOT current.source_name
               OR base.relation IS NOT current.relation
               OR base.target_id IS NOT current.target_id
               OR base.target_name IS NOT current.target_name
               OR base.provenance IS NOT current.provenance
               OR base.confidence IS NOT current.confidence
               OR base.evidence_path IS NOT current.evidence_path
               OR base.evidence_span_json IS NOT current.evidence_span_json
          `;
          const changedEdges = yield* lastStatementChangeCount(sql);
          yield* sql`
            INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id)
            SELECT ${snapshot.id}, base.id
            FROM edges AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_edges AS current WHERE current.id = base.id)
          `;
          const deletedEdges = yield* lastStatementChangeCount(sql);
          yield* observe('copying-edges', 'completed', changedEdges + deletedEdges);
        }
      }
      if (activated) {
        const ownedSymbols = yield* sql<{readonly count: number | bigint}>`
          SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ${snapshot.id}
        `;
        const expectedCompactSymbols = yield* validatedCompactLexicalCount(
          ownedSymbols[0]?.count ?? 0,
          'activation symbol count',
        );
        if (compactLexicalReceipt.symbolCount !== expectedCompactSymbols) {
          return yield* Effect.fail(new CodeGraphStoreError('Compact lexical activation symbol count changed.'));
        }
        yield* recordCompactLexicalFormat(
          sql,
          snapshot.id,
          compactLexicalReceipt,
          compactLexicalReceipt.postingCount,
          expectedCompactSymbols,
        );
        // Dirty overlays keep their clean base reachable and are never selected
        // as reusable clean roots, so duplicating every unchanged shard
        // association would add repository-sized publication work for no cache
        // ownership benefit.
        if (baseSnapshotId && !snapshot.dirty) {
          yield* inheritSnapshotFileShards(sql, snapshot.id, baseSnapshotId);
        }
        yield* associateSnapshotFileShards(sql, snapshot, reusableBaseReceipt);
      }
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
      if (snapshotPackProvenance !== undefined) {
        yield* recordSnapshotPackProvenance(sql, snapshot.id, snapshotPackProvenance);
      }
      if (activated && !baseSnapshotId && !snapshot.dirty && reusableBaseReceipt) {
        yield* observe('copying-lookup-keys', 'started');
        yield* sql`
          INSERT INTO snapshot_symbol_lookup (
            snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
            provenance, evidence_edge_id, evidence_path
          )
          SELECT ${snapshot.id}, lookup_key, symbol_id, resolution_domain, exported,
            provenance, evidence_edge_id, evidence_path
          FROM activation_symbol_lookup
        `;
        yield* observe('copying-lookup-keys', 'completed', Number(counts.lookup_keys));
        yield* observe('copying-reexports', 'started');
        yield* sql`
          INSERT INTO snapshot_reexport_provenance (
            snapshot_id, source_path, local_name, target_path, imported_name
          )
          SELECT ${snapshot.id}, source_path, local_name, target_path, imported_name
          FROM activation_reexport_provenance
        `;
        yield* observe('copying-reexports', 'completed', Number(counts.reexports));
        yield* sql`
          INSERT INTO snapshot_reuse_receipts (
            snapshot_id, format_version, resolution_surface_version, extractor_set,
            workspace_fingerprint, file_set_fingerprint, lookup_count, alias_count,
            reexport_count, inventory_receipt_json, created_at
          )
          SELECT
            ${snapshot.id}, ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, ${CODE_GRAPH_RESOLUTION_SURFACE_VERSION}, ${snapshot.extractorSet},
            ${reusableBaseReceipt.workspaceFingerprint}, ${reusableBaseReceipt.fileSetFingerprint},
            COUNT(*), COALESCE(SUM(CASE WHEN provenance = 'alias' THEN 1 ELSE 0 END), 0),
            (SELECT COUNT(*) FROM activation_reexport_provenance),
            ${encodeCodeGraphInventoryReuseReceipt(reusableBaseReceipt.inventory)},
            ${new Date().toISOString()}
          FROM activation_symbol_lookup
        `;
      }
      if (activated && baseSnapshotId && !snapshot.dirty && reusableBaseReceipt) {
        yield* recordLayeredSnapshotInventoryReceipt(sql, snapshot, reusableBaseReceipt, new Date().toISOString());
      }
      yield* insertActivationLease(sql, snapshot.id, promotionLease);
      if (activated) {
        const completedAt = new Date().toISOString();
        yield* observe('recording-completion', 'started');
        yield* sql`
          UPDATE snapshots
          SET state = 'ready', completed_at = ${completedAt}
          WHERE id = ${snapshot.id} AND state = 'building'
        `;
        yield* observe('recording-completion', 'completed', 1);
      }
      yield* observe('committing-snapshot', 'started');
    }),
  );
  yield* observe('committing-snapshot', 'completed');
  yield* observe('checkpointing-snapshot', 'started');
  yield* observe('checkpointing-snapshot', 'completed');
  yield* sql`
    INSERT OR REPLACE INTO activation_state (key, value)
    VALUES ('snapshot_id', ${snapshot.id})
  `;
});

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

const activatePersistedIncrementalSnapshot = Effect.fn('codeGraph.activatePersistedIncrementalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  baseSnapshotId: string,
  reusableBaseReceipt: CodeGraphReusableBaseReceiptInput | undefined,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
  onProgress?: CodeGraphActivationProgressCallback,
  snapshotPackProvenance?: readonly CodeGraphLanguagePackProvenance[],
) {
  const observe = activationProgressObserver(onProgress);
  let compactLexicalReceipt = Option.none<CompactLexicalFormatReceipt>();
  yield* configureConnection(sql);
  yield* observe('validating-input', 'started');
  if (snapshot.baseSnapshotId !== baseSnapshotId) {
    return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental activation has the wrong base snapshot.'));
  }
  const completedAt = new Date().toISOString();
  const priorSnapshot = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT state FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
  `;
  if (priorSnapshot[0]?.state !== 'ready') {
    yield* clearCompactLexicalSnapshotRows(sql, snapshot.id);
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* selectReusableBaseReceipt(baseSnapshotId, true))) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Reusable base receipt ${baseSnapshotId} is unavailable or incomplete.`),
        );
      }
      const closureRows = yield* sql<{readonly value: string}>`
        SELECT value FROM activation_state WHERE key = 'resolution_closure' LIMIT 1
      `;
      const resolutionClosure = closureRows[0]?.value;
      if (!isPersistedIncrementalResolutionClosure(resolutionClosure)) {
        return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental resolution closure is invalid.'));
      }
      if (resolutionClosure === 'changed' && !(yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId))) {
        return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental resolution surface changed.'));
      }
      if (resolutionClosure === 'project' && !(yield* persistedIncrementalProjectFilesMatch(sql, baseSnapshotId))) {
        return yield* Effect.fail(new CodeGraphStoreError('Persisted project closure changed the base file set.'));
      }
      const changedPathsOnly = yield* sql<{readonly id: string}>`
        SELECT edge.id
        FROM activation_edges AS edge
        WHERE NOT EXISTS (SELECT 1 FROM activation_files AS file WHERE file.path = edge.evidence_path)
        UNION ALL
        SELECT symbol.id
        FROM activation_symbols AS symbol
        WHERE NOT EXISTS (SELECT 1 FROM activation_files AS file WHERE file.path = symbol.path)
        LIMIT 1
      `;
      if (changedPathsOnly[0]) {
        return yield* Effect.fail(new CodeGraphStoreError('Incremental facts escaped the changed-file boundary.'));
      }
      const invalidEdges = yield* sql<{readonly id: string}>`
        SELECT edge.id
        FROM activation_edges AS edge
        WHERE (edge.source_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = edge.source_id)
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS base
                 WHERE base.snapshot_id = ${baseSnapshotId} AND base.id = edge.source_id
                   AND NOT EXISTS (
                     SELECT 1 FROM activation_incremental_paths AS changed WHERE changed.path = base.path
                   )
               ))
           OR (edge.target_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = edge.target_id)
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS base
                 WHERE base.snapshot_id = ${baseSnapshotId} AND base.id = edge.target_id
                   AND NOT EXISTS (
                     SELECT 1 FROM activation_incremental_paths AS changed WHERE changed.path = base.path
                   )
               ))
        LIMIT 1
      `;
      if (invalidEdges[0]) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Code graph edge ${invalidEdges[0].id} references a missing effective symbol.`),
        );
      }
      const counts = yield* persistedIncrementalFactCounts(sql, baseSnapshotId);
      if (
        counts.files !== snapshot.fileCount ||
        counts.symbols !== snapshot.symbolCount ||
        counts.edges !== snapshot.edgeCount
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Persisted incremental counts do not match the ready snapshot.'),
        );
      }
      const stagedRows = yield* sql<{
        readonly edges: number;
        readonly files: number;
        readonly symbols: number;
        readonly terms: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM activation_edges) AS edges,
          (SELECT COUNT(*) FROM activation_files) AS files,
          (SELECT COUNT(*) FROM activation_symbols) AS symbols,
          (SELECT COUNT(*) FROM activation_symbol_terms) AS terms
      `;
      const staged = stagedRows[0] ?? {edges: 0, files: 0, symbols: 0, terms: 0};
      yield* observe('validating-input', 'completed', counts.files + counts.symbols + counts.edges);

      yield* upsertRepository(sql, identity);
      const existing = yield* sql<{readonly started_at: string; readonly state: CodeGraphSnapshot['state']}>`
        SELECT state, started_at FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
      `;
      if (existing[0]?.state !== 'ready') {
        const startedAt = existing[0]?.started_at ?? completedAt;
        yield* purgeSnapshotTerms(sql, snapshot.id);
        yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
        yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
            started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.graphContentId ?? snapshot.id}, ${baseSnapshotId}, ${snapshot.extractorSet},
            ${snapshot.dirty ? 1 : 0},
            ${snapshot.dirty ? (snapshot.overlayFingerprint ?? null) : null},
            'building', ${snapshot.fileCount}, ${snapshot.symbolCount}, ${snapshot.edgeCount},
            ${startedAt}, NULL
          )
        `;
        yield* observe('copying-workspace', 'started');
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
          INSERT INTO workspace_external_dependencies (
            snapshot_id, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
            version_constraint, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
            version_constraint, evidence_path, evidence_span_json
          FROM workspace_external_dependencies WHERE snapshot_id = ${baseSnapshotId}
        `;
        yield* sql`
          INSERT INTO code_graph_monikers (
            snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
            package_name, package_version, import_path, qualified_name, component_id,
            symbol_id, dependency_kind, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, id, version, scheme, role, kind, resolution_domain, identity,
            package_name, package_version, import_path, qualified_name, component_id,
            symbol_id, dependency_kind, evidence_path, evidence_span_json
          FROM code_graph_monikers AS base
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND (
              base.scheme = 'package'
              OR base.evidence_path NOT IN (SELECT path FROM activation_incremental_paths)
            )
        `;
        yield* sql`
          INSERT INTO code_graph_monikers (
            snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
            package_name, package_version, import_path, qualified_name, component_id,
            symbol_id, dependency_kind, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, id, version, scheme, role, kind, resolution_domain, identity,
            package_name, package_version, import_path, qualified_name, component_id,
            symbol_id, dependency_kind, evidence_path, evidence_span_json
          FROM activation_monikers
        `;
        yield* observe('copying-workspace', 'completed');
        yield* observe('copying-files', 'started');
        yield* sql`
          INSERT INTO snapshot_files (
            snapshot_id, path, content_hash, raw_content_hash, language, mode, size, source
          )
          SELECT ${snapshot.id}, path, content_hash, raw_content_hash, language, mode, size, source
          FROM activation_files
        `;
        const fileDeletions = persistedIncrementalFileDeletionsStatement(snapshot.id, baseSnapshotId);
        yield* sql.unsafe(fileDeletions.text, fileDeletions.parameters);
        yield* observe('copying-files', 'completed', Number(staged.files));
        yield* observe('copying-symbols', 'started');
        yield* sql`
          INSERT INTO symbols (
            snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
            arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
            exported, signature, documentation, span_json
          )
          SELECT ${snapshot.id}, id, content_hash, kind, name, qualified_name, path, language,
            arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
            exported, signature, documentation, span_json
          FROM activation_symbols
        `;
        yield* observe('copying-symbols', 'completed', Number(staged.symbols));
        yield* observe('copying-terms', 'started');
        const compact = yield* copyActivationCompactLexicalFacts(sql, snapshot.id, 'all');
        if (compact.symbolCount !== Number(staged.symbols) || compact.postingCount !== Number(staged.terms)) {
          return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental compact lexical rows changed.'));
        }
        compactLexicalReceipt = Option.some(compact);
        yield* observe('copying-terms', 'completed', compact.postingCount);
        const symbolDeletions = persistedIncrementalSymbolDeletionsStatement(snapshot.id, baseSnapshotId);
        yield* sql.unsafe(symbolDeletions.text, symbolDeletions.parameters);
        yield* observe('copying-edges', 'started');
        yield* sql`
          INSERT INTO edges (
            snapshot_id, id, source_id, source_name, relation, target_id, target_name,
            provenance, confidence, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, id, source_id, source_name, relation, target_id, target_name,
            provenance, confidence, evidence_path, evidence_span_json
          FROM activation_edges
        `;
        const edgeDeletions = persistedIncrementalEdgeDeletionsStatement(snapshot.id, baseSnapshotId);
        yield* sql.unsafe(edgeDeletions.text, edgeDeletions.parameters);
        yield* observe('copying-edges', 'completed', Number(staged.edges));
      }
      if (existing[0]?.state !== 'ready') {
        if (Option.isNone(compactLexicalReceipt)) {
          return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental lexical receipt is unavailable.'));
        }
        yield* recordCompactLexicalFormat(
          sql,
          snapshot.id,
          compactLexicalReceipt.value,
          Number(staged.terms),
          Number(staged.symbols),
        );
        if (!snapshot.dirty) yield* inheritSnapshotFileShards(sql, snapshot.id, baseSnapshotId);
        yield* associateSnapshotFileShards(sql, snapshot, reusableBaseReceipt);
      }
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
      if (snapshotPackProvenance !== undefined) {
        yield* recordSnapshotPackProvenance(sql, snapshot.id, snapshotPackProvenance);
      }
      if (existing[0]?.state !== 'ready' && !snapshot.dirty && reusableBaseReceipt) {
        yield* recordLayeredSnapshotInventoryReceipt(sql, snapshot, reusableBaseReceipt, completedAt);
      }
      yield* insertActivationLease(sql, snapshot.id, promotionLease);
      if (existing[0]?.state !== 'ready') {
        yield* observe('recording-completion', 'started');
        yield* sql`
          UPDATE snapshots
          SET state = 'ready', completed_at = ${completedAt}
          WHERE id = ${snapshot.id} AND state = 'building'
        `;
        yield* observe('recording-completion', 'completed', 1);
      }
      yield* observe('committing-snapshot', 'started');
    }),
  );
  yield* observe('committing-snapshot', 'completed');
  yield* observe('checkpointing-snapshot', 'started');
  yield* observe('checkpointing-snapshot', 'completed');
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql`
    INSERT INTO activation_state (key, value) VALUES ('snapshot_id', ${snapshot.id})
  `;
});

export {activateStagedSnapshot, activatePersistedIncrementalSnapshot};
