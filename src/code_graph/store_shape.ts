import type {Effect, Option} from 'effect';
import type * as SqlClient from 'effect/unstable/sql/SqlClient';
import type {CodeGraphBlobReuseFile} from './blob_reuse.js';
import type {CodeGraphCacheFactInput} from './fact_budget.js';
import type {CodeGraphWorkspace} from './languages/types.js';
import type {CodeGraphMonikerV1} from './cross_repository/types.js';
import type {
  CodeGraphActivationProgressCallback,
  CodeGraphActiveViewIdentity,
  CodeGraphAnalysisEdgeAggregatePage,
  CodeGraphAnalysisSummary,
  CodeGraphAnalysisSymbolAggregatePage,
  CodeGraphDatabaseHealth,
  CodeGraphDatabaseRepair,
  CodeGraphDirectPersistentCapacityProtector,
  CodeGraphEdgeCursor,
  CodeGraphPersistentBuildClaim,
  CodeGraphLanguagePackProvenance,
  CodeGraphMaterializedShardAssociationBatch,
  CodeGraphMaterializedShardCacheBatch,
  CodeGraphRemovedViewCleanupAuthorizationResult,
  CodeGraphRemovedViewCleanupEntry,
  CodeGraphRemovedViewCleanupStoreOptions,
  CodeGraphRemovedViewCleanupUpdate,
  CodeGraphRemovedViewCleanupUpdateResult,
  CodeGraphResolutionProgressCallback,
  CodeGraphResolutionSummary,
  CodeGraphRetiredSnapshotCleanupProgressCallback,
  CodeGraphReusableBaseReceipt,
  CodeGraphReusableBaseReceiptInput,
  CodeGraphReusableCleanBase,
  CodeGraphReusableCleanBaseSlice,
  CodeGraphReusableReexport,
  CodeGraphReusableReexportSeed,
  CodeGraphSecondaryIndexRestorationProgressCallback,
  CodeGraphRoutineMaintenanceOptions,
  CodeGraphRoutineMaintenanceResult,
  CodeGraphSnapshotLeaseAcquireOptions,
  CodeGraphSnapshotLeaseWriterOptions,
  CodeGraphSnapshotPromotionOptions,
  CodeGraphSnapshotPurgeObservationResult,
  CodeGraphSnapshotPurgeStoreOptions,
  CodeGraphSnapshotPurgeStoreResult,
  CodeGraphStagingBatch,
  CodeGraphStagingBatchProgressCallback,
  CodeGraphStagingProgressCallback,
  CodeGraphSymbolCursor,
  CodeGraphViewObservationResult,
  CodeGraphViewRemovalResult,
  CodeGraphViewRemovalStoreOptions,
  CodeGraphViewSnapshotLeaseRetainOptions,
  CodeGraphViewSnapshotLeaseRetainResult,
  CodeGraphViewSnapshotLeaseValidationResult,
  CodeGraphVisualizationCatalog,
  CodeGraphVisualizationCatalogOptions,
  CodeGraphVisualizationEdgePage,
  CodeGraphVisualizationRelationshipSummary,
  CodeGraphVisualizationScope,
  CodeGraphVisualizationScopeEdge,
  CodeGraphVisualizationScopeEdgeSummary,
  CodeGraphWorktreeReconciliationCandidate,
  CodeGraphWorktreeReconciliationClaimOptions,
  CodeGraphWorktreeReconciliationIndexPreparationResult,
  LoadedCodeGraphFacts,
  StoredCodeGraph,
} from './store_models.js';
import type {CodeGraphPersistentSchemaMigrationPhase} from './store_schema_contracts.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphQueryNode,
  CodeGraphReference,
  CodeGraphSnapshot,
  CodeGraphStoreError,
  CodeGraphSymbol,
  RepositoryIdentity,
} from './types.js';

