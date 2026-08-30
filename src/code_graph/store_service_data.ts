import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {type CodeGraphDirectPersistentCapacityBoundary} from './disk_capacity.js';
import {configureConnection, useDatabase, useReadOnlyDatabase} from './store_session.js';
import {CodeGraphStoreError} from './types.js';
import {upsertRepository, storeError} from './store_utilities.js';
import {selectCachedCommittedFileKeys} from './store_query_core.js';
import {discardInvalidCachedFacts} from './store_cache_repair.js';
import {stageActivationFiles, activationMode, type CodeGraphWriterGate} from './store_build_core.js';
import {
  selectReusableBaseReceipt,
  selectReusableFoldForwardBase,
  selectReusableCleanBaseForCommit,
  selectReusableCleanBaseForCommitPaths,
  selectExistingSnapshotFilePaths,
  selectReadySnapshot,
  selectReadySnapshotById,
  selectCurrentLexicalReadySnapshotById,
  selectReadySnapshotForCommit,
  selectLatestReadySnapshotForRepository,
  selectReusableCleanBase,
  selectReusableOverlayBase,
  selectReusableReexports,
  selectCachedFacts,
  selectMaterializedFileShards,
  selectSnapshotMaterializedFileShards,
  selectStoredGraph,
  selectStoredSymbols,
  selectEdgePage,
  selectEdgesForNodes,
} from './store_queries.js';
import {selectSnapshotPackProvenance} from './store_pack_provenance.js';
import {pruneCachedFileBlobs} from './store_cleanup_core.js';
import {prepareActivationTables} from './store_staging_core.js';
import {
  selectAnalysisSummary,
  selectSymbolPage,
  selectAnalysisSymbolAggregatePage,
  selectAnalysisEdgeAggregatePage,
  selectEmbeddingSymbolCount,
  selectEmbeddingSymbolPage,
} from './store_analysis.js';
import {initializeSchema} from './store_schema_initialization.js';
import {diagnoseDatabase} from './store_diagnostics.js';
import {ensureReadySnapshotAnalysisSummary} from './store_activation_persistent.js';
import {pruneRetiredSnapshotRows} from './store_retirement.js';
import {selectResumableForcedBuild, selectResumableBuildById} from './store_resolution_core.js';
import {
  claimPersistentSnapshotBuild,
  retireIncompleteWorktreeSnapshots,
  finalizePersistentMaterializationPlan,
  failBuildingSnapshot,
} from './store_persistent_build.js';
import {
  selectVisualizationCatalog,
  selectVisualizationCatalogs,
  selectVisualizationScopeEdges,
  selectVisualizationScopeEdgeSummary,
  selectVisualizationSymbols,
} from './store_visualization.js';
import {selectActiveViewFence, selectActiveViewIdentities} from './store_active_views.js';
import {repairDatabase} from './store_repair.js';
import {
  preparePersistedFullActivation,
  preparePersistedIncrementalActivation,
  replaceStagedModifiedFiles,
} from './store_build_preparation.js';
import {
  selectSymbolsByPathAndName,
  selectRepresentativeEdgesForNodes,
  selectRelationshipSummaryForNode,
} from './store_relationship_queries.js';
import {type CodeGraphStoreRuntime} from './store_runtime.js';
import {type CodeGraphStoreShape} from './store_shape.js';
import {selectSnapshotProjectClosureFiles} from './store_project_closure.js';
import {
  temporaryActivationInventoryCapacity,
  temporaryIncrementalActivationCapacity,
} from './store_temporary_capacity.js';
import {restoreCodeGraphQueryIndexesAfterColdBuild} from './store_cold_index_deferral.js';
import {
  finalizePersistentMaterializationSpool,
  persistentMaterializationStorageObservation,
  removePersistentMaterializationSpool,
} from './store_materialization_spool_lifecycle.js';
import {codeGraphMaterializationSpoolPath} from './materialization_spool.js';
import {
  selectEffectiveSnapshotCitationEvidence,
  selectEffectiveSnapshotFilesByContentHashes,
  selectEffectiveSnapshotFilesByPaths,
  selectEffectiveSnapshotSymbolsBySemanticLocators,
} from './store_citation_queries.js';

type CodeGraphStoreDataMethods = Pick<
  CodeGraphStoreShape,
  | 'initialize'
  | 'prepareActivation'
  | 'finalizePersistentMaterializationPlan'
  | 'preparePersistedIncrementalActivation'
  | 'replaceStagedModifiedFiles'
  | 'diagnose'
  | 'cachedCommittedFileKeys'
  | 'discardInvalidCachedFacts'
  | 'edgesForNodes'
  | 'findSymbolsByPathAndName'
  | 'loadCachedFacts'
  | 'loadMaterializedFileShards'
  | 'loadSnapshotMaterializedFileShards'
  | 'loadGraph'
  | 'loadSymbols'
  | 'loadEdgePage'
  | 'loadSymbolPage'
  | 'loadAnalysisSymbolAggregatePage'
  | 'loadAnalysisEdgeAggregatePage'
  | 'loadAnalysisSummary'
  | 'ensureAnalysisSummary'
  | 'countEmbeddingSymbols'
  | 'loadEmbeddingSymbolPage'
  | 'loadVisualizationCatalog'
  | 'loadActiveViewIdentities'
  | 'loadActiveViewFence'
  | 'loadVisualizationCatalogs'
  | 'loadVisualizationScopeEdges'
  | 'loadVisualizationScopeEdgeSummary'
  | 'loadVisualizationSymbols'
  | 'representativeEdgesForNodes'
  | 'markBuilding'
  | 'claimPersistentBuild'
  | 'resumableForcedBuild'
  | 'resumableBuildById'
  | 'retireIncompleteWorktreeSnapshots'
  | 'markFailed'
  | 'readySnapshot'
  | 'readySnapshotById'
  | 'currentLexicalReadySnapshotById'
  | 'readySnapshotForCommit'
  | 'latestReadySnapshotForRepository'
  | 'reusableBaseReceipt'
  | 'reusableFoldForwardBase'
  | 'snapshotPackProvenance'
  | 'reusableCleanBase'
  | 'reusableCleanBaseForCommit'
  | 'reusableCleanBaseForCommitPaths'
  | 'existingSnapshotFilePaths'
  | 'effectiveSnapshotFilesByPaths'
  | 'effectiveSnapshotFilesByContentHashes'
  | 'effectiveSnapshotSymbolsBySemanticLocators'
  | 'effectiveSnapshotCitationEvidence'
  | 'snapshotProjectClosureFiles'
  | 'reusableOverlayBase'
  | 'reusableReexports'
  | 'relationshipSummaryForNode'
  | 'pruneCachedFacts'
  | 'pruneRetiredSnapshots'
  | 'repair'
>;