export interface CodeGraphStoreShape {
  readonly withSession: <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
    options?: CodeGraphDatabaseSessionOptions,
  ) => Effect.Effect<A, E | CodeGraphStoreError, Exclude<R, SqlClient.SqlClient>>;
  /** Release disposable SQLite page-cache allocations between index phases. */
  readonly shrinkMemory: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  /** Read-only preflight used before a long-lived process starts an isolated builder. */
  readonly assertRuntimeSchemaCompatible: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly activate: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    files: readonly CodeGraphInventoryFile[],
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
    snapshotPackProvenance?: readonly CodeGraphLanguagePackProvenance[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly activateStaged: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
    promotionLeaseDurationMilliseconds?: number,
    onProgress?: CodeGraphActivationProgressCallback,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    snapshotPackProvenance?: readonly CodeGraphLanguagePackProvenance[],
    materializedFileShardAssociationsComplete?: boolean,
  ) => Effect.Effect<Option.Option<string>, CodeGraphStoreError>;
  readonly activateCleanSnapshotAlias?: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    baseSnapshotId: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly cacheFacts: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphCacheFactInput[],
    extractorSet: string,
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly cacheMaterializedFileShards: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphCacheFactInput[],
    extractorSet: string,
    derivationIdentity: string,
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly cacheMaterializedFileShardBatches: (
    databasePath: string,
    batches: readonly CodeGraphMaterializedShardCacheBatch[],
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly associateMaterializedFileShardBatches: (
    databasePath: string,
    snapshotId: string,
    ownerToken: string,
    batches: readonly CodeGraphMaterializedShardAssociationBatch[],
    persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly acquireSnapshotLease: (
    databasePath: string,
    snapshotId: string,
    durationMilliseconds: number,
    options?: CodeGraphSnapshotLeaseAcquireOptions,
  ) => Effect.Effect<string, CodeGraphStoreError>;
  readonly retainViewSnapshotLease: (
    databasePath: string,
    worktreeId: string,
    snapshotId: string,
    durationMilliseconds: number,
    options?: CodeGraphViewSnapshotLeaseRetainOptions,
  ) => Effect.Effect<CodeGraphViewSnapshotLeaseRetainResult, CodeGraphStoreError>;
  readonly validateViewSnapshotLease: (
    databasePath: string,
    worktreeId: string,
    snapshotId: string,
    token: string,
    minimumRemainingMilliseconds: number,
  ) => Effect.Effect<CodeGraphViewSnapshotLeaseValidationResult, CodeGraphStoreError>;
  readonly promote: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshotId: string,
    options?: CodeGraphSnapshotPromotionOptions,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly observeView: (
    databasePath: string,
    worktreeId: string,
    expectedSnapshotId: string,
  ) => Effect.Effect<CodeGraphViewObservationResult, CodeGraphStoreError>;
  readonly claimWorktreeReconciliationCandidates: (
    databasePath: string,
    limit: number,
    options?: CodeGraphWorktreeReconciliationClaimOptions,
  ) => Effect.Effect<readonly CodeGraphWorktreeReconciliationCandidate[], CodeGraphStoreError>;
  readonly prepareWorktreeReconciliationIndexes: (
    databasePath: string,
    options?: CodeGraphWorktreeReconciliationClaimOptions,
  ) => Effect.Effect<CodeGraphWorktreeReconciliationIndexPreparationResult, CodeGraphStoreError>;
  readonly removeView: (
    databasePath: string,
    worktreeId: string,
    expectedSnapshotId: string,
    options?: CodeGraphViewRemovalStoreOptions,
  ) => Effect.Effect<CodeGraphViewRemovalResult, CodeGraphStoreError>;
  readonly observeSnapshotPurge: (
    databasePath: string,
    snapshotId: string,
    nowMilliseconds: number,
  ) => Effect.Effect<CodeGraphSnapshotPurgeObservationResult, CodeGraphStoreError>;
  readonly purgeSnapshot: (
    databasePath: string,
    snapshotId: string,
    expectedGraphEvidenceDigest: string,
    nowMilliseconds: number,
    options?: CodeGraphSnapshotPurgeStoreOptions,
  ) => Effect.Effect<CodeGraphSnapshotPurgeStoreResult, CodeGraphStoreError>;
  readonly claimRemovedViewCleanupCandidates: (
    databasePath: string,
    nowMilliseconds: number,
    limit: number,
    options?: CodeGraphRemovedViewCleanupStoreOptions,
  ) => Effect.Effect<readonly CodeGraphRemovedViewCleanupEntry[], CodeGraphStoreError>;
  readonly authorizeRemovedViewCleanup: (
    databasePath: string,
    entry: CodeGraphRemovedViewCleanupEntry,
    options?: CodeGraphRemovedViewCleanupStoreOptions,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupAuthorizationResult, CodeGraphStoreError>;
  readonly updateRemovedViewCleanup: (
    databasePath: string,
    entry: CodeGraphRemovedViewCleanupEntry,
    update: CodeGraphRemovedViewCleanupUpdate,
    options?: CodeGraphRemovedViewCleanupStoreOptions,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupUpdateResult, CodeGraphStoreError>;
  readonly initialize: (
    databasePath: string,
    options?: {readonly waitTimeoutMilliseconds?: number},
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly prepareActivation: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    persistentSnapshotId?: string,
    persistentBatchCount?: number,
    persistentOwnerToken?: string,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly finalizePersistentMaterializationPlan: (
    databasePath: string,
    expectedBatchCount: number,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    onSecondaryIndexProgress?: CodeGraphSecondaryIndexRestorationProgressCallback,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly preparePersistedIncrementalActivation: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
    options?: {
      readonly deletedPaths?: readonly string[];
      readonly resolutionClosure?: 'changed' | 'full' | 'project';
    },
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly replaceStagedModifiedFiles: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly diagnose: (databasePath: string) => Effect.Effect<CodeGraphDatabaseHealth | undefined, CodeGraphStoreError>;
  readonly cachedCommittedFileKeys: (
    databasePath: string,
    extractorSet: string,
    files?: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  ) => Effect.Effect<ReadonlySet<string>, CodeGraphStoreError>;
  readonly discardInvalidCachedFacts?: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly loadCachedFacts: (
    databasePath: string,
    files: readonly CodeGraphBlobReuseFile[],
    extractorSet: string,
    options?: {readonly decode?: boolean},
  ) => Effect.Effect<LoadedCodeGraphFacts, CodeGraphStoreError>;
  readonly loadMaterializedFileShards: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
    derivationIdentity: string,
    provenance?: {
      readonly currentGraphContentId: string;
      readonly snapshotIds: readonly string[];
    },
  ) => Effect.Effect<LoadedCodeGraphFacts, CodeGraphStoreError>;
  readonly loadSnapshotMaterializedFileShards?: (
    databasePath: string,
    snapshotId: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  ) => Effect.Effect<LoadedCodeGraphFacts, CodeGraphStoreError>;
  readonly loadGraph: (databasePath: string, snapshotId: string) => Effect.Effect<StoredCodeGraph, CodeGraphStoreError>;
  readonly loadSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly loadEdgePage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphEdgeCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreError>;
  readonly loadSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly loadAnalysisSymbolAggregatePage: (
    databasePath: string,
    snapshotId: string,
    cursorId: string | undefined,
    limit: number,
  ) => Effect.Effect<CodeGraphAnalysisSymbolAggregatePage, CodeGraphStoreError>;
  readonly loadAnalysisEdgeAggregatePage: (
    databasePath: string,
    snapshotId: string,
    cursorId: string | undefined,
    limit: number,
  ) => Effect.Effect<CodeGraphAnalysisEdgeAggregatePage, CodeGraphStoreError>;
  readonly loadAnalysisSummary: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<Option.Option<CodeGraphAnalysisSummary>, CodeGraphStoreError>;
  readonly ensureAnalysisSummary: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly countEmbeddingSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<number, CodeGraphStoreError>;
  readonly loadEmbeddingSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly loadVisualizationCatalog: (
    databasePath: string,
    metrics?: 'complete' | 'deferred',
    options?: CodeGraphVisualizationCatalogOptions,
  ) => Effect.Effect<CodeGraphVisualizationCatalog | undefined, CodeGraphStoreError>;
  readonly loadActiveViewIdentities: (
    databasePath: string,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphActiveViewIdentity[], CodeGraphStoreError>;
  readonly loadVisualizationCatalogs: (
    databasePath: string,
    metrics?: 'complete' | 'deferred',
    options?: CodeGraphVisualizationCatalogOptions,
  ) => Effect.Effect<readonly CodeGraphVisualizationCatalog[], CodeGraphStoreError>;
  readonly loadVisualizationScopeEdges: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphVisualizationScopeEdge[], CodeGraphStoreError>;
  readonly loadVisualizationScopeEdgeSummary: (
    databasePath: string,
    snapshotId: string,
    scopeIds: readonly string[],
    limit: number,
  ) => Effect.Effect<CodeGraphVisualizationScopeEdgeSummary, CodeGraphStoreError>;
  readonly loadVisualizationSymbols: (
    databasePath: string,
    snapshotId: string,
    scope: CodeGraphVisualizationScope,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly edgesForNodes: (
    databasePath: string,
    snapshotId: string,
    nodeIds: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreError>;
  readonly representativeEdgesForNodes: (
    databasePath: string,
    snapshotId: string,
    nodeIds: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<CodeGraphVisualizationEdgePage, CodeGraphStoreError>;
  readonly relationshipSummaryForNode: (
    databasePath: string,
    snapshotId: string,
    nodeId: string,
    allowedProvenances: readonly CodeGraphProvenance[],
    limit?: number,
  ) => Effect.Effect<CodeGraphVisualizationRelationshipSummary, CodeGraphStoreError>;
  readonly findSymbolsByPathAndName: (
    databasePath: string,
    snapshotId: string,
    path: string,
    name: string,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreError>;
  readonly markBuilding: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly claimPersistentBuild: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    claim: CodeGraphPersistentBuildClaim,
  ) => Effect.Effect<string, CodeGraphStoreError>;
  readonly resumableForcedBuild: (
    databasePath: string,
    logicalSnapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly resumableBuildById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly retireIncompleteWorktreeSnapshots: (
    databasePath: string,
    repositoryId: string,
    worktreeId: string,
    retainedSnapshotIds: ReadonlySet<string>,
    onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
    options?: {readonly cleanupMode?: 'deferred' | 'required'},
  ) => Effect.Effect<number, CodeGraphStoreError>;
  readonly markFailed: (
    databasePath: string,
    snapshotId: string,
    summary: string,
    ownerToken?: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly readySnapshot: (
    databasePath: string,
    worktreeId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly readySnapshotById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly currentLexicalReadySnapshotById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly readySnapshotForCommit: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    extractorSet?: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly latestReadySnapshotForRepository: (
    databasePath: string,
    repositoryId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly reusableBaseReceipt: (
    databasePath: string,
    snapshotId: string,
    options?: {readonly allowDirtyRoot?: boolean},
  ) => Effect.Effect<CodeGraphReusableBaseReceipt | undefined, CodeGraphStoreError>;
  readonly snapshotPackProvenance: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphLanguagePackProvenance[] | undefined, CodeGraphStoreError>;
  readonly reusableCleanBase?: (
    databasePath: string,
    repositoryId: string,
    extractorSet: string,
    workspaceFingerprint: string,
    fileSetFingerprint: string,
    graphContentId?: string,
    preferredCommitGroups?: readonly (readonly string[])[],
    allowExtractorMismatch?: boolean,
  ) => Effect.Effect<CodeGraphReusableCleanBase | undefined, CodeGraphStoreError>;
  readonly reusableCleanBaseForCommit: (
    databasePath: string,
    repositoryId: string,
    commit: string,
  ) => Effect.Effect<CodeGraphReusableCleanBase | undefined, CodeGraphStoreError>;
  readonly reusableCleanBaseForCommitPaths?: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    paths: readonly string[],
  ) => Effect.Effect<CodeGraphReusableCleanBaseSlice | undefined, CodeGraphStoreError>;
  readonly existingSnapshotFilePaths?: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
  ) => Effect.Effect<readonly string[] | undefined, CodeGraphStoreError>;
  readonly snapshotProjectClosureFiles?: (
    databasePath: string,
    snapshotId: string,
    prefixes: readonly string[],
  ) => Effect.Effect<readonly CodeGraphInventoryFile[] | undefined, CodeGraphStoreError>;
  readonly reusableOverlayBase?: (
    databasePath: string,
    repositoryId: string,
    extractorSet: string,
    overlayFingerprint: string,
  ) => Effect.Effect<CodeGraphReusableCleanBase | undefined, CodeGraphStoreError>;
  readonly reusableReexports: (
    databasePath: string,
    snapshotId: string,
    seeds: readonly CodeGraphReusableReexportSeed[],
    options?: {readonly maxRows?: number},
  ) => Effect.Effect<readonly CodeGraphReusableReexport[] | undefined, CodeGraphStoreError>;
  readonly pruneCachedFacts: (
    databasePath: string,
    acceptedExtractorSets?: readonly string[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly pruneRetiredSnapshots: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly repair: (
    databasePath: string,
    dryRun?: boolean,
  ) => Effect.Effect<CodeGraphDatabaseRepair | undefined, CodeGraphStoreError>;
  readonly runRoutineMaintenance: (
    databasePath: string,
    options?: CodeGraphRoutineMaintenanceOptions,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>;
  readonly releaseSnapshotLease: (
    databasePath: string,
    token: string,
    options?: CodeGraphSnapshotLeaseWriterOptions,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly renewSnapshotLease: (
    databasePath: string,
    token: string,
    durationMilliseconds: number,
    options?: CodeGraphSnapshotLeaseWriterOptions,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly searchSymbols: (
    databasePath: string,
    snapshotId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreError>;
  readonly searchSymbolsMany: (
    databasePath: string,
    snapshotId: string,
    queries: readonly string[],
    limit: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreError>;
  readonly searchSymbolsByPaths: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
    limitPerPath: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreError>;
  readonly symbolsByIds: (
    databasePath: string,
    snapshotId: string,
    ids: readonly string[],
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly stageActivationFacts: (
    databasePath: string,
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
    references?: readonly CodeGraphReference[],
    onProgress?: CodeGraphStagingProgressCallback,
    batchIndex?: number,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
    monikers?: readonly CodeGraphMonikerV1[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly stageActivationFactBatches: (
    databasePath: string,
    batches: readonly CodeGraphStagingBatch[],
    onProgress?: CodeGraphStagingBatchProgressCallback,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly stageWorkspaceCatalog: (
    databasePath: string,
    workspace: CodeGraphWorkspace,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly resolveStagedReferences: (
    databasePath: string,
    onProgress?: CodeGraphResolutionProgressCallback,
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  ) => Effect.Effect<CodeGraphResolutionSummary, CodeGraphStoreError>;
  readonly stagedFactCounts: (
    databasePath: string,
  ) => Effect.Effect<{readonly edges: number; readonly symbols: number}, CodeGraphStoreError>;
}

export interface CodeGraphDatabaseSessionOptions {
  /** @internal Open a non-creating, query-only SQLite connection without WAL bootstrap writes. */
  readonly readOnly?: boolean;
  /** @internal Ordinary index sessions opportunistically reclaim completed build-only rows. */
  readonly cleanupCompletedBuildRows?: boolean;
  /** @internal Observes the point at which gated background cleanup may open SQLite. */
  readonly onCompletedBuildCleanupConnection?: () => Effect.Effect<void, never>;
  /** @internal Deterministic transaction-boundary observer used by migration fault tests. */
  readonly onPersistentSchemaMigrationPhase?: (
    phase: CodeGraphPersistentSchemaMigrationPhase,
  ) => Effect.Effect<void, never>;
  /** @internal Deterministic checkout-writer acquisition observer used by coordination tests. */
  readonly onWriterAcquired?: () => Effect.Effect<void, never>;
  readonly onWriterContention?: () => Effect.Effect<void, never>;
  /** @internal Records effective PRAGMA values for controlled benchmark evidence. */
  readonly onSqliteWriterConfigured?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>;
  /** @internal Benchmark-only overrides. Production indexing leaves this unset. */
  readonly sqliteWriterTuning?: CodeGraphSqliteWriterTuning;
  /** @internal The caller already owns this database's checkout-wide writer gate. */
  readonly writerGateHeld?: boolean;
  readonly writerLockPath?: string;
}

export interface CodeGraphSqliteWriterTuning {
  readonly mainCacheKiB?: number;
  readonly mmapSizeBytes?: number;
  /** Use NORMAL only while a clean, unpublished snapshot remains reconstructible. */
  readonly reconstructibleBuildSynchronous?: 'normal';
  readonly walAutoCheckpointPages?: number;
}

export interface CodeGraphSqliteWriterSettings {
  readonly cacheSizePragma: number;
  readonly journalMode: string;
  readonly mmapSizeBytes: number;
  readonly phase: 'building' | 'connection' | 'publication';
  readonly synchronous: number;
  readonly walAutoCheckpointPages: number;
}