export function makeCodeGraphStoreDataMethods(runtime: CodeGraphStoreRuntime): CodeGraphStoreDataMethods {
  const {prepare, ensureSchemaInitialized, scheduleRoutinePhysicalCleanup, withWriterGate, fs, system, crypto} =
    runtime;
  return {
    initialize: (databasePath, options) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* ensureSchemaInitialized(databasePath, sql, options?.waitTimeoutMilliseconds);
            }),
          ),
        ),
        Effect.mapError(cause => storeError('initialize code graph database', cause)),
      ),
    prepareActivation: (
      databasePath,
      files,
      persistentSnapshotId,
      persistentBatchCount,
      persistentOwnerToken,
      persistentCapacityProtector,
    ) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* ensureSchemaInitialized(databasePath, sql);
              if (persistentSnapshotId === undefined) {
                const staging = Effect.gen(function* () {
                  yield* prepareActivationTables(sql);
                  yield* stageActivationFiles(sql, files, 'insert');
                });
                yield* persistentCapacityProtector
                  ? persistentCapacityProtector(temporaryActivationInventoryCapacity(files), staging)
                  : staging;
              } else {
                yield* preparePersistedFullActivation(
                  sql,
                  persistentSnapshotId,
                  files,
                  persistentBatchCount,
                  persistentOwnerToken,
                  effect => withWriterGate(databasePath, effect),
                  persistentCapacityProtector,
                );
              }
            }),
          ),
        ),
        Effect.mapError(cause => storeError('prepare staged code graph activation', cause)),
      ),
    finalizePersistentMaterializationPlan: (
      databasePath,
      expectedBatchCount,
      persistentCapacityProtector,
      onSecondaryIndexProgress,
      materializationSpool,
    ) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const mode = yield* activationMode(sql);
              if (mode?.mode !== 'persisted-full') {
                return yield* Effect.fail(
                  new CodeGraphStoreError('Persistent full-build materialization is not active.'),
                );
              }
              const spoolPath = materializationSpool
                ? yield* finalizePersistentMaterializationSpool(
                    runtime,
                    databasePath,
                    sql,
                    mode.snapshotId,
                    mode.ownerToken,
                    expectedBatchCount,
                    materializationSpool,
                    effect => withWriterGate(databasePath, effect),
                    persistentCapacityProtector,
                  )
                : undefined;
              const boundary: CodeGraphDirectPersistentCapacityBoundary = {
                finalFactBytes: 0,
                operation: 'register persistent code graph materialization plan',
                // Owner plan registration and the lexical counter receipt.
                rowCount: 2,
              };
              const transaction = withWriterGate(
                databasePath,
                finalizePersistentMaterializationPlan(sql, mode.snapshotId, mode.ownerToken, expectedBatchCount),
              );
              yield* persistentCapacityProtector ? persistentCapacityProtector(boundary, transaction) : transaction;
              yield* restoreCodeGraphQueryIndexesAfterColdBuild({
                onProgress: onSecondaryIndexProgress,
                ...(spoolPath && materializationSpool?.onStorageObservation
                  ? {
                      observeTransaction: () =>
                        Effect.sync(() =>
                          materializationSpool.onStorageObservation?.(
                            persistentMaterializationStorageObservation(databasePath, spoolPath),
                          ),
                        ),
                    }
                  : {}),
                ownerToken: mode.ownerToken,
                persistentCapacityProtector,
                snapshotId: mode.snapshotId,
                sql,
                writerGate: effect => withWriterGate(databasePath, effect),
              });
              if (spoolPath) yield* removePersistentMaterializationSpool(runtime, spoolPath);
            }),
          ),
        ),
        Effect.mapError(cause => storeError('finalize persistent code graph materialization plan', cause)),
      ),
    preparePersistedIncrementalActivation: (
      databasePath,
      baseSnapshotId,
      files,
      facts,
      options,
      persistentCapacityProtector,
    ) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* ensureSchemaInitialized(databasePath, sql);
              const preparation = preparePersistedIncrementalActivation(baseSnapshotId, files, facts, options);
              return yield* persistentCapacityProtector
                ? persistentCapacityProtector(
                    temporaryIncrementalActivationCapacity(files, facts, options?.deletedPaths, options?.foldForward),
                    preparation,
                  )
                : preparation;
            }),
          ),
        ),
        Effect.mapError(cause => storeError('prepare persisted incremental code graph activation', cause)),
      ),
    replaceStagedModifiedFiles: (databasePath, baseSnapshotId, files, facts, persistentCapacityProtector) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            persistentCapacityProtector
              ? persistentCapacityProtector(
                  temporaryIncrementalActivationCapacity(files, facts),
                  replaceStagedModifiedFiles(baseSnapshotId, files, facts),
                )
              : replaceStagedModifiedFiles(baseSnapshotId, files, facts),
          ),
        ),
        Effect.mapError(cause => storeError('replace staged modified code graph files', cause)),
      ),
    diagnose: databasePath =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists => (exists ? useDatabase(databasePath, diagnoseDatabase()) : Effect.succeed(undefined))),
        Effect.mapError(cause => storeError('diagnose code graph database', cause)),
      ),
    cachedCommittedFileKeys: (databasePath, extractorSet, files) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectCachedCommittedFileKeys(extractorSet, files))
            : Effect.succeed(new Set<string>()),
        ),
        Effect.mapError(cause => storeError('load cached code graph file keys', cause)),
      ),
    discardInvalidCachedFacts: (databasePath, files) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* configureConnection(sql);
                  yield* sql.withTransaction(discardInvalidCachedFacts(files));
                }),
              )
            : Effect.void,
        ),
        Effect.mapError(cause => storeError('discard invalid cached code graph facts', cause)),
      ),
    edgesForNodes: (databasePath, snapshotId, nodeIds, direction, limit, allowedProvenances) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(
            databasePath,
            selectEdgesForNodes(snapshotId, nodeIds, direction, limit, allowedProvenances),
          ),
        ),
        Effect.mapError(cause => storeError('load code graph adjacency', cause)),
      ),
    findSymbolsByPathAndName: (databasePath, snapshotId, sourcePath, name) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSymbolsByPathAndName(snapshotId, sourcePath, name))),
        Effect.mapError(cause => storeError('resolve qualified code graph symbol', cause)),
      ),
    loadCachedFacts: (databasePath, files, extractorSet, options) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(databasePath, selectCachedFacts(files, extractorSet, options?.decode !== false)),
        ),
        Effect.mapError(cause => storeError('load cached code graph facts', cause)),
      ),
    loadMaterializedFileShards: (databasePath, files, extractorSet, derivationIdentity, provenance) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(
            databasePath,
            selectMaterializedFileShards(files, extractorSet, derivationIdentity, provenance),
          ),
        ),
        Effect.mapError(cause => storeError('load materialized code graph file shards', cause)),
      ),
    loadSnapshotMaterializedFileShards: (databasePath, snapshotId, files) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSnapshotMaterializedFileShards(snapshotId, files))),
        Effect.mapError(cause => storeError('load associated materialized code graph file shards', cause)),
      ),
    loadGraph: (databasePath, snapshotId) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectStoredGraph(snapshotId))),
        Effect.mapError(cause => storeError('load code graph snapshot', cause)),
      ),
    loadSymbols: (databasePath, snapshotId) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectStoredSymbols(snapshotId))),
        Effect.mapError(cause => storeError('load code graph snapshot symbols', cause)),
      ),
    loadEdgePage: (databasePath, snapshotId, cursor, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectEdgePage(snapshotId, cursor, limit))),
        Effect.mapError(cause => storeError('load code graph edge page', cause)),
      ),
    loadSymbolPage: (databasePath, snapshotId, cursor, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectSymbolPage(snapshotId, cursor, limit))),
        Effect.mapError(cause => storeError('load code graph symbol page', cause)),
      ),
    loadAnalysisSymbolAggregatePage: (databasePath, snapshotId, cursorId, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(databasePath, selectAnalysisSymbolAggregatePage(snapshotId, cursorId, limit)),
        ),
        Effect.mapError(cause => storeError('aggregate code graph symbol page', cause)),
      ),
    loadAnalysisEdgeAggregatePage: (databasePath, snapshotId, cursorId, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectAnalysisEdgeAggregatePage(snapshotId, cursorId, limit))),
        Effect.mapError(cause => storeError('aggregate code graph edge page', cause)),
      ),
    loadAnalysisSummary: (databasePath, snapshotId) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectAnalysisSummary(snapshotId))),
        Effect.mapError(cause => storeError('load code graph analysis summary', cause)),
      ),
    ensureAnalysisSummary: (databasePath, snapshotId) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          withWriterGate(
            databasePath,
            useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* initializeSchema(sql);
                return yield* sql.withTransaction(ensureReadySnapshotAnalysisSummary(sql, snapshotId));
              }),
            ),
          ),
        ),
        Effect.mapError(cause => storeError('ensure code graph analysis summary', cause)),
      ),
    countEmbeddingSymbols: (databasePath, snapshotId) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectEmbeddingSymbolCount(snapshotId))),
        Effect.mapError(cause => storeError('count code graph embedding symbols', cause)),
      ),
    loadEmbeddingSymbolPage: (databasePath, snapshotId, cursor, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectEmbeddingSymbolPage(snapshotId, cursor, limit))),
        Effect.mapError(cause => storeError('load code graph embedding symbol page', cause)),
      ),
    loadVisualizationCatalog: (databasePath, metrics = 'complete', options = {}) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectVisualizationCatalog(undefined, metrics, options))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load code graph visualization catalog', cause)),
      ),
    loadActiveViewIdentities: (databasePath, limit) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, selectActiveViewIdentities(limit)) : Effect.succeed([]),
        ),
        Effect.mapError(cause => storeError('load active code graph view identities', cause)),
      ),
    loadActiveViewFence: (databasePath, worktreeId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, selectActiveViewFence(worktreeId)) : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load active code graph view fence', cause)),
      ),
    loadVisualizationCatalogs: (databasePath, metrics = 'complete', options = {}) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectVisualizationCatalogs(metrics, options))
            : Effect.succeed([]),
        ),
        Effect.mapError(cause => storeError('load code graph visualization catalogs', cause)),
      ),
    loadVisualizationScopeEdges: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, selectVisualizationScopeEdges(snapshotId)) : Effect.succeed([]),
        ),
        Effect.mapError(cause => storeError('load code graph visualization scope edges', cause)),
      ),
    loadVisualizationScopeEdgeSummary: (databasePath, snapshotId, scopeIds, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(databasePath, selectVisualizationScopeEdgeSummary(snapshotId, scopeIds, limit)),
        ),
        Effect.mapError(cause => storeError('load bounded code graph visualization scope edges', cause)),
      ),
    loadVisualizationSymbols: (databasePath, snapshotId, scope, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectVisualizationSymbols(snapshotId, scope, limit))),
        Effect.mapError(cause => storeError('load code graph visualization symbols', cause)),
      ),
    representativeEdgesForNodes: (databasePath, snapshotId, nodeIds, direction, limit, allowedProvenances) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(
            databasePath,
            selectRepresentativeEdgesForNodes(snapshotId, nodeIds, direction, limit, allowedProvenances),
          ),
        ),
        Effect.mapError(cause => storeError('load representative code graph adjacency', cause)),
      ),
    markBuilding: (databasePath, identity, snapshot) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          withWriterGate(
            databasePath,
            useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* initializeSchema(sql);
                yield* upsertRepository(sql, identity);
                const registered = yield* sql<{readonly id: string}>`
                          INSERT INTO snapshots (
                            id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
                            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
                          ) VALUES (
                            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
                            ${snapshot.graphContentId ?? snapshot.id}, ${snapshot.baseSnapshotId ?? null},
                            ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
                            ${snapshot.overlayFingerprint ?? null}, 'building', 0, 0, 0, ${new Date().toISOString()}
                          )
                          ON CONFLICT(id) DO UPDATE SET
                            graph_content_id = excluded.graph_content_id,
                            state = 'building',
                            file_count = 0,
                            symbol_count = 0,
                            edge_count = 0,
                            started_at = excluded.started_at,
                            completed_at = NULL,
                            failure_summary = NULL
                          WHERE snapshots.repository_id = excluded.repository_id
                            AND snapshots.worktree_id = excluded.worktree_id
                            AND snapshots.commit_id = excluded.commit_id
                            AND snapshots.graph_content_id = excluded.graph_content_id
                            AND snapshots.base_snapshot_id IS excluded.base_snapshot_id
                            AND snapshots.extractor_set = excluded.extractor_set
                            AND snapshots.dirty = excluded.dirty
                            AND snapshots.overlay_fingerprint IS excluded.overlay_fingerprint
                            AND snapshots.state IN ('building', 'failed', 'retired')
                          RETURNING id
                        `;
                if (registered.length !== 1) {
                  return yield* Effect.fail(
                    new CodeGraphStoreError(
                      `Snapshot identity ${snapshot.id} already belongs to incompatible or ready content.`,
                    ),
                  );
                }
              }),
            ),
          ),
        ),
        Effect.mapError(cause => storeError('start code graph snapshot', cause)),
      ),
    claimPersistentBuild: (databasePath, identity, snapshot, claim) =>
      Effect.gen(function* () {
        const ownerToken = `${system.processId}:${yield* crypto.randomUUIDv4}`;
        const writerGate: CodeGraphWriterGate = effect => withWriterGate(databasePath, effect);
        yield* prepare(databasePath);
        yield* useDatabase(
          databasePath,
          claimPersistentSnapshotBuild(identity, snapshot, ownerToken, claim, writerGate),
        );
        return ownerToken;
      }).pipe(Effect.mapError(cause => storeError('claim persistent code graph snapshot', cause))),
    resumableForcedBuild: (databasePath, logicalSnapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectResumableForcedBuild(logicalSnapshotId))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load resumable forced code graph snapshot', cause)),
      ),
    resumableBuildById: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, selectResumableBuildById(snapshotId)) : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load resumable code graph snapshot by identity', cause)),
      ),
    retireIncompleteWorktreeSnapshots: (
      databasePath,
      repositoryId,
      worktreeId,
      retainedSnapshotIds,
      onProgress,
      options,
    ) =>
      Effect.gen(function* () {
        yield* prepare(databasePath);
        const result = yield* useDatabase(
          databasePath,
          retireIncompleteWorktreeSnapshots(
            repositoryId,
            worktreeId,
            retainedSnapshotIds,
            effect => withWriterGate(databasePath, effect),
            onProgress,
            options?.cleanupMode,
          ),
        );
        for (const snapshotId of result.spoolCleanupSnapshotIds) {
          const spoolPath = yield* Effect.try({
            catch: () => new CodeGraphStoreError('Retired materialization spool identity is invalid.'),
            try: () =>
              codeGraphMaterializationSpoolPath(
                runtime.path,
                {repositoryRoot: runtime.path.dirname(databasePath)},
                snapshotId,
              ),
          });
          yield* removePersistentMaterializationSpool(runtime, spoolPath);
        }
        if (result.reclaimable > 0) {
          yield* scheduleRoutinePhysicalCleanup(databasePath);
        }
        return result.retired;
      }).pipe(Effect.mapError(cause => storeError('retire incomplete code graph snapshots', cause))),
    markFailed: (databasePath, snapshotId, summary, ownerToken) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useDatabase(
            databasePath,
            withWriterGate(databasePath, failBuildingSnapshot(snapshotId, summary, ownerToken)).pipe(Effect.asVoid),
          ),
        ),
        Effect.mapError(cause => storeError('fail code graph snapshot', cause)),
      ),
    readySnapshot: (databasePath, worktreeId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, selectReadySnapshot(worktreeId)) : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load ready code graph snapshot', cause)),
      ),
    readySnapshotById: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists ? useReadOnlyDatabase(databasePath, selectReadySnapshotById(snapshotId)) : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load ready code graph snapshot by identity', cause)),
      ),
    currentLexicalReadySnapshotById: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectCurrentLexicalReadySnapshotById(snapshotId))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load current-format ready code graph snapshot by identity', cause)),
      ),
    readySnapshotForCommit: (databasePath, repositoryId, commit, extractorSet) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectReadySnapshotForCommit(repositoryId, commit, extractorSet))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load ready code graph snapshot for commit', cause)),
      ),
    latestReadySnapshotForRepository: (databasePath, repositoryId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectLatestReadySnapshotForRepository(repositoryId))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load latest ready code graph snapshot for repository', cause)),
      ),
    reusableBaseReceipt: (databasePath, snapshotId, options) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectReusableBaseReceipt(snapshotId, options?.allowDirtyRoot === true))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable code graph base receipt', cause)),
      ),
    reusableFoldForwardBase: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectReusableFoldForwardBase(snapshotId))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable code graph fold-forward base', cause)),
      ),
    snapshotPackProvenance: (databasePath, snapshotId) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectSnapshotPackProvenance(snapshotId))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load code graph snapshot language-pack provenance', cause)),
      ),
    reusableCleanBase: (
      databasePath,
      repositoryId,
      extractorSet,
      workspaceFingerprint,
      fileSetFingerprint,
      graphContentId,
      preferredCommitGroups,
      allowExtractorMismatch,
    ) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(
                databasePath,
                selectReusableCleanBase(
                  repositoryId,
                  extractorSet,
                  workspaceFingerprint,
                  fileSetFingerprint,
                  graphContentId,
                  preferredCommitGroups,
                  allowExtractorMismatch,
                ),
              )
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable clean code graph base', cause)),
      ),
    reusableCleanBaseForCommit: (databasePath, repositoryId, commit) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectReusableCleanBaseForCommit(repositoryId, commit))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable clean code graph base for commit', cause)),
      ),
    reusableCleanBaseForCommitPaths: (databasePath, repositoryId, commit, paths) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectReusableCleanBaseForCommitPaths(repositoryId, commit, paths))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable clean code graph base paths for commit', cause)),
      ),
    existingSnapshotFilePaths: (databasePath, snapshotId, paths) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectExistingSnapshotFilePaths(snapshotId, paths))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('probe existing code graph snapshot file paths', cause)),
      ),
    effectiveSnapshotFilesByPaths: (databasePath, snapshotId, paths) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectEffectiveSnapshotFilesByPaths(snapshotId, paths))),
        Effect.mapError(cause => storeError('load effective code graph files by path', cause)),
      ),
    effectiveSnapshotFilesByContentHashes: (databasePath, snapshotId, contentHashes, limitPerHash) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(
            databasePath,
            selectEffectiveSnapshotFilesByContentHashes(snapshotId, contentHashes, limitPerHash),
          ),
        ),
        Effect.mapError(cause => storeError('load effective code graph files by content hash', cause)),
      ),
    effectiveSnapshotSymbolsBySemanticLocators: (databasePath, snapshotId, locators, limitPerLocator) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(
            databasePath,
            selectEffectiveSnapshotSymbolsBySemanticLocators(snapshotId, locators, limitPerLocator),
          ),
        ),
        Effect.mapError(cause => storeError('load effective code graph symbols by semantic locator', cause)),
      ),
    effectiveSnapshotCitationEvidence: (databasePath, snapshotId, request) =>
      prepare(databasePath).pipe(
        Effect.andThen(useReadOnlyDatabase(databasePath, selectEffectiveSnapshotCitationEvidence(snapshotId, request))),
        Effect.mapError(cause => storeError('load effective code graph citation evidence', cause)),
      ),
    snapshotProjectClosureFiles: (databasePath, snapshotId, prefixes) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectSnapshotProjectClosureFiles(snapshotId, prefixes))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load bounded code graph project closure files', cause)),
      ),
    reusableOverlayBase: (databasePath, repositoryId, extractorSet, overlayFingerprint) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(
                databasePath,
                selectReusableOverlayBase(repositoryId, extractorSet, overlayFingerprint),
              )
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable retained overlay code graph base', cause)),
      ),
    reusableReexports: (databasePath, snapshotId, seeds, options) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useReadOnlyDatabase(databasePath, selectReusableReexports(snapshotId, seeds, options?.maxRows))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('load reusable code graph reexport provenance', cause)),
      ),
    relationshipSummaryForNode: (databasePath, snapshotId, nodeId, allowedProvenances, limit) =>
      prepare(databasePath).pipe(
        Effect.andThen(
          useReadOnlyDatabase(
            databasePath,
            selectRelationshipSummaryForNode(snapshotId, nodeId, allowedProvenances, limit),
          ),
        ),
        Effect.mapError(cause => storeError('summarize code graph relationships', cause)),
      ),
    pruneCachedFacts: (databasePath, acceptedExtractorSets) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* configureConnection(sql);
                  yield* sql.withTransaction(pruneCachedFileBlobs(sql, acceptedExtractorSets));
                }),
              )
            : Effect.void,
        ),
        Effect.mapError(cause => storeError('prune cached code graph facts', cause)),
      ),
    pruneRetiredSnapshots: databasePath =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useDatabase(
                databasePath,
                pruneRetiredSnapshotRows(effect => withWriterGate(databasePath, effect)),
              )
            : Effect.void,
        ),
        Effect.mapError(cause => storeError('prune retired code graph snapshots', cause)),
      ),
    repair: (databasePath, dryRun = false, options) =>
      fs.exists(databasePath).pipe(
        Effect.flatMap(exists =>
          exists
            ? useDatabase(databasePath, repairDatabase(dryRun, options?.allowSchemaMigrationPreview === true))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(cause => storeError('repair code graph database', cause)),
      ),
  } as const;
}
