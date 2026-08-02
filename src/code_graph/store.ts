import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as SqlError from 'effect/unstable/sql/SqlError';
import {sha256HexSync} from '../crypto/sha256.js';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {
  areCodeGraphLookupTiersWithinCandidateBudget,
  CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM,
  ensureBoundedCodeGraphFact,
  isCodeGraphReferenceWithinCandidateBudget,
  type BoundedCodeGraphFact,
  type CodeGraphCacheFactInput,
} from './fact_budget.js';
import {compareCodeUnits} from './ordering.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphResolutionActivity,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  CodeGraphQueryNode,
  RepositoryIdentity,
} from './types.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CODE_GRAPH_SCHEMA_VERSION, CodeGraphStoreError} from './types.js';
import type {
  CodeGraphWorkspace,
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProvenance,
} from './languages/types.js';

interface SnapshotRow {
  readonly base_snapshot_id: unknown;
  readonly commit_id: string;
  readonly completed_at: unknown;
  readonly dirty: number;
  readonly edge_count: number;
  readonly extractor_set: string;
  readonly file_count: number;
  readonly id: string;
  readonly overlay_fingerprint: unknown;
  readonly repository_id: string;
  readonly state: CodeGraphSnapshot['state'];
  readonly symbol_count: number;
  readonly worktree_id: string;
}

interface SymbolRow {
  readonly arity: unknown;
  readonly content_hash: string;
  readonly documentation: unknown;
  readonly exported: number;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly lookup_keys_json: string;
  readonly package_name: unknown;
  readonly path: string;
  readonly qualified_name: string;
  readonly resolution_domain: unknown;
  readonly resolution_scope_id: unknown;
  readonly signature: unknown;
  readonly span_json: string;
}

interface EdgeRow {
  readonly confidence: number;
  readonly evidence_path: string;
  readonly evidence_span_json: string;
  readonly id: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly source_id: unknown;
  readonly source_name: string;
  readonly target_id: unknown;
  readonly target_name: string;
}

interface FileBlobRow {
  readonly content_hash: string;
  readonly facts_json: string;
}

export const CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION = 2 as const;

export interface CodeGraphReusableBaseReceiptInput {
  readonly fileSetFingerprint: string;
  readonly workspaceFingerprint: string;
}

export interface CodeGraphReusableBaseReceipt extends CodeGraphReusableBaseReceiptInput {
  readonly aliasCount: number;
  readonly formatVersion: number;
  readonly lookupCount: number;
  readonly resolutionSurfaceVersion: number;
  readonly reexportCount: number;
  readonly snapshotId: string;
}

export interface CodeGraphReusableReexport {
  readonly importedName: string;
  readonly localName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CodeGraphReusableReexportSeed {
  readonly name: string;
  readonly path: string;
}

interface CodeGraphActivationLease {
  readonly durationMilliseconds: number;
  readonly token: string;
}

export interface StoredCodeGraph {
  readonly edges: readonly CodeGraphEdge[];
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphEdgeCursor {
  readonly id: string;
  readonly relation: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphSymbolCursor {
  readonly id: string;
  readonly path: string;
  readonly qualifiedName: string;
}

export interface CodeGraphAnalysisSymbolAggregate {
  readonly count: number;
  readonly kind: string;
  readonly language: string;
}

export interface CodeGraphAnalysisSymbolAggregatePage {
  readonly counts: readonly CodeGraphAnalysisSymbolAggregate[];
  readonly lastId?: string;
  readonly rows: number;
}

export interface CodeGraphAnalysisEdgeAggregate {
  readonly confidenceHigh: number;
  readonly confidenceInvalid: number;
  readonly confidenceLow: number;
  readonly confidenceMedium: number;
  readonly confidenceTotal: number;
  readonly count: number;
  readonly lowestConfidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly reviewFindingCount: number;
  readonly selfLoopCount: number;
  readonly unresolvedEndpointCount: number;
}

export interface CodeGraphAnalysisEdgeAggregatePage {
  readonly counts: readonly CodeGraphAnalysisEdgeAggregate[];
  readonly lastId?: string;
  readonly rows: number;
}

export interface CodeGraphAnalysisSummary {
  readonly digest: string;
  readonly edgeCount: number;
  readonly edges: readonly CodeGraphAnalysisEdgeAggregate[];
  readonly symbolCount: number;
  readonly symbols: readonly CodeGraphAnalysisSymbolAggregate[];
  readonly version: 1;
}

export interface CodeGraphDatabaseHealth {
  readonly activeSnapshots: number;
  readonly buildingSnapshots: number;
  readonly cachedFileBlobs: number;
  readonly failedSnapshots: number;
  readonly foreignKeyViolations: number;
  readonly integrity: 'corrupt' | 'incompatible' | 'ok';
  readonly persistentExtensionSchemaRevision?: number;
  readonly readySnapshots: number;
  readonly schemaVersion?: number;
}

export interface CodeGraphDatabaseRepair {
  readonly removedSnapshots: number;
}

export interface CodeGraphRetiredSnapshotCleanupProgress {
  readonly pagesCompleted: number;
  readonly rowsDeleted: number;
  readonly snapshotsCompleted: number;
  readonly snapshotsTotal: number;
}

export type CodeGraphRetiredSnapshotCleanupProgressCallback = (
  progress: CodeGraphRetiredSnapshotCleanupProgress,
) => Effect.Effect<void, never>;

interface OrphanedIncompleteSnapshotCandidate {
  readonly id: string;
  readonly ownerToken: Option.Option<string>;
  readonly startedAt: string;
  readonly state: 'building' | 'failed' | 'retired';
}

export interface LoadedCodeGraphFacts {
  /** UTF-8 bytes occupied by the successfully decoded cached fact payloads. */
  readonly bytes: number;
  readonly bytesByPath?: ReadonlyMap<string, number>;
  readonly facts: ReadonlyMap<string, CodeGraphFileFacts>;
  /** Paths represented by stored rows, also populated for metadata-only reads. */
  readonly keys?: ReadonlySet<string>;
}

export type CodeGraphStagingStage =
  | 'analysis'
  | 'committed'
  | 'committing'
  | 'edges'
  | 'lookup-keys'
  | 'reference-candidates'
  | 'references'
  | 'receipt'
  | 'reexports'
  | 'symbols'
  | 'terms'
  | 'validating';

export interface CodeGraphStagingProgress {
  readonly chunkRows: number;
  /** Allocated durable database pages while a clean snapshot is built in place. */
  readonly durableDatabaseBytes?: number;
  readonly elapsedMilliseconds: number;
  readonly rowsCompleted: number;
  readonly stage: CodeGraphStagingStage;
  /** Batch-local wall time spent in bounded SQLite work for this stage. */
  readonly stageElapsedMilliseconds?: number;
  /** Allocated TEMP database pages; excludes rollback journals and subjournals. */
  readonly temporaryDatabaseBytes?: number;
}

export type CodeGraphStagingProgressCallback = (progress: CodeGraphStagingProgress) => Effect.Effect<void, never>;

export type CodeGraphActivationStage =
  | 'checkpointing-snapshot'
  | 'committing-snapshot'
  | 'copying-edges'
  | 'copying-files'
  | 'copying-lookup-keys'
  | 'copying-reexports'
  | 'copying-symbols'
  | 'copying-terms'
  | 'copying-workspace'
  | 'recording-completion'
  | 'validating-input';

export interface CodeGraphActivationProgress {
  readonly elapsedMilliseconds: number;
  readonly rows?: number;
  readonly stage: CodeGraphActivationStage;
  readonly stageElapsedMilliseconds: number;
  readonly state: 'completed' | 'progress' | 'started';
  readonly transactionMilliseconds?: number;
}

export type CodeGraphActivationProgressCallback = (progress: CodeGraphActivationProgress) => Effect.Effect<void, never>;

export type CodeGraphResolutionProgressCallback = (progress: CodeGraphResolutionActivity) => Effect.Effect<void, never>;

export interface CodeGraphResolutionSummary {
  readonly aliasesDiscovered: number;
  readonly elapsedMilliseconds: number;
  readonly matchingMilliseconds: number;
  readonly pagesCompleted: number;
  readonly passesCompleted: number;
  readonly referencesExamined: number;
  readonly resolved: number;
  readonly transactionMilliseconds: number;
}

export interface CodeGraphVisualizationProject {
  readonly buildSystem?: CodeGraphWorkspaceBuildSystem;
  readonly dependencies: readonly {
    readonly evidence?: string;
    readonly provenance: CodeGraphWorkspaceProvenance;
    readonly targetId: string;
  }[];
  readonly diagnostics: readonly string[];
  readonly fileCount: number;
  readonly id: string;
  readonly kind: CodeGraphWorkspaceComponentKind | 'documentation' | 'legacy-group';
  readonly label: string;
  readonly languages: readonly string[];
  readonly model: 'component' | 'facet' | 'legacy-fallback';
  readonly provenance: CodeGraphWorkspaceProvenance | 'legacy';
  readonly resolutionDomain?: string;
  readonly root?: string;
  readonly sourceRoots: readonly string[];
  readonly symbolCount: number;
  readonly workspaceId?: string;
  readonly workspaceRoots: readonly string[];
}

export interface CodeGraphVisualizationWorkspace {
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly root: string;
}

export interface CodeGraphVisualizationScopeEdge {
  readonly confidence: number;
  readonly count: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: 'declared-build-dependency' | 'source-relationship';
}

export interface CodeGraphVisualizationCatalog {
  readonly accounting: {
    readonly attributedSymbols: number;
    readonly componentSymbols: number;
    readonly fallbackSymbols: number;
    readonly omittedSymbols: number;
    readonly totalSymbols: number;
  };
  readonly activatedAt?: string;
  readonly metrics: 'complete' | 'deferred';
  readonly model: 'legacy-fallback' | 'workspace';
  readonly projects: readonly CodeGraphVisualizationProject[];
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshot: CodeGraphSnapshot;
  readonly viewWorktreeId: string;
  readonly workspaces: readonly CodeGraphVisualizationWorkspace[];
}

export interface CodeGraphVisualizationRelationshipSummary {
  readonly incoming: number;
  readonly outgoing: number;
  readonly provenances: readonly {
    readonly count: number;
    readonly provenance: CodeGraphProvenance;
  }[];
  readonly relations: readonly {
    readonly count: number;
    readonly incoming: number;
    readonly outgoing: number;
    readonly relation: CodeGraphEdge['relation'];
  }[];
}

export type CodeGraphVisualizationScope =
  | {readonly type: 'all'}
  | {readonly type: 'component'; readonly value: string}
  | {readonly type: 'documentation-facet'}
  | {readonly type: 'package'; readonly value: string}
  | {readonly type: 'path'; readonly value: string}
  | {readonly type: 'unscoped'};

export interface CodeGraphStoreShape {
  readonly withSession: <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
    options?: CodeGraphDatabaseSessionOptions,
  ) => Effect.Effect<A, E | CodeGraphStoreError, Exclude<R, SqlClient.SqlClient>>;
  readonly activate: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    files: readonly CodeGraphInventoryFile[],
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly activateStaged: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
    promotionLeaseDurationMilliseconds?: number,
    onProgress?: CodeGraphActivationProgressCallback,
  ) => Effect.Effect<Option.Option<string>, CodeGraphStoreError>;
  readonly cacheFacts: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphCacheFactInput[],
    extractorSet: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly acquireSnapshotLease: (
    databasePath: string,
    snapshotId: string,
    durationMilliseconds: number,
  ) => Effect.Effect<string, CodeGraphStoreError>;
  readonly promote: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshotId: string,
    activeWorktreeIds: ReadonlySet<string>,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly initialize: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly prepareActivation: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    persistentSnapshotId?: string,
    persistentBatchCount?: number,
    persistentOwnerToken?: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly finalizePersistentMaterializationPlan: (
    databasePath: string,
    expectedBatchCount: number,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly preparePersistedIncrementalActivation: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly replaceStagedModifiedFiles: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly diagnose: (databasePath: string) => Effect.Effect<CodeGraphDatabaseHealth | undefined, CodeGraphStoreError>;
  readonly cachedCommittedFileKeys: (
    databasePath: string,
    extractorSet: string,
  ) => Effect.Effect<ReadonlySet<string>, CodeGraphStoreError>;
  readonly loadCachedFacts: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
    options?: {readonly decode?: boolean},
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
  ) => Effect.Effect<CodeGraphVisualizationCatalog | undefined, CodeGraphStoreError>;
  readonly loadVisualizationCatalogs: (
    databasePath: string,
    metrics?: 'complete' | 'deferred',
  ) => Effect.Effect<readonly CodeGraphVisualizationCatalog[], CodeGraphStoreError>;
  readonly loadVisualizationScopeEdges: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphVisualizationScopeEdge[], CodeGraphStoreError>;
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
  readonly relationshipSummaryForNode: (
    databasePath: string,
    snapshotId: string,
    nodeId: string,
    allowedProvenances: readonly CodeGraphProvenance[],
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
    activeWorktreeIds?: ReadonlySet<string>,
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
  readonly reusableBaseReceipt: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphReusableBaseReceipt | undefined, CodeGraphStoreError>;
  readonly reusableReexports: (
    databasePath: string,
    snapshotId: string,
    seeds: readonly CodeGraphReusableReexportSeed[],
  ) => Effect.Effect<readonly CodeGraphReusableReexport[] | undefined, CodeGraphStoreError>;
  readonly reconcileWorktrees: (
    databasePath: string,
    activeWorktreeIds: ReadonlySet<string>,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly pruneCachedFacts: (
    databasePath: string,
    acceptedExtractorSets?: readonly string[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly pruneRetiredSnapshots: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly repair: (
    databasePath: string,
    dryRun?: boolean,
  ) => Effect.Effect<CodeGraphDatabaseRepair | undefined, CodeGraphStoreError>;
  readonly releaseSnapshotLease: (databasePath: string, token: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly renewSnapshotLease: (
    databasePath: string,
    token: string,
    durationMilliseconds: number,
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
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly stageWorkspaceCatalog: (
    databasePath: string,
    workspace: CodeGraphWorkspace,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly resolveStagedReferences: (
    databasePath: string,
    onProgress?: CodeGraphResolutionProgressCallback,
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

interface CodeGraphDatabaseSessionShape extends CodeGraphDatabaseSessionOptions {
  readonly databasePath: string;
  schemaInitialized: boolean;
  readonly sql: SqlClient.SqlClient;
}

class CodeGraphDatabaseSession extends Context.Service<CodeGraphDatabaseSession, CodeGraphDatabaseSessionShape>()(
  'threadnote/codeGraph/CodeGraphDatabaseSession',
) {}

export class CodeGraphStore extends Context.Service<CodeGraphStore, CodeGraphStoreShape>()(
  'threadnote/codeGraph/CodeGraphStore',
) {
  static readonly layer = Layer.effect(
    CodeGraphStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const scope = yield* Effect.scope;
      const prepare = (databasePath: string) =>
        fs
          .makeDirectory(path.dirname(databasePath), {recursive: true, mode: 0o700})
          .pipe(Effect.mapError(cause => storeError('prepare code graph database', cause)));
      const withWriterGate = <A, E, R>(databasePath: string, effect: Effect.Effect<A, E, R>) =>
        Effect.serviceOption(CodeGraphDatabaseSession).pipe(
          Effect.flatMap(session => {
            const options =
              Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
            if (options?.writerGateHeld) return effect;
            const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
            if (!writerLockPath) return effect;
            return withExclusiveFileLock(
              fs,
              writerLockPath,
              {
                ...CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
                onAcquired: () => options?.onWriterAcquired?.() ?? Effect.void,
                onContention: () => options?.onWriterContention?.() ?? Effect.void,
              },
              effect,
            ).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, system),
            );
          }),
        );
      const ensureSchemaInitialized = (databasePath: string, sql: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
          const matching =
            Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
          if (matching?.schemaInitialized) return;
          yield* withWriterGate(databasePath, initializeSchema(sql));
          if (matching?.sqliteWriterTuning) {
            yield* configureSqliteWriterConnection(
              sql,
              matching.sqliteWriterTuning,
              'connection',
              matching.onSqliteWriterConfigured,
            );
          }
          if (matching) matching.schemaInitialized = true;
        });
      const scheduleCompletedBuildCleanup = (databasePath: string, snapshotId?: string) =>
        Effect.gen(function* () {
          const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
          const options =
            Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
          const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
          const cleanupSweep = Effect.gen(function* () {
            // Purge owns the same gate before deleting the repository root. Check
            // existence only after acquiring it, and open SQLite inside the same
            // critical section, so a detached cleanup fiber cannot retain a
            // Windows file handle or recreate a database after purge.
            if (!(yield* fs.exists(databasePath))) return {deleted: 0, remaining: false};
            yield* options?.onCompletedBuildCleanupConnection?.() ?? Effect.void;
            return yield* useDatabaseDirect(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* configureConnection(sql);
                return yield* drainCompletedPersistentBuildRows(sql, snapshotId, undefined, 1);
              }),
            );
          });
          const runSweep =
            writerLockPath === undefined
              ? cleanupSweep.pipe(Effect.map(Option.some))
              : withExclusiveFileLock(fs, writerLockPath, CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS, cleanupSweep).pipe(
                  Effect.map(Option.some),
                  Effect.catch(error =>
                    isFileLockTimeout(error) ? Effect.succeed(Option.none()) : Effect.fail(error),
                  ),
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
          const cleanup = Effect.gen(function* () {
            for (;;) {
              const result = yield* runSweep;
              // Detached cleanup is opportunistic. Once a foreground writer
              // contends, stop this fiber and leave the reconstructible rows
              // for the next session or maintenance pass.
              if (Option.isNone(result) || !result.value.remaining) return;
              // Foreground writers poll the checkout gate every 25 ms. Detached
              // cleanup never queues on that gate and waits for two polling
              // windows before another bounded page.
              yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
            }
          });
          yield* cleanup.pipe(Effect.ignore, Effect.forkIn(scope));
        }).pipe(Effect.asVoid);
      return CodeGraphStore.of({
        withSession: (databasePath, effect, options) =>
          useDatabaseDirect(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* options?.readOnly ? configureReadConnection(sql) : configureConnection(sql);
              if (options?.writerLockPath !== undefined) {
                // Keep hot upper B-tree pages resident for the one long-lived
                // indexing writer. Read/query sessions retain SQLite's small
                // default cache, so concurrent agents do not multiply this
                // bounded 64 MiB budget.
                if (options.sqliteWriterTuning) {
                  yield* configureSqliteWriterConnection(
                    sql,
                    options.sqliteWriterTuning,
                    'connection',
                    options.onSqliteWriterConfigured,
                  );
                } else {
                  yield* sql.unsafe(`PRAGMA main.cache_size = -${CODE_GRAPH_WRITER_MAIN_CACHE_KIB}`);
                }
              }
              const session = {
                databasePath,
                schemaInitialized: false,
                sql,
                ...options,
              } satisfies CodeGraphDatabaseSessionShape;
              return yield* Effect.gen(function* () {
                // Indexing sessions identify themselves with the checkout-wide
                // writer lock. Reclaim one bounded page from every completed
                // build table before normal work, then let a best-effort fiber
                // continue. A process killed immediately after the ready CAS
                // therefore self-heals on the next ordinary index without
                // making graph queries pay cleanup latency.
                if (options?.cleanupCompletedBuildRows && (yield* tableExists(sql, 'snapshots'))) {
                  yield* drainCompletedPersistentBuildRows(
                    sql,
                    undefined,
                    write => withWriterGate(databasePath, write),
                    1,
                  ).pipe(Effect.ignore);
                  yield* scheduleCompletedBuildCleanup(databasePath);
                }
                return yield* effect;
              }).pipe(Effect.provideService(CodeGraphDatabaseSession, session));
            }),
            options?.readOnly === true,
          ).pipe(
            Effect.catchTag('SqlError', cause =>
              Effect.fail(storeError('use code graph database session', cause as SqlError.SqlError)),
            ),
          ),
        acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds) =>
          Effect.gen(function* () {
            const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
            return yield* prepare(databasePath).pipe(
              Effect.andThen(
                withWriterGate(
                  databasePath,
                  useDatabase(databasePath, acquireSnapshotLease(snapshotId, durationMilliseconds, token)),
                ),
              ),
              Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause)),
            );
          }).pipe(Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause))),
        activate: (databasePath, identity, snapshot, files, symbols, edges) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              withWriterGate(
                databasePath,
                useDatabase(
                  databasePath,
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* initializeSchema(sql);
                    yield* prepareActivationTables(sql);
                    yield* stageActivationFiles(sql, files, 'insert');
                    yield* stageActivationSymbols(sql, symbols, 'insert');
                    yield* stageActivationSymbolTerms(sql, symbols, 'insert');
                    yield* stageActivationEdges(sql, edges, 'insert');
                    yield* activateStagedSnapshot(sql, identity, snapshot);
                  }),
                ),
              ),
            ),
            Effect.mapError(cause => storeError('activate code graph snapshot', cause)),
          ),
        activateStaged: (
          databasePath,
          identity,
          snapshot,
          reusableBaseReceipt,
          promotionLeaseDurationMilliseconds,
          onProgress,
        ) =>
          Effect.gen(function* () {
            const promotionLease =
              promotionLeaseDurationMilliseconds === undefined
                ? Option.none<CodeGraphActivationLease>()
                : Option.some({
                    durationMilliseconds: validatedSnapshotLeaseDuration(promotionLeaseDurationMilliseconds),
                    token: `${system.processId}:${yield* crypto.randomUUIDv4}`,
                  });
            yield* prepare(databasePath);
            const completedPersistentSnapshot = yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const mode = yield* activationMode(sql);
                if (mode?.mode === 'persisted-delta') {
                  yield* withWriterGate(
                    databasePath,
                    activatePersistedIncrementalSnapshot(
                      sql,
                      identity,
                      snapshot,
                      mode.baseSnapshotId,
                      promotionLease,
                      onProgress,
                    ),
                  );
                  return undefined;
                }
                if (mode?.mode === 'persisted-full') {
                  if (mode.snapshotId !== snapshot.id) {
                    return yield* Effect.fail(
                      new CodeGraphStoreError('Persistent full-build activation identity changed.'),
                    );
                  }
                  yield* activatePersistedFullSnapshot(
                    sql,
                    identity,
                    snapshot,
                    mode.ownerToken,
                    reusableBaseReceipt,
                    promotionLease,
                    onProgress,
                    effect => withWriterGate(databasePath, effect),
                  );
                  return snapshot.id;
                }
                yield* withWriterGate(
                  databasePath,
                  activateStagedSnapshot(sql, identity, snapshot, reusableBaseReceipt, promotionLease, onProgress),
                );
                return undefined;
              }),
            );
            if (completedPersistentSnapshot) {
              yield* scheduleCompletedBuildCleanup(databasePath, completedPersistentSnapshot);
            }
            return Option.map(promotionLease, lease => lease.token);
          }).pipe(Effect.mapError(cause => storeError('activate staged code graph snapshot', cause))),
        cacheFacts: (databasePath, files, facts, extractorSet) =>
          Effect.gen(function* () {
            const bounded = yield* Effect.sync(() => facts.map(ensureBoundedCodeGraphFact));
            yield* prepare(databasePath);
            yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureSchemaInitialized(databasePath, sql);
                yield* withWriterGate(
                  databasePath,
                  sql.withTransaction(storeFreshFacts(sql, files, bounded, extractorSet)),
                );
              }),
            );
          }).pipe(Effect.mapError(cause => storeError('cache code graph file facts', cause))),
        promote: (databasePath, identity, snapshotId, activeWorktreeIds) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              withWriterGate(
                databasePath,
                useDatabase(databasePath, promoteSnapshot(identity, snapshotId, activeWorktreeIds)),
              ),
            ),
            Effect.mapError(cause => storeError('promote code graph snapshot', cause)),
          ),
        initialize: databasePath =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureSchemaInitialized(databasePath, sql);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('initialize code graph database', cause)),
          ),
        prepareActivation: (databasePath, files, persistentSnapshotId, persistentBatchCount, persistentOwnerToken) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureSchemaInitialized(databasePath, sql);
                  if (persistentSnapshotId === undefined) {
                    yield* prepareActivationTables(sql);
                    yield* stageActivationFiles(sql, files, 'insert');
                  } else {
                    yield* preparePersistedFullActivation(
                      sql,
                      persistentSnapshotId,
                      files,
                      persistentBatchCount,
                      persistentOwnerToken,
                      effect => withWriterGate(databasePath, effect),
                    );
                  }
                }),
              ),
            ),
            Effect.mapError(cause => storeError('prepare staged code graph activation', cause)),
          ),
        finalizePersistentMaterializationPlan: (databasePath, expectedBatchCount) =>
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
                  yield* withWriterGate(
                    databasePath,
                    finalizePersistentMaterializationPlan(sql, mode.snapshotId, mode.ownerToken, expectedBatchCount),
                  );
                }),
              ),
            ),
            Effect.mapError(cause => storeError('finalize persistent code graph materialization plan', cause)),
          ),
        preparePersistedIncrementalActivation: (databasePath, baseSnapshotId, files, facts) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureSchemaInitialized(databasePath, sql);
                  return yield* preparePersistedIncrementalActivation(baseSnapshotId, files, facts);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('prepare persisted incremental code graph activation', cause)),
          ),
        replaceStagedModifiedFiles: (databasePath, baseSnapshotId, files, facts) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, replaceStagedModifiedFiles(baseSnapshotId, files, facts))),
            Effect.mapError(cause => storeError('replace staged modified code graph files', cause)),
          ),
        diagnose: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, diagnoseDatabase()) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('diagnose code graph database', cause)),
          ),
        cachedCommittedFileKeys: (databasePath, extractorSet) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useReadOnlyDatabase(databasePath, selectCachedCommittedFileKeys(extractorSet))
                : Effect.succeed(new Set<string>()),
            ),
            Effect.mapError(cause => storeError('load cached code graph file keys', cause)),
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
            Effect.andThen(
              useReadOnlyDatabase(databasePath, selectAnalysisEdgeAggregatePage(snapshotId, cursorId, limit)),
            ),
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
        loadVisualizationCatalog: (databasePath, metrics = 'complete') =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useReadOnlyDatabase(databasePath, selectVisualizationCatalog(undefined, metrics))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load code graph visualization catalog', cause)),
          ),
        loadVisualizationCatalogs: (databasePath, metrics = 'complete') =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useReadOnlyDatabase(databasePath, selectVisualizationCatalogs(metrics)) : Effect.succeed([]),
            ),
            Effect.mapError(cause => storeError('load code graph visualization catalogs', cause)),
          ),
        loadVisualizationScopeEdges: (databasePath, snapshotId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useReadOnlyDatabase(databasePath, selectVisualizationScopeEdges(snapshotId))
                : Effect.succeed([]),
            ),
            Effect.mapError(cause => storeError('load code graph visualization scope edges', cause)),
          ),
        loadVisualizationSymbols: (databasePath, snapshotId, scope, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useReadOnlyDatabase(databasePath, selectVisualizationSymbols(snapshotId, scope, limit))),
            Effect.mapError(cause => storeError('load code graph visualization symbols', cause)),
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
                        id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
                        dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
                      ) VALUES (
                        ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
                        ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
                        ${snapshot.overlayFingerprint ?? null}, 'building', 0, 0, 0, ${new Date().toISOString()}
                      )
                      ON CONFLICT(id) DO UPDATE SET
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
        claimPersistentBuild: (databasePath, identity, snapshot) =>
          Effect.gen(function* () {
            const ownerToken = `${system.processId}:${yield* crypto.randomUUIDv4}`;
            const writerGate: CodeGraphWriterGate = effect => withWriterGate(databasePath, effect);
            yield* prepare(databasePath);
            yield* useDatabase(databasePath, claimPersistentSnapshotBuild(identity, snapshot, ownerToken, writerGate));
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
              exists
                ? useReadOnlyDatabase(databasePath, selectResumableBuildById(snapshotId))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load resumable code graph snapshot by identity', cause)),
          ),
        retireIncompleteWorktreeSnapshots: (
          databasePath,
          repositoryId,
          worktreeId,
          retainedSnapshotIds,
          onProgress,
          activeWorktreeIds,
        ) =>
          Effect.gen(function* () {
            yield* prepare(databasePath);
            const orphaned =
              activeWorktreeIds === undefined
                ? []
                : yield* useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const now = yield* Clock.currentTimeMillis;
                      const candidates = yield* selectOrphanedIncompleteSnapshots(repositoryId, activeWorktreeIds, now);
                      return candidates.filter(candidate =>
                        orphanedIncompleteSnapshotSafeToReclaim(candidate, now, system.isProcessRunning),
                      );
                    }),
                  );
            return yield* useDatabase(
              databasePath,
              retireIncompleteWorktreeSnapshots(
                repositoryId,
                worktreeId,
                retainedSnapshotIds,
                effect => withWriterGate(databasePath, effect),
                onProgress,
                orphaned,
              ),
            );
          }).pipe(Effect.mapError(cause => storeError('retire incomplete code graph snapshots', cause))),
        markFailed: (databasePath, snapshotId, summary, ownerToken) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const changed = yield* withWriterGate(
                    databasePath,
                    failBuildingSnapshot(snapshotId, summary, ownerToken),
                  );
                  if (ownerToken !== undefined && changed > 0) {
                    yield* pruneRetiredSnapshotRows(effect => withWriterGate(databasePath, effect));
                  }
                }),
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
              exists
                ? useReadOnlyDatabase(databasePath, selectReadySnapshotById(snapshotId))
                : Effect.succeed(undefined),
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
        reusableBaseReceipt: (databasePath, snapshotId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useReadOnlyDatabase(databasePath, selectReusableBaseReceipt(snapshotId))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load reusable code graph base receipt', cause)),
          ),
        reusableReexports: (databasePath, snapshotId, seeds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useReadOnlyDatabase(databasePath, selectReusableReexports(snapshotId, seeds))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load reusable code graph reexport provenance', cause)),
          ),
        relationshipSummaryForNode: (databasePath, snapshotId, nodeId, allowedProvenances) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useReadOnlyDatabase(
                databasePath,
                selectRelationshipSummaryForNode(snapshotId, nodeId, allowedProvenances),
              ),
            ),
            Effect.mapError(cause => storeError('summarize code graph relationships', cause)),
          ),
        reconcileWorktrees: (databasePath, activeWorktreeIds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? withWriterGate(
                    databasePath,
                    useDatabase(
                      databasePath,
                      Effect.gen(function* () {
                        const sql = yield* SqlClient.SqlClient;
                        yield* configureConnection(sql);
                        yield* sql.withTransaction(reconcileActiveWorktrees(sql, activeWorktreeIds));
                      }),
                    ),
                  )
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('reconcile code graph worktrees', cause)),
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
        repair: (databasePath, dryRun = false) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, repairDatabase(dryRun)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('repair code graph database', cause)),
          ),
        releaseSnapshotLease: (databasePath, token) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? withWriterGate(databasePath, useDatabase(databasePath, releaseSnapshotLease(token)))
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('release code graph snapshot lease', cause)),
          ),
        renewSnapshotLease: (databasePath, token, durationMilliseconds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? withWriterGate(
                    databasePath,
                    useDatabase(databasePath, renewSnapshotLease(token, durationMilliseconds)),
                  )
                : Effect.fail(new CodeGraphStoreError('The code graph database disappeared while renewing a lease.')),
            ),
            Effect.mapError(cause => storeError('renew code graph snapshot lease', cause)),
          ),
        searchSymbols: (databasePath, snapshotId, query, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useReadOnlyDatabase(databasePath, selectSearchSymbols(snapshotId, query, limit))),
            Effect.mapError(cause => storeError('search code graph symbols', cause)),
          ),
        searchSymbolsMany: (databasePath, snapshotId, queries, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useReadOnlyDatabase(databasePath, selectSearchSymbolsMany(snapshotId, queries, limit))),
            Effect.mapError(cause => storeError('search code graph symbols', cause)),
          ),
        searchSymbolsByPaths: (databasePath, snapshotId, sourcePaths, limitPerPath) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useReadOnlyDatabase(databasePath, selectSymbolsByPaths(snapshotId, sourcePaths, limitPerPath)),
            ),
            Effect.mapError(cause => storeError('search code graph symbols by path', cause)),
          ),
        symbolsByIds: (databasePath, snapshotId, ids) =>
          prepare(databasePath).pipe(
            Effect.andThen(useReadOnlyDatabase(databasePath, selectSymbolsByIds(snapshotId, ids))),
            Effect.mapError(cause => storeError('load code graph symbols', cause)),
          ),
        stageActivationFacts: (databasePath, symbols, edges, references = [], onProgress, batchIndex) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const mode = yield* activationMode(sql);
                  const observer = activationStagingObserver(
                    sql,
                    onProgress,
                    mode?.mode === 'persisted-full' ? 'main' : 'temp',
                  );
                  if (mode?.mode === 'persisted-full') {
                    yield* withWriterGate(
                      databasePath,
                      stagePersistedFullFacts(
                        sql,
                        mode.snapshotId,
                        mode.ownerToken,
                        batchIndex ?? 0,
                        symbols,
                        edges,
                        references,
                        observer,
                      ),
                    );
                    return;
                  }
                  yield* sql.withTransaction(
                    Effect.gen(function* () {
                      yield* stageActivationSymbols(sql, symbols, 'insert', observer);
                      yield* stageActivationSymbolTerms(sql, symbols, 'insert', observer);
                      yield* stageActivationEdges(sql, edges, 'insert', observer);
                      yield* stageActivationReferences(sql, references, 'insert', observer);
                      yield* observer('committing', 0, true);
                    }),
                  );
                  yield* observer('committed', 0, true);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('stage code graph facts', cause)),
          ),
        stageWorkspaceCatalog: (databasePath, workspace) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const mode = yield* activationMode(sql);
                  if (mode?.mode === 'persisted-full') {
                    yield* withWriterGate(
                      databasePath,
                      stagePersistedFullWorkspace(sql, mode.snapshotId, mode.ownerToken, workspace),
                    );
                  } else {
                    yield* stageActivationWorkspace(workspace);
                  }
                }),
              ),
            ),
            Effect.mapError(cause => storeError('stage code graph workspace catalog', cause)),
          ),
        resolveStagedReferences: (databasePath, onProgress) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                resolveActivationReferences(onProgress, effect => withWriterGate(databasePath, effect)),
              ),
            ),
            Effect.mapError(cause => storeError('resolve staged code graph references', cause)),
          ),
        stagedFactCounts: databasePath =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const mode = yield* activationMode(sql);
                  if (mode?.mode === 'persisted-delta') {
                    const counts = yield* persistedIncrementalFactCounts(sql, mode.baseSnapshotId);
                    return {edges: counts.edges, symbols: counts.symbols};
                  }
                  if (mode?.mode === 'persisted-full') {
                    const rows = yield* sql<{readonly edges: number; readonly symbols: number}>`
                      SELECT
                        (SELECT COUNT(*) FROM edges WHERE snapshot_id = ${mode.snapshotId}) AS edges,
                        (SELECT COUNT(*) FROM symbols WHERE snapshot_id = ${mode.snapshotId}) AS symbols
                    `;
                    return {
                      edges: Number(rows[0]?.edges ?? 0),
                      symbols: Number(rows[0]?.symbols ?? 0),
                    };
                  }
                  const [symbolRows, edgeRows] = yield* Effect.all([
                    sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM activation_symbols`,
                    sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM activation_edges`,
                  ]);
                  return {
                    edges: Number(edgeRows[0]?.count ?? 0),
                    symbols: Number(symbolRows[0]?.count ?? 0),
                  };
                }),
              ),
            ),
            Effect.mapError(cause => storeError('count staged code graph facts', cause)),
          ),
      });
    }),
  );
}

function useDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.serviceOption(CodeGraphDatabaseSession).pipe(
    Effect.flatMap(session =>
      Option.isSome(session) && session.value.databasePath === databasePath
        ? effect.pipe(Effect.provideService(SqlClient.SqlClient, session.value.sql))
        : useDatabaseDirect(databasePath, effect),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function useReadOnlyDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.serviceOption(CodeGraphDatabaseSession).pipe(
    Effect.flatMap(session =>
      Option.isSome(session) && session.value.databasePath === databasePath
        ? effect.pipe(Effect.provideService(SqlClient.SqlClient, session.value.sql))
        : useDatabaseDirect(databasePath, effect, true),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function useDatabaseDirect<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
  readOnly = false,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  const layer = readOnly
    ? SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      })
    : SqliteClient.layer({filename: databasePath});
  return Effect.scoped(effect.pipe(Effect.provide(layer))) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

const configureConnection = Effect.fn('codeGraph.configureConnection')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
});

const configureReadConnection = Effect.fn('codeGraph.configureReadConnection')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  yield* sql.unsafe('PRAGMA query_only = ON');
});

const CODE_GRAPH_WRITER_MAIN_CACHE_KIB = 64 * 1_024;
const CODE_GRAPH_SQLITE_WRITER_CACHE_KIB_MAXIMUM = 4 * 1_024 * 1_024;
const CODE_GRAPH_SQLITE_WRITER_MMAP_BYTES_MAXIMUM = 64 * 1_024 * 1_024 * 1_024;
const CODE_GRAPH_SQLITE_WRITER_WAL_CHECKPOINT_PAGES_MAXIMUM = 1_000_000;

const configureSqliteWriterConnection = Effect.fn('codeGraph.configureSqliteWriterConnection')(function* (
  sql: SqlClient.SqlClient,
  tuning: CodeGraphSqliteWriterTuning,
  phase: CodeGraphSqliteWriterSettings['phase'],
  observe?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>,
) {
  if (tuning.mainCacheKiB !== undefined) {
    const value = sqlitePragmaInteger(
      tuning.mainCacheKiB,
      'SQLite writer cache KiB',
      1,
      CODE_GRAPH_SQLITE_WRITER_CACHE_KIB_MAXIMUM,
    );
    yield* sql.unsafe(`PRAGMA main.cache_size = -${value}`);
  }
  if (tuning.mmapSizeBytes !== undefined) {
    const value = sqlitePragmaInteger(
      tuning.mmapSizeBytes,
      'SQLite writer mmap bytes',
      0,
      CODE_GRAPH_SQLITE_WRITER_MMAP_BYTES_MAXIMUM,
    );
    yield* sql.unsafe(`PRAGMA main.mmap_size = ${value}`);
  }
  if (tuning.walAutoCheckpointPages !== undefined) {
    const value = sqlitePragmaInteger(
      tuning.walAutoCheckpointPages,
      'SQLite writer WAL auto-checkpoint pages',
      0,
      CODE_GRAPH_SQLITE_WRITER_WAL_CHECKPOINT_PAGES_MAXIMUM,
    );
    yield* sql.unsafe(`PRAGMA wal_autocheckpoint = ${value}`);
  }
  yield* reportSqliteWriterSettings(sql, phase, observe);
});

const configureReconstructibleBuildDurability = Effect.fn('codeGraph.configureReconstructibleBuildDurability')(
  function* (sql: SqlClient.SqlClient) {
    const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
    if (
      Option.isNone(session) ||
      session.value.sql !== sql ||
      session.value.sqliteWriterTuning?.reconstructibleBuildSynchronous !== 'normal'
    ) {
      return;
    }
    // Only unpublished full-build rows use NORMAL. They are ignored by readers,
    // fingerprinted by batch, and can be resumed or reconstructed after a crash.
    yield* sql.unsafe('PRAGMA synchronous = NORMAL');
    yield* reportSqliteWriterSettings(sql, 'building', session.value.onSqliteWriterConfigured);
  },
);

const configurePublicationDurability = Effect.fn('codeGraph.configurePublicationDurability')(function* (
  sql: SqlClient.SqlClient,
) {
  const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
  if (
    Option.isNone(session) ||
    session.value.sql !== sql ||
    session.value.sqliteWriterTuning?.reconstructibleBuildSynchronous !== 'normal'
  ) {
    return;
  }
  // The ready-state CAS is the publication boundary. FULL makes that commit
  // sync the WAL containing every earlier NORMAL full-build transaction before
  // readers can observe the snapshot as ready.
  yield* sql.unsafe('PRAGMA synchronous = FULL');
  yield* reportSqliteWriterSettings(sql, 'publication', session.value.onSqliteWriterConfigured);
});

const reportSqliteWriterSettings = Effect.fn('codeGraph.reportSqliteWriterSettings')(function* (
  sql: SqlClient.SqlClient,
  phase: CodeGraphSqliteWriterSettings['phase'],
  observe?: (settings: CodeGraphSqliteWriterSettings) => Effect.Effect<void, never>,
) {
  if (!observe) return;
  const [cache, journal, mmap, synchronous, wal] = yield* Effect.all(
    [
      sql.unsafe<{readonly cache_size: number}>('PRAGMA main.cache_size'),
      sql.unsafe<{readonly journal_mode: string}>('PRAGMA main.journal_mode'),
      sql.unsafe<{readonly mmap_size: number}>('PRAGMA main.mmap_size'),
      sql.unsafe<{readonly synchronous: number}>('PRAGMA main.synchronous'),
      sql.unsafe<{readonly wal_autocheckpoint: number}>('PRAGMA wal_autocheckpoint'),
    ] as const,
    {concurrency: 1},
  );
  yield* observe({
    cacheSizePragma: Number(cache[0]?.cache_size ?? 0),
    journalMode: String(journal[0]?.journal_mode ?? 'unknown'),
    mmapSizeBytes: Number(mmap[0]?.mmap_size ?? 0),
    phase,
    synchronous: Number(synchronous[0]?.synchronous ?? -1),
    walAutoCheckpointPages: Number(wal[0]?.wal_autocheckpoint ?? 0),
  });
});

function sqlitePragmaInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CodeGraphStoreError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: Number.POSITIVE_INFINITY,
} as const;

const CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS = {
  ...CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS,
  waitTimeoutMilliseconds: 0,
} as const;

const CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS = CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS.retryIntervalMilliseconds * 2;
const CODE_GRAPH_ORPHANED_UNOWNED_BUILD_MINIMUM_AGE_MILLISECONDS = 15 * 60_000;

function inferredCodeGraphWriterLockPath(path: Path.Path, databasePath: string): string | undefined {
  if (path.basename(databasePath) !== `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`) return undefined;
  const repositoryRoot = path.dirname(databasePath);
  const checkoutId = path.basename(repositoryRoot);
  const repositoriesRoot = path.dirname(repositoryRoot);
  const codeGraphRoot = path.dirname(repositoriesRoot);
  const indexesRoot = path.dirname(codeGraphRoot);
  if (
    !/^[0-9a-f]{64}$/.test(checkoutId) ||
    path.basename(repositoriesRoot) !== 'repositories' ||
    path.basename(codeGraphRoot) !== 'code-graph' ||
    path.basename(indexesRoot) !== 'indexes'
  ) {
    return undefined;
  }
  return path.join(
    path.dirname(indexesRoot),
    'locks',
    'indexes',
    'code-graph',
    'database-writes',
    `${checkoutId}.lock`,
  );
}

type PersistentExtensionGroup = 'analysis' | 'build' | 'lexical';

export type CodeGraphPersistentSchemaMigrationPhase =
  | 'added-materialization-plan'
  | 'created-extensions'
  | 'dropped-incompatible'
  | 'dropped-obsolete-indexes'
  | 'recorded-revision'
  | 'retired-incompatible-ready'
  | 'retired-incomplete'
  | 'validated';

interface PersistentExtensionColumnContract {
  readonly name: string;
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
  readonly type: string;
}

interface PersistentExtensionTableContract {
  readonly columns: readonly PersistentExtensionColumnContract[];
  readonly createSql: string;
  readonly foreignKeys?: readonly PersistentExtensionForeignKeyContract[];
  readonly group: PersistentExtensionGroup;
  readonly name: string;
  readonly requiredDefinitionPatterns?: readonly RegExp[];
  readonly uniqueKeys?: readonly (readonly string[])[];
  readonly withoutRowid?: boolean;
}

interface PersistentExtensionForeignKeyContract {
  readonly from: string;
  readonly onDelete: string;
  readonly table: string;
  readonly to: string;
}

interface PersistentExtensionTableInspection {
  readonly compatible: boolean;
  readonly exists: boolean;
  readonly group: PersistentExtensionGroup;
  readonly name: string;
}

interface SqliteTableColumnRow {
  readonly cid: number;
  readonly dflt_value: unknown;
  readonly name: string;
  readonly notnull: number;
  readonly pk: number;
  readonly type: string;
}

interface SqliteForeignKeyRow {
  readonly from: string;
  readonly on_delete: string;
  readonly table: string;
  readonly to: string;
}

interface SqliteIndexListRow {
  readonly name: string;
  readonly partial: number;
  readonly unique: number;
}

interface SqliteIndexInfoRow {
  readonly name: string;
  readonly seqno: number;
}

const requiredColumn = (name: string, type: string, primaryKeyPosition = 0): PersistentExtensionColumnContract => ({
  name,
  notNull: true,
  primaryKeyPosition,
  type,
});

const optionalColumn = (name: string, type: string): PersistentExtensionColumnContract => ({
  name,
  notNull: false,
  primaryKeyPosition: 0,
  type,
});

/**
 * Complete persistent schema delta from beta.30. These tables deliberately do
 * not change the public graph schema version: beta databases can retain ready
 * snapshots while derived summaries are created and interrupted full builds
 * are restarted against the current resumable-build contract.
 */
const PERSISTENT_EXTENSION_TABLES = [
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('owner_token', 'TEXT'),
      requiredColumn('claimed_at', 'TEXT'),
      optionalColumn('expected_batch_count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_build_owners (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expected_batch_count INTEGER CHECK (expected_batch_count IS NULL OR expected_batch_count >= 0)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'snapshot_build_owners',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('language', 'TEXT', 2),
      requiredColumn('kind', 'TEXT', 3),
      requiredColumn('count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_symbol_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, language, kind)
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_symbol_counts',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('provenance', 'TEXT', 2),
      requiredColumn('relation', 'TEXT', 3),
      requiredColumn('confidence', 'REAL', 4),
      requiredColumn('endpoint_state', 'INTEGER', 5),
      requiredColumn('count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_histogram (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      endpoint_state INTEGER NOT NULL CHECK (endpoint_state IN (0, 1, 2)),
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, provenance, relation, confidence, endpoint_state)
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_edge_histogram',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('provenance', 'TEXT', 2),
      requiredColumn('relation', 'TEXT', 3),
      requiredColumn('count', 'INTEGER'),
      requiredColumn('confidence_invalid', 'INTEGER'),
      requiredColumn('confidence_total', 'REAL'),
      requiredColumn('lowest_confidence', 'REAL'),
      requiredColumn('confidence_high', 'INTEGER'),
      requiredColumn('confidence_medium', 'INTEGER'),
      requiredColumn('confidence_low', 'INTEGER'),
      requiredColumn('unresolved_endpoint_count', 'INTEGER'),
      requiredColumn('self_loop_count', 'INTEGER'),
      requiredColumn('review_finding_count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count >= 0),
      confidence_invalid INTEGER NOT NULL CHECK (confidence_invalid >= 0),
      confidence_total REAL NOT NULL,
      lowest_confidence REAL NOT NULL,
      confidence_high INTEGER NOT NULL CHECK (confidence_high >= 0),
      confidence_medium INTEGER NOT NULL CHECK (confidence_medium >= 0),
      confidence_low INTEGER NOT NULL CHECK (confidence_low >= 0),
      unresolved_endpoint_count INTEGER NOT NULL CHECK (unresolved_endpoint_count >= 0),
      self_loop_count INTEGER NOT NULL CHECK (self_loop_count >= 0),
      review_finding_count INTEGER NOT NULL CHECK (review_finding_count >= 0),
      PRIMARY KEY (snapshot_id, provenance, relation)
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_edge_counts',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('version', 'INTEGER'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('digest', 'TEXT'),
      requiredColumn('created_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_analysis_summary_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version = 1),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'analysis',
    name: 'snapshot_analysis_summary_receipts',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('batch_index', 'INTEGER', 2),
      requiredColumn('batch_fingerprint', 'TEXT'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('completed_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_analysis_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_analysis_batches',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('edge_id', 'TEXT', 2),
      requiredColumn('resolution_domain', 'TEXT'),
      requiredColumn('exported_only', 'INTEGER'),
      requiredColumn('alias_lookup_keys_json', 'TEXT'),
      requiredColumn('lookup_tiers_json', 'TEXT'),
      requiredColumn('candidate_count', 'INTEGER'),
      requiredColumn('candidate_payload_bytes', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_references (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
      alias_lookup_keys_json TEXT NOT NULL,
      lookup_tiers_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      candidate_payload_bytes INTEGER NOT NULL CHECK (candidate_payload_bytes >= 0),
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_references',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('edge_id', 'TEXT', 2),
      requiredColumn('tier', 'INTEGER', 3),
      requiredColumn('lookup_key', 'TEXT', 4),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_reference_candidates (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id, tier, lookup_key)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_reference_candidates',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('batch_index', 'INTEGER', 2),
      requiredColumn('batch_fingerprint', 'TEXT'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('edge_count', 'INTEGER'),
      requiredColumn('term_count', 'INTEGER'),
      requiredColumn('lookup_count', 'INTEGER'),
      requiredColumn('reference_count', 'INTEGER'),
      requiredColumn('candidate_count', 'INTEGER'),
      requiredColumn('reexport_count', 'INTEGER'),
      requiredColumn('completed_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_materialization_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0),
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      reference_count INTEGER NOT NULL CHECK (reference_count >= 0),
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_materialization_batches',
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('completed_batch_count', 'INTEGER'),
      requiredColumn('posting_count', 'INTEGER'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('term_count', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS building_lexical_counters (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      completed_batch_count INTEGER NOT NULL CHECK (completed_batch_count >= 0),
      posting_count INTEGER NOT NULL CHECK (posting_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0)
    ) WITHOUT ROWID`,
    group: 'build',
    name: 'building_lexical_counters',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*completed_batch_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*posting_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*symbol_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*term_count\s*>=\s*0\s*\)/i,
    ],
  },
  {
    columns: [requiredColumn('snapshot_key', 'INTEGER', 1), requiredColumn('snapshot_id', 'TEXT')],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_snapshots (
      snapshot_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_id TEXT UNIQUE NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE
    )`,
    foreignKeys: [{from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshots', to: 'id'}],
    group: 'lexical',
    name: 'lexical_compact_snapshots',
    uniqueKeys: [['snapshot_id']],
    withoutRowid: false,
  },
  {
    columns: [
      requiredColumn('term_key', 'INTEGER', 1),
      requiredColumn('snapshot_key', 'INTEGER'),
      requiredColumn('term', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_terms (
      term_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
      term TEXT NOT NULL,
      UNIQUE (snapshot_key, term)
    )`,
    foreignKeys: [{from: 'snapshot_key', onDelete: 'CASCADE', table: 'lexical_compact_snapshots', to: 'snapshot_key'}],
    group: 'lexical',
    name: 'lexical_compact_terms',
    uniqueKeys: [['snapshot_key', 'term']],
    withoutRowid: false,
  },
  {
    columns: [
      requiredColumn('symbol_key', 'INTEGER', 1),
      requiredColumn('snapshot_key', 'INTEGER'),
      requiredColumn('symbol_id', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_symbols (
      symbol_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      UNIQUE (snapshot_key, symbol_id)
    )`,
    foreignKeys: [{from: 'snapshot_key', onDelete: 'CASCADE', table: 'lexical_compact_snapshots', to: 'snapshot_key'}],
    group: 'lexical',
    name: 'lexical_compact_symbols',
    uniqueKeys: [['snapshot_key', 'symbol_id']],
    withoutRowid: false,
  },
  {
    columns: [
      requiredColumn('snapshot_key', 'INTEGER', 1),
      requiredColumn('term_key', 'INTEGER', 2),
      requiredColumn('symbol_key', 'INTEGER', 3),
      requiredColumn('weight', 'INTEGER'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_compact_postings (
      snapshot_key INTEGER NOT NULL REFERENCES lexical_compact_snapshots(snapshot_key) ON DELETE CASCADE,
      term_key INTEGER NOT NULL,
      symbol_key INTEGER NOT NULL,
      weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 5),
      PRIMARY KEY (snapshot_key, term_key, symbol_key)
    ) WITHOUT ROWID`,
    foreignKeys: [{from: 'snapshot_key', onDelete: 'CASCADE', table: 'lexical_compact_snapshots', to: 'snapshot_key'}],
    group: 'lexical',
    name: 'lexical_compact_postings',
    requiredDefinitionPatterns: [/CHECK\s*\(\s*weight\s+BETWEEN\s+1\s+AND\s+5\s*\)/i],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('format_version', 'INTEGER'),
      requiredColumn('posting_count', 'INTEGER'),
      requiredColumn('symbol_count', 'INTEGER'),
      requiredColumn('term_count', 'INTEGER'),
      requiredColumn('created_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS lexical_storage_formats (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL CHECK (format_version = 1),
      posting_count INTEGER NOT NULL CHECK (posting_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0),
      created_at TEXT NOT NULL
    ) WITHOUT ROWID`,
    group: 'lexical',
    name: 'lexical_storage_formats',
    requiredDefinitionPatterns: [
      /CHECK\s*\(\s*format_version\s*=\s*1\s*\)/i,
      /CHECK\s*\(\s*posting_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*symbol_count\s*>=\s*0\s*\)/i,
      /CHECK\s*\(\s*term_count\s*>=\s*0\s*\)/i,
    ],
  },
] as const satisfies readonly PersistentExtensionTableContract[];

const LEGACY_SNAPSHOT_BUILD_OWNERS_CONTRACT = {
  columns: [
    requiredColumn('snapshot_id', 'TEXT', 1),
    requiredColumn('owner_token', 'TEXT'),
    requiredColumn('claimed_at', 'TEXT'),
  ],
  createSql: `CREATE TABLE snapshot_build_owners (
    snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    owner_token TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  ) WITHOUT ROWID`,
  group: 'build',
  name: 'snapshot_build_owners',
} as const satisfies PersistentExtensionTableContract;

const LEGACY_BUILDING_REFERENCES_V3_TABLE = 'legacy_building_references_v3';
const LEGACY_BUILDING_REFERENCES_V3_CONTRACT = {
  columns: [
    requiredColumn('snapshot_id', 'TEXT', 1),
    requiredColumn('edge_id', 'TEXT', 2),
    requiredColumn('resolution_domain', 'TEXT'),
    requiredColumn('exported_only', 'INTEGER'),
    requiredColumn('alias_lookup_keys_json', 'TEXT'),
  ],
  createSql: `CREATE TABLE building_references (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    edge_id TEXT NOT NULL,
    resolution_domain TEXT NOT NULL,
    exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
    alias_lookup_keys_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, edge_id)
  ) WITHOUT ROWID`,
  group: 'build',
  name: 'building_references',
} as const satisfies PersistentExtensionTableContract;

const REMOVED_BETA30_INDEXES = ['snapshot_symbol_lookup_key', 'terms_lookup', 'terms_symbol'] as const;
export const CODE_GRAPH_PERSISTENT_EXTENSION_TABLE_NAMES = PERSISTENT_EXTENSION_TABLES.map(table => table.name);
export const CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION = 5;

function persistentExtensionTableInspection(
  sql: SqlClient.SqlClient,
  contract: PersistentExtensionTableContract,
): Effect.Effect<PersistentExtensionTableInspection, SqlError.SqlError> {
  return Effect.gen(function* () {
    const definitions = yield* sql<{readonly sql: string}>`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${contract.name} LIMIT 1
    `;
    const definition = definitions[0]?.sql;
    if (definition === undefined) {
      return {compatible: false, exists: false, group: contract.group, name: contract.name};
    }
    const columns = yield* sql.unsafe<SqliteTableColumnRow>(`PRAGMA table_info("${contract.name}")`);
    const foreignKeys = yield* sql.unsafe<SqliteForeignKeyRow>(`PRAGMA foreign_key_list("${contract.name}")`);
    const indexes =
      contract.uniqueKeys === undefined
        ? []
        : yield* sql.unsafe<SqliteIndexListRow>(`PRAGMA index_list("${contract.name}")`);
    const compatibleColumns =
      columns.length === contract.columns.length &&
      columns.every((column, index) => {
        const expected = contract.columns[index];
        return (
          expected !== undefined &&
          Number(column.cid) === index &&
          column.name === expected.name &&
          column.type.toUpperCase() === expected.type &&
          Number(column.notnull) === Number(expected.notNull) &&
          Number(column.pk) === expected.primaryKeyPosition &&
          column.dflt_value == null
        );
      });
    const expectedForeignKeys = contract.foreignKeys ?? [
      {from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshots', to: 'id'},
    ];
    const actualForeignKeys = foreignKeys
      .map(key => ({
        from: key.from,
        onDelete: key.on_delete.toUpperCase(),
        table: key.table,
        to: key.to,
      }))
      .sort(
        (left, right) =>
          compareCodeUnits(left.from, right.from) ||
          compareCodeUnits(left.table, right.table) ||
          compareCodeUnits(left.to, right.to),
      );
    const normalizedExpectedForeignKeys = [...expectedForeignKeys]
      .map(key => ({...key, onDelete: key.onDelete.toUpperCase()}))
      .sort(
        (left, right) =>
          compareCodeUnits(left.from, right.from) ||
          compareCodeUnits(left.table, right.table) ||
          compareCodeUnits(left.to, right.to),
      );
    const compatibleForeignKeys =
      actualForeignKeys.length === normalizedExpectedForeignKeys.length &&
      actualForeignKeys.every((key, index) => {
        const expected = normalizedExpectedForeignKeys[index];
        return (
          expected !== undefined &&
          key.from === expected.from &&
          key.table === expected.table &&
          key.to === expected.to &&
          key.onDelete === expected.onDelete
        );
      });
    const actualUniqueKeys: (readonly string[])[] = [];
    for (const index of indexes) {
      if (Number(index.unique) !== 1 || Number(index.partial) !== 0) continue;
      const escapedIndexName = index.name.replaceAll('"', '""');
      const indexedColumns = yield* sql.unsafe<SqliteIndexInfoRow>(`PRAGMA index_info("${escapedIndexName}")`);
      actualUniqueKeys.push(
        [...indexedColumns].sort((left, right) => Number(left.seqno) - Number(right.seqno)).map(column => column.name),
      );
    }
    const compatibleUniqueKeys = (contract.uniqueKeys ?? []).every(expected =>
      actualUniqueKeys.some(
        actual => actual.length === expected.length && actual.every((column, index) => column === expected[index]),
      ),
    );
    const compatibleDefinition = (contract.requiredDefinitionPatterns ?? []).every(pattern => pattern.test(definition));
    const expectsWithoutRowid = contract.withoutRowid ?? true;
    return {
      compatible:
        compatibleColumns &&
        compatibleForeignKeys &&
        compatibleUniqueKeys &&
        compatibleDefinition &&
        /\bWITHOUT\s+ROWID\b/i.test(definition) === expectsWithoutRowid,
      exists: true,
      group: contract.group,
      name: contract.name,
    };
  });
}

const inspectPersistentExtensionTables = Effect.fn('codeGraph.inspectPersistentExtensionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* Effect.forEach(PERSISTENT_EXTENSION_TABLES, contract =>
    persistentExtensionTableInspection(sql, contract),
  );
});

export const codeGraphPersistentExtensionSchemaCompatible = Effect.fn('codeGraph.persistentExtensionSchemaCompatible')(
  function* (sql: SqlClient.SqlClient) {
    const inspections = yield* inspectPersistentExtensionTables(sql);
    return inspections.every(inspection => inspection.exists && inspection.compatible);
  },
);

const migratePersistentExtensionTables = Effect.fn('codeGraph.migratePersistentExtensionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
  const observe = Option.isSome(session) ? session.value.onPersistentSchemaMigrationPhase : undefined;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const revision = yield* sql<{readonly value: string}>`
        SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision' LIMIT 1
      `;
      const recordedRevision = Number(revision[0]?.value);
      if (
        Number.isSafeInteger(recordedRevision) &&
        recordedRevision > CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError(
            `Code graph persistent extension schema ${recordedRevision} is newer than ${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}.`,
          ),
        );
      }
      const legacyBuildOwners = yield* persistentExtensionTableInspection(sql, LEGACY_SNAPSHOT_BUILD_OWNERS_CONTRACT);
      if (legacyBuildOwners.compatible) {
        const completedAt = new Date().toISOString();
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${completedAt}),
              failure_summary = COALESCE(
                failure_summary,
                'Persistent code graph materialization plan changed; rebuild required.'
              )
          WHERE state IN ('building', 'failed')
        `;
        const retired = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
        if (Number(retired[0]?.count ?? 0) > 0) yield* observe?.('retired-incomplete') ?? Effect.void;
        // The beta.30 owner table is tiny. Upgrade it in place so retiring a
        // multi-gigabyte interrupted build never synchronously drops its
        // staging tables; bounded maintenance reclaims those rows later.
        yield* sql.unsafe(`
          ALTER TABLE snapshot_build_owners
          ADD COLUMN expected_batch_count INTEGER
          CHECK (expected_batch_count IS NULL OR expected_batch_count >= 0)
        `);
        yield* observe?.('added-materialization-plan') ?? Effect.void;
      }
      if (revision[0]?.value === '3') {
        const legacyReferences = yield* persistentExtensionTableInspection(sql, LEGACY_BUILDING_REFERENCES_V3_CONTRACT);
        const alreadyRenamed = yield* tableExists(sql, LEGACY_BUILDING_REFERENCES_V3_TABLE);
        if (legacyReferences.compatible && !alreadyRenamed) {
          const completedAt = new Date().toISOString();
          yield* sql`
            UPDATE snapshots
            SET state = 'retired',
                completed_at = COALESCE(completed_at, ${completedAt}),
                failure_summary = COALESCE(
                  failure_summary,
                  'Persistent reference candidate format changed; rebuild required.'
                )
            WHERE state IN ('building', 'failed')
          `;
          const retired = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          if (Number(retired[0]?.count ?? 0) > 0) yield* observe?.('retired-incomplete') ?? Effect.void;
          // Renaming the old reference surface is metadata-only. Its rows and
          // the much larger row-per-candidate table remain available to the
          // bounded maintenance collector instead of being dropped in this
          // schema transaction.
          yield* sql.unsafe(`ALTER TABLE building_references RENAME TO ${LEGACY_BUILDING_REFERENCES_V3_TABLE}`);
          const currentReferences = PERSISTENT_EXTENSION_TABLES.find(table => table.name === 'building_references');
          if (currentReferences === undefined) {
            return yield* Effect.fail(new CodeGraphStoreError('Current persistent reference schema is unavailable.'));
          }
          yield* sql.unsafe(currentReferences.createSql);
        }
      }
      const inspections = yield* inspectPersistentExtensionTables(sql);
      const extensionSchemaCompatible = inspections.every(inspection => inspection.exists && inspection.compatible);
      if (revision[0]?.value === String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION) && extensionSchemaCompatible) {
        return;
      }
      const incompatibleGroups = new Set(
        inspections
          .filter(inspection => inspection.exists && !inspection.compatible)
          .map(inspection => inspection.group),
      );
      const missingTable = inspections.some(inspection => !inspection.exists);
      const lexicalReadSurfaceMissing = inspections.some(
        inspection => inspection.group === 'lexical' && !inspection.exists,
      );
      const incomplete = yield* sql<{readonly count: number}>`
        SELECT COUNT(*) AS count FROM snapshots WHERE state IN ('building', 'failed')
      `;
      const hasIncompleteSnapshots = Number(incomplete[0]?.count ?? 0) > 0;

      // A receipt from a different resumable-build contract cannot prove that
      // already committed rows belong to the caller's current fact batch. Keep
      // ready snapshots intact, but make every incomplete snapshot unreachable
      // before replacing its build-only schema. Retired rows are reclaimed by
      // the normal bounded collector instead of one unbounded cascade here.
      if (hasIncompleteSnapshots && (missingTable || incompatibleGroups.size > 0)) {
        const completedAt = new Date().toISOString();
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${completedAt}),
              failure_summary = COALESCE(
                failure_summary,
                'Persistent code graph build schema changed; rebuild required.'
              )
          WHERE state IN ('building', 'failed')
        `;
        yield* observe?.('retired-incomplete') ?? Effect.void;
      }
      // Revision 5 is the first schema that can claim compact lexical storage.
      // If any table in that contract is missing or incompatible, keeping a
      // ready snapshot while replacing its dictionaries would make the graph
      // appear healthy but return no lexical candidates. Invalidate the ready
      // pointer atomically and let the normal snapshot-identity path rebuild it.
      // Revision 4 snapshots remain readable from legacy symbol_terms while the
      // new compact tables are introduced alongside them.
      if (
        recordedRevision === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
        (incompatibleGroups.has('lexical') || lexicalReadSurfaceMissing)
      ) {
        if (yield* tableExists(sql, 'active_snapshots')) {
          yield* sql`
            DELETE FROM active_snapshots
            WHERE snapshot_id IN (SELECT id FROM snapshots WHERE state = 'ready')
          `;
        }
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${new Date().toISOString()}),
              failure_summary = COALESCE(
                failure_summary,
                'Compact lexical storage schema changed; rebuild required.'
              )
          WHERE state = 'ready'
        `;
        yield* observe?.('retired-incompatible-ready') ?? Effect.void;
      }
      for (const group of incompatibleGroups) {
        for (const table of [...PERSISTENT_EXTENSION_TABLES].reverse()) {
          if (table.group === group) yield* sql.unsafe(`DROP TABLE IF EXISTS "${table.name}"`);
        }
      }
      yield* observe?.('dropped-incompatible') ?? Effect.void;
      for (const table of PERSISTENT_EXTENSION_TABLES) yield* sql.unsafe(table.createSql);
      yield* observe?.('created-extensions') ?? Effect.void;
      for (const index of REMOVED_BETA30_INDEXES) yield* sql.unsafe(`DROP INDEX IF EXISTS "${index}"`);
      yield* observe?.('dropped-obsolete-indexes') ?? Effect.void;
      yield* validatePersistentExtensionTables(sql);
      yield* observe?.('validated') ?? Effect.void;
      yield* sql`
        INSERT INTO schema_metadata (key, value)
        VALUES ('persistent_extension_schema_revision', ${String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `;
      yield* observe?.('recorded-revision') ?? Effect.void;
    }),
  );
});

const validatePersistentExtensionTables = Effect.fn('codeGraph.validatePersistentExtensionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspections = yield* inspectPersistentExtensionTables(sql);
  const incompatible = inspections.filter(inspection => !inspection.exists || !inspection.compatible);
  if (incompatible.length > 0) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph persistent extension schema is incompatible: ${incompatible.map(table => table.name).join(', ')}.`,
      ),
    );
  }
});

const initializeSchema = Effect.fn('codeGraph.initializeSchema')(function* (sql: SqlClient.SqlClient) {
  yield* configureConnection(sql);
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  // Explicit whole-WAL checkpoints can monopolize the synchronous SQLite
  // connection for longer than the build heartbeat. Committed WAL records are
  // already durable; keep routine checkpoint work bounded to SQLite's default
  // 1,000-page auto-checkpoint cadence instead.
  yield* sql.unsafe('PRAGMA wal_autocheckpoint = 1000');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      object_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      worktree_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      base_snapshot_id TEXT,
      extractor_set TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      overlay_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'retired')),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_summary TEXT
    )
  `);
  yield* migratePersistentExtensionTables(sql);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_extractor_generations (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_build_owners (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS active_snapshots_require_current_extractor
    BEFORE INSERT ON active_snapshots
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1
      FROM snapshot_extractor_generations AS generation
      JOIN schema_metadata AS minimum
        ON minimum.key = 'minimum_extractor_generation'
      WHERE generation.snapshot_id = NEW.snapshot_id
        AND generation.generation >= CAST(minimum.value AS INTEGER)
    )
    BEGIN
      SELECT RAISE(ABORT, 'Code graph snapshot was built by an older extractor generation.');
    END
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_leases (
      token TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_files (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size >= 0),
      source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_file_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS file_blobs (
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, extractor_set, path_hint)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbols (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'symbols', 'resolution_scope_id', 'TEXT');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_scopes (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_components (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      source_roots_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_component_dependencies (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (snapshot_id, source_component_id, target_component_id, provenance)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS edges (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_edge_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  // Compact, snapshot-owned analysis facts. Building snapshots may contain
  // partial rows, but readers require a matching ready-summary receipt.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_symbol_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, language, kind)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_histogram (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      endpoint_state INTEGER NOT NULL CHECK (endpoint_state IN (0, 1, 2)),
      count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, provenance, relation, confidence, endpoint_state)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_edge_counts (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      count INTEGER NOT NULL CHECK (count >= 0),
      confidence_invalid INTEGER NOT NULL CHECK (confidence_invalid >= 0),
      confidence_total REAL NOT NULL,
      lowest_confidence REAL NOT NULL,
      confidence_high INTEGER NOT NULL CHECK (confidence_high >= 0),
      confidence_medium INTEGER NOT NULL CHECK (confidence_medium >= 0),
      confidence_low INTEGER NOT NULL CHECK (confidence_low >= 0),
      unresolved_endpoint_count INTEGER NOT NULL CHECK (unresolved_endpoint_count >= 0),
      self_loop_count INTEGER NOT NULL CHECK (self_loop_count >= 0),
      review_finding_count INTEGER NOT NULL CHECK (review_finding_count >= 0),
      PRIMARY KEY (snapshot_id, provenance, relation)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_analysis_summary_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version = 1),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_analysis_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbol_terms (
      snapshot_id TEXT NOT NULL,
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (snapshot_id, term, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance IN ('alias', 'symbol')),
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_reuse_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL,
      resolution_surface_version INTEGER NOT NULL,
      extractor_set TEXT NOT NULL,
      workspace_fingerprint TEXT NOT NULL,
      file_set_fingerprint TEXT NOT NULL,
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      alias_count INTEGER NOT NULL CHECK (alias_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'snapshot_reuse_receipts', 'reexport_count', 'INTEGER NOT NULL DEFAULT 0');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_reexport_provenance (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  // Clean full builds write directly into the final snapshot tables while the
  // snapshot remains `building`. Reference lookup tiers live as one compact
  // payload per reference, while the legacy candidate table remains available
  // only for bounded cleanup of pre-compaction databases. Batch receipts make
  // interrupted builds resumable without replaying committed fact batches.
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_references (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
      alias_lookup_keys_json TEXT NOT NULL,
      lookup_tiers_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      candidate_payload_bytes INTEGER NOT NULL CHECK (candidate_payload_bytes >= 0),
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_reference_candidates (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id, tier, lookup_key)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS building_materialization_batches (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_fingerprint TEXT NOT NULL,
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      term_count INTEGER NOT NULL CHECK (term_count >= 0),
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      reference_count INTEGER NOT NULL CHECK (reference_count >= 0),
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      completed_at TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, batch_index)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_worktree_state ON snapshots(worktree_id, state)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_commit ON snapshots(repository_id, commit_id)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_files_blob ON snapshot_files(path, content_hash)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(snapshot_id, name)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path ON symbols(snapshot_id, path)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_resolution_scope ON symbols(snapshot_id, resolution_scope_id)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name_nocase ON symbols(snapshot_id, name COLLATE NOCASE)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS symbols_qualified_nocase ON symbols(snapshot_id, qualified_name COLLATE NOCASE)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path_nocase ON symbols(snapshot_id, path COLLATE NOCASE)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS symbols_export_order ON symbols(snapshot_id, path, qualified_name, id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS edges_source ON edges(snapshot_id, source_id, relation)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS edges_target ON edges(snapshot_id, target_id, relation)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS edges_export_order ON edges(snapshot_id, source_name, relation, target_name, id)',
  );
  // The WITHOUT ROWID primary key already serves `(snapshot_id, term)` lexical
  // lookups. Snapshot-owned postings are purged before snapshot/symbol rows, so
  // a second `(snapshot_id, symbol_id)` ordering is unnecessary for cascades.
  // Reference reuse first narrows by the leading `(snapshot_id, lookup_key)`
  // primary-key columns, then filters the normally tiny candidate set by
  // domain/export visibility. The former secondary index duplicated every
  // lookup row and dominated full-snapshot activation.
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshot_reexport_source ON snapshot_reexport_provenance(snapshot_id, source_path, local_name)',
  );
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('minimum_extractor_generation', ${String(CODE_GRAPH_EXTRACTOR_GENERATION)})
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(MAX(CAST(schema_metadata.value AS INTEGER), ${CODE_GRAPH_EXTRACTOR_GENERATION}) AS TEXT)
  `;
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const rows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  if (rows[0]?.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph schema ${rows[0]?.value ?? 'unknown'} is incompatible with ${CODE_GRAPH_SCHEMA_VERSION}.`,
      ),
    );
  }
});

const ensureColumn = Effect.fn('codeGraph.ensureColumn')(function* (
  sql: SqlClient.SqlClient,
  table: string,
  column: string,
  declaration: string,
) {
  const columns = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info(${table})`);
  if (columns.some(candidate => candidate.name === column)) return;
  yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
});

const diagnoseDatabase = Effect.fn('codeGraph.diagnoseDatabase')(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const integrityRows = yield* sql.unsafe<{readonly integrity_check: string}>('PRAGMA integrity_check(10)');
  const schemaRows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  const extensionRevisionRows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'
  `;
  const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
  const persistentExtensionSchemaRevision = Number.parseInt(extensionRevisionRows[0]?.value ?? '', 10);
  const persistentExtensionCurrent =
    persistentExtensionSchemaRevision === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
    (yield* codeGraphPersistentExtensionSchemaCompatible(sql));
  const stateRows = yield* sql<{readonly count: number; readonly state: CodeGraphSnapshot['state']}>`
    SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state
  `;
  const activeRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM active_snapshots`;
  const cacheRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM file_blobs`;
  const foreignKeyRows = yield* sql.unsafe('PRAGMA foreign_key_check');
  const counts = new Map(stateRows.map(row => [row.state, Number(row.count)]));
  const integrityOk =
    integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0;
  return {
    activeSnapshots: Number(activeRows[0]?.count ?? 0),
    buildingSnapshots: counts.get('building') ?? 0,
    cachedFileBlobs: Number(cacheRows[0]?.count ?? 0),
    failedSnapshots: counts.get('failed') ?? 0,
    foreignKeyViolations: foreignKeyRows.length,
    integrity:
      !Number.isSafeInteger(schemaVersion) || schemaVersion !== CODE_GRAPH_SCHEMA_VERSION || !persistentExtensionCurrent
        ? 'incompatible'
        : integrityOk
          ? 'ok'
          : 'corrupt',
    readySnapshots: counts.get('ready') ?? 0,
    persistentExtensionSchemaRevision: Number.isSafeInteger(persistentExtensionSchemaRevision)
      ? persistentExtensionSchemaRevision
      : undefined,
    schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
  } satisfies CodeGraphDatabaseHealth;
});

const repairDatabase = Effect.fn('codeGraph.repairDatabase')(function* (dryRun: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const health = yield* diagnoseDatabase();
  if (health.integrity !== 'ok') {
    return yield* Effect.fail(
      new CodeGraphStoreError(`Code graph database is ${health.integrity}; discard and rebuild it.`),
    );
  }
  const now = yield* Clock.currentTimeMillis;
  if (dryRun) {
    const candidates = yield* sql<{readonly count: number}>`
      SELECT COUNT(*) AS count
      FROM snapshots AS snapshot
      WHERE snapshot.state IN ('building', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_leases AS lease
          WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
        )
    `;
    return {removedSnapshots: Number(candidates[0]?.count ?? 0)} satisfies CodeGraphDatabaseRepair;
  }
  const candidates = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshots AS snapshot
    WHERE snapshot.state IN ('building', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_leases AS lease
        WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
      )
  `;
  const removedSnapshots = Number(candidates[0]?.count ?? 0);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Reuse the bounded retired-snapshot collector. A direct full build can
      // own tens of millions of rows, so cascading it from one repair DELETE
      // would recreate the same long heartbeat gap that direct staging avoids.
      yield* sql`
        UPDATE snapshots
        SET state = 'retired'
        WHERE state IN ('building', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = snapshots.id AND lease.expires_at > ${now}
          )
      `;
    }),
  );
  yield* pruneRetiredSnapshotRows();
  yield* sql.withTransaction(pruneUnreferencedFileBlobs(sql));
  return {removedSnapshots} satisfies CodeGraphDatabaseRepair;
});

const acquireSnapshotLease = Effect.fn('codeGraph.acquireSnapshotLease')(function* (
  snapshotId: string,
  durationMilliseconds: number,
  token: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM snapshot_leases WHERE expires_at <= ${now}`;
      const ready = yield* sql<{readonly id: string}>`
        SELECT id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
      `;
      if (!ready[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} is no longer available.`));
      }
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
        VALUES (${token}, ${snapshotId}, ${now + duration})
      `;
    }),
  );
  return token;
});

const releaseSnapshotLease = Effect.fn('codeGraph.releaseSnapshotLease')(function* (token: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  yield* sql`DELETE FROM snapshot_leases WHERE token = ${token}`;
});

const renewSnapshotLease = Effect.fn('codeGraph.renewSnapshotLease')(function* (
  token: string,
  durationMilliseconds: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const active = yield* sql<{readonly token: string}>`
        SELECT token FROM snapshot_leases WHERE token = ${token} AND expires_at > ${now} LIMIT 1
      `;
      if (!active[0]) {
        return yield* Effect.fail(new CodeGraphStoreError('The code graph snapshot lease expired before renewal.'));
      }
      yield* sql`
        UPDATE snapshot_leases SET expires_at = ${now + duration} WHERE token = ${token}
      `;
    }),
  );
});

function validatedSnapshotLeaseDuration(durationMilliseconds: number): number {
  const finiteDuration = Number.isFinite(durationMilliseconds) ? Math.floor(durationMilliseconds) : 1_000;
  return Math.max(1_000, Math.min(60 * 60_000, finiteDuration));
}

const insertActivationLease = Effect.fn('codeGraph.insertActivationLease')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  lease: Option.Option<CodeGraphActivationLease>,
) {
  if (Option.isNone(lease)) return;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`
    INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
    VALUES (${lease.value.token}, ${snapshotId}, ${now + lease.value.durationMilliseconds})
  `;
});

const recordSnapshotExtractorGeneration = Effect.fn('codeGraph.recordSnapshotExtractorGeneration')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`
    INSERT INTO snapshot_extractor_generations (snapshot_id, generation)
    VALUES (${snapshotId}, ${CODE_GRAPH_EXTRACTOR_GENERATION})
    ON CONFLICT(snapshot_id) DO UPDATE SET
      generation = MAX(snapshot_extractor_generations.generation, excluded.generation)
  `;
});

type ActivationProgressObserver = (
  stage: CodeGraphActivationStage,
  state: 'completed' | 'progress' | 'started',
  rows?: number,
  transactionMilliseconds?: number,
) => Effect.Effect<void, never>;

function activationProgressObserver(
  onProgress: CodeGraphActivationProgressCallback | undefined,
): ActivationProgressObserver {
  const startedAt = performance.now();
  const stageStartedAt = new Map<CodeGraphActivationStage, number>();
  return (stage, state, rows, transactionMilliseconds) =>
    Effect.gen(function* () {
      const now = performance.now();
      if (state === 'started') stageStartedAt.set(stage, now);
      const stageStart = stageStartedAt.get(stage) ?? now;
      yield* onProgress?.({
        elapsedMilliseconds: Math.max(0, now - startedAt),
        ...(rows === undefined ? {} : {rows}),
        stage,
        stageElapsedMilliseconds: state === 'started' ? 0 : Math.max(0, now - stageStart),
        state,
        ...(transactionMilliseconds === undefined ? {} : {transactionMilliseconds}),
      }) ?? Effect.void;
      // SQLite statements are synchronous under Bun. Yield at every observable
      // boundary so the independent heartbeat and progress writer can run.
      yield* Effect.yieldNow;
    });
}

interface PersistentActivationCopySpec {
  readonly batchRows: number;
  readonly columns: readonly string[];
  readonly destinationTable: string;
  readonly keyColumns: readonly string[];
  readonly maximumBatchRows: number;
  readonly sourceTable: string;
  readonly tally?: {
    readonly column: string;
    readonly value: string;
  };
}

interface PersistentActivationCopyResult {
  readonly rows: number;
  readonly talliedRows: number;
}

const PERSISTENT_ACTIVATION_COPY_SPECS = {
  edges: {
    batchRows: 10_000,
    columns: [
      'id',
      'source_id',
      'source_name',
      'relation',
      'target_id',
      'target_name',
      'provenance',
      'confidence',
      'evidence_path',
      'evidence_span_json',
    ],
    destinationTable: 'edges',
    keyColumns: ['id'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_edges',
  },
  files: {
    batchRows: 10_000,
    columns: ['path', 'content_hash', 'language', 'mode', 'size', 'source'],
    destinationTable: 'snapshot_files',
    keyColumns: ['path'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_files',
  },
  lookupKeys: {
    batchRows: 10_000,
    columns: [
      'lookup_key',
      'symbol_id',
      'resolution_domain',
      'exported',
      'provenance',
      'evidence_edge_id',
      'evidence_path',
    ],
    destinationTable: 'snapshot_symbol_lookup',
    keyColumns: ['lookup_key', 'symbol_id'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_symbol_lookup',
    tally: {column: 'provenance', value: 'alias'},
  },
  reexports: {
    batchRows: 10_000,
    columns: ['source_path', 'local_name', 'target_path', 'imported_name'],
    destinationTable: 'snapshot_reexport_provenance',
    keyColumns: ['source_path', 'local_name', 'target_path', 'imported_name'],
    maximumBatchRows: 40_000,
    sourceTable: 'activation_reexport_provenance',
  },
  symbols: {
    batchRows: 5_000,
    columns: [
      'id',
      'content_hash',
      'kind',
      'name',
      'qualified_name',
      'path',
      'language',
      'arity',
      'lookup_keys_json',
      'resolution_domain',
      'resolution_scope_id',
      'package_name',
      'exported',
      'signature',
      'documentation',
      'span_json',
    ],
    destinationTable: 'symbols',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_symbols',
  },
  terms: {
    batchRows: 10_000,
    columns: ['term', 'symbol_id', 'weight'],
    destinationTable: 'symbol_terms',
    keyColumns: ['term', 'symbol_id'],
    maximumBatchRows: 50_000,
    sourceTable: 'activation_symbol_terms',
  },
  workspaceComponents: {
    batchRows: 5_000,
    columns: [
      'id',
      'workspace_id',
      'build_system',
      'kind',
      'name',
      'root',
      'resolution_domain',
      'languages_json',
      'source_roots_json',
      'workspace_roots_json',
      'provenance',
      'diagnostics_json',
    ],
    destinationTable: 'workspace_components',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_components',
  },
  workspaceDependencies: {
    batchRows: 5_000,
    columns: ['source_component_id', 'target_component_id', 'provenance', 'evidence'],
    destinationTable: 'workspace_component_dependencies',
    keyColumns: ['source_component_id', 'target_component_id', 'provenance'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_dependencies',
  },
  workspaceScopes: {
    batchRows: 5_000,
    columns: ['id', 'build_system', 'name', 'root', 'provenance', 'diagnostics_json'],
    destinationTable: 'workspace_scopes',
    keyColumns: ['id'],
    maximumBatchRows: 10_000,
    sourceTable: 'activation_workspace_scopes',
  },
} as const satisfies Readonly<Record<string, PersistentActivationCopySpec>>;

const PERSISTENT_ACTIVATION_BATCH_TARGET_MILLISECONDS = 3_000;
const PERSISTENT_ACTIVATION_BATCH_DEADBAND_MIN_MILLISECONDS = 2_000;
const PERSISTENT_ACTIVATION_BATCH_DEADBAND_MAX_MILLISECONDS = 5_000;
const PERSISTENT_ACTIVATION_BATCH_MIN_ROWS = 250;

/**
 * Adapt copy pages toward a three-second transaction while retaining a wide
 * margin below the 15-second build heartbeat threshold. Growth is limited to
 * 2x per observation so a fast region cannot immediately create an oversized
 * synchronous SQLite statement in the next, denser B-tree region.
 */
export function nextPersistentActivationBatchRows(
  currentRows: number,
  transactionMilliseconds: number,
  maximumRows: number,
): number {
  const current = Math.max(PERSISTENT_ACTIVATION_BATCH_MIN_ROWS, Math.floor(currentRows));
  const maximum = Math.max(current, Math.floor(maximumRows));
  if (!Number.isFinite(transactionMilliseconds) || transactionMilliseconds < 0) {
    return Math.max(PERSISTENT_ACTIVATION_BATCH_MIN_ROWS, Math.floor(current / 200) * 100);
  }
  if (
    transactionMilliseconds >= PERSISTENT_ACTIVATION_BATCH_DEADBAND_MIN_MILLISECONDS &&
    transactionMilliseconds <= PERSISTENT_ACTIVATION_BATCH_DEADBAND_MAX_MILLISECONDS
  ) {
    return Math.min(current, maximum);
  }
  const duration = Math.max(1, transactionMilliseconds);
  const target = Math.floor((current * PERSISTENT_ACTIVATION_BATCH_TARGET_MILLISECONDS) / duration);
  const growthBounded = Math.min(current * 2, target);
  const rounded = Math.floor(growthBounded / 100) * 100;
  return Math.max(PERSISTENT_ACTIVATION_BATCH_MIN_ROWS, Math.min(maximum, rounded));
}

/**
 * Copies one final-table partition in bounded keyset transactions. The target
 * snapshot remains `building`, so committed chunks are invisible to normal
 * readers while SQLite can checkpoint and the heartbeat can run between them.
 */
const copyPersistentActivationRows = Effect.fn('codeGraph.copyPersistentActivationRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  spec: PersistentActivationCopySpec,
  stage: CodeGraphActivationStage,
  observe: ActivationProgressObserver,
  initialRowsCompleted = 0,
) {
  let cursor = Option.none<readonly string[]>();
  let batchRows = spec.batchRows;
  let rowsCompleted = 0;
  let talliedRows = 0;
  for (;;) {
    const previousCursor = cursor;
    const transactionStartedAt = performance.now();
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const cursorPredicate = Option.match(cursor, {
          onNone: () => '',
          onSome: () =>
            spec.keyColumns.length === 1
              ? `WHERE ${spec.keyColumns[0]!} > ?`
              : `WHERE (${spec.keyColumns.join(', ')}) > (${spec.keyColumns.map(() => '?').join(', ')})`,
        });
        const parameters = [snapshotId, ...Option.getOrElse(cursor, () => []), batchRows];
        yield* sql.unsafe(
          `INSERT INTO ${spec.destinationTable} (snapshot_id, ${spec.columns.join(', ')})
           SELECT ?, ${spec.columns.join(', ')}
           FROM ${spec.sourceTable}
           ${cursorPredicate}
           ORDER BY ${spec.keyColumns.join(', ')}
           LIMIT ?`,
          parameters,
        );
        const changed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
        const inserted = Number(changed[0]?.count ?? 0);
        if (!Number.isSafeInteger(inserted) || inserted < 0) {
          return yield* Effect.fail(new CodeGraphStoreError('Persistent activation returned an invalid row count.'));
        }
        if (inserted === 0) {
          return {cursor: Option.none<readonly string[]>(), inserted, tallied: 0};
        }
        const last = yield* sql.unsafe<Record<string, unknown>>(
          `SELECT ${spec.keyColumns.join(', ')}
           FROM ${spec.destinationTable}
           WHERE snapshot_id = ?
           ORDER BY ${spec.keyColumns.map(column => `${column} DESC`).join(', ')}
           LIMIT 1`,
          [snapshotId],
        );
        const row = last[0];
        if (!row) {
          return yield* Effect.fail(new CodeGraphStoreError('Persistent activation lost its keyset cursor.'));
        }
        const nextCursor = spec.keyColumns.map(column => row[column]);
        if (nextCursor.some(value => typeof value !== 'string')) {
          return yield* Effect.fail(
            new CodeGraphStoreError('Persistent activation returned an invalid keyset cursor.'),
          );
        }
        const validatedCursor = nextCursor as readonly string[];
        let tallied = 0;
        if (spec.tally) {
          const lowerPredicate = Option.match(previousCursor, {
            onNone: () => '',
            onSome: () =>
              spec.keyColumns.length === 1
                ? `${spec.keyColumns[0]!} > ? AND `
                : `(${spec.keyColumns.join(', ')}) > (${spec.keyColumns.map(() => '?').join(', ')}) AND `,
          });
          const upperPredicate =
            spec.keyColumns.length === 1
              ? `${spec.keyColumns[0]!} <= ?`
              : `(${spec.keyColumns.join(', ')}) <= (${spec.keyColumns.map(() => '?').join(', ')})`;
          const tallyRows = yield* sql.unsafe<{readonly count: number}>(
            `SELECT COUNT(*) AS count
             FROM ${spec.sourceTable}
             WHERE ${lowerPredicate}${upperPredicate}
               AND ${spec.tally.column} = ?`,
            [...Option.getOrElse(previousCursor, () => []), ...validatedCursor, spec.tally.value],
          );
          tallied = Number(tallyRows[0]?.count ?? 0);
          if (!Number.isSafeInteger(tallied) || tallied < 0 || tallied > inserted) {
            return yield* Effect.fail(new CodeGraphStoreError('Persistent activation returned an invalid tally.'));
          }
        }
        return {cursor: Option.some(validatedCursor), inserted, tallied};
      }),
    );
    if (result.inserted === 0) break;
    cursor = result.cursor;
    rowsCompleted += result.inserted;
    talliedRows += result.tallied;
    const transactionMilliseconds = Math.max(0, performance.now() - transactionStartedAt);
    yield* observe(stage, 'progress', initialRowsCompleted + rowsCompleted, transactionMilliseconds);
    batchRows = nextPersistentActivationBatchRows(batchRows, transactionMilliseconds, spec.maximumBatchRows);
  }
  return {rows: rowsCompleted, talliedRows} satisfies PersistentActivationCopyResult;
});

const resetSnapshotAnalysisSummary = Effect.fn('codeGraph.resetSnapshotAnalysisSummary')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`DELETE FROM snapshot_analysis_summary_receipts WHERE snapshot_id = ${snapshotId}`;
  yield* sql`DELETE FROM snapshot_analysis_edge_counts WHERE snapshot_id = ${snapshotId}`;
  yield* sql`DELETE FROM snapshot_analysis_edge_histogram WHERE snapshot_id = ${snapshotId}`;
  yield* sql`DELETE FROM snapshot_analysis_symbol_counts WHERE snapshot_id = ${snapshotId}`;
});

const materializeSnapshotAnalysisEdgeCounts = Effect.fn('codeGraph.materializeSnapshotAnalysisEdgeCounts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`DELETE FROM snapshot_analysis_edge_counts WHERE snapshot_id = ${snapshotId}`;
  yield* sql.unsafe(
    `INSERT INTO snapshot_analysis_edge_counts (
       snapshot_id, provenance, relation, count, confidence_invalid, confidence_total,
       lowest_confidence, confidence_high, confidence_medium, confidence_low,
       unresolved_endpoint_count, self_loop_count, review_finding_count
     )
     SELECT ?, provenance, relation,
       SUM(count),
       0,
       SUM(confidence * count),
       MIN(confidence),
       SUM(CASE WHEN confidence >= 0.9 THEN count ELSE 0 END),
       SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.9 THEN count ELSE 0 END),
       SUM(CASE WHEN confidence < 0.6 THEN count ELSE 0 END),
       SUM(CASE WHEN endpoint_state = 1 THEN count ELSE 0 END),
       SUM(CASE WHEN endpoint_state = 2 THEN count ELSE 0 END),
       SUM(CASE WHEN confidence < CASE provenance
         WHEN 'declared' THEN 0.9
         WHEN 'resolved' THEN 0.9
         WHEN 'syntactic' THEN 0.7
         WHEN 'heuristic' THEN 0.45
         WHEN 'model' THEN 0.35
       END THEN count ELSE 0 END)
     FROM snapshot_analysis_edge_histogram
     WHERE snapshot_id = ? AND count > 0
     GROUP BY provenance, relation`,
    [snapshotId, snapshotId],
  );
});

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

const materializeCleanSnapshotAnalysisSummary = Effect.fn('codeGraph.materializeCleanSnapshotAnalysisSummary')(
  function* (sql: SqlClient.SqlClient, snapshot: CodeGraphSnapshot) {
    yield* resetSnapshotAnalysisSummary(sql, snapshot.id);
    yield* sql`
    INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
    SELECT ${snapshot.id}, language, kind, COUNT(*)
    FROM symbols WHERE snapshot_id = ${snapshot.id}
    GROUP BY language, kind
  `;
    yield* sql`
    INSERT INTO snapshot_analysis_edge_histogram (
      snapshot_id, provenance, relation, confidence, endpoint_state, count
    )
    SELECT ${snapshot.id}, provenance, relation, confidence,
      CASE
        WHEN source_id IS NULL OR target_id IS NULL THEN 1
        WHEN source_id = target_id THEN 2
        ELSE 0
      END,
      COUNT(*)
    FROM edges WHERE snapshot_id = ${snapshot.id}
    GROUP BY provenance, relation, confidence,
      CASE
        WHEN source_id IS NULL OR target_id IS NULL THEN 1
        WHEN source_id = target_id THEN 2
        ELSE 0
      END
  `;
    yield* materializeSnapshotAnalysisEdgeCounts(sql, snapshot.id);
  },
);

const materializeOverlaySnapshotAnalysisSummary = Effect.fn('codeGraph.materializeOverlaySnapshotAnalysisSummary')(
  function* (sql: SqlClient.SqlClient, snapshot: CodeGraphSnapshot, baseSnapshotId: string) {
    yield* resetSnapshotAnalysisSummary(sql, snapshot.id);
    yield* sql.unsafe(
      `WITH affected(id) AS (
       SELECT id FROM symbols WHERE snapshot_id = ?
       UNION
       SELECT symbol_id FROM snapshot_symbol_deletions WHERE snapshot_id = ?
     ),
     contributions(language, kind, count) AS (
       SELECT language, kind, count
       FROM snapshot_analysis_symbol_counts WHERE snapshot_id = ?
       UNION ALL
       SELECT language, kind, COUNT(*)
       FROM symbols WHERE snapshot_id = ? GROUP BY language, kind
       UNION ALL
       SELECT base.language, base.kind, -COUNT(*)
       FROM affected
       JOIN symbols AS base ON base.snapshot_id = ? AND base.id = affected.id
       GROUP BY base.language, base.kind
     )
     INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
     SELECT ?, language, kind, SUM(count)
     FROM contributions
     GROUP BY language, kind
     HAVING SUM(count) > 0`,
      [snapshot.id, snapshot.id, baseSnapshotId, snapshot.id, baseSnapshotId, snapshot.id],
    );
    yield* sql.unsafe(
      `WITH affected(id) AS (
       SELECT id FROM edges WHERE snapshot_id = ?
       UNION
       SELECT edge_id FROM snapshot_edge_deletions WHERE snapshot_id = ?
     ),
     contributions(provenance, relation, confidence, endpoint_state, count) AS (
       SELECT provenance, relation, confidence, endpoint_state, count
       FROM snapshot_analysis_edge_histogram WHERE snapshot_id = ?
       UNION ALL
       SELECT provenance, relation, confidence,
         CASE
           WHEN source_id IS NULL OR target_id IS NULL THEN 1
           WHEN source_id = target_id THEN 2
           ELSE 0
         END,
         COUNT(*)
       FROM edges WHERE snapshot_id = ?
       GROUP BY provenance, relation, confidence,
         CASE
           WHEN source_id IS NULL OR target_id IS NULL THEN 1
           WHEN source_id = target_id THEN 2
           ELSE 0
         END
       UNION ALL
       SELECT base.provenance, base.relation, base.confidence,
         CASE
           WHEN base.source_id IS NULL OR base.target_id IS NULL THEN 1
           WHEN base.source_id = base.target_id THEN 2
           ELSE 0
         END,
         -COUNT(*)
       FROM affected
       JOIN edges AS base ON base.snapshot_id = ? AND base.id = affected.id
       GROUP BY base.provenance, base.relation, base.confidence,
         CASE
           WHEN base.source_id IS NULL OR base.target_id IS NULL THEN 1
           WHEN base.source_id = base.target_id THEN 2
           ELSE 0
         END
     )
     INSERT INTO snapshot_analysis_edge_histogram (
       snapshot_id, provenance, relation, confidence, endpoint_state, count
     )
     SELECT ?, provenance, relation, confidence, endpoint_state, SUM(count)
     FROM contributions
     GROUP BY provenance, relation, confidence, endpoint_state
     HAVING SUM(count) > 0`,
      [snapshot.id, snapshot.id, baseSnapshotId, snapshot.id, baseSnapshotId, snapshot.id],
    );
    yield* materializeSnapshotAnalysisEdgeCounts(sql, snapshot.id);
  },
);

const ensureReadySnapshotAnalysisSummary = Effect.fn('codeGraph.ensureReadySnapshotAnalysisSummary')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  // Treat a receipt as complete only when its compact rows still reproduce the
  // recorded totals and digest. A crashed beta or manual database recovery can
  // otherwise leave a plausible receipt that makes every later writer skip the
  // repair while readers repeatedly fall back to the expensive raw scan.
  const existing = yield* selectAnalysisSummary(snapshotId);
  if (Option.isSome(existing)) return false;
  const rows = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1`;
  if (!rows[0]) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  const snapshot = snapshotFromRow(rows[0]);
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
  if (baseSnapshotId) {
    const baseSummary = yield* selectAnalysisSummary(baseSnapshotId);
    if (Option.isNone(baseSummary)) {
      const baseRows = yield* sql<SnapshotRow>`
        SELECT * FROM snapshots WHERE id = ${baseSnapshotId} AND state = 'ready' LIMIT 1
      `;
      const base = baseRows[0];
      if (!base || Option.isSome(sqlTextOption(base.base_snapshot_id))) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Nested legacy overlays require a clean code graph rebuild before summary backfill.'),
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
          id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
          dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
        ) VALUES (
          ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
          NULL, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0}, ${snapshot.overlayFingerprint ?? null},
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
      yield* materializeCleanSnapshotAnalysisSummary(sql, snapshot);
      yield* recordSnapshotAnalysisReceipt(sql, snapshot);
      yield* recordCompactLexicalFormat(sql, snapshot.id, copiedTerms, copiedTerms.postingCount, snapshot.symbolCount);
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

const lastStatementChangeCount = Effect.fn('codeGraph.lastStatementChangeCount')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
  const count = Number(rows[0]?.count ?? -1);
  if (!Number.isSafeInteger(count) || count < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('SQLite returned an invalid changed-row count.'));
  }
  return count;
});

const activateStagedSnapshot = Effect.fn('codeGraph.activateStagedSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
  onProgress?: CodeGraphActivationProgressCallback,
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
        + (SELECT COUNT(*) FROM activation_workspace_dependencies) AS workspace_rows
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
            id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
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
        yield* observe('copying-workspace', 'completed', Number(counts.workspace_rows));
        if (!baseSnapshotId) {
          yield* observe('copying-files', 'started');
          yield* sql`
            INSERT INTO snapshot_files (
              snapshot_id, path, content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, path, content_hash, language, mode, size, source
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
              snapshot_id, path, content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, current.path, current.content_hash, current.language,
              current.mode, current.size, current.source
            FROM activation_files AS current
            LEFT JOIN snapshot_files AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
            WHERE base.path IS NULL
               OR base.content_hash IS NOT current.content_hash
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
      }
      if (baseSnapshotId) {
        yield* ensureReadySnapshotAnalysisSummary(sql, baseSnapshotId);
        yield* materializeOverlaySnapshotAnalysisSummary(sql, snapshot, baseSnapshotId);
      } else {
        yield* materializeCleanSnapshotAnalysisSummary(sql, snapshot);
      }
      yield* recordSnapshotAnalysisReceipt(sql, snapshot);
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
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
            reexport_count, created_at
          )
          SELECT
            ${snapshot.id}, ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, 1, ${snapshot.extractorSet},
            ${reusableBaseReceipt.workspaceFingerprint}, ${reusableBaseReceipt.fileSetFingerprint},
            COUNT(*), COALESCE(SUM(CASE WHEN provenance = 'alias' THEN 1 ELSE 0 END), 0),
            (SELECT COUNT(*) FROM activation_reexport_provenance),
            ${new Date().toISOString()}
          FROM activation_symbol_lookup
        `;
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

const ACTIVATION_EDGE_VALIDATION_PAGE_ROWS = 50_000;
const PERSISTENT_ACTIVATION_ENDPOINT_VALIDATION_PAGE_ROWS = 100_000;

type CodeGraphEdgeEndpoint = 'source' | 'target';

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
const validateStagedEdgeSymbols = Effect.fn('codeGraph.validateStagedEdgeSymbols')(function* (
  sql: SqlClient.SqlClient,
  observe: ReturnType<typeof activationProgressObserver>,
) {
  let cursor = Option.none<string>();
  let examined = 0;
  while (true) {
    const cursorPredicate = Option.isSome(cursor) ? 'WHERE id > ?' : '';
    const rows = yield* sql.unsafe<{
      readonly cursor: string;
      readonly invalid_id: string;
      readonly rows_examined: number;
    }>(
      `
      WITH page AS (
        SELECT id, source_id, target_id
        FROM activation_edges
        ${cursorPredicate}
        ORDER BY id
        LIMIT ?
      )
      SELECT
        COALESCE(MAX(page.id), '') AS cursor,
        COALESCE(MIN(
          CASE
            WHEN (page.source_id IS NOT NULL AND source_symbol.id IS NULL)
              OR (page.target_id IS NOT NULL AND target_symbol.id IS NULL)
            THEN page.id
          END
        ), '') AS invalid_id,
        COUNT(*) AS rows_examined
      FROM page
      LEFT JOIN activation_symbols AS source_symbol ON source_symbol.id = page.source_id
      LEFT JOIN activation_symbols AS target_symbol ON target_symbol.id = page.target_id
      `,
      [...Option.toArray(cursor), ACTIVATION_EDGE_VALIDATION_PAGE_ROWS],
    );
    const page = rows[0];
    const rowsExamined = Number(page?.rows_examined ?? 0);
    if (!Number.isSafeInteger(rowsExamined) || rowsExamined < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Staged edge validation returned an invalid row count.'));
    }
    if (page?.invalid_id) {
      return yield* Effect.fail(
        new CodeGraphStoreError(`Code graph edge ${page.invalid_id} references a missing symbol.`),
      );
    }
    if (rowsExamined === 0) return examined;
    if (typeof page?.cursor !== 'string' || (Option.isSome(cursor) && page.cursor <= cursor.value)) {
      return yield* Effect.fail(new CodeGraphStoreError('Staged edge validation cursor did not advance.'));
    }
    cursor = Option.some(page.cursor);
    examined += rowsExamined;
    yield* observe('validating-input', 'progress', examined);
    if (rowsExamined < ACTIVATION_EDGE_VALIDATION_PAGE_ROWS) return examined;
  }
});

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

const countPersistedFullReuseRows = Effect.fn('codeGraph.countPersistedFullReuseRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  observe: ActivationProgressObserver,
) {
  let lookupCursor = Option.none<readonly [string, string]>();
  let lookupCount = 0;
  let aliasCount = 0;
  for (;;) {
    const predicate = Option.isSome(lookupCursor) ? 'AND (lookup_key > ? OR (lookup_key = ? AND symbol_id > ?))' : '';
    const rows = yield* sql.unsafe<{
      readonly aliases: number;
      readonly last_lookup_key: string;
      readonly last_symbol_id: string;
      readonly rows_examined: number;
    }>(
      `WITH page AS (
         SELECT lookup_key, symbol_id, provenance
         FROM snapshot_symbol_lookup
         WHERE snapshot_id = ? ${predicate}
         ORDER BY lookup_key, symbol_id
         LIMIT ?
       )
       SELECT COUNT(*) AS rows_examined,
         COALESCE(SUM(CASE WHEN provenance = 'alias' THEN 1 ELSE 0 END), 0) AS aliases,
         COALESCE(MAX(lookup_key), '') AS last_lookup_key,
         COALESCE((
           SELECT symbol_id FROM page
           ORDER BY lookup_key DESC, symbol_id DESC LIMIT 1
         ), '') AS last_symbol_id
       FROM page`,
      [
        snapshotId,
        ...(Option.isSome(lookupCursor) ? [lookupCursor.value[0], lookupCursor.value[0], lookupCursor.value[1]] : []),
        ACTIVATION_EDGE_VALIDATION_PAGE_ROWS,
      ],
    );
    const page = rows[0];
    const pageRows = Number(page?.rows_examined ?? 0);
    if (pageRows === 0) break;
    lookupCount += pageRows;
    aliasCount += Number(page?.aliases ?? 0);
    const next = [page?.last_lookup_key ?? '', page?.last_symbol_id ?? ''] as const;
    if (
      Option.isSome(lookupCursor) &&
      (next[0] < lookupCursor.value[0] || (next[0] === lookupCursor.value[0] && next[1] <= lookupCursor.value[1]))
    ) {
      return yield* Effect.fail(new CodeGraphStoreError('Persistent lookup count cursor did not advance.'));
    }
    lookupCursor = Option.some(next);
    yield* observe('validating-input', 'progress', lookupCount);
    if (pageRows < ACTIVATION_EDGE_VALIDATION_PAGE_ROWS) break;
  }
  const reexportRows = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshot_reexport_provenance
    WHERE snapshot_id = ${snapshotId}
  `;
  return {
    aliasCount,
    lookupCount,
    reexportCount: Number(reexportRows[0]?.count ?? 0),
  };
});

const PERSISTED_FULL_RESOLUTION_DRAIN_SPECS = [
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id', 'tier', 'lookup_key'],
    maximumBatchRows: 20_000,
    table: 'building_reference_candidates',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: LEGACY_BUILDING_REFERENCES_V3_TABLE,
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: 'building_references',
  },
] as const;

const COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS = [
  ...PERSISTED_FULL_RESOLUTION_DRAIN_SPECS,
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 5_000,
    table: 'building_materialization_batches',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 5_000,
    table: 'building_analysis_batches',
  },
  {
    batchRows: 1,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1,
    table: 'building_lexical_counters',
  },
] as const;

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
  const readyTransactionStartedAt = performance.now();
  yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* assertPersistentBuildOwner(sql, snapshot.id, ownerToken);
        yield* assertPersistentMaterializationComplete(sql, snapshot.id, ownerToken);
        yield* materializeSnapshotAnalysisEdgeCounts(sql, snapshot.id);
        yield* recordSnapshotAnalysisReceipt(sql, snapshot);
        yield* publishCompactLexicalFormat(sql, snapshot.id, compactLexicalReceipt);
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
  const readyTransactionMilliseconds = Math.max(0, performance.now() - readyTransactionStartedAt);
  yield* observe('recording-completion', 'completed', 1, readyTransactionMilliseconds);
  yield* observe('committing-snapshot', 'completed', undefined, readyTransactionMilliseconds);
  // Connection-private cleanup is not part of the publication contract. A
  // fresh connection drops these TEMP objects automatically; a long-lived
  // session attempts cleanup but cannot turn an already-ready snapshot into a
  // reported indexing failure.
  yield* dropPersistedFullResolutionViews(sql).pipe(Effect.ignore);
});

const dropPersistedFullResolutionViews = Effect.fn('codeGraph.dropPersistedFullResolutionViews')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const name of [
    'persisted_full_reference_candidate_delete',
    'persisted_full_reference_delete',
    'persisted_full_edge_delete',
    'persisted_full_edge_insert',
    'persisted_full_lookup_insert',
  ] as const) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS temp.${name}`);
  }
  for (const name of [
    'activation_reference_candidates',
    'activation_references',
    'activation_edges',
    'activation_symbol_lookup',
    'activation_symbols',
  ] as const) {
    yield* sql.unsafe(`DROP VIEW IF EXISTS temp.${name}`);
  }
  yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
  yield* sql.unsafe('DELETE FROM activation_state');
});

const persistedIncrementalFactCounts = Effect.fn('codeGraph.persistedIncrementalFactCounts')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const rows = yield* sql<{
    readonly edges: number;
    readonly files: number;
    readonly symbols: number;
  }>`
    SELECT
      base.file_count AS files,
      base.symbol_count
        - (
            SELECT COUNT(*)
            FROM symbols AS symbol
            JOIN activation_files AS changed ON changed.path = symbol.path
            WHERE symbol.snapshot_id = base.id
          )
        + (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      base.edge_count
        - (
            SELECT COUNT(*)
            FROM edges AS edge
            JOIN activation_files AS changed ON changed.path = edge.evidence_path
            WHERE edge.snapshot_id = base.id
          )
        + (SELECT COUNT(*) FROM activation_edges) AS edges
    FROM snapshots AS base
    WHERE base.id = ${baseSnapshotId} AND base.state = 'ready'
      AND base.dirty = 0 AND base.base_snapshot_id IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return yield* Effect.fail(new CodeGraphStoreError(`Reusable base ${baseSnapshotId} is unavailable.`));
  const counts = {
    edges: Number(row.edges),
    files: Number(row.files),
    symbols: Number(row.symbols),
  };
  if (Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) {
    return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental graph counts are invalid.'));
  }
  return counts;
});

const activatePersistedIncrementalSnapshot = Effect.fn('codeGraph.activatePersistedIncrementalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  baseSnapshotId: string,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
  onProgress?: CodeGraphActivationProgressCallback,
) {
  const observe = activationProgressObserver(onProgress);
  let compactLexicalReceipt = Option.none<CompactLexicalFormatReceipt>();
  yield* configureConnection(sql);
  yield* observe('validating-input', 'started');
  if (!snapshot.dirty || snapshot.baseSnapshotId !== baseSnapshotId) {
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
      if (!(yield* selectReusableBaseReceipt(baseSnapshotId))) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Reusable base receipt ${baseSnapshotId} is unavailable or incomplete.`),
        );
      }
      if (!(yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId))) {
        return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental resolution surface changed.'));
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
               ))
           OR (edge.target_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = edge.target_id)
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS base
                 WHERE base.snapshot_id = ${baseSnapshotId} AND base.id = edge.target_id
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
            id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
            started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${baseSnapshotId}, ${snapshot.extractorSet}, 1, ${snapshot.overlayFingerprint ?? null},
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
        yield* observe('copying-workspace', 'completed');
        yield* observe('copying-files', 'started');
        yield* sql`
          INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
          SELECT ${snapshot.id}, path, content_hash, language, mode, size, source
          FROM activation_files
        `;
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
        yield* sql`
          INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id)
          SELECT ${snapshot.id}, base.id
          FROM symbols AS base
          JOIN activation_files AS changed ON changed.path = base.path
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id)
        `;
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
        yield* sql`
          INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id)
          SELECT ${snapshot.id}, base.id
          FROM edges AS base
          JOIN activation_files AS changed ON changed.path = base.evidence_path
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND NOT EXISTS (SELECT 1 FROM activation_edges AS current WHERE current.id = base.id)
        `;
        yield* observe('copying-edges', 'completed', Number(staged.edges));
      }
      yield* ensureReadySnapshotAnalysisSummary(sql, baseSnapshotId);
      yield* materializeOverlaySnapshotAnalysisSummary(sql, snapshot, baseSnapshotId);
      yield* recordSnapshotAnalysisReceipt(sql, snapshot);
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
      }
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
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

function storeFreshFacts(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphInventoryFile[],
  cacheFacts: readonly BoundedCodeGraphFact[],
  cacheExtractorSet: string,
) {
  return Effect.gen(function* () {
    const createdAt = new Date().toISOString();
    const filesByPath = new Map(files.map(file => [file.path, file]));
    for (const bounded of cacheFacts) {
      const file = filesByPath.get(bounded.facts.path);
      if (!file) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Fresh parser facts do not match the indexed file inventory: ${bounded.facts.path}.`),
        );
      }
      yield* sql`
        INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
        VALUES (
          ${file.contentHash}, ${cacheExtractorSet}, ${file.path},
          ${bounded.json}, ${createdAt}
        )
        ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET
          facts_json = excluded.facts_json,
          created_at = excluded.created_at
      `;
    }
  });
}

function persistentSnapshotBuildIdentityMatches(current: CodeGraphSnapshot, requested: CodeGraphSnapshot): boolean {
  return (
    current.repositoryId === requested.repositoryId &&
    current.commit === requested.commit &&
    current.dirty === requested.dirty &&
    current.extractorSet === requested.extractorSet &&
    current.baseSnapshotId === requested.baseSnapshotId &&
    current.overlayFingerprint === requested.overlayFingerprint
  );
}

const claimPersistentSnapshotBuild = Effect.fn('codeGraph.claimPersistentSnapshotBuild')(function* (
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  ownerToken: string,
  writerGate?: CodeGraphWriterGate,
) {
  const sql = yield* SqlClient.SqlClient;
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  yield* runWrite(initializeSchema(sql));
  const retiredUnusableReady = yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshot.id} LIMIT 1`;
        const current = existing[0] ? snapshotFromRow(existing[0]) : undefined;
        if (
          current === undefined ||
          current.state !== 'ready' ||
          !persistentSnapshotBuildIdentityMatches(current, snapshot)
        ) {
          return false;
        }
        const compatible = yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count
          FROM lexical_storage_formats
          WHERE snapshot_id = ${snapshot.id}
            AND format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
        `;
        if (Number(compatible[0]?.count ?? 0) === 1) return false;
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${new Date().toISOString()}),
              failure_summary = COALESCE(
                failure_summary,
                'Compact lexical storage receipt changed; rebuild required.'
              )
          WHERE id = ${snapshot.id} AND state = 'ready'
            AND NOT EXISTS (
              SELECT 1 FROM lexical_storage_formats
              WHERE snapshot_id = snapshots.id
                AND format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
            )
        `;
        const retired = yield* lastStatementChangeCount(sql);
        if (retired === 1) yield* sql`DELETE FROM active_snapshots WHERE snapshot_id = ${snapshot.id}`;
        return retired === 1;
      }),
    ),
  );
  const prior = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT state FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
  `;
  if (retiredUnusableReady || prior[0]?.state === 'retired') {
    // Owner-aware failure first publishes `retired`, then reclaims rows in
    // bounded transactions. A process may die at that exact boundary. The
    // deterministic snapshot identity must remain retryable without requiring
    // doctor/repair, so finish that targeted reclamation before claiming it.
    yield* pruneRetiredSnapshotRows(runWrite, snapshot.id);
  }
  yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* upsertRepository(sql, identity);
        const existing = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshot.id} LIMIT 1`;
        if (existing[0]) {
          const current = snapshotFromRow(existing[0]);
          if (
            !persistentSnapshotBuildIdentityMatches(current, snapshot) ||
            !['building', 'failed'].includes(current.state)
          ) {
            return yield* Effect.fail(
              new CodeGraphStoreError('Persistent build claim does not match the existing snapshot identity.'),
            );
          }
        } else {
          yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
            ${snapshot.overlayFingerprint ?? null}, 'building', 0, 0, 0, ${new Date().toISOString()}
          )
        `;
        }
        yield* sql`
        INSERT INTO snapshot_build_owners (snapshot_id, owner_token, claimed_at)
        VALUES (${snapshot.id}, ${ownerToken}, ${new Date().toISOString()})
        ON CONFLICT(snapshot_id) DO UPDATE SET
          owner_token = excluded.owner_token,
          claimed_at = excluded.claimed_at
      `;
      }),
    ),
  );
});

const selectResumableForcedBuild = Effect.fn('codeGraph.selectResumableForcedBuild')(function* (
  logicalSnapshotId: string,
) {
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    return yield* Effect.fail(new CodeGraphStoreError('Logical snapshot identity is invalid.'));
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE state = 'building'
      AND id GLOB ${`${logicalSnapshotId}-full-[0-9a-f]*`}
      AND length(id) = ${logicalSnapshotId.length + '-full-'.length + 16}
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectResumableBuildById = Effect.fn('codeGraph.selectResumableBuildById')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots'))) return undefined;
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'building' LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectOrphanedIncompleteSnapshots = Effect.fn('codeGraph.selectOrphanedIncompleteSnapshots')(function* (
  repositoryId: string,
  activeWorktreeIds: ReadonlySet<string>,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots'))) return [];
  const rows = yield* sql<{
    readonly id: string;
    readonly owner_token: unknown;
    readonly started_at: string;
    readonly state: OrphanedIncompleteSnapshotCandidate['state'];
    readonly worktree_id: string;
  }>`
    SELECT snapshot.id, snapshot.started_at, snapshot.state, snapshot.worktree_id, owner.owner_token
    FROM snapshots AS snapshot
    LEFT JOIN snapshot_build_owners AS owner ON owner.snapshot_id = snapshot.id
    WHERE snapshot.repository_id = ${repositoryId}
      AND snapshot.state IN ('building', 'failed', 'retired')
      AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
      AND snapshot.id NOT IN (
        SELECT base_snapshot_id
        FROM snapshots
        WHERE base_snapshot_id IS NOT NULL
          AND id IN (
            SELECT snapshot_id FROM active_snapshots
            UNION
            SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
          )
      )
    ORDER BY snapshot.id
  `;
  return rows
    .filter(row => !activeWorktreeIds.has(row.worktree_id))
    .map(row => ({
      id: row.id,
      ownerToken: sqlTextOption(row.owner_token),
      startedAt: row.started_at,
      state: row.state,
    }));
});

function orphanedIncompleteSnapshotSafeToReclaim(
  candidate: OrphanedIncompleteSnapshotCandidate,
  now: number,
  isProcessRunning: (processId: number) => boolean,
): boolean {
  if (candidate.state === 'failed' || candidate.state === 'retired') return true;
  const processId = Option.flatMap(candidate.ownerToken, persistentBuildOwnerProcessId);
  if (Option.isSome(processId)) return !isProcessRunning(processId.value);
  const startedAt = Date.parse(candidate.startedAt);
  return Number.isFinite(startedAt) && now - startedAt >= CODE_GRAPH_ORPHANED_UNOWNED_BUILD_MINIMUM_AGE_MILLISECONDS;
}

function persistentBuildOwnerProcessId(ownerToken: string): Option.Option<number> {
  const separator = ownerToken.indexOf(':');
  if (separator <= 0) return Option.none();
  const processId = Number(ownerToken.slice(0, separator));
  return Number.isSafeInteger(processId) && processId > 0 ? Option.some(processId) : Option.none();
}

const retireOrphanedIncompleteSnapshot = Effect.fn('codeGraph.retireOrphanedIncompleteSnapshot')(function* (
  sql: SqlClient.SqlClient,
  repositoryId: string,
  candidate: OrphanedIncompleteSnapshotCandidate,
  now: number,
) {
  if (candidate.state === 'retired') return 0;
  const completedAt = new Date(now).toISOString();
  const rows = yield* Option.match(candidate.ownerToken, {
    onNone: () =>
      sql<{readonly id: string}>`
        UPDATE snapshots
        SET state = 'retired', completed_at = COALESCE(completed_at, ${completedAt})
        WHERE id = ${candidate.id}
          AND repository_id = ${repositoryId}
          AND state IN ('building', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_build_owners AS owner WHERE owner.snapshot_id = snapshots.id
          )
          AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
          AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
          AND id NOT IN (
            SELECT base_snapshot_id
            FROM snapshots
            WHERE base_snapshot_id IS NOT NULL
              AND id IN (
                SELECT snapshot_id FROM active_snapshots
                UNION
                SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
              )
          )
        RETURNING id
      `,
    onSome: ownerToken =>
      sql<{readonly id: string}>`
        UPDATE snapshots
        SET state = 'retired', completed_at = COALESCE(completed_at, ${completedAt})
        WHERE id = ${candidate.id}
          AND repository_id = ${repositoryId}
          AND state IN ('building', 'failed')
          AND EXISTS (
            SELECT 1
            FROM snapshot_build_owners AS owner
            WHERE owner.snapshot_id = snapshots.id AND owner.owner_token = ${ownerToken}
          )
          AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
          AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
          AND id NOT IN (
            SELECT base_snapshot_id
            FROM snapshots
            WHERE base_snapshot_id IS NOT NULL
              AND id IN (
                SELECT snapshot_id FROM active_snapshots
                UNION
                SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
              )
          )
        RETURNING id
      `,
  });
  return rows.length;
});

const selectExactReclaimableSnapshot = Effect.fn('codeGraph.selectExactReclaimableSnapshot')(function* (
  sql: SqlClient.SqlClient,
  repositoryId: string,
  snapshotId: string,
  now: number,
) {
  const rows = yield* sql<{readonly id: string}>`
    SELECT id
    FROM snapshots AS candidate
    WHERE candidate.id = ${snapshotId}
      AND candidate.repository_id = ${repositoryId}
      AND candidate.state = 'retired'
      AND candidate.id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND candidate.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
      AND candidate.id NOT IN (
        SELECT base_snapshot_id
        FROM snapshots
        WHERE base_snapshot_id IS NOT NULL
          AND id IN (
            SELECT snapshot_id FROM active_snapshots
            UNION
            SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
          )
      )
    LIMIT 1
  `;
  return rows[0]?.id;
});

const retireIncompleteWorktreeSnapshots = Effect.fn('codeGraph.retireIncompleteWorktreeSnapshots')(function* (
  repositoryId: string,
  worktreeId: string,
  retainedSnapshotIds: ReadonlySet<string>,
  writerGate?: CodeGraphWriterGate,
  onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
  orphaned: readonly OrphanedIncompleteSnapshotCandidate[] = [],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  const retained = [...retainedSnapshotIds];
  const result = yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const retire = () =>
          retained.length === 0
            ? sql<{readonly id: string}>`
                UPDATE snapshots
                SET state = 'retired', completed_at = COALESCE(completed_at, ${new Date().toISOString()})
                WHERE repository_id = ${repositoryId}
                  AND worktree_id = ${worktreeId}
                  AND state IN ('building', 'failed')
                  AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
                  AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
                  AND id NOT IN (
                    SELECT base_snapshot_id
                    FROM snapshots
                    WHERE base_snapshot_id IS NOT NULL
                      AND id IN (
                        SELECT snapshot_id FROM active_snapshots
                        UNION
                        SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                      )
                  )
                RETURNING id
              `
            : sql<{readonly id: string}>`
                UPDATE snapshots
                SET state = 'retired', completed_at = COALESCE(completed_at, ${new Date().toISOString()})
                WHERE repository_id = ${repositoryId}
                  AND worktree_id = ${worktreeId}
                  AND state IN ('building', 'failed')
                  AND NOT (${sql.in('id', retained)})
                  AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
                  AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
                  AND id NOT IN (
                    SELECT base_snapshot_id
                    FROM snapshots
                    WHERE base_snapshot_id IS NOT NULL
                      AND id IN (
                        SELECT snapshot_id FROM active_snapshots
                        UNION
                        SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                      )
                  )
                RETURNING id
              `;
        const retired = yield* retire();
        let orphanedRetired = 0;
        for (const candidate of orphaned) {
          orphanedRetired += yield* retireOrphanedIncompleteSnapshot(sql, repositoryId, candidate, now);
        }
        // Retention only protects resumable building/failed identities above.
        // A ready snapshot may have retired the logical or direct sibling that
        // appears in the next run's candidate set; keeping that already-retired
        // row would leak its full graph forever across mode switches.
        const reclaimable = yield* sql<{readonly id: string}>`
          SELECT id
          FROM snapshots AS candidate
          WHERE candidate.repository_id = ${repositoryId}
            AND candidate.worktree_id = ${worktreeId}
            AND candidate.state = 'retired'
            AND candidate.id NOT IN (SELECT snapshot_id FROM active_snapshots)
            AND candidate.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
            AND candidate.id NOT IN (
              SELECT base_snapshot_id
              FROM snapshots
              WHERE base_snapshot_id IS NOT NULL
                AND id IN (
                  SELECT snapshot_id FROM active_snapshots
                  UNION
                  SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                )
            )
          ORDER BY id
        `;
        const orphanedReclaimable: string[] = [];
        for (const candidate of orphaned) {
          const snapshotId = yield* selectExactReclaimableSnapshot(sql, repositoryId, candidate.id, now);
          if (snapshotId !== undefined) orphanedReclaimable.push(snapshotId);
        }
        const reclaimableIds = [...new Set([...reclaimable.map(snapshot => snapshot.id), ...orphanedReclaimable])].sort(
          compareCodeUnits,
        );
        for (const snapshotIds of chunk(reclaimableIds, 100)) {
          yield* sql`DELETE FROM snapshot_build_owners WHERE ${sql.in('snapshot_id', snapshotIds)}`;
        }
        return {reclaimable: reclaimableIds, retired: retired.length + orphanedRetired};
      }),
    ),
  );
  if (result.reclaimable.length > 0) {
    yield* reclaimRetiredSnapshotRows(sql, result.reclaimable, runWrite, onProgress);
  }
  return result.retired;
});

/**
 * Superseded persistent builds can own repository-sized durable tables. Reclaim
 * their exact identities before the replacement build starts, one transaction
 * at a time. The writer gate is released between pages so linked worktrees can
 * make progress; unlike best-effort detached cleanup, this required path waits
 * through contention until every still-eligible target is gone.
 */
const reclaimRetiredSnapshotRows = Effect.fn('codeGraph.reclaimRetiredSnapshotRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  writerGate: CodeGraphWriterGate,
  onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
) {
  const targets = [...new Set(snapshotIds)].sort(compareCodeUnits);
  if (targets.length === 0) return;
  const targetBatches = [...chunk(targets, 100)];
  let pagesCompleted = 0;
  let rowsDeleted = 0;
  let snapshotsCompleted = 0;
  yield* onProgress?.({
    pagesCompleted,
    rowsDeleted,
    snapshotsCompleted,
    snapshotsTotal: targets.length,
  }) ?? Effect.void;
  for (let index = 0; index < targetBatches.length; index += 1) {
    const targetBatch = targetBatches[index]!;
    for (;;) {
      const page = yield* writerGate(sql.withTransaction(reclaimRetiredSnapshotPage(sql, targetBatch)));
      pagesCompleted += 1;
      rowsDeleted += page.rowsDeleted;
      if (page.complete) snapshotsCompleted += targetBatch.length;
      yield* onProgress?.({
        pagesCompleted,
        rowsDeleted,
        snapshotsCompleted,
        snapshotsTotal: targets.length,
      }) ?? Effect.void;
      if (page.complete) break;
      yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
    }
    if (index + 1 < targetBatches.length) {
      yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
    }
  }
});

const reclaimRetiredSnapshotPage = Effect.fn('codeGraph.reclaimRetiredSnapshotPage')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
) {
  const now = yield* Clock.currentTimeMillis;
  const snapshotPlaceholders = snapshotIds.map(() => '?').join(', ');
  const compactTargets = yield* sql.unsafe<CompactLexicalSnapshotKeyRow & {readonly snapshot_id: string}>(
    `SELECT compact.snapshot_key, compact.snapshot_id
     FROM lexical_compact_snapshots AS compact
     JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
     WHERE snapshot.id IN (${snapshotPlaceholders})
       AND snapshot.state = 'retired'
       AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
       AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
       AND snapshot.id NOT IN (
         SELECT base_snapshot_id
         FROM snapshots
         WHERE base_snapshot_id IS NOT NULL
           AND id IN (
             SELECT snapshot_id FROM active_snapshots
             UNION
             SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
           )
       )
     ORDER BY compact.snapshot_id
     LIMIT 1`,
    [...snapshotIds, now, now],
  );
  const compactTarget = compactTargets[0];
  if (compactTarget !== undefined) {
    const compactSnapshotKey = yield* validatedCompactLexicalCount(compactTarget.snapshot_key, 'cleanup snapshot key');
    for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
      const statement = compactLexicalCleanupPageStatement(spec, compactSnapshotKey, spec.batchRows, Option.none());
      yield* sql.unsafe(statement.text, statement.parameters);
      const deleted = yield* lastStatementChangeCount(sql);
      if (deleted > 0) return {complete: false, rowsDeleted: deleted};
    }
    yield* sql.unsafe('DELETE FROM lexical_storage_formats WHERE snapshot_id = ?', [compactTarget.snapshot_id]);
    const formatsDeleted = yield* lastStatementChangeCount(sql);
    yield* sql.unsafe('DELETE FROM lexical_compact_snapshots WHERE snapshot_key = ? AND snapshot_id = ?', [
      compactSnapshotKey,
      compactTarget.snapshot_id,
    ]);
    const snapshotsDeleted = yield* lastStatementChangeCount(sql);
    const metadataDeleted = formatsDeleted + snapshotsDeleted;
    if (metadataDeleted > 0) return {complete: false, rowsDeleted: metadataDeleted};
  }
  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    const key = `(${spec.keyColumns.join(', ')})`;
    yield* sql.unsafe(
      `DELETE FROM ${spec.table}
       WHERE ${key} IN (
         SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
         FROM ${spec.table} AS candidate
         JOIN snapshots AS snapshot ON snapshot.id = candidate.snapshot_id
         WHERE candidate.snapshot_id IN (${snapshotPlaceholders})
           AND snapshot.state = 'retired'
           AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
           AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
           AND snapshot.id NOT IN (
             SELECT base_snapshot_id
             FROM snapshots
             WHERE base_snapshot_id IS NOT NULL
               AND id IN (
                 SELECT snapshot_id FROM active_snapshots
                 UNION
                 SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
               )
           )
         ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
         LIMIT ?
       )`,
      [...snapshotIds, now, now, spec.batchRows],
    );
    const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
    const deleted = Number(changes[0]?.count ?? 0);
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid row count.'));
    }
    if (deleted > 0) return {complete: false, rowsDeleted: deleted};
  }
  yield* sql.unsafe(
    `DELETE FROM snapshots
     WHERE id IN (
       SELECT snapshot.id
       FROM snapshots AS snapshot
       WHERE snapshot.id IN (${snapshotPlaceholders})
         AND snapshot.state = 'retired'
         AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
         AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
         AND snapshot.id NOT IN (
           SELECT base_snapshot_id
           FROM snapshots
           WHERE base_snapshot_id IS NOT NULL
             AND id IN (
               SELECT snapshot_id FROM active_snapshots
               UNION
               SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
             )
         )
       ORDER BY snapshot.id
       LIMIT 100
     )`,
    [...snapshotIds, now, now],
  );
  const removed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
  const removedCount = Number(removed[0]?.count ?? 0);
  if (!Number.isSafeInteger(removedCount) || removedCount < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid count.'));
  }
  const remaining = yield* sql.unsafe<{readonly present: number}>(
    `SELECT EXISTS(
       SELECT 1
       FROM snapshots AS snapshot
       WHERE snapshot.id IN (${snapshotPlaceholders})
         AND snapshot.state = 'retired'
         AND snapshot.id NOT IN (SELECT snapshot_id FROM active_snapshots)
         AND snapshot.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?)
         AND snapshot.id NOT IN (
           SELECT base_snapshot_id
           FROM snapshots
           WHERE base_snapshot_id IS NOT NULL
             AND id IN (
               SELECT snapshot_id FROM active_snapshots
               UNION
               SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ?
             )
         )
       LIMIT 1
     ) AS present`,
    [...snapshotIds, now, now],
  );
  return {complete: Number(remaining[0]?.present ?? 0) === 0, rowsDeleted: removedCount};
});

const assertPersistentBuildOwner = Effect.fn('codeGraph.assertPersistentBuildOwner')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
) {
  const rows = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT snapshot.state
    FROM snapshots AS snapshot
    JOIN snapshot_build_owners AS owner ON owner.snapshot_id = snapshot.id
    WHERE snapshot.id = ${snapshotId} AND owner.owner_token = ${ownerToken}
    LIMIT 1
  `;
  if (!rows[0] || !['building', 'failed'].includes(rows[0].state)) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent build ownership changed.'));
  }
});

const registerPersistentMaterializationPlan = Effect.fn('codeGraph.registerPersistentMaterializationPlan')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  expectedBatchCount: number,
) {
  const registered = yield* sql<{readonly expected_batch_count: number}>`
      UPDATE snapshot_build_owners
      SET expected_batch_count = COALESCE(expected_batch_count, ${expectedBatchCount})
      WHERE snapshot_id = ${snapshotId}
        AND owner_token = ${ownerToken}
        AND (expected_batch_count IS NULL OR expected_batch_count = ${expectedBatchCount})
      RETURNING expected_batch_count
    `;
  if (Number(registered[0]?.expected_batch_count ?? -1) !== expectedBatchCount) {
    return yield* Effect.fail(
      new CodeGraphStoreError('Persisted full-build materialization plan changed; discard and rebuild it.'),
    );
  }
  yield* sql`
    INSERT INTO building_lexical_counters (
      snapshot_id, completed_batch_count, posting_count, symbol_count, term_count
    ) VALUES (${snapshotId}, 0, 0, 0, 0)
    ON CONFLICT(snapshot_id) DO NOTHING
  `;
});

const finalizePersistentMaterializationPlan = Effect.fn('codeGraph.finalizePersistentMaterializationPlan')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  expectedBatchCount: number,
) {
  if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization batch count is invalid.'));
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      const rows = yield* sql<{
        readonly analysis_count: number;
        readonly analysis_maximum: number | null;
        readonly analysis_minimum: number | null;
        readonly expected_batch_count: number | null;
        readonly materialization_count: number;
        readonly materialization_maximum: number | null;
        readonly materialization_minimum: number | null;
      }>`
        SELECT owner.expected_batch_count,
          (SELECT COUNT(*) FROM building_materialization_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_count,
          (SELECT MIN(batch_index) FROM building_materialization_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_minimum,
          (SELECT MAX(batch_index) FROM building_materialization_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_maximum,
          (SELECT COUNT(*) FROM building_analysis_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_count,
          (SELECT MIN(batch_index) FROM building_analysis_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_minimum,
          (SELECT MAX(batch_index) FROM building_analysis_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_maximum
        FROM snapshot_build_owners AS owner
        WHERE owner.snapshot_id = ${snapshotId} AND owner.owner_token = ${ownerToken}
        LIMIT 1
      `;
      const row = rows[0];
      const registered = row?.expected_batch_count;
      const contiguous = (count: number, minimum: number | null, maximum: number | null) =>
        expectedBatchCount === 0
          ? count === 0 && minimum === null && maximum === null
          : count === expectedBatchCount && Number(minimum) === 0 && Number(maximum) === expectedBatchCount - 1;
      if (
        row === undefined ||
        (registered !== null && Number(registered) !== expectedBatchCount) ||
        !contiguous(Number(row.materialization_count), row.materialization_minimum, row.materialization_maximum) ||
        !contiguous(Number(row.analysis_count), row.analysis_minimum, row.analysis_maximum)
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Persistent full-build materialization has incomplete or non-contiguous receipts.'),
        );
      }
      yield* registerPersistentMaterializationPlan(sql, snapshotId, ownerToken, expectedBatchCount);
      yield* assertPersistentMaterializationComplete(sql, snapshotId, ownerToken);
    }),
  );
});

const assertPersistentMaterializationComplete = Effect.fn('codeGraph.assertPersistentMaterializationComplete')(
  function* (sql: SqlClient.SqlClient, snapshotId: string, ownerToken: string) {
    const rows = yield* sql<{
      readonly analysis_receipts: number;
      readonly expected_batches: number;
      readonly invalid_analysis_receipts: number;
      readonly invalid_materialization_receipts: number;
      readonly lexical_batches: number;
      readonly materialization_receipts: number;
    }>`
      SELECT
        COALESCE(owner.expected_batch_count, -1) AS expected_batches,
        (
          SELECT COUNT(*) FROM building_materialization_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
        ) AS materialization_receipts,
        (
          SELECT COUNT(*) FROM building_materialization_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
            AND receipt.batch_index >= COALESCE(owner.expected_batch_count, -1)
        ) AS invalid_materialization_receipts,
        (
          SELECT COUNT(*) FROM building_analysis_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
        ) AS analysis_receipts,
        (
          SELECT COUNT(*) FROM building_analysis_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
            AND receipt.batch_index >= COALESCE(owner.expected_batch_count, -1)
        ) AS invalid_analysis_receipts,
        COALESCE((
          SELECT completed_batch_count FROM building_lexical_counters AS lexical
          WHERE lexical.snapshot_id = owner.snapshot_id
        ), -1) AS lexical_batches
      FROM snapshot_build_owners AS owner
      WHERE owner.snapshot_id = ${snapshotId} AND owner.owner_token = ${ownerToken}
      LIMIT 1
    `;
    const row = rows[0];
    const expected = Number(row?.expected_batches ?? -1);
    if (
      expected < 0 ||
      Number(row?.materialization_receipts ?? -1) !== expected ||
      Number(row?.analysis_receipts ?? -1) !== expected ||
      Number(row?.lexical_batches ?? -1) !== expected ||
      Number(row?.invalid_materialization_receipts ?? -1) !== 0 ||
      Number(row?.invalid_analysis_receipts ?? -1) !== 0
    ) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent full-build materialization has incomplete batch receipts.'),
      );
    }
  },
);

const assertPersistentMaterializationBatchPlanned = Effect.fn('codeGraph.assertPersistentMaterializationBatchPlanned')(
  function* (sql: SqlClient.SqlClient, snapshotId: string, ownerToken: string, batchIndex: number) {
    const rows = yield* sql<{
      readonly analysis_count: number;
      readonly analysis_maximum: number | null;
      readonly analysis_minimum: number | null;
      readonly expected_batch_count: number | null;
      readonly materialization_count: number;
      readonly materialization_maximum: number | null;
      readonly materialization_minimum: number | null;
    }>`
      SELECT owner.expected_batch_count,
        (SELECT COUNT(*) FROM building_materialization_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_count,
        (SELECT MIN(batch_index) FROM building_materialization_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_minimum,
        (SELECT MAX(batch_index) FROM building_materialization_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_maximum,
        (SELECT COUNT(*) FROM building_analysis_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_count,
        (SELECT MIN(batch_index) FROM building_analysis_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_minimum,
        (SELECT MAX(batch_index) FROM building_analysis_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_maximum
      FROM snapshot_build_owners AS owner
      WHERE owner.snapshot_id = ${snapshotId} AND owner.owner_token = ${ownerToken}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(new CodeGraphStoreError('Persistent build ownership changed.'));
    }
    if (row.expected_batch_count !== null) {
      if (batchIndex < Number(row.expected_batch_count)) return;
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent materialization batch is outside the registered plan.'),
      );
    }
    const materializationCount = Number(row.materialization_count);
    const analysisCount = Number(row.analysis_count);
    const contiguous = (count: number, minimum: number | null, maximum: number | null) =>
      count === 0 ? minimum === null && maximum === null : Number(minimum) === 0 && Number(maximum) === count - 1;
    if (
      materializationCount !== analysisCount ||
      !contiguous(materializationCount, row.materialization_minimum, row.materialization_maximum) ||
      !contiguous(analysisCount, row.analysis_minimum, row.analysis_maximum) ||
      batchIndex > materializationCount
    ) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent materialization batches must be staged in contiguous order.'),
      );
    }
  },
);

const failBuildingSnapshot = Effect.fn('codeGraph.failBuildingSnapshot')(function* (
  snapshotId: string,
  summary: string,
  ownerToken?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const targetState = ownerToken === undefined ? 'failed' : 'retired';
  const changed = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        UPDATE snapshots
        SET state = ${targetState}, failure_summary = ${summary.slice(0, 2_000)},
          completed_at = ${new Date().toISOString()}
        WHERE id = ${snapshotId}
          AND state = 'building'
          AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
          AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
          AND (
            ${ownerToken ?? null} IS NULL OR EXISTS (
              SELECT 1 FROM snapshot_build_owners AS owner
              WHERE owner.snapshot_id = snapshots.id AND owner.owner_token = ${ownerToken ?? null}
            )
          )
      `;
      const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
      if (Number(changes[0]?.count ?? 0) > 0 && ownerToken !== undefined) {
        yield* sql`
          DELETE FROM snapshot_build_owners
          WHERE snapshot_id = ${snapshotId} AND owner_token = ${ownerToken}
        `;
      }
      return Number(changes[0]?.count ?? 0);
    }),
  );
  return changed;
});

const preparePersistedFullActivation = Effect.fn('codeGraph.preparePersistedFullActivation')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  expectedBatchCount?: number,
  ownerToken?: string,
  writerGate?: CodeGraphWriterGate,
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
    yield* runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
          yield* registerPersistentMaterializationPlan(sql, snapshotId, ownerToken, expectedBatchCount);
        }),
      ),
    );
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
    yield* runWrite(
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

const preparePersistedFullResolutionViews = Effect.fn('codeGraph.preparePersistedFullResolutionViews')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const name of [
    'activation_reference_candidates',
    'activation_references',
    'activation_edges',
    'activation_symbol_lookup',
    'activation_symbols',
  ] as const) {
    yield* sql.unsafe(`DROP VIEW IF EXISTS temp.${name}`);
  }
  for (const name of [
    'persisted_full_reference_candidate_delete',
    'persisted_full_reference_delete',
    'persisted_full_edge_delete',
    'persisted_full_edge_insert',
    'persisted_full_lookup_insert',
  ] as const) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS temp.${name}`);
  }
  // These views are read-only compatibility surfaces. Persistent resolution
  // writes directly to snapshot-prefixed tables in bounded set operations;
  // per-row INSTEAD OF triggers are intentionally not recreated.
  const snapshotSelector = `(SELECT value FROM activation_state WHERE key = 'snapshot_id')`;
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_symbols AS
    SELECT id, content_hash, kind, name, qualified_name, path, language, arity,
      lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
      exported, signature, documentation, span_json
    FROM symbols WHERE snapshot_id = ${snapshotSelector}
  `);
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_symbol_lookup AS
    SELECT lookup_key, symbol_id, resolution_domain, exported, provenance,
      evidence_edge_id, evidence_path
    FROM snapshot_symbol_lookup WHERE snapshot_id = ${snapshotSelector}
  `);
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_edges AS
    SELECT id, source_id, source_name, relation, target_id, target_name, provenance,
      confidence, evidence_path, evidence_span_json
    FROM edges WHERE snapshot_id = ${snapshotSelector}
  `);
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_references AS
    SELECT edge_id, resolution_domain, exported_only, alias_lookup_keys_json
    FROM building_references WHERE snapshot_id = ${snapshotSelector}
  `);
});

const prepareActivationTables = Effect.fn('codeGraph.prepareActivationTables')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA temp_store = FILE');
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL,
      source TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbols (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL,
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_scopes (
      id TEXT PRIMARY KEY,
      build_system TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_components (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      source_roots_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_dependencies (
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (source_component_id, target_component_id, provenance)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbol_lookup (
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (lookup_key, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_references (
      edge_id TEXT PRIMARY KEY,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL,
      alias_lookup_keys_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reexport_provenance (
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      PRIMARY KEY (source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reference_candidates (
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (edge_id, tier, lookup_key)
    ) WITHOUT ROWID
  `);
  // Resolution is explicitly bounded by an edge-id range. The table primary
  // key serves that access path, while activation_symbol_lookup serves the
  // lookup-key join. A second lookup-key-first index was never selected by the
  // resolver and doubled random B-tree maintenance during full ingestion.
  yield* sql.unsafe('DROP INDEX IF EXISTS temp.activation_reference_candidates_lookup');
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
  yield* prepareAnalysisResolutionTables(sql);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbol_terms (
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (term, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(
    'CREATE TEMP TABLE IF NOT EXISTS activation_changed_symbol_ids (id TEXT PRIMARY KEY) WITHOUT ROWID',
  );
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_incremental_paths (
      path TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql.unsafe('DELETE FROM activation_files');
  yield* sql.unsafe('DELETE FROM activation_workspace_scopes');
  yield* sql.unsafe('DELETE FROM activation_workspace_components');
  yield* sql.unsafe('DELETE FROM activation_workspace_dependencies');
  yield* sql.unsafe('DELETE FROM activation_symbols');
  yield* sql.unsafe('DELETE FROM activation_symbol_lookup');
  yield* sql.unsafe('DELETE FROM activation_edges');
  yield* sql.unsafe('DELETE FROM activation_references');
  yield* sql.unsafe('DELETE FROM activation_reexport_provenance');
  yield* sql.unsafe('DELETE FROM activation_reference_candidates');
  yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
  yield* sql.unsafe('DELETE FROM activation_analysis_edge_affected_ids');
  yield* sql.unsafe('DELETE FROM activation_analysis_edge_before');
  yield* sql.unsafe('DELETE FROM activation_symbol_terms');
  yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
});

const prepareAnalysisResolutionTables = Effect.fn('codeGraph.prepareAnalysisResolutionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_analysis_edge_affected_ids (
      id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_analysis_edge_before (
      id TEXT PRIMARY KEY,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      endpoint_state INTEGER NOT NULL CHECK (endpoint_state IN (0, 1, 2))
    ) WITHOUT ROWID
  `);
});

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.
const ACTIVATION_FILE_BATCH_ROWS = 2_500;
const ACTIVATION_SYMBOL_BATCH_ROWS = 1_000;
const ACTIVATION_LOOKUP_BATCH_ROWS = 4_000;
const ACTIVATION_TERM_BATCH_ROWS = 5_000;
const ACTIVATION_EDGE_BATCH_ROWS = 1_500;
const ACTIVATION_REFERENCE_BATCH_ROWS = 3_000;
const ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS = 5_000;

export const CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION = 1 as const;

type ActivationInsertMode = 'insert' | 'upsert';
type ActivationStagingObserver = (
  stage: CodeGraphStagingStage,
  chunkRows: number,
  force?: boolean,
) => Effect.Effect<void, unknown>;

function activationStagingObserver(
  sql: SqlClient.SqlClient,
  onProgress: CodeGraphStagingProgressCallback | undefined,
  storageDatabase: 'main' | 'temp' = 'temp',
): ActivationStagingObserver {
  const startedAt = performance.now();
  const elapsedByStage = new Map<Exclude<CodeGraphStagingStage, 'committed'>, number>();
  const rowsByStage = new Map<CodeGraphStagingStage, number>();
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let lastStorageSampleAt = Number.NEGATIVE_INFINITY;
  let lastStage: CodeGraphStagingStage | undefined;
  let lastTimingAt = startedAt;
  let lastTimingStage: Exclude<CodeGraphStagingStage, 'committed'> | undefined;
  return (stage, chunkRows, force = false) =>
    Effect.gen(function* () {
      const rowsCompleted = (rowsByStage.get(stage) ?? 0) + chunkRows;
      rowsByStage.set(stage, rowsCompleted);
      const now = performance.now();
      const timingStage = stage === 'committed' ? 'committing' : stage;
      if (lastTimingStage === timingStage) {
        elapsedByStage.set(timingStage, (elapsedByStage.get(timingStage) ?? 0) + Math.max(0, now - lastTimingAt));
      }
      lastTimingAt = now;
      lastTimingStage = timingStage;
      const shouldReport = force || stage !== lastStage || now - lastReportAt >= 500;
      if (onProgress && shouldReport) {
        let allocatedDatabaseBytes: number | undefined;
        if (stage === 'committed' || now - lastStorageSampleAt >= 1_000) {
          const pageCountRows = yield* sql.unsafe<{readonly page_count: number}>(
            `PRAGMA ${storageDatabase}.page_count`,
          );
          const pageSizeRows = yield* sql.unsafe<{readonly page_size: number}>(`PRAGMA ${storageDatabase}.page_size`);
          const pageCount = Number(pageCountRows[0]?.page_count ?? 0);
          const pageSize = Number(pageSizeRows[0]?.page_size ?? 0);
          if (Number.isSafeInteger(pageCount) && pageCount >= 0 && Number.isSafeInteger(pageSize) && pageSize > 0) {
            allocatedDatabaseBytes = pageCount * pageSize;
          }
          lastStorageSampleAt = now;
        }
        yield* onProgress({
          chunkRows,
          elapsedMilliseconds: Math.max(0, now - startedAt),
          rowsCompleted,
          stage,
          stageElapsedMilliseconds: elapsedByStage.get(timingStage) ?? 0,
          ...(allocatedDatabaseBytes === undefined
            ? {}
            : storageDatabase === 'main'
              ? {durableDatabaseBytes: allocatedDatabaseBytes}
              : {temporaryDatabaseBytes: allocatedDatabaseBytes}),
        });
        lastReportAt = now;
        lastStage = stage;
      }
      // Bun's SQLite calls are synchronous. Explicitly yield between bounded
      // statements so the independent build heartbeat can run even when the
      // current materialization batch is expensive.
      yield* Effect.yieldNow;
    });
}

function activationInsertClause(mode: ActivationInsertMode): 'INSERT' | 'INSERT OR REPLACE' {
  return mode === 'insert' ? 'INSERT' : 'INSERT OR REPLACE';
}

const activationMode = Effect.fn('codeGraph.activationMode')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{readonly key: string; readonly value: string}>`
    SELECT key, value
    FROM activation_state
    WHERE key IN ('base_snapshot_id', 'mode', 'owner_token', 'snapshot_id')
  `;
  const values = new Map(rows.map(row => [row.key, row.value]));
  const baseSnapshotId = values.get('base_snapshot_id');
  if (values.get('mode') === 'persisted-delta' && baseSnapshotId) {
    return {baseSnapshotId, mode: 'persisted-delta'} as const;
  }
  const snapshotId = values.get('snapshot_id');
  const ownerToken = values.get('owner_token');
  if (values.get('mode') === 'persisted-full' && snapshotId && ownerToken) {
    return {mode: 'persisted-full', ownerToken, snapshotId} as const;
  }
  return undefined;
});

function stageActivationFiles(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphInventoryFile[],
  mode: ActivationInsertMode = 'upsert',
) {
  return Effect.gen(function* () {
    for (const batch of chunk(
      sortedBy(files, file => file.path),
      ACTIVATION_FILE_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_files (
          path, content_hash, language, mode, size, source
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(file => [file.path, file.contentHash, file.language, file.mode, file.size, file.source]),
      );
    }
  });
}

function stageActivationWorkspace(workspace: CodeGraphWorkspace) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const scope of workspace.workspaces) {
      yield* sql`
        INSERT OR REPLACE INTO activation_workspace_scopes (
          id, build_system, name, root, provenance, diagnostics_json
        ) VALUES (
          ${scope.id}, ${scope.buildSystem}, ${scope.name}, ${scope.root},
          ${scope.provenance}, ${JSON.stringify(scope.diagnostics)}
        )
      `;
    }
    for (const component of workspace.projects) {
      yield* sql`
        INSERT OR REPLACE INTO activation_workspace_components (
          id, workspace_id, build_system, kind, name, root, resolution_domain,
          languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
        ) VALUES (
          ${component.id}, ${component.workspaceId}, ${component.buildSystem}, ${component.kind},
          ${component.name}, ${component.root}, ${component.resolutionDomain},
          ${JSON.stringify(component.languages)}, ${JSON.stringify(component.sourceRoots)},
          ${JSON.stringify(component.workspaceRoots)}, ${component.provenance},
          ${JSON.stringify(component.diagnostics)}
        )
      `;
      for (const dependency of component.dependencyDetails) {
        yield* sql`
          INSERT OR REPLACE INTO activation_workspace_dependencies (
            source_component_id, target_component_id, provenance, evidence
          ) VALUES (
            ${component.id}, ${dependency.targetId}, ${dependency.provenance}, ${dependency.evidence ?? null}
          )
        `;
      }
    }
  });
}

const stagePersistedFullWorkspace = Effect.fn('codeGraph.stagePersistedFullWorkspace')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  workspace: CodeGraphWorkspace,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      for (const scope of workspace.workspaces) {
        yield* sql`
          INSERT OR REPLACE INTO workspace_scopes (
            snapshot_id, id, build_system, name, root, provenance, diagnostics_json
          ) VALUES (
            ${snapshotId}, ${scope.id}, ${scope.buildSystem}, ${scope.name}, ${scope.root},
            ${scope.provenance}, ${JSON.stringify(scope.diagnostics)}
          )
        `;
      }
      for (const component of workspace.projects) {
        yield* sql`
          INSERT OR REPLACE INTO workspace_components (
            snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          ) VALUES (
            ${snapshotId}, ${component.id}, ${component.workspaceId}, ${component.buildSystem},
            ${component.kind}, ${component.name}, ${component.root}, ${component.resolutionDomain},
            ${JSON.stringify(component.languages)}, ${JSON.stringify(component.sourceRoots)},
            ${JSON.stringify(component.workspaceRoots)}, ${component.provenance},
            ${JSON.stringify(component.diagnostics)}
          )
        `;
        for (const dependency of component.dependencyDetails) {
          yield* sql`
            INSERT OR REPLACE INTO workspace_component_dependencies (
              snapshot_id, source_component_id, target_component_id, provenance, evidence
            ) VALUES (
              ${snapshotId}, ${component.id}, ${dependency.targetId},
              ${dependency.provenance}, ${dependency.evidence ?? null}
            )
          `;
        }
      }
    }),
  );
});

function stageActivationSymbols(
  sql: SqlClient.SqlClient,
  symbols: readonly CodeGraphSymbol[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    yield* observer?.('symbols', 0, true) ?? Effect.void;
    for (const batch of chunk(
      sortedBy(symbols, symbol => symbol.id),
      ACTIVATION_SYMBOL_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_symbols (
          id, content_hash, kind, name, qualified_name, path, language, package_name,
          arity, lookup_keys_json, resolution_domain, resolution_scope_id, exported, signature,
          documentation, span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(symbol => [
          symbol.id,
          symbol.contentHash,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.path,
          symbol.language,
          symbol.packageName ?? null,
          symbol.arity ?? null,
          JSON.stringify(symbol.lookupKeys ?? []),
          symbol.resolutionDomain ?? null,
          symbol.resolutionScopeId ?? null,
          symbol.exported ? 1 : 0,
          symbol.signature ?? null,
          symbol.documentation ?? null,
          JSON.stringify(symbol.span),
        ]),
      );
      yield* observer?.('symbols', batch.length) ?? Effect.void;
      const lookupRows = [
        ...uniqueBy(
          batch.flatMap(symbol =>
            (symbol.lookupKeys ?? []).map(
              key =>
                [
                  key,
                  symbol.id,
                  lookupDomain(key, symbol.resolutionDomain),
                  symbol.exported ? 1 : 0,
                  'symbol',
                  null,
                  symbol.path,
                ] as const,
            ),
          ),
          row => `${row[0]}\0${row[1]}`,
        ),
      ].sort((left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]));
      yield* observer?.('lookup-keys', 0, true) ?? Effect.void;
      for (const lookupBatch of chunk(lookupRows, ACTIVATION_LOOKUP_BATCH_ROWS)) {
        yield* sql.unsafe(
          `${activationInsertClause(mode)} INTO activation_symbol_lookup (
            lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
          ) VALUES ${lookupBatch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          lookupBatch.flat(),
        );
        yield* observer?.('lookup-keys', lookupBatch.length) ?? Effect.void;
      }
    }
    yield* observer?.('symbols', 0, true) ?? Effect.void;
    yield* observer?.('lookup-keys', 0, true) ?? Effect.void;
  });
}

function stageActivationSymbolTerms(
  sql: SqlClient.SqlClient,
  symbols: readonly CodeGraphSymbol[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    yield* observer?.('terms', 0, true) ?? Effect.void;
    let termBatch: Array<readonly [string, string, number]> = [];
    const flush = () => {
      if (termBatch.length === 0) return Effect.void;
      const current = termBatch.sort(
        (left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]),
      );
      termBatch = [];
      return Effect.gen(function* () {
        yield* sql.unsafe(
          `${activationInsertClause(mode)} INTO activation_symbol_terms (term, symbol_id, weight)
           VALUES ${current.map(() => '(?, ?, ?)').join(', ')}`,
          current.flat(),
        );
        yield* observer?.('terms', current.length) ?? Effect.void;
      });
    };
    for (const symbol of sortedBy(symbols, symbol => symbol.id)) {
      for (const [term, weight] of symbolTerms(symbol)) {
        termBatch.push([term, symbol.id, weight]);
        if (termBatch.length >= ACTIVATION_TERM_BATCH_ROWS) yield* flush();
      }
    }
    yield* flush();
    yield* observer?.('terms', 0, true) ?? Effect.void;
  });
}

interface CompactLexicalSnapshotKeyRow {
  readonly snapshot_key: number | bigint;
}

function validatedCompactLexicalCount(
  value: number | bigint,
  description: string,
): Effect.Effect<number, CodeGraphStoreError> {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0
    ? Effect.succeed(count)
    : Effect.fail(new CodeGraphStoreError(`Compact lexical ${description} is invalid.`));
}

const ensureCompactLexicalSnapshot = Effect.fn('codeGraph.ensureCompactLexicalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`
    INSERT INTO lexical_compact_snapshots (snapshot_id)
    VALUES (${snapshotId})
    ON CONFLICT(snapshot_id) DO NOTHING
  `;
  const rows = yield* sql<CompactLexicalSnapshotKeyRow>`
    SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId} LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return yield* Effect.fail(new CodeGraphStoreError(`Compact lexical snapshot ${snapshotId} was not allocated.`));
  }
  return yield* validatedCompactLexicalCount(row.snapshot_key, 'snapshot key');
});

const stageCompactLexicalFacts = Effect.fn('codeGraph.stageCompactLexicalFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  symbols: readonly CodeGraphSymbol[],
  observer?: ActivationStagingObserver,
) {
  const snapshotKey = yield* ensureCompactLexicalSnapshot(sql, snapshotId);
  const orderedSymbols = sortedBy(symbols, symbol => symbol.id);
  let symbolCount = 0;
  for (const batch of chunk(orderedSymbols, ACTIVATION_SYMBOL_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id)
       VALUES ${batch.map(() => '(?, ?)').join(', ')}`,
      batch.flatMap(symbol => [snapshotKey, symbol.id]),
    );
    const inserted = yield* lastStatementChangeCount(sql);
    if (inserted !== batch.length) {
      return yield* Effect.fail(new CodeGraphStoreError('Compact lexical symbol dictionary lost rows.'));
    }
    symbolCount += inserted;
  }

  yield* observer?.('terms', 0, true) ?? Effect.void;
  let postingCount = 0;
  let termCount = 0;
  let termBatch: Array<readonly [string, string, number]> = [];
  const flush = () => {
    if (termBatch.length === 0) return Effect.void;
    const current = termBatch.sort(
      (left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]),
    );
    termBatch = [];
    return Effect.gen(function* () {
      const terms = [...new Set(current.map(row => row[0]))].sort(compareCodeUnits);
      for (const termRows of chunk(terms, ACTIVATION_TERM_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO lexical_compact_terms (snapshot_key, term)
           VALUES ${termRows.map(() => '(?, ?)').join(', ')}`,
          termRows.flatMap(term => [snapshotKey, term]),
        );
        termCount += yield* lastStatementChangeCount(sql);
      }
      yield* sql.unsafe(
        `WITH input(term, symbol_id, weight) AS (
           VALUES ${current.map(() => '(?, ?, ?)').join(', ')}
         )
         INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
         SELECT ?, terms.term_key, symbols.symbol_key, input.weight
         FROM input
         JOIN lexical_compact_terms AS terms
           ON terms.snapshot_key = ? AND terms.term = input.term
         JOIN lexical_compact_symbols AS symbols
           ON symbols.snapshot_key = ? AND symbols.symbol_id = input.symbol_id
         ORDER BY terms.term_key, symbols.symbol_key`,
        [...current.flat(), snapshotKey, snapshotKey, snapshotKey],
      );
      const inserted = yield* lastStatementChangeCount(sql);
      if (inserted !== current.length) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Compact lexical dictionary join lost ${current.length - inserted} posting(s).`),
        );
      }
      postingCount += inserted;
      yield* observer?.('terms', inserted) ?? Effect.void;
    });
  };
  for (const symbol of orderedSymbols) {
    for (const [term, weight] of symbolTerms(symbol)) {
      termBatch.push([term, symbol.id, weight]);
      if (termBatch.length >= ACTIVATION_TERM_BATCH_ROWS) yield* flush();
    }
  }
  yield* flush();
  yield* observer?.('terms', 0, true) ?? Effect.void;
  return {postingCount, symbolCount, termCount} satisfies CompactLexicalFormatReceipt;
});

type CompactActivationSymbolSelection = 'all' | 'changed';

const copyActivationCompactLexicalFacts = Effect.fn('codeGraph.copyActivationCompactLexicalFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  selection: CompactActivationSymbolSelection,
) {
  const snapshotKey = yield* ensureCompactLexicalSnapshot(sql, snapshotId);
  const symbolJoin =
    selection === 'changed' ? 'JOIN activation_changed_symbol_ids AS changed ON changed.id = symbol.id' : '';
  const termJoin =
    selection === 'changed' ? 'JOIN activation_changed_symbol_ids AS changed ON changed.id = posting.symbol_id' : '';
  yield* sql.unsafe(
    `INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id)
     SELECT ?, symbol.id
     FROM activation_symbols AS symbol
     ${symbolJoin}
     ORDER BY symbol.id`,
    [snapshotKey],
  );
  const symbolCount = yield* lastStatementChangeCount(sql);
  yield* sql.unsafe(
    `INSERT OR IGNORE INTO lexical_compact_terms (snapshot_key, term)
     SELECT DISTINCT ?, posting.term
     FROM activation_symbol_terms AS posting
     ${termJoin}
     ORDER BY posting.term`,
    [snapshotKey],
  );
  const termCount = yield* lastStatementChangeCount(sql);
  yield* sql.unsafe(
    `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
     SELECT ?, terms.term_key, symbols.symbol_key, posting.weight
     FROM activation_symbol_terms AS posting
     ${termJoin}
     JOIN lexical_compact_terms AS terms
       ON terms.snapshot_key = ? AND terms.term = posting.term
     JOIN lexical_compact_symbols AS symbols
       ON symbols.snapshot_key = ? AND symbols.symbol_id = posting.symbol_id
     ORDER BY terms.term_key, symbols.symbol_key`,
    [snapshotKey, snapshotKey, snapshotKey],
  );
  const postingCount = yield* lastStatementChangeCount(sql);
  const expectedRows = yield* sql.unsafe<{readonly count: number | bigint}>(
    `SELECT COUNT(*) AS count
     FROM activation_symbol_terms AS posting
     ${termJoin}`,
  );
  const expectedPostings = yield* validatedCompactLexicalCount(expectedRows[0]?.count ?? 0, 'staged posting count');
  if (postingCount !== expectedPostings) {
    return yield* Effect.fail(
      new CodeGraphStoreError(`Compact lexical activation lost ${expectedPostings - postingCount} posting(s).`),
    );
  }
  return {postingCount, symbolCount, termCount} satisfies CompactLexicalFormatReceipt;
});

interface CompactLexicalFormatReceipt {
  readonly postingCount: number;
  readonly symbolCount: number;
  readonly termCount: number;
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

function validatedCompactLexicalReceipt(
  receipt: CompactLexicalFormatReceipt,
  expectedPostingCount: number,
  expectedSymbolCount: number,
): Effect.Effect<CompactLexicalFormatReceipt, CodeGraphStoreError> {
  const counts = [receipt.postingCount, receipt.symbolCount, receipt.termCount];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) {
    return Effect.fail(new CodeGraphStoreError('Compact lexical receipt contains an invalid count.'));
  }
  if (receipt.postingCount !== expectedPostingCount || receipt.symbolCount !== expectedSymbolCount) {
    return Effect.fail(
      new CodeGraphStoreError(
        `Compact lexical receipt mismatch (${receipt.postingCount}/${expectedPostingCount} postings, ` +
          `${receipt.symbolCount}/${expectedSymbolCount} symbols).`,
      ),
    );
  }
  return Effect.succeed(receipt);
}

const publishCompactLexicalFormat = Effect.fn('codeGraph.publishCompactLexicalFormat')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  receipt: CompactLexicalFormatReceipt,
) {
  yield* sql`
    INSERT INTO lexical_storage_formats (
      snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
    ) VALUES (
      ${snapshotId}, ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}, ${receipt.postingCount},
      ${receipt.symbolCount}, ${receipt.termCount}, ${new Date().toISOString()}
    )
    ON CONFLICT(snapshot_id) DO UPDATE SET
      format_version = excluded.format_version,
      posting_count = excluded.posting_count,
      symbol_count = excluded.symbol_count,
      term_count = excluded.term_count,
      created_at = excluded.created_at
  `;
});

const recordCompactLexicalFormat = Effect.fn('codeGraph.recordCompactLexicalFormat')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  receipt: CompactLexicalFormatReceipt,
  expectedPostingCount: number,
  expectedSymbolCount: number,
) {
  yield* publishCompactLexicalFormat(
    sql,
    snapshotId,
    yield* validatedCompactLexicalReceipt(receipt, expectedPostingCount, expectedSymbolCount),
  );
});

function stageActivationEdges(
  sql: SqlClient.SqlClient,
  edges: readonly CodeGraphEdge[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    yield* observer?.('edges', 0, true) ?? Effect.void;
    for (const batch of chunk(
      sortedBy(edges, edge => edge.id),
      ACTIVATION_EDGE_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_edges (
          id, source_id, source_name, relation, target_id, target_name, provenance,
          confidence, evidence_path, evidence_span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(edge => [
          edge.id,
          edge.sourceId ?? null,
          edge.sourceName,
          edge.relation,
          edge.targetId ?? null,
          edge.targetName,
          edge.provenance,
          edge.confidence,
          edge.evidencePath,
          JSON.stringify(edge.evidenceSpan),
        ]),
      );
      yield* observer?.('edges', batch.length) ?? Effect.void;
    }
    yield* observer?.('edges', 0, true) ?? Effect.void;
  });
}

function stageActivationReferences(
  sql: SqlClient.SqlClient,
  references: readonly CodeGraphReference[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    const boundedReferences = references.filter(isCodeGraphReferenceWithinCandidateBudget);
    yield* observer?.('references', 0, true) ?? Effect.void;
    for (const batch of chunk(
      sortedBy(boundedReferences, reference => reference.edgeId),
      ACTIVATION_REFERENCE_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_references (
          edge_id, resolution_domain, exported_only, alias_lookup_keys_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(reference => [
          reference.edgeId,
          reference.resolutionDomain,
          reference.exportedOnly === true ? 1 : 0,
          JSON.stringify(reference.aliasLookupKeys ?? []),
        ]),
      );
      yield* observer?.('references', batch.length) ?? Effect.void;
      const candidates = [
        ...uniqueBy(
          batch.flatMap(reference =>
            reference.lookupTiers.flatMap((tier, tierIndex) =>
              tier.map(key => [reference.edgeId, tierIndex, key] as const),
            ),
          ),
          row => `${row[0]}\0${row[1]}\0${row[2]}`,
        ),
      ].sort(
        (left, right) =>
          compareCodeUnits(left[0], right[0]) || left[1] - right[1] || compareCodeUnits(left[2], right[2]),
      );
      yield* observer?.('reference-candidates', 0, true) ?? Effect.void;
      for (const candidateBatch of chunk(candidates, ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS)) {
        yield* sql.unsafe(
          `${activationInsertClause(mode)} INTO activation_reference_candidates (
            edge_id, tier, lookup_key
          ) VALUES ${candidateBatch.map(() => '(?, ?, ?)').join(', ')}`,
          candidateBatch.flat(),
        );
        yield* observer?.('reference-candidates', candidateBatch.length) ?? Effect.void;
      }
      const reexports = [
        ...uniqueBy(batch.flatMap(normalizedReexportProvenance), reexport =>
          [reexport.sourcePath, reexport.localName, reexport.targetPath, reexport.importedName].join('\0'),
        ),
      ].sort(
        (left, right) =>
          compareCodeUnits(left.sourcePath, right.sourcePath) ||
          compareCodeUnits(left.localName, right.localName) ||
          compareCodeUnits(left.targetPath, right.targetPath) ||
          compareCodeUnits(left.importedName, right.importedName),
      );
      yield* observer?.('reexports', 0, true) ?? Effect.void;
      for (const reexportBatch of chunk(reexports, ACTIVATION_REFERENCE_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO activation_reexport_provenance (
            source_path, local_name, target_path, imported_name
          ) VALUES ${reexportBatch.map(() => '(?, ?, ?, ?)').join(', ')}`,
          reexportBatch.flatMap(reexport => [
            reexport.sourcePath,
            reexport.localName,
            reexport.targetPath,
            reexport.importedName,
          ]),
        );
        yield* observer?.('reexports', reexportBatch.length) ?? Effect.void;
      }
    }
    yield* observer?.('references', 0, true) ?? Effect.void;
    yield* observer?.('reference-candidates', 0, true) ?? Effect.void;
    yield* observer?.('reexports', 0, true) ?? Effect.void;
  });
}

const persistedFullBatchFingerprint = Effect.fn('codeGraph.persistedFullBatchFingerprint')(function* (
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
) {
  const digest = new Bun.CryptoHasher('sha256');
  let rows = 0;
  const update = (kind: 'edge' | 'reference' | 'symbol', value: readonly unknown[]) => {
    digest.update(kind);
    digest.update('\0');
    digest.update(JSON.stringify(value));
    digest.update('\n');
  };
  for (const edge of sortedBy(edges, edge => edge.id)) {
    update('edge', [
      edge.id,
      edge.sourceId,
      edge.sourceName,
      edge.relation,
      edge.targetId,
      edge.targetName,
      edge.provenance,
      edge.confidence,
      edge.evidencePath,
      edge.evidenceSpan,
    ]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  for (const reference of sortedBy(references, reference => reference.edgeId)) {
    update('reference', [
      reference.edgeId,
      reference.resolutionDomain,
      reference.exportedOnly === true,
      reference.lookupTiers,
      reference.aliasLookupKeys ?? [],
      reference.relation,
      reference.evidencePath,
    ]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  for (const symbol of sortedBy(symbols, symbol => symbol.id)) {
    update('symbol', [
      symbol.id,
      symbol.contentHash,
      symbol.kind,
      symbol.name,
      symbol.qualifiedName,
      symbol.path,
      symbol.language,
      symbol.packageName,
      symbol.arity,
      symbol.lookupKeys ?? [],
      symbol.resolutionDomain,
      symbol.resolutionScopeId,
      symbol.exported,
      symbol.signature,
      symbol.documentation,
      symbol.span,
    ]);
    if ((rows += 1) % 1_024 === 0) yield* Effect.yieldNow;
  }
  return digest.digest('hex');
});

interface PersistedFullBatchReceipt {
  readonly batch_fingerprint: string;
  readonly candidate_count: number;
  readonly edge_count: number;
  readonly lookup_count: number;
  readonly reference_count: number;
  readonly reexport_count: number;
  readonly symbol_count: number;
  readonly term_count: number;
}

interface PersistedAnalysisBatchReceipt {
  readonly batch_fingerprint: string;
  readonly edge_count: number;
  readonly symbol_count: number;
}

interface AnalysisEdgeHistogramDelta {
  readonly confidence: number;
  readonly count: number;
  readonly endpointState: 0 | 1 | 2;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
}

const stagePersistedAnalysisBatch = Effect.fn('codeGraph.stagePersistedAnalysisBatch')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  batchIndex: number,
  batchFingerprint: string,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
) {
  const existing = yield* sql<PersistedAnalysisBatchReceipt>`
    SELECT batch_fingerprint, symbol_count, edge_count
    FROM building_analysis_batches
    WHERE snapshot_id = ${snapshotId} AND batch_index = ${batchIndex}
    LIMIT 1
  `;
  if (existing[0]) {
    if (
      existing[0].batch_fingerprint !== batchFingerprint ||
      Number(existing[0].symbol_count) !== symbols.length ||
      Number(existing[0].edge_count) !== edges.length
    ) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persisted analysis batch contents changed; discard and rebuild it.'),
      );
    }
    return;
  }

  const symbolCounts = new Map<string, {count: number; kind: string; language: string}>();
  for (const symbol of symbols) {
    const key = `${symbol.language}\0${symbol.kind}`;
    const current = symbolCounts.get(key) ?? {count: 0, kind: symbol.kind, language: symbol.language};
    current.count += 1;
    symbolCounts.set(key, current);
  }
  for (const batch of chunk([...symbolCounts.values()], 400)) {
    yield* sql.unsafe(
      `INSERT INTO snapshot_analysis_symbol_counts (snapshot_id, language, kind, count)
       VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}
       ON CONFLICT(snapshot_id, language, kind) DO UPDATE SET
         count = snapshot_analysis_symbol_counts.count + excluded.count`,
      batch.flatMap(row => [snapshotId, row.language, row.kind, row.count]),
    );
  }

  const edgeCounts = aggregateEdgeHistogram(edges);
  for (const batch of chunk(edgeCounts, 400)) {
    yield* sql.unsafe(
      `INSERT INTO snapshot_analysis_edge_histogram (
         snapshot_id, provenance, relation, confidence, endpoint_state, count
       ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(snapshot_id, provenance, relation, confidence, endpoint_state) DO UPDATE SET
         count = snapshot_analysis_edge_histogram.count + excluded.count`,
      batch.flatMap(row => [snapshotId, row.provenance, row.relation, row.confidence, row.endpointState, row.count]),
    );
  }
  yield* sql`
    INSERT INTO building_analysis_batches (
      snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, completed_at
    ) VALUES (
      ${snapshotId}, ${batchIndex}, ${batchFingerprint}, ${symbols.length}, ${edges.length},
      ${new Date().toISOString()}
    )
  `;
});

function aggregateEdgeHistogram(edges: readonly CodeGraphEdge[]): readonly AnalysisEdgeHistogramDelta[] {
  const counts = new Map<string, AnalysisEdgeHistogramDelta>();
  for (const edge of edges) {
    const endpointState = analysisEndpointState(edge.sourceId, edge.targetId);
    const key = `${edge.provenance}\0${edge.relation}\0${edge.confidence}\0${endpointState}`;
    const current = counts.get(key);
    counts.set(
      key,
      current
        ? {...current, count: current.count + 1}
        : {
            confidence: edge.confidence,
            count: 1,
            endpointState,
            provenance: edge.provenance,
            relation: edge.relation,
          },
    );
  }
  return [...counts.values()].sort(
    (left, right) =>
      compareCodeUnits(left.provenance, right.provenance) ||
      compareCodeUnits(left.relation, right.relation) ||
      left.confidence - right.confidence ||
      left.endpointState - right.endpointState,
  );
}

function analysisEndpointState(sourceId: string | undefined, targetId: string | undefined): 0 | 1 | 2 {
  if (sourceId === undefined || targetId === undefined) return 1;
  return sourceId === targetId ? 2 : 0;
}

interface CompactedReferenceLookupTiers {
  readonly candidateCount: number;
  readonly json: string;
  readonly payloadBytes: number;
  readonly tiers: readonly (readonly string[])[];
}

const referenceCandidateEncoder = new TextEncoder();

function compactReferenceLookupTiers(lookupTiers: readonly (readonly string[])[]): CompactedReferenceLookupTiers {
  const tiers = lookupTiers.map(tier => [...new Set(tier)].sort(compareCodeUnits));
  const json = JSON.stringify(tiers);
  return {
    candidateCount: tiers.reduce((total, tier) => total + tier.length, 0),
    json,
    payloadBytes: referenceCandidateEncoder.encode(json).byteLength,
    tiers,
  };
}

const stagePersistedFullFacts = Effect.fn('codeGraph.stagePersistedFullFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  batchIndex: number,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
  observer: ActivationStagingObserver,
) {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization batch identity is invalid.'));
  }
  const boundedReferences = references.filter(isCodeGraphReferenceWithinCandidateBudget);
  const batchFingerprint = yield* persistedFullBatchFingerprint(symbols, edges, boundedReferences);

  let lookupCount = 0;
  let termCount = 0;
  let candidateCount = 0;
  let reexportCount = 0;
  let compactBatchCounts: CompactLexicalFormatReceipt = {postingCount: 0, symbolCount: 0, termCount: 0};
  const resumed = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* observer('validating', 0, true);
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      yield* assertPersistentMaterializationBatchPlanned(sql, snapshotId, ownerToken, batchIndex);
      const existing = yield* sql<PersistedFullBatchReceipt>`
        SELECT batch_fingerprint, symbol_count, edge_count, term_count, lookup_count,
          reference_count, candidate_count, reexport_count
        FROM building_materialization_batches
        WHERE snapshot_id = ${snapshotId} AND batch_index = ${batchIndex}
        LIMIT 1
      `;
      yield* observer('validating', 3, true);
      if (existing[0]) {
        if (existing[0].batch_fingerprint !== batchFingerprint) {
          return yield* Effect.fail(
            new CodeGraphStoreError('Persisted full-build batch contents changed; discard and rebuild it.'),
          );
        }
        // Beta databases may have a durable materialization receipt created
        // before compact analysis summaries existed. Repair that batch from
        // the fingerprint-verified caller facts without replaying fact rows.
        yield* observer('analysis', 0, true);
        yield* stagePersistedAnalysisBatch(sql, snapshotId, batchIndex, batchFingerprint, symbols, edges);
        yield* observer('analysis', symbols.length + edges.length, true);
        return existing[0];
      }
      yield* observer('symbols', 0, true);
      for (const batch of chunk(
        sortedBy(symbols, symbol => symbol.id),
        ACTIVATION_SYMBOL_BATCH_ROWS,
      )) {
        yield* sql.unsafe(
          `INSERT INTO symbols (
            snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
            arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
            exported, signature, documentation, span_json
          ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          batch.flatMap(symbol => [
            snapshotId,
            symbol.id,
            symbol.contentHash,
            symbol.kind,
            symbol.name,
            symbol.qualifiedName,
            symbol.path,
            symbol.language,
            symbol.arity ?? null,
            JSON.stringify(symbol.lookupKeys ?? []),
            symbol.resolutionDomain ?? null,
            symbol.resolutionScopeId ?? null,
            symbol.packageName ?? null,
            symbol.exported ? 1 : 0,
            symbol.signature ?? null,
            symbol.documentation ?? null,
            JSON.stringify(symbol.span),
          ]),
        );
        yield* observer('symbols', batch.length);
        const lookupRows = [
          ...uniqueBy(
            batch.flatMap(symbol =>
              (symbol.lookupKeys ?? []).map(
                key =>
                  [
                    snapshotId,
                    key,
                    symbol.id,
                    lookupDomain(key, symbol.resolutionDomain),
                    symbol.exported ? 1 : 0,
                    'symbol',
                    null,
                    symbol.path,
                  ] as const,
              ),
            ),
            row => `${row[1]}\0${row[2]}`,
          ),
        ].sort((left, right) => compareCodeUnits(left[1], right[1]) || compareCodeUnits(left[2], right[2]));
        yield* observer('lookup-keys', 0, true);
        for (const lookupBatch of chunk(lookupRows, ACTIVATION_LOOKUP_BATCH_ROWS)) {
          yield* sql.unsafe(
            `INSERT INTO snapshot_symbol_lookup (
              snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
              provenance, evidence_edge_id, evidence_path
            ) VALUES ${lookupBatch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            lookupBatch.flat(),
          );
          lookupCount += lookupBatch.length;
          yield* observer('lookup-keys', lookupBatch.length);
        }
      }
      yield* observer('symbols', 0, true);
      yield* observer('lookup-keys', 0, true);

      compactBatchCounts = yield* stageCompactLexicalFacts(sql, snapshotId, symbols, observer);
      termCount = compactBatchCounts.postingCount;

      yield* observer('edges', 0, true);
      for (const batch of chunk(
        sortedBy(edges, edge => edge.id),
        ACTIVATION_EDGE_BATCH_ROWS,
      )) {
        yield* sql.unsafe(
          `INSERT INTO edges (
            snapshot_id, id, source_id, source_name, relation, target_id, target_name,
            provenance, confidence, evidence_path, evidence_span_json
          ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          batch.flatMap(edge => [
            snapshotId,
            edge.id,
            edge.sourceId ?? null,
            edge.sourceName,
            edge.relation,
            edge.targetId ?? null,
            edge.targetName,
            edge.provenance,
            edge.confidence,
            edge.evidencePath,
            JSON.stringify(edge.evidenceSpan),
          ]),
        );
        yield* observer('edges', batch.length);
      }
      yield* observer('edges', 0, true);

      yield* observer('references', 0, true);
      for (const batch of chunk(
        sortedBy(boundedReferences, reference => reference.edgeId),
        ACTIVATION_REFERENCE_BATCH_ROWS,
      )) {
        const compacted = batch.map(reference => ({
          candidates: compactReferenceLookupTiers(reference.lookupTiers),
          reference,
        }));
        yield* sql.unsafe(
          `INSERT INTO building_references (
            snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
            lookup_tiers_json, candidate_count, candidate_payload_bytes
          ) VALUES ${compacted.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          compacted.flatMap(({candidates, reference}) => [
            snapshotId,
            reference.edgeId,
            reference.resolutionDomain,
            reference.exportedOnly === true ? 1 : 0,
            JSON.stringify(reference.aliasLookupKeys ?? []),
            candidates.json,
            candidates.candidateCount,
            candidates.payloadBytes,
          ]),
        );
        yield* observer('references', batch.length);
        const candidates = compacted.reduce((total, entry) => total + entry.candidates.candidateCount, 0);
        yield* observer('reference-candidates', 0, true);
        candidateCount += candidates;
        yield* observer('reference-candidates', candidates);
        const reexports = [
          ...uniqueBy(batch.flatMap(normalizedReexportProvenance), reexport =>
            [reexport.sourcePath, reexport.localName, reexport.targetPath, reexport.importedName].join('\0'),
          ),
        ].sort(
          (left, right) =>
            compareCodeUnits(left.sourcePath, right.sourcePath) ||
            compareCodeUnits(left.localName, right.localName) ||
            compareCodeUnits(left.targetPath, right.targetPath) ||
            compareCodeUnits(left.importedName, right.importedName),
        );
        yield* observer('reexports', 0, true);
        for (const reexportBatch of chunk(reexports, ACTIVATION_REFERENCE_BATCH_ROWS)) {
          yield* sql.unsafe(
            `INSERT OR IGNORE INTO snapshot_reexport_provenance (
              snapshot_id, source_path, local_name, target_path, imported_name
            ) VALUES ${reexportBatch.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            reexportBatch.flatMap(reexport => [
              snapshotId,
              reexport.sourcePath,
              reexport.localName,
              reexport.targetPath,
              reexport.importedName,
            ]),
          );
          reexportCount += reexportBatch.length;
          yield* observer('reexports', reexportBatch.length);
        }
      }
      yield* observer('references', 0, true);
      yield* observer('reference-candidates', 0, true);
      yield* observer('reexports', 0, true);
      yield* observer('analysis', 0, true);
      yield* stagePersistedAnalysisBatch(sql, snapshotId, batchIndex, batchFingerprint, symbols, edges);
      yield* observer('analysis', symbols.length + edges.length, true);
      yield* observer('receipt', 0, true);
      yield* sql`
        INSERT INTO building_materialization_batches (
          snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, term_count, lookup_count,
          reference_count, candidate_count, reexport_count, completed_at
        ) VALUES (
          ${snapshotId}, ${batchIndex}, ${batchFingerprint}, ${symbols.length}, ${edges.length}, ${termCount}, ${lookupCount},
          ${boundedReferences.length}, ${candidateCount}, ${reexportCount}, ${new Date().toISOString()}
        )
      `;
      const lexicalCounter = yield* sql<{
        readonly completed_batch_count: number;
        readonly posting_count: number;
        readonly symbol_count: number;
        readonly term_count: number;
      }>`
        INSERT INTO building_lexical_counters (
          snapshot_id, completed_batch_count, posting_count, symbol_count, term_count
        ) VALUES (
          ${snapshotId}, 1, ${compactBatchCounts.postingCount}, ${compactBatchCounts.symbolCount},
          ${compactBatchCounts.termCount}
        )
        ON CONFLICT(snapshot_id) DO UPDATE SET
          completed_batch_count = building_lexical_counters.completed_batch_count + 1,
          posting_count = building_lexical_counters.posting_count + excluded.posting_count,
          symbol_count = building_lexical_counters.symbol_count + excluded.symbol_count,
          term_count = building_lexical_counters.term_count + excluded.term_count
        RETURNING completed_batch_count, posting_count, symbol_count, term_count
      `;
      if (Number(lexicalCounter[0]?.completed_batch_count ?? -1) !== batchIndex + 1) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Compact lexical counters no longer match contiguous batch receipts.'),
        );
      }
      yield* observer('receipt', 1, true);
      yield* observer('committing', 0, true);
      return undefined;
    }),
  );
  if (resumed) {
    for (const [stage, rows] of [
      ['symbols', Number(resumed.symbol_count)],
      ['lookup-keys', Number(resumed.lookup_count)],
      ['terms', Number(resumed.term_count)],
      ['edges', Number(resumed.edge_count)],
      ['references', Number(resumed.reference_count)],
      ['reference-candidates', Number(resumed.candidate_count)],
      ['reexports', Number(resumed.reexport_count)],
      ['receipt', 1],
    ] as const) {
      yield* observer(stage, rows, true);
    }
  }
  yield* observer('committed', 0, true);
});

function normalizedReexportProvenance(reference: CodeGraphReference): readonly CodeGraphReusableReexport[] {
  if (reference.relation !== 'reexports' || reference.resolutionDomain !== 'typescript') return [];
  const aliases = uniqueBy(
    (reference.aliasLookupKeys ?? []).flatMap(key => {
      const parsed = parseTypeScriptPathNameLookupKey(key);
      return parsed && parsed.path === reference.evidencePath ? [parsed] : [];
    }),
    candidate => `${candidate.path}\0${candidate.name}`,
  );
  const targets = uniqueBy(
    reference.lookupTiers.flatMap(tier =>
      tier.flatMap(key => {
        const parsed = parseTypeScriptPathNameLookupKey(key);
        return parsed ? [parsed] : [];
      }),
    ),
    candidate => `${candidate.path}\0${candidate.name}`,
  );
  return aliases.flatMap(alias =>
    targets.map(target => ({
      importedName: target.name,
      localName: alias.name,
      sourcePath: alias.path,
      targetPath: target.path,
    })),
  );
}

function parseTypeScriptPathNameLookupKey(value: string): {readonly name: string; readonly path: string} | undefined {
  const match =
    /^typescript:(?:[^:]+:)?path:([^:]+):name:([^:]+)(?::(?:arity:\d+|implementation|merge-canonical))?$/.exec(value);
  if (!match) return undefined;
  try {
    return {name: decodeURIComponent(match[2]!), path: decodeURIComponent(match[1]!)};
  } catch {
    return undefined;
  }
}

const preparePersistedIncrementalActivation = Effect.fn('codeGraph.preparePersistedIncrementalActivation')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
) {
  const sql = yield* SqlClient.SqlClient;
  if (files.length === 0 || facts.length !== files.length) return false;
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length || facts.some(file => !paths.has(file.path))) return false;
  if (!(yield* selectReusableBaseReceipt(baseSnapshotId))) return false;

  yield* prepareActivationTables(sql);
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
  const safe = yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId);
  if (!safe) {
    yield* prepareActivationTables(sql);
    return false;
  }
  yield* sql`
    INSERT INTO activation_state (key, value)
    VALUES ('mode', 'persisted-delta'), ('base_snapshot_id', ${baseSnapshotId})
  `;
  return true;
});

const persistedIncrementalSurfaceMatches = Effect.fn('codeGraph.persistedIncrementalSurfaceMatches')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const changedFiles = yield* sql<{readonly expected: number; readonly present: number}>`
    SELECT
      (SELECT COUNT(*) FROM activation_files) AS expected,
      (
        SELECT COUNT(*)
        FROM activation_files AS current
        JOIN snapshot_files AS base
          ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
      ) AS present
  `;
  if (Number(changedFiles[0]?.expected ?? 0) !== Number(changedFiles[0]?.present ?? -1)) return false;
  const mismatches = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM (
      SELECT current.id
      FROM activation_symbols AS current
      LEFT JOIN symbols AS base
        ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
      WHERE base.id IS NULL
         OR base.kind IS NOT current.kind
         OR base.name IS NOT current.name
         OR base.qualified_name IS NOT current.qualified_name
         OR base.path IS NOT current.path
         OR base.language IS NOT current.language
         OR base.arity IS NOT current.arity
         OR base.lookup_keys_json IS NOT current.lookup_keys_json
         OR base.resolution_domain IS NOT current.resolution_domain
         OR base.resolution_scope_id IS NOT current.resolution_scope_id
         OR base.package_name IS NOT current.package_name
         OR base.exported IS NOT current.exported
      UNION ALL
      SELECT base.id
      FROM symbols AS base
      JOIN activation_files AS changed ON changed.path = base.path
      LEFT JOIN activation_symbols AS current ON current.id = base.id
      WHERE base.snapshot_id = ${baseSnapshotId} AND current.id IS NULL
    ) AS mismatch
  `;
  return Number(mismatches[0]?.count ?? 0) === 0;
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

interface ResolvableActivationReferenceRow extends EdgeRow {
  readonly alias_lookup_keys_json: string;
  readonly symbol_exported: number;
  readonly symbol_kind: string;
  readonly symbol_resolution_domain: unknown;
  readonly target_symbol_id: string;
  readonly target_symbol_name: string;
}

interface ActivationResolutionRow {
  readonly confidence: number;
  readonly newEdgeId: string;
  readonly oldEdgeId: string;
  readonly provenance: CodeGraphProvenance;
  readonly relation: string;
  readonly targetId: string;
  readonly targetName: string;
}

const RESOLUTION_PAGE_ROWS = 500;
// A sampled 232k-file graph resolved a 5,000-reference page with roughly 80k
// candidate matches in less than four seconds once persistent writes bypassed
// row triggers. Keep connection-private/delta pages conservative, while clean
// full-build pages are independently bounded by reference count, candidate
// count, and encoded payload bytes before their lookup tiers are decoded.
const PERSISTENT_FULL_RESOLUTION_PAGE_ROWS = 5_000;
const PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES = CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM;
const PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES = 8 * 1_024 * 1_024;
const PERSISTENT_FULL_LOOKUP_SUMMARY_BATCH_KEYS = 256;
const REEXPORT_CLOSURE_SEED_PAGE_ROWS = 100;
const REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS = 10_000;

export interface CodeGraphPersistentReferencePageLimits {
  readonly candidateCount: number;
  readonly payloadBytes: number;
  readonly references: number;
}

interface PersistedFullReferencePageRow {
  readonly candidate_count: number;
  readonly candidate_payload_bytes: number;
  readonly edge_id: string;
  readonly lookup_tiers_json: string;
}

interface PersistedFullReferenceTotalsRow {
  readonly candidate_count: number;
  readonly count: number;
  readonly payload_bytes: number;
}

/** @internal Exposed so property tests can verify all three page bounds. */
export function codeGraphPersistentReferencePageStatement(
  snapshotId: string,
  cursor: string,
  limits: CodeGraphPersistentReferencePageLimits = {
    candidateCount: PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
    payloadBytes: PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
    references: PERSISTENT_FULL_RESOLUTION_PAGE_ROWS,
  },
): CodeGraphSqlQueryStatement {
  const references = positivePageLimit(limits.references, PERSISTENT_FULL_RESOLUTION_PAGE_ROWS);
  const candidateCount = positivePageLimit(limits.candidateCount, PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES);
  const payloadBytes = positivePageLimit(limits.payloadBytes, PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES);
  return {
    parameters: [snapshotId, cursor, references, candidateCount, payloadBytes],
    text: `WITH bounded AS MATERIALIZED (
        SELECT edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes
        FROM building_references
        WHERE snapshot_id = ? AND edge_id > ?
        ORDER BY edge_id
        LIMIT ?
      ),
      measured AS (
        SELECT edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes,
          ROW_NUMBER() OVER (ORDER BY edge_id) AS ordinal,
          SUM(candidate_count) OVER (
            ORDER BY edge_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative_candidate_count,
          SUM(candidate_payload_bytes) OVER (
            ORDER BY edge_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative_payload_bytes
        FROM bounded
      )
      SELECT edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes
      FROM measured
      WHERE cumulative_candidate_count <= ? AND cumulative_payload_bytes <= ?
      ORDER BY edge_id`,
  };
}

function positivePageLimit(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function persistentFullReferencePageTotal(row: PersistedFullReferenceTotalsRow): number {
  const references = Number(row.count);
  if (!Number.isSafeInteger(references) || references <= 0) return 0;
  const candidates = Math.max(0, Number(row.candidate_count));
  const payloadBytes = Math.max(0, Number(row.payload_bytes));
  return Math.max(
    Math.ceil(references / PERSISTENT_FULL_RESOLUTION_PAGE_ROWS),
    Math.ceil(candidates / PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES),
    Math.ceil(payloadBytes / PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES),
  );
}

function decodePersistedReferenceCandidateRows(
  references: readonly PersistedFullReferencePageRow[],
): Effect.Effect<readonly (readonly [string, string, number])[], CodeGraphStoreError> {
  return Effect.try({
    try: () => {
      const rows: Array<readonly [string, string, number]> = [];
      for (const reference of references) {
        if (
          !Number.isSafeInteger(reference.candidate_count) ||
          reference.candidate_count < 0 ||
          reference.candidate_count > PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES ||
          !Number.isSafeInteger(reference.candidate_payload_bytes) ||
          reference.candidate_payload_bytes < 0 ||
          reference.candidate_payload_bytes > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES
        ) {
          throw new CodeGraphStoreError('Stored reference candidate metadata is invalid.');
        }
        // Metadata makes the SQL page selection cheap, but is not a trust
        // boundary. Measure the actual UTF-8 payload before JSON.parse so a
        // corrupt row cannot turn a compact page into an unbounded decode.
        if (reference.lookup_tiers_json.length > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES) {
          throw new CodeGraphStoreError('Stored reference candidate payload exceeds its byte budget.');
        }
        const actualPayloadBytes = referenceCandidateEncoder.encode(reference.lookup_tiers_json).byteLength;
        if (
          actualPayloadBytes > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES ||
          actualPayloadBytes !== reference.candidate_payload_bytes
        ) {
          throw new CodeGraphStoreError('Stored reference candidate metadata does not match its payload.');
        }
        const parsed: unknown = JSON.parse(reference.lookup_tiers_json);
        if (
          !Array.isArray(parsed) ||
          !parsed.every(tier => Array.isArray(tier) && tier.every(lookupKey => typeof lookupKey === 'string'))
        ) {
          throw new CodeGraphStoreError('Stored reference lookup tiers are invalid.');
        }
        if (!areCodeGraphLookupTiersWithinCandidateBudget(parsed)) {
          throw new CodeGraphStoreError('Stored reference candidate payload exceeds its cardinality budget.');
        }
        const compacted = compactReferenceLookupTiers(parsed);
        if (
          compacted.json !== reference.lookup_tiers_json ||
          compacted.candidateCount !== reference.candidate_count ||
          compacted.payloadBytes !== reference.candidate_payload_bytes
        ) {
          throw new CodeGraphStoreError('Stored reference candidate metadata does not match its payload.');
        }
        for (const [tier, lookupKeys] of compacted.tiers.entries()) {
          for (const lookupKey of lookupKeys) rows.push([lookupKey, reference.edge_id, tier]);
        }
      }
      return rows.sort(
        (left, right) =>
          compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]) || left[2] - right[2],
      );
    },
    catch: cause =>
      cause instanceof CodeGraphStoreError
        ? cause
        : new CodeGraphStoreError('Stored reference candidate payload could not be decoded.'),
  });
}

/** @internal Exposed so regression tests can verify the SQLite access plan. */
export function codeGraphPersistedDeltaResolutionPageStatement(
  baseSnapshotId: string,
  cursor: string,
  batchEnd: string,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [cursor, batchEnd, baseSnapshotId, baseSnapshotId],
    text: `WITH page_candidates AS MATERIALIZED (
        SELECT DISTINCT candidate.edge_id, candidate.tier, candidate.lookup_key,
          reference.resolution_domain, reference.exported_only,
          edge.relation, edge.source_id
        FROM activation_reference_candidates AS candidate
        CROSS JOIN activation_references AS reference
          ON reference.edge_id = candidate.edge_id
        CROSS JOIN activation_edges AS edge
          ON edge.id = candidate.edge_id AND edge.target_id IS NULL
        WHERE candidate.edge_id > ? AND candidate.edge_id <= ?
      ),
      candidate_matches AS (
        SELECT DISTINCT
          candidate.edge_id,
          candidate.tier,
          lookup.symbol_id,
          0 AS ambiguous
        FROM page_candidates AS candidate
        CROSS JOIN activation_symbol_lookup AS lookup
          INDEXED BY sqlite_autoindex_activation_symbol_lookup_1
          ON lookup.lookup_key = candidate.lookup_key
         AND lookup.resolution_domain = candidate.resolution_domain
         AND (candidate.exported_only = 0 OR lookup.exported = 1)
         AND (candidate.relation <> 'overrides' OR lookup.symbol_id IS NOT candidate.source_id)
        UNION ALL
        SELECT DISTINCT
          candidate.edge_id,
          candidate.tier,
          lookup.symbol_id,
          0 AS ambiguous
        FROM page_candidates AS candidate
        CROSS JOIN snapshot_symbol_lookup AS lookup
          INDEXED BY sqlite_autoindex_snapshot_symbol_lookup_1
          ON lookup.snapshot_id = ?
         AND lookup.lookup_key = candidate.lookup_key
         AND lookup.resolution_domain = candidate.resolution_domain
         AND (candidate.exported_only = 0 OR lookup.exported = 1)
         AND (candidate.relation <> 'overrides' OR lookup.symbol_id IS NOT candidate.source_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM activation_files AS changed
          WHERE changed.path = lookup.evidence_path
        )
          AND NOT EXISTS (
          SELECT 1
          FROM activation_symbol_lookup AS current
            INDEXED BY sqlite_autoindex_activation_symbol_lookup_1
          WHERE current.lookup_key = lookup.lookup_key AND current.symbol_id = lookup.symbol_id
        )
      ),
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
      ),
      resolved_candidates AS (
        SELECT candidate.edge_id,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        CROSS JOIN activation_symbols AS symbol
          INDEXED BY sqlite_autoindex_activation_symbols_1
          ON symbol.id = candidate.symbol_id
        UNION ALL
        SELECT candidate.edge_id,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        CROSS JOIN symbols AS symbol
          INDEXED BY sqlite_autoindex_symbols_1
          ON symbol.snapshot_id = ? AND symbol.id = candidate.symbol_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM activation_symbols AS current INDEXED BY sqlite_autoindex_activation_symbols_1
          WHERE current.id = symbol.id
        )
      )
      SELECT
        edge.*,
        reference.alias_lookup_keys_json,
        candidate.target_symbol_id,
        candidate.target_symbol_name,
        candidate.symbol_exported,
        candidate.symbol_kind,
        candidate.symbol_resolution_domain
      FROM resolved_candidates AS candidate
      CROSS JOIN activation_edges AS edge ON edge.id = candidate.edge_id
      CROSS JOIN activation_references AS reference ON reference.edge_id = candidate.edge_id
      ORDER BY candidate.edge_id
      LIMIT ${RESOLUTION_PAGE_ROWS}`,
  };
}

type CodeGraphWriterGate = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>;

interface ReexportClosureRow {
  readonly imported_name: string;
  readonly local_name: string;
  readonly source_path: string;
  readonly target_path: string;
}

/**
 * Resolves TypeScript barrel topology once from durable provenance, then seeds
 * exact scoped aliases before the general reference scan. Deep chains therefore
 * do not require one repository-wide unresolved pass per barrel. Seed pages,
 * a bounded closure result, and the ordinary writer fence keep this optional
 * acceleration from becoming a repository-size rejection or an unbounded write.
 * Pages whose branching closure exceeds the budget safely fall back to the
 * existing reference resolver.
 */
const expandTransitiveReexportAliases = Effect.fn('codeGraph.expandTransitiveReexportAliases')(function* (
  sql: SqlClient.SqlClient,
  mode:
    | {readonly baseSnapshotId: string; readonly mode: 'persisted-delta'}
    | {readonly mode: 'persisted-full'; readonly ownerToken: string; readonly snapshotId: string}
    | undefined,
  writerGate?: CodeGraphWriterGate,
  onProgress?: (aliasesDiscovered: number) => Effect.Effect<void, never>,
) {
  if (mode?.mode === 'persisted-delta') return 0;
  const persistent = mode?.mode === 'persisted-full';
  const snapshotId = persistent ? mode.snapshotId : undefined;
  const provenanceTable = persistent ? 'snapshot_reexport_provenance' : 'activation_reexport_provenance';
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reexport_closure_page (
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      source_key_component TEXT NOT NULL,
      target_key_component TEXT NOT NULL,
      PRIMARY KEY (source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  let aliases = 0;
  let cursorPath = '';
  let cursorName = '';
  for (;;) {
    const seeds = yield* sql.unsafe<{readonly local_name: string; readonly source_path: string}>(
      `SELECT DISTINCT source_path, local_name
       FROM ${provenanceTable}
       WHERE ${persistent ? 'snapshot_id = ? AND ' : ''}
         (source_path > ? OR (source_path = ? AND local_name > ?))
       ORDER BY source_path, local_name
       LIMIT ${REEXPORT_CLOSURE_SEED_PAGE_ROWS}`,
      [...(persistent ? [snapshotId] : []), cursorPath, cursorPath, cursorName],
    );
    if (seeds.length === 0) break;
    yield* onProgress?.(aliases) ?? Effect.void;
    yield* Effect.yieldNow;
    const closure = yield* sql.unsafe<ReexportClosureRow>(
      `WITH RECURSIVE
       requested(source_path, local_name) AS (
         VALUES ${seeds.map(() => '(?, ?)').join(', ')}
       ),
       closure(source_path, local_name, target_path, imported_name) AS (
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM requested
         CROSS JOIN ${provenanceTable} AS provenance
           ON ${persistent ? 'provenance.snapshot_id = ? AND ' : ''}
              requested.source_path = provenance.source_path
          AND requested.local_name = provenance.local_name
         UNION
         SELECT closure.source_path, closure.local_name,
           provenance.target_path, provenance.imported_name
         FROM closure
         CROSS JOIN ${provenanceTable} AS provenance
           ON ${persistent ? 'provenance.snapshot_id = ? AND ' : ''}
              closure.target_path = provenance.source_path
          AND closure.imported_name = provenance.local_name
       )
       SELECT closure.source_path, closure.local_name,
         closure.target_path, closure.imported_name
       FROM closure
       WHERE NOT EXISTS (
         SELECT 1 FROM ${provenanceTable} AS next
         WHERE ${persistent ? 'next.snapshot_id = ? AND ' : ''}
           next.source_path = closure.target_path
           AND next.local_name = closure.imported_name
       )
       ORDER BY closure.source_path, closure.local_name, closure.target_path, closure.imported_name
       LIMIT ${REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS + 1}`,
      [
        ...seeds.flatMap(seed => [seed.source_path, seed.local_name]),
        ...(persistent ? [snapshotId, snapshotId, snapshotId] : []),
      ],
    );
    cursorPath = seeds.at(-1)!.source_path;
    cursorName = seeds.at(-1)!.local_name;
    if (closure.length > REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS) {
      yield* onProgress?.(aliases) ?? Effect.void;
      yield* Effect.yieldNow;
      continue;
    }
    const encoded = uniqueBy(
      closure.map(row => ({
        ...row,
        sourceKeyComponent: `path:${encodeURIComponent(row.source_path)}:name:${encodeURIComponent(row.local_name)}`,
        targetKeyComponent: `path:${encodeURIComponent(row.target_path)}:name:${encodeURIComponent(row.imported_name)}`,
      })),
      row => `${row.source_path}\0${row.local_name}\0${row.target_path}\0${row.imported_name}`,
    );
    if (encoded.length === 0) {
      yield* onProgress?.(aliases) ?? Effect.void;
      yield* Effect.yieldNow;
      continue;
    }
    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        if (persistent) yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
        yield* sql.unsafe('DELETE FROM activation_reexport_closure_page');
        for (const batch of chunk(encoded, 400)) {
          yield* sql.unsafe(
            `INSERT INTO activation_reexport_closure_page (
               source_path, local_name, target_path, imported_name,
               source_key_component, target_key_component
             ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
            batch.flatMap(row => [
              row.source_path,
              row.local_name,
              row.target_path,
              row.imported_name,
              row.sourceKeyComponent,
              row.targetKeyComponent,
            ]),
          );
        }
        const symbolTable = persistent ? 'symbols' : 'activation_symbols';
        const lookupTable = persistent ? 'snapshot_symbol_lookup' : 'activation_symbol_lookup';
        const symbolSnapshotPredicate = persistent ? 'symbol.snapshot_id = ? AND' : '';
        const targetSnapshotPredicate = persistent ? 'target.snapshot_id = ? AND' : '';
        const symbolPathIndex = persistent ? 'INDEXED BY symbols_path' : '';
        const lookupSnapshotPredicate = persistent ? 'lookup.snapshot_id = candidate.snapshot_id AND' : '';
        const insert = persistent
          ? `INSERT OR IGNORE INTO snapshot_symbol_lookup (
               snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
               provenance, evidence_edge_id, evidence_path
             )
             SELECT ?, lookup_key, symbol_id, 'typescript', exported, 'alias', NULL, evidence_path`
          : `INSERT OR IGNORE INTO activation_symbol_lookup (
               lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
             )
             SELECT lookup_key, symbol_id, 'typescript', exported, 'alias', NULL, evidence_path`;
        yield* sql.unsafe(
          `
          WITH
          source_scopes AS (
            SELECT closure.source_path, closure.local_name,
              MIN(symbol.resolution_scope_id) AS resolution_scope_id
            FROM activation_reexport_closure_page AS closure
            CROSS JOIN ${symbolTable} AS symbol ${symbolPathIndex}
              ON ${symbolSnapshotPredicate} symbol.path = closure.source_path
             AND symbol.resolution_domain = 'typescript'
            GROUP BY closure.source_path, closure.local_name
            HAVING COUNT(DISTINCT COALESCE(symbol.resolution_scope_id, '')) = 1
          ),
          candidate_targets AS MATERIALIZED (
            SELECT closure.source_path, closure.local_name,
              target.id AS symbol_id, target.exported,
              ${persistent ? 'target.snapshot_id' : "''"} AS snapshot_id,
              'typescript:' ||
                CASE WHEN target.resolution_scope_id IS NULL THEN '' ELSE target.resolution_scope_id || ':' END ||
                closure.target_key_component || ':implementation' AS implementation_key,
              'typescript:' ||
                CASE WHEN target.resolution_scope_id IS NULL THEN '' ELSE target.resolution_scope_id || ':' END ||
                closure.target_key_component || ':merge-canonical' AS merge_key,
              'typescript:' ||
                CASE WHEN target.resolution_scope_id IS NULL THEN '' ELSE target.resolution_scope_id || ':' END ||
                closure.target_key_component AS base_key
            FROM activation_reexport_closure_page AS closure
            CROSS JOIN ${symbolTable} AS target ${symbolPathIndex}
              ON ${targetSnapshotPredicate} target.path = closure.target_path
             AND target.name = closure.imported_name
             AND target.resolution_domain = 'typescript'
             AND target.exported = 1
          ),
          candidate_matches AS (
            SELECT candidate.source_path, candidate.local_name,
              candidate.symbol_id, candidate.exported,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM ${lookupTable} AS lookup
                  WHERE ${lookupSnapshotPredicate}
                    lookup.lookup_key = candidate.implementation_key
                    AND lookup.symbol_id = candidate.symbol_id
                    AND lookup.provenance = 'symbol'
                ) THEN 0
                WHEN EXISTS (
                  SELECT 1 FROM ${lookupTable} AS lookup
                  WHERE ${lookupSnapshotPredicate}
                    lookup.lookup_key = candidate.merge_key
                    AND lookup.symbol_id = candidate.symbol_id
                    AND lookup.provenance = 'symbol'
                ) THEN 1
                ELSE 2
              END AS priority
            FROM candidate_targets AS candidate
            WHERE EXISTS (
              SELECT 1 FROM ${lookupTable} AS lookup
              WHERE ${lookupSnapshotPredicate}
                lookup.lookup_key IN (candidate.implementation_key, candidate.merge_key, candidate.base_key)
                AND lookup.symbol_id = candidate.symbol_id
                AND lookup.provenance = 'symbol'
            )
          ),
          first_priorities AS (
            SELECT source_path, local_name, MIN(priority) AS priority
            FROM candidate_matches
            GROUP BY source_path, local_name
          ),
          unique_targets AS (
            SELECT candidate.source_path, candidate.local_name,
              MIN(candidate.symbol_id) AS symbol_id, MIN(candidate.exported) AS exported
            FROM candidate_matches AS candidate
            JOIN first_priorities AS first
              ON first.source_path = candidate.source_path
             AND first.local_name = candidate.local_name
             AND first.priority = candidate.priority
            GROUP BY candidate.source_path, candidate.local_name
            HAVING COUNT(DISTINCT candidate.symbol_id) = 1
          ),
          alias_rows(lookup_key, symbol_id, exported, evidence_path) AS (
            SELECT 'typescript:' ||
                CASE WHEN source.resolution_scope_id IS NULL THEN '' ELSE source.resolution_scope_id || ':' END ||
                closure.source_key_component || ':implementation',
              target.symbol_id, target.exported, closure.source_path
            FROM activation_reexport_closure_page AS closure
            JOIN source_scopes AS source
              ON source.source_path = closure.source_path AND source.local_name = closure.local_name
            JOIN unique_targets AS target
              ON target.source_path = closure.source_path AND target.local_name = closure.local_name
            UNION
            SELECT 'typescript:' ||
                CASE WHEN source.resolution_scope_id IS NULL THEN '' ELSE source.resolution_scope_id || ':' END ||
                closure.source_key_component,
              target.symbol_id, target.exported, closure.source_path
            FROM activation_reexport_closure_page AS closure
            JOIN source_scopes AS source
              ON source.source_path = closure.source_path AND source.local_name = closure.local_name
            JOIN unique_targets AS target
              ON target.source_path = closure.source_path AND target.local_name = closure.local_name
          )
          ${insert}
          FROM alias_rows
          ORDER BY lookup_key, symbol_id
        `,
          persistent ? [mode.snapshotId, mode.snapshotId, mode.snapshotId] : [],
        );
        const changed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
        return Number(changed[0]?.count ?? 0);
      }),
    );
    aliases += yield* persistent && writerGate ? writerGate(transaction) : transaction;
    yield* onProgress?.(aliases) ?? Effect.void;
    yield* Effect.yieldNow;
  }
  yield* sql.unsafe('DELETE FROM activation_reexport_closure_page');
  return aliases;
});

const capturePersistedAnalysisResolutionEdges = Effect.fn('codeGraph.capturePersistedAnalysisResolutionEdges')(
  function* (sql: SqlClient.SqlClient, snapshotId: string) {
    yield* sql.unsafe('DELETE FROM activation_analysis_edge_affected_ids');
    yield* sql.unsafe('DELETE FROM activation_analysis_edge_before');
    yield* sql.unsafe(`
    INSERT OR IGNORE INTO activation_analysis_edge_affected_ids (id)
    SELECT old_edge_id FROM activation_resolved_reference_batch
    UNION
    SELECT new_edge_id FROM activation_resolved_reference_batch
  `);
    yield* sql.unsafe(
      `
    INSERT INTO activation_analysis_edge_before (id, provenance, relation, confidence, endpoint_state)
    SELECT edge.id, edge.provenance, edge.relation, edge.confidence,
      CASE
        WHEN edge.source_id IS NULL OR edge.target_id IS NULL THEN 1
        WHEN edge.source_id = edge.target_id THEN 2
        ELSE 0
      END
    FROM activation_analysis_edge_affected_ids AS affected
    CROSS JOIN edges AS edge ON edge.snapshot_id = ? AND edge.id = affected.id
  `,
      [snapshotId],
    );
  },
);

const adjustPersistedAnalysisResolutionEdges = Effect.fn('codeGraph.adjustPersistedAnalysisResolutionEdges')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql.unsafe(
    `INSERT INTO snapshot_analysis_edge_histogram (
       snapshot_id, provenance, relation, confidence, endpoint_state, count
     )
     SELECT ?, provenance, relation, confidence, endpoint_state, -COUNT(*)
     FROM activation_analysis_edge_before
     GROUP BY provenance, relation, confidence, endpoint_state
     ON CONFLICT(snapshot_id, provenance, relation, confidence, endpoint_state) DO UPDATE SET
       count = snapshot_analysis_edge_histogram.count + excluded.count`,
    [snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO snapshot_analysis_edge_histogram (
       snapshot_id, provenance, relation, confidence, endpoint_state, count
     )
     SELECT ?, edge.provenance, edge.relation, edge.confidence,
       CASE
         WHEN edge.source_id IS NULL OR edge.target_id IS NULL THEN 1
         WHEN edge.source_id = edge.target_id THEN 2
         ELSE 0
       END,
       COUNT(*)
     FROM activation_analysis_edge_affected_ids AS affected
     CROSS JOIN edges AS edge ON edge.snapshot_id = ? AND edge.id = affected.id
     GROUP BY edge.provenance, edge.relation, edge.confidence,
       CASE
         WHEN edge.source_id IS NULL OR edge.target_id IS NULL THEN 1
         WHEN edge.source_id = edge.target_id THEN 2
         ELSE 0
       END
     ON CONFLICT(snapshot_id, provenance, relation, confidence, endpoint_state) DO UPDATE SET
       count = snapshot_analysis_edge_histogram.count + excluded.count`,
    [snapshotId, snapshotId],
  );
  const invalid = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshot_analysis_edge_histogram
    WHERE snapshot_id = ${snapshotId} AND count < 0
  `;
  if (Number(invalid[0]?.count ?? 0) > 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Reference resolution produced a negative analysis delta.'));
  }
  yield* sql`
    DELETE FROM snapshot_analysis_edge_histogram
    WHERE snapshot_id = ${snapshotId} AND count = 0
  `;
});

const resolveActivationReferences = Effect.fn('codeGraph.resolveActivationReferences')(function* (
  onProgress?: CodeGraphResolutionProgressCallback,
  writerGate?: CodeGraphWriterGate,
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
        yield* mode?.mode === 'persisted-full' && writerGate ? writerGate(transaction) : transaction;
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

const identifyChangedSymbols = Effect.fn('codeGraph.identifyChangedSymbols')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string | undefined,
) {
  if (!baseSnapshotId) {
    yield* sql.unsafe('INSERT INTO activation_changed_symbol_ids (id) SELECT id FROM activation_symbols');
    return;
  }
  yield* sql`
    INSERT INTO activation_changed_symbol_ids (id)
    SELECT current.id
    FROM activation_symbols AS current
    LEFT JOIN symbols AS base
      ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
    WHERE base.id IS NULL
       OR base.content_hash IS NOT current.content_hash
       OR base.kind IS NOT current.kind
       OR base.name IS NOT current.name
       OR base.qualified_name IS NOT current.qualified_name
       OR base.path IS NOT current.path
       OR base.language IS NOT current.language
       OR base.arity IS NOT current.arity
       OR base.lookup_keys_json IS NOT current.lookup_keys_json
       OR base.resolution_domain IS NOT current.resolution_domain
       OR base.resolution_scope_id IS NOT current.resolution_scope_id
       OR base.package_name IS NOT current.package_name
       OR base.exported IS NOT current.exported
       OR base.signature IS NOT current.signature
       OR base.documentation IS NOT current.documentation
       OR base.span_json IS NOT current.span_json
  `;
});

const promoteSnapshot = Effect.fn('codeGraph.promoteSnapshot')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  yield* initializeSchema(sql);
  yield* sql.withTransaction(ensureReadySnapshotAnalysisSummary(sql, snapshotId));
  const retainedWorktreeIds = [...new Set([...activeWorktreeIds, identity.worktreeId])];
  yield* sql.withTransaction(
    Effect.gen(function* () {
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
      yield* sql`
        DELETE FROM active_snapshots
        WHERE NOT (${sql.in('worktree_id', retainedWorktreeIds)})
      `;
      yield* sql`
        INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
        VALUES (${identity.worktreeId}, ${snapshotId}, ${new Date().toISOString()})
        ON CONFLICT(worktree_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          activated_at = excluded.activated_at
      `;
      yield* markUnusedSnapshotsRetired(sql);
    }),
  );
});

const reconcileActiveWorktrees = Effect.fn('codeGraph.reconcileActiveWorktrees')(function* (
  sql: SqlClient.SqlClient,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const retained = [...activeWorktreeIds];
  if (retained.length === 0) yield* sql`DELETE FROM active_snapshots`;
  else {
    yield* sql`
      DELETE FROM active_snapshots
      WHERE NOT (${sql.in('worktree_id', retained)})
    `;
  }
  yield* markUnusedSnapshotsRetired(sql);
});

const markUnusedSnapshotsRetired = Effect.fn('codeGraph.markUnusedSnapshotsRetired')(function* (
  sql: SqlClient.SqlClient,
) {
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM snapshot_leases WHERE expires_at <= ${now}`;
  yield* sql`
    UPDATE snapshots
    SET state = 'retired'
    WHERE state = 'ready'
      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
      AND id NOT IN (
        SELECT base_snapshot_id FROM snapshots
        WHERE base_snapshot_id IS NOT NULL
          AND id IN (SELECT snapshot_id FROM active_snapshots UNION SELECT snapshot_id FROM snapshot_leases)
      )
  `;
});

interface CompactLexicalCleanupSpec {
  readonly batchRows: number;
  readonly indexName?: string;
  readonly keyColumns: readonly string[];
  readonly maximumBatchRows: number;
  readonly table: 'lexical_compact_postings' | 'lexical_compact_symbols' | 'lexical_compact_terms';
}

const COMPACT_LEXICAL_CLEANUP_SPECS: readonly CompactLexicalCleanupSpec[] = [
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_key', 'term_key', 'symbol_key'],
    maximumBatchRows: 20_000,
    table: 'lexical_compact_postings',
  },
  {
    batchRows: 5_000,
    indexName: 'sqlite_autoindex_lexical_compact_symbols_1',
    keyColumns: ['snapshot_key', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'lexical_compact_symbols',
  },
  {
    batchRows: 5_000,
    indexName: 'sqlite_autoindex_lexical_compact_terms_1',
    keyColumns: ['snapshot_key', 'term'],
    maximumBatchRows: 20_000,
    table: 'lexical_compact_terms',
  },
];

function compactLexicalCleanupPageStatement(
  spec: CompactLexicalCleanupSpec,
  snapshotKey: number,
  batchRows: number,
  retiredSnapshotId: Option.Option<string>,
): CodeGraphSqlQueryStatement {
  const key = `(${spec.keyColumns.join(', ')})`;
  const retirement = Option.match(retiredSnapshotId, {
    onNone: () => ({parameters: [] as readonly string[], predicate: ''}),
    onSome: snapshotId => ({
      parameters: [snapshotId],
      predicate: `AND EXISTS (
        SELECT 1
        FROM lexical_compact_snapshots AS compact
        JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
        WHERE compact.snapshot_key = candidate.snapshot_key
          AND compact.snapshot_id = ?
          AND snapshot.state = 'retired'
      )`,
    }),
  });
  return {
    parameters: [snapshotKey, ...retirement.parameters, batchRows],
    text: `DELETE FROM ${spec.table}
      WHERE ${key} IN (
        SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
        FROM ${spec.table} AS candidate${spec.indexName ? ` INDEXED BY ${spec.indexName}` : ''}
        WHERE candidate.snapshot_key = ?
          ${retirement.predicate}
        ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
        LIMIT ?
      )`,
  };
}

/** @internal Exact indexed cleanup statement retained for query-plan regression tests. */
export function codeGraphCompactLexicalCleanupPageStatement(
  table: CompactLexicalCleanupSpec['table'],
  snapshotKey: number,
  batchRows: number,
): CodeGraphSqlQueryStatement {
  const spec = COMPACT_LEXICAL_CLEANUP_SPECS.find(candidate => candidate.table === table);
  if (spec === undefined) throw new Error(`Unknown compact lexical cleanup table: ${table}`);
  return compactLexicalCleanupPageStatement(spec, snapshotKey, batchRows, Option.none());
}

const clearCompactLexicalSnapshotRows = Effect.fn('codeGraph.clearCompactLexicalSnapshotRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  writerGate?: CodeGraphWriterGate,
  ownerToken?: string,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  const compactRows = yield* sql<CompactLexicalSnapshotKeyRow>`
    SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId} LIMIT 1
  `;
  const compactSnapshotKey = compactRows[0]
    ? yield* validatedCompactLexicalCount(compactRows[0].snapshot_key, 'cleanup snapshot key')
    : undefined;
  for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
    if (compactSnapshotKey === undefined) break;
    let batchRows: number = spec.batchRows;
    for (;;) {
      const startedAt = performance.now();
      const deleted = yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            if (ownerToken !== undefined) yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
            const statement = compactLexicalCleanupPageStatement(spec, compactSnapshotKey, batchRows, Option.none());
            yield* sql.unsafe(statement.text, statement.parameters);
            return yield* lastStatementChangeCount(sql);
          }),
        ),
      );
      if (deleted === 0) break;
      batchRows = nextPersistentActivationBatchRows(
        batchRows,
        Math.max(0, performance.now() - startedAt),
        spec.maximumBatchRows,
      );
      yield* Effect.yieldNow;
    }
  }
  yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        if (ownerToken !== undefined) yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
        yield* sql`DELETE FROM lexical_storage_formats WHERE snapshot_id = ${snapshotId}`;
        yield* sql`DELETE FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId}`;
      }),
    ),
  );
});

const pruneRetiredCompactLexicalRows = Effect.fn('codeGraph.pruneRetiredCompactLexicalRows')(function* (
  sql: SqlClient.SqlClient,
  writerGate: CodeGraphWriterGate,
  snapshotId?: string,
) {
  for (;;) {
    const targets = yield* sql<CompactLexicalSnapshotKeyRow & {readonly snapshot_id: string}>`
      SELECT compact.snapshot_key, compact.snapshot_id
      FROM lexical_compact_snapshots AS compact
      JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
      WHERE snapshot.state = 'retired'
        AND (${snapshotId ?? null} IS NULL OR snapshot.id = ${snapshotId ?? null})
      ORDER BY compact.snapshot_id
      LIMIT 1
    `;
    const target = targets[0];
    if (target === undefined) break;
    const compactSnapshotKey = yield* validatedCompactLexicalCount(target.snapshot_key, 'cleanup snapshot key');
    for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
      let batchRows: number = spec.batchRows;
      for (;;) {
        const startedAt = performance.now();
        const deleted = yield* writerGate(
          sql.withTransaction(
            Effect.gen(function* () {
              const statement = compactLexicalCleanupPageStatement(
                spec,
                compactSnapshotKey,
                batchRows,
                Option.some(target.snapshot_id),
              );
              yield* sql.unsafe(statement.text, statement.parameters);
              return yield* lastStatementChangeCount(sql);
            }),
          ),
        );
        if (deleted === 0) break;
        batchRows = nextPersistentActivationBatchRows(
          batchRows,
          Math.max(0, performance.now() - startedAt),
          spec.maximumBatchRows,
        );
        yield* Effect.yieldNow;
      }
    }
    const metadataDeleted = yield* writerGate(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `DELETE FROM lexical_storage_formats
             WHERE snapshot_id = ?
               AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
            [target.snapshot_id, target.snapshot_id],
          );
          const formatRows = yield* lastStatementChangeCount(sql);
          yield* sql.unsafe(
            `DELETE FROM lexical_compact_snapshots
             WHERE snapshot_key = ? AND snapshot_id = ?
               AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
            [compactSnapshotKey, target.snapshot_id, target.snapshot_id],
          );
          return formatRows + (yield* lastStatementChangeCount(sql));
        }),
      ),
    );
    if (metadataDeleted === 0) {
      // The snapshot stopped being retired between pages. The next selection
      // either chooses another target or observes that cleanup is complete.
      yield* Effect.yieldNow;
    }
  }
});

const purgeSnapshotTerms = Effect.fn('codeGraph.purgeSnapshotTerms')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  // Legacy snapshots retain their original text postings. Compact rows are
  // reclaimed separately in bounded snapshot-key pages before this backstop.
  yield* sql`DELETE FROM symbol_terms WHERE snapshot_id = ${snapshotId}`;
});

interface RetiredSnapshotCleanupSpec {
  readonly batchRows: number;
  readonly keyColumns: readonly string[];
  readonly maximumBatchRows: number;
  readonly table: string;
}

const RETIRED_SNAPSHOT_CLEANUP_SPECS = [
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id', 'tier', 'lookup_key'],
    maximumBatchRows: 20_000,
    table: 'building_reference_candidates',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: LEGACY_BUILDING_REFERENCES_V3_TABLE,
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: 'building_references',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'lookup_key', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_symbol_lookup',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'term', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'symbol_terms',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'edges',
  },
  {
    batchRows: 2_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 5_000,
    table: 'symbols',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'path'],
    maximumBatchRows: 20_000,
    table: 'snapshot_files',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'source_path', 'local_name', 'target_path', 'imported_name'],
    maximumBatchRows: 20_000,
    table: 'snapshot_reexport_provenance',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'source_component_id', 'target_component_id', 'provenance'],
    maximumBatchRows: 20_000,
    table: 'workspace_component_dependencies',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'workspace_components',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'id'],
    maximumBatchRows: 20_000,
    table: 'workspace_scopes',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'symbol_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_symbol_deletions',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'edge_id'],
    maximumBatchRows: 20_000,
    table: 'snapshot_edge_deletions',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'path'],
    maximumBatchRows: 20_000,
    table: 'snapshot_file_deletions',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 20_000,
    table: 'building_materialization_batches',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'batch_index'],
    maximumBatchRows: 20_000,
    table: 'building_analysis_batches',
  },
  {
    batchRows: 1,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1,
    table: 'building_lexical_counters',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'language', 'kind'],
    maximumBatchRows: 20_000,
    table: 'snapshot_analysis_symbol_counts',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'provenance', 'relation', 'confidence', 'endpoint_state'],
    maximumBatchRows: 20_000,
    table: 'snapshot_analysis_edge_histogram',
  },
  {
    batchRows: 5_000,
    keyColumns: ['snapshot_id', 'provenance', 'relation'],
    maximumBatchRows: 20_000,
    table: 'snapshot_analysis_edge_counts',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_analysis_summary_receipts',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_reuse_receipts',
  },
  {
    batchRows: 1_000,
    keyColumns: ['snapshot_id'],
    maximumBatchRows: 1_000,
    table: 'snapshot_extractor_generations',
  },
] as const satisfies readonly RetiredSnapshotCleanupSpec[];

const clearSnapshotOwnedRows = Effect.fn('codeGraph.clearSnapshotOwnedRows')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  writerGate?: CodeGraphWriterGate,
  ownerToken?: string,
) {
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  yield* clearCompactLexicalSnapshotRows(sql, snapshotId, runWrite, ownerToken);
  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    let batchRows: number = spec.batchRows;
    for (;;) {
      const startedAt = performance.now();
      const deleted = yield* runWrite(
        sql.withTransaction(
          Effect.gen(function* () {
            if (ownerToken !== undefined) yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
            const key = `(${spec.keyColumns.join(', ')})`;
            yield* sql.unsafe(
              `DELETE FROM ${spec.table}
             WHERE ${key} IN (
               SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               FROM ${spec.table} AS candidate
               WHERE candidate.snapshot_id = ?
               ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               LIMIT ?
             )`,
              [snapshotId, batchRows],
            );
            const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
            return Number(changes[0]?.count ?? 0);
          }),
        ),
      );
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return yield* Effect.fail(new CodeGraphStoreError('Snapshot reset returned an invalid row count.'));
      }
      if (deleted === 0) break;
      batchRows = nextPersistentActivationBatchRows(
        batchRows,
        Math.max(0, performance.now() - startedAt),
        spec.maximumBatchRows,
      );
      yield* Effect.yieldNow;
    }
  }
});

/**
 * Deep maintenance reclaims retired snapshots in independently committed,
 * adaptive pages. Pointer promotion only marks snapshots retired, so a prior
 * multi-million-row snapshot can never delay or roll back the new pointer.
 */
const pruneRetiredSnapshotRows = Effect.fn('codeGraph.pruneRetiredSnapshotRows')(function* (
  writerGate?: CodeGraphWriterGate,
  snapshotId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  yield* runWrite(initializeSchema(sql));
  yield* drainCompletedPersistentBuildRows(sql, snapshotId, runWrite);
  yield* pruneRetiredCompactLexicalRows(sql, runWrite, snapshotId);
  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (spec.table === LEGACY_BUILDING_REFERENCES_V3_TABLE && !(yield* tableExists(sql, spec.table))) continue;
    let batchRows: number = spec.batchRows;
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
               WHERE candidate.snapshot_id IN (SELECT id FROM snapshots WHERE state = 'retired')
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
        return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid row count.'));
      }
      if (deleted === 0) break;
      batchRows = nextPersistentActivationBatchRows(
        batchRows,
        Math.max(0, performance.now() - startedAt),
        spec.maximumBatchRows,
      );
      yield* Effect.yieldNow;
    }
  }
  for (;;) {
    const removed = yield* runWrite(
      sql.withTransaction(
        Effect.gen(function* () {
          // The bounded table collector above should already have exhausted
          // these rows. Keep the postings-first invariant local to the direct
          // snapshot DELETE as a lifecycle backstop.
          yield* sql.unsafe(
            `
          DELETE FROM symbol_terms
          WHERE snapshot_id IN (
            SELECT id FROM snapshots
            WHERE state = 'retired' AND (? IS NULL OR id = ?)
            ORDER BY id LIMIT 100
          )
        `,
            [snapshotId ?? null, snapshotId ?? null],
          );
          yield* sql.unsafe(
            `
          DELETE FROM snapshots
          WHERE id IN (
            SELECT id FROM snapshots
            WHERE state = 'retired' AND (? IS NULL OR id = ?)
            ORDER BY id LIMIT 100
          )
        `,
            [snapshotId ?? null, snapshotId ?? null],
          );
          const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          return Number(changes[0]?.count ?? 0);
        }),
      ),
    );
    if (!Number.isSafeInteger(removed) || removed < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid count.'));
    }
    if (removed === 0) break;
    yield* Effect.yieldNow;
  }
});

const pruneUnreferencedFileBlobs = Effect.fn('codeGraph.pruneUnreferencedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    DELETE FROM file_blobs
    WHERE NOT EXISTS (
      SELECT 1
      FROM snapshot_files
      WHERE snapshot_files.path = file_blobs.path_hint
        AND snapshot_files.content_hash = file_blobs.content_hash
    )
  `;
});

const pruneCachedFileBlobs = Effect.fn('codeGraph.pruneCachedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
  acceptedExtractorSets?: readonly string[],
) {
  if (acceptedExtractorSets === undefined) {
    yield* pruneUnreferencedFileBlobs(sql);
    return;
  }
  if (acceptedExtractorSets.length === 0) {
    return yield* Effect.fail(new CodeGraphStoreError('At least one active extractor cache is required.'));
  }
  yield* sql.unsafe(
    `DELETE FROM file_blobs
     WHERE extractor_set NOT IN (${acceptedExtractorSets.map(() => '?').join(', ')})
        OR NOT EXISTS (
          SELECT 1
          FROM snapshot_files
          WHERE snapshot_files.path = file_blobs.path_hint
            AND snapshot_files.content_hash = file_blobs.content_hash
        )`,
    acceptedExtractorSets,
  );
});

const selectReadySnapshot = Effect.fn('codeGraph.selectReadySnapshot')(function* (worktreeId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'active_snapshots')) || !(yield* tableExists(sql, 'snapshots'))) return undefined;
  const rows = yield* sql<SnapshotRow>`
    SELECT snapshots.*
    FROM active_snapshots
    JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
    WHERE active_snapshots.worktree_id = ${worktreeId}
      AND snapshots.state = 'ready'
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotById = Effect.fn('codeGraph.selectReadySnapshotById')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots'))) return undefined;
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectCurrentLexicalReadySnapshotById = Effect.fn('codeGraph.selectCurrentLexicalReadySnapshotById')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'lexical_storage_formats'))) {
    return undefined;
  }
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots
    WHERE id = ${snapshotId} AND state = 'ready'
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = snapshots.id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotForCommit = Effect.fn('codeGraph.selectReadySnapshotForCommit')(function* (
  repositoryId: string,
  commit: string,
  extractorSet?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots'))) return undefined;
  const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE repository_id = ${repositoryId}
      AND commit_id = ${commit}
      AND dirty = 0
      AND (${extractorSet ?? null} IS NULL OR extractor_set = ${extractorSet ?? null})
      AND state = 'ready'
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = snapshots.id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
    ORDER BY completed_at DESC, id
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReusableBaseReceipt = Effect.fn('codeGraph.selectReusableBaseReceipt')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<{
    readonly alias_count: number;
    readonly file_set_fingerprint: string;
    readonly format_version: number;
    readonly lookup_count: number;
    readonly reexport_count: number;
    readonly resolution_surface_version: number;
    readonly snapshot_id: string;
    readonly workspace_fingerprint: string;
  }>`
    SELECT receipt.*
    FROM snapshot_reuse_receipts AS receipt
    JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
    WHERE receipt.snapshot_id = ${snapshotId}
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = 1
      AND receipt.extractor_set = snapshot.extractor_set
      AND snapshot.state = 'ready'
      AND snapshot.dirty = 0
      AND snapshot.base_snapshot_id IS NULL
      AND EXISTS (
        SELECT 1 FROM lexical_storage_formats AS lexical
        WHERE lexical.snapshot_id = receipt.snapshot_id
          AND lexical.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
      )
      AND (
        receipt.lookup_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE lookup.snapshot_id = receipt.snapshot_id
        )
      )
      AND (
        receipt.alias_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE lookup.snapshot_id = receipt.snapshot_id AND lookup.provenance = 'alias'
        )
      )
      AND (
        receipt.reexport_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_reexport_provenance AS provenance
          WHERE provenance.snapshot_id = receipt.snapshot_id
        )
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const lookupCount = Number(row.lookup_count);
  const aliasCount = Number(row.alias_count);
  const reexportCount = Number(row.reexport_count);
  // Receipt rows and their lookup/provenance rows are committed in one SQLite
  // transaction. Avoid recounting the repository-wide lookup tables on every
  // one-file overlay; integrity checks belong to doctor/repair, not the hot path.
  if (
    !Number.isSafeInteger(lookupCount) ||
    lookupCount < 0 ||
    !Number.isSafeInteger(aliasCount) ||
    aliasCount < 0 ||
    aliasCount > lookupCount ||
    !Number.isSafeInteger(reexportCount) ||
    reexportCount < 0
  ) {
    return undefined;
  }
  return {
    aliasCount,
    fileSetFingerprint: row.file_set_fingerprint,
    formatVersion: Number(row.format_version),
    lookupCount,
    reexportCount,
    resolutionSurfaceVersion: Number(row.resolution_surface_version),
    snapshotId: row.snapshot_id,
    workspaceFingerprint: row.workspace_fingerprint,
  } satisfies CodeGraphReusableBaseReceipt;
});

const selectReusableReexports = Effect.fn('codeGraph.selectReusableReexports')(function* (
  snapshotId: string,
  seeds: readonly CodeGraphReusableReexportSeed[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* selectReusableBaseReceipt(snapshotId))) return undefined;
  const uniqueSeeds = uniqueBy(seeds, seed => `${seed.path}\0${seed.name}`);
  if (uniqueSeeds.length === 0) return [];
  const output = new Map<string, CodeGraphReusableReexport>();
  for (const batch of chunk(uniqueSeeds, 200)) {
    const rows = yield* sql.unsafe<{
      readonly imported_name: string;
      readonly local_name: string;
      readonly source_path: string;
      readonly target_path: string;
    }>(
      `WITH RECURSIVE
       requested(path, name) AS (VALUES ${batch.map(() => '(?, ?)').join(', ')}),
       closure(source_path, local_name, target_path, imported_name) AS (
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM snapshot_reexport_provenance AS provenance
         JOIN requested
           ON requested.path = provenance.source_path AND requested.name = provenance.local_name
         WHERE provenance.snapshot_id = ?
         UNION
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM snapshot_reexport_provenance AS provenance
         JOIN closure
           ON closure.target_path = provenance.source_path
          AND closure.imported_name = provenance.local_name
         WHERE provenance.snapshot_id = ?
       )
       SELECT source_path, local_name, target_path, imported_name
       FROM closure
       ORDER BY source_path, local_name, target_path, imported_name`,
      [...batch.flatMap(seed => [seed.path, seed.name]), snapshotId, snapshotId],
    );
    for (const row of rows) {
      const value = {
        importedName: row.imported_name,
        localName: row.local_name,
        sourcePath: row.source_path,
        targetPath: row.target_path,
      } satisfies CodeGraphReusableReexport;
      output.set(`${value.sourcePath}\0${value.localName}\0${value.targetPath}\0${value.importedName}`, value);
    }
  }
  return [...output.values()].sort((left, right) =>
    compareCodeUnits(
      `${left.sourcePath}\0${left.localName}\0${left.targetPath}\0${left.importedName}`,
      `${right.sourcePath}\0${right.localName}\0${right.targetPath}\0${right.importedName}`,
    ),
  );
});

const selectCachedFacts = Effect.fn('codeGraph.selectCachedFacts')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
  decode: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const output = new Map<string, CodeGraphFileFacts>();
  const bytesByPath = new Map<string, number>();
  const keys = new Set<string>();
  let bytes = 0;
  for (const batch of chunk(files, 300)) {
    if (!decode) {
      const rows = yield* selectFileBlobMetadataBatch(sql, batch, extractorSet);
      for (const row of rows) {
        keys.add(row.path_hint);
        const factBytes = Number(row.facts_bytes);
        bytes += factBytes;
        bytesByPath.set(row.path_hint, factBytes);
      }
      continue;
    }
    const rows = yield* selectFileBlobBatch(sql, batch, extractorSet);
    for (const row of rows) {
      try {
        output.set(row.path_hint, JSON.parse(row.facts_json) as CodeGraphFileFacts);
        keys.add(row.path_hint);
        const factBytes = Number(row.facts_bytes);
        bytes += factBytes;
        bytesByPath.set(row.path_hint, factBytes);
      } catch {
        // A malformed cache row is disposable and will be replaced after extraction.
      }
    }
  }
  return {bytes, bytesByPath, facts: output, keys} satisfies LoadedCodeGraphFacts;
});

function selectFileBlobMetadataBatch(
  sql: SqlClient.SqlClient,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  if (files.length === 0) {
    return Effect.succeed([] as readonly {readonly facts_bytes: number; readonly path_hint: string}[]);
  }
  return sql.unsafe<{readonly facts_bytes: number; readonly path_hint: string}>(
    `SELECT path_hint, length(CAST(facts_json AS BLOB)) AS facts_bytes
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${files.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
    [extractorSet, ...files.flatMap(file => [file.contentHash, file.path])],
  );
}

function selectFileBlobBatch(
  sql: SqlClient.SqlClient,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  if (files.length === 0) {
    return Effect.succeed([] as readonly (FileBlobRow & {readonly facts_bytes: number; readonly path_hint: string})[]);
  }
  return sql.unsafe<FileBlobRow & {readonly facts_bytes: number; readonly path_hint: string}>(
    `SELECT content_hash, path_hint, facts_json, length(CAST(facts_json AS BLOB)) AS facts_bytes
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${files.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
    [extractorSet, ...files.flatMap(file => [file.contentHash, file.path])],
  );
}

const selectCachedCommittedFileKeys = Effect.fn('codeGraph.selectCachedCommittedFileKeys')(function* (
  extractorSet: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<{readonly content_hash: string; readonly path_hint: string}>`
    SELECT content_hash, path_hint
    FROM file_blobs
    WHERE extractor_set = ${extractorSet}
      AND json_valid(facts_json)
  `;
  return new Set(rows.map(row => `${row.path_hint}\0${row.content_hash}\0${extractorSet}`));
});

const selectStoredGraph = Effect.fn('codeGraph.selectStoredGraph')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const snapshots = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready'
  `;
  const snapshot = snapshots[0];
  if (!snapshot) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(snapshot.base_snapshot_id));
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId),
      selectAllEffectiveEdges(sql, snapshotId, baseSnapshotId),
    ],
    {concurrency: 1},
  );
  return {
    edges: edgeRows.map(edgeFromRow),
    snapshot: snapshotFromRow(snapshot),
    symbols: symbolRows.map(symbolFromRow),
  } satisfies StoredCodeGraph;
});

const selectStoredSymbols = Effect.fn('codeGraph.selectStoredSymbols')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return (yield* selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId)).map(symbolFromRow);
});

function effectiveSymbolsCte(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  )`;
}

function effectiveEdgesCte(): string {
  return `WITH effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphCtes(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  ), effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  ];
}

function effectiveSnapshotParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId];
}

const selectBaseSnapshotId = Effect.fn('codeGraph.selectBaseSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{readonly base_snapshot_id: unknown}>`
    SELECT base_snapshot_id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  if (!rows[0]) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  return Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
});

function selectAllEffectiveSymbols(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT * FROM effective_symbols
     ORDER BY path, qualified_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

function selectAllEffectiveEdges(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<EdgeRow>(
    `${effectiveEdgesCte()}
     SELECT * FROM effective_edges
     ORDER BY source_name, relation, target_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

const selectSymbolPage = Effect.fn('codeGraph.selectSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.path,
          cursor.qualifiedName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

interface AnalysisSymbolAggregateRow {
  readonly count: number;
  readonly kind: string;
  readonly language: string;
  readonly last_id: string;
}

interface PersistedAnalysisSymbolRow {
  readonly count: number;
  readonly kind: string;
  readonly language: string;
}

interface PersistedAnalysisEdgeRow {
  readonly confidence_high: number;
  readonly confidence_invalid: number;
  readonly confidence_low: number;
  readonly confidence_medium: number;
  readonly confidence_total: number;
  readonly count: number;
  readonly lowest_confidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly review_finding_count: number;
  readonly self_loop_count: number;
  readonly unresolved_endpoint_count: number;
}

const selectAnalysisSummary = Effect.fn('codeGraph.selectAnalysisSummary')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const tables = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'snapshot_analysis_summary_receipts'
  `;
  if (Number(tables[0]?.count ?? 0) !== 1) return Option.none<CodeGraphAnalysisSummary>();
  const receipts = yield* sql<{
    readonly digest: string;
    readonly edge_count: number;
    readonly expected_edge_count: number;
    readonly expected_symbol_count: number;
    readonly symbol_count: number;
    readonly version: number;
  }>`
    SELECT receipt.digest, receipt.edge_count, receipt.symbol_count, receipt.version,
      snapshot.edge_count AS expected_edge_count, snapshot.symbol_count AS expected_symbol_count
    FROM snapshot_analysis_summary_receipts AS receipt
    JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
    WHERE receipt.snapshot_id = ${snapshotId} AND snapshot.state = 'ready'
    LIMIT 1
  `;
  const receipt = receipts[0];
  if (!receipt || Number(receipt.version) !== 1) return Option.none<CodeGraphAnalysisSummary>();
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      sql<PersistedAnalysisSymbolRow>`
        SELECT language, kind, count
        FROM snapshot_analysis_symbol_counts
        WHERE snapshot_id = ${snapshotId}
        ORDER BY language, kind
      `,
      sql<PersistedAnalysisEdgeRow>`
        SELECT provenance, relation, count, confidence_invalid, confidence_total,
          lowest_confidence, confidence_high, confidence_medium, confidence_low,
          unresolved_endpoint_count, self_loop_count, review_finding_count
        FROM snapshot_analysis_edge_counts
        WHERE snapshot_id = ${snapshotId}
        ORDER BY provenance, relation
      `,
    ],
    {concurrency: 1},
  );
  const symbols = symbolRows.map(analysisSymbolAggregateFromRow);
  const edges = edgeRows.map(analysisEdgeAggregateFromRow);
  const symbolCount = symbols.reduce((total, row) => total + row.count, 0);
  const edgeCount = edges.reduce((total, row) => total + row.count, 0);
  const summary = {
    digest: receipt.digest,
    edgeCount,
    edges,
    symbolCount,
    symbols,
    version: 1,
  } satisfies CodeGraphAnalysisSummary;
  if (
    symbolCount !== Number(receipt.symbol_count) ||
    edgeCount !== Number(receipt.edge_count) ||
    symbolCount !== Number(receipt.expected_symbol_count) ||
    edgeCount !== Number(receipt.expected_edge_count) ||
    codeGraphAnalysisSummaryDigest(symbols, edges) !== receipt.digest
  ) {
    return Option.none<CodeGraphAnalysisSummary>();
  }
  return Option.some(summary);
});

function analysisSymbolAggregateFromRow(row: PersistedAnalysisSymbolRow): CodeGraphAnalysisSymbolAggregate {
  return {count: Number(row.count), kind: row.kind, language: row.language};
}

function analysisEdgeAggregateFromRow(row: PersistedAnalysisEdgeRow): CodeGraphAnalysisEdgeAggregate {
  return {
    confidenceHigh: Number(row.confidence_high),
    confidenceInvalid: Number(row.confidence_invalid),
    confidenceLow: Number(row.confidence_low),
    confidenceMedium: Number(row.confidence_medium),
    confidenceTotal: Number(row.confidence_total),
    count: Number(row.count),
    lowestConfidence: Number(row.lowest_confidence),
    provenance: row.provenance,
    relation: row.relation,
    reviewFindingCount: Number(row.review_finding_count),
    selfLoopCount: Number(row.self_loop_count),
    unresolvedEndpointCount: Number(row.unresolved_endpoint_count),
  };
}

export function codeGraphAnalysisSummaryDigest(
  symbols: readonly CodeGraphAnalysisSymbolAggregate[],
  edges: readonly CodeGraphAnalysisEdgeAggregate[],
): string {
  return sha256HexSync(
    JSON.stringify({
      edges: [...edges].sort(
        (left, right) =>
          compareCodeUnits(left.provenance, right.provenance) || compareCodeUnits(left.relation, right.relation),
      ),
      symbols: [...symbols].sort(
        (left, right) => compareCodeUnits(left.language, right.language) || compareCodeUnits(left.kind, right.kind),
      ),
      version: 1,
    }),
  );
}

const selectAnalysisSymbolAggregatePage = Effect.fn('codeGraph.selectAnalysisSymbolAggregatePage')(function* (
  snapshotId: string,
  cursorId: string | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphAnalysisSymbolAggregatePageStatement(snapshotId, baseSnapshotId, cursorId, limit);
  const rows = yield* sql.unsafe<AnalysisSymbolAggregateRow>(statement.text, statement.parameters);
  const counts = rows.map(row => ({
    count: Number(row.count),
    kind: row.kind,
    language: row.language,
  }));
  const rowCount = counts.reduce((total, row) => total + row.count, 0);
  const lastId = rows.reduce<string | undefined>(
    (current, row) => (current === undefined || compareCodeUnits(current, row.last_id) < 0 ? row.last_id : current),
    undefined,
  );
  return {
    counts,
    ...(lastId === undefined ? {} : {lastId}),
    rows: rowCount,
  } satisfies CodeGraphAnalysisSymbolAggregatePage;
});

/**
 * Build one ID-keyset aggregate page. Overlay cursor predicates live inside
 * both current/base branches so every page performs two primary-key seeks
 * instead of rematerializing the whole effective snapshot.
 */
export function codeGraphAnalysisSymbolAggregatePageStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  cursorId: string | undefined,
  limit: number,
): CodeGraphSqlQueryStatement {
  const cursor = cursorId ?? '';
  const page =
    baseSnapshotId === undefined
      ? `SELECT id, language, kind
         FROM symbols
         WHERE snapshot_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`
      : `SELECT id, language, kind
         FROM (
           SELECT current_symbols.id, current_symbols.language, current_symbols.kind
           FROM symbols AS current_symbols
           WHERE current_symbols.snapshot_id = ? AND current_symbols.id > ?
           UNION ALL
           SELECT base_symbols.id, base_symbols.language, base_symbols.kind
           FROM symbols AS base_symbols
           WHERE base_symbols.snapshot_id = ? AND base_symbols.id > ?
             AND NOT EXISTS (
               SELECT 1 FROM symbols AS overrides
               WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM snapshot_symbol_deletions AS deletions
               WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
             )
         )
         ORDER BY id
         LIMIT ?`;
  return {
    parameters:
      baseSnapshotId === undefined
        ? [snapshotId, cursor, boundedAggregatePageLimit(limit)]
        : [snapshotId, cursor, baseSnapshotId, cursor, snapshotId, snapshotId, boundedAggregatePageLimit(limit)],
    text: `WITH page AS (${page})
      SELECT language, kind, COUNT(*) AS count, MAX(id) AS last_id
      FROM page
      GROUP BY language, kind
      ORDER BY language, kind`,
  };
}

interface AnalysisEdgeAggregateRow {
  readonly confidence_high: number;
  readonly confidence_invalid: number;
  readonly confidence_low: number;
  readonly confidence_medium: number;
  readonly confidence_total: number;
  readonly count: number;
  readonly last_id: string;
  readonly lowest_confidence: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly review_finding_count: number;
  readonly self_loop_count: number;
  readonly unresolved_endpoint_count: number;
}

const ANALYSIS_EDGE_AGGREGATE_SELECT = `
  SELECT
    provenance,
    relation,
    COUNT(*) AS count,
    SUM(CASE WHEN confidence < 0 OR confidence > 1 THEN 1 ELSE 0 END) AS confidence_invalid,
    SUM(CASE WHEN confidence < 0 THEN 0 WHEN confidence > 1 THEN 1 ELSE confidence END) AS confidence_total,
    MIN(CASE WHEN confidence < 0 THEN 0 WHEN confidence > 1 THEN 1 ELSE confidence END) AS lowest_confidence,
    SUM(CASE WHEN confidence >= 0.9 THEN 1 ELSE 0 END) AS confidence_high,
    SUM(CASE WHEN confidence >= 0.6 AND confidence < 0.9 THEN 1 ELSE 0 END) AS confidence_medium,
    SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) AS confidence_low,
    SUM(CASE WHEN source_id IS NULL OR target_id IS NULL THEN 1 ELSE 0 END) AS unresolved_endpoint_count,
    SUM(
      CASE WHEN source_id IS NOT NULL AND target_id IS NOT NULL AND source_id = target_id THEN 1 ELSE 0 END
    ) AS self_loop_count,
    SUM(
      CASE
        WHEN confidence < 0 OR confidence > 1 THEN 1
        WHEN confidence < CASE provenance
          WHEN 'declared' THEN 0.9
          WHEN 'resolved' THEN 0.9
          WHEN 'syntactic' THEN 0.7
          WHEN 'heuristic' THEN 0.45
          WHEN 'model' THEN 0.35
        END THEN 1
        ELSE 0
      END
    ) AS review_finding_count,
    MAX(id) AS last_id
  FROM page
  GROUP BY provenance, relation
  ORDER BY provenance, relation`;

const selectAnalysisEdgeAggregatePage = Effect.fn('codeGraph.selectAnalysisEdgeAggregatePage')(function* (
  snapshotId: string,
  cursorId: string | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphAnalysisEdgeAggregatePageStatement(snapshotId, baseSnapshotId, cursorId, limit);
  const rows = yield* sql.unsafe<AnalysisEdgeAggregateRow>(statement.text, statement.parameters);
  const counts = rows.map(row => ({
    confidenceHigh: Number(row.confidence_high),
    confidenceInvalid: Number(row.confidence_invalid),
    confidenceLow: Number(row.confidence_low),
    confidenceMedium: Number(row.confidence_medium),
    confidenceTotal: Number(row.confidence_total),
    count: Number(row.count),
    lowestConfidence: Number(row.lowest_confidence),
    provenance: row.provenance,
    relation: row.relation,
    reviewFindingCount: Number(row.review_finding_count),
    selfLoopCount: Number(row.self_loop_count),
    unresolvedEndpointCount: Number(row.unresolved_endpoint_count),
  }));
  const rowCount = counts.reduce((total, row) => total + row.count, 0);
  const lastId = rows.reduce<string | undefined>(
    (current, row) => (current === undefined || compareCodeUnits(current, row.last_id) < 0 ? row.last_id : current),
    undefined,
  );
  return {
    counts,
    ...(lastId === undefined ? {} : {lastId}),
    rows: rowCount,
  } satisfies CodeGraphAnalysisEdgeAggregatePage;
});

/** Edge counterpart of codeGraphAnalysisSymbolAggregatePageStatement. */
export function codeGraphAnalysisEdgeAggregatePageStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  cursorId: string | undefined,
  limit: number,
): CodeGraphSqlQueryStatement {
  const cursor = cursorId ?? '';
  const page =
    baseSnapshotId === undefined
      ? `SELECT id, provenance, relation, confidence, source_id, target_id
         FROM edges
         WHERE snapshot_id = ? AND id > ?
         ORDER BY id
         LIMIT ?`
      : `SELECT id, provenance, relation, confidence, source_id, target_id
         FROM (
           SELECT current_edges.id, current_edges.provenance, current_edges.relation,
             current_edges.confidence, current_edges.source_id, current_edges.target_id
           FROM edges AS current_edges
           WHERE current_edges.snapshot_id = ? AND current_edges.id > ?
           UNION ALL
           SELECT base_edges.id, base_edges.provenance, base_edges.relation,
             base_edges.confidence, base_edges.source_id, base_edges.target_id
           FROM edges AS base_edges
           WHERE base_edges.snapshot_id = ? AND base_edges.id > ?
             AND NOT EXISTS (
               SELECT 1 FROM edges AS overrides
               WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM snapshot_edge_deletions AS deletions
               WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
             )
         )
         ORDER BY id
         LIMIT ?`;
  return {
    parameters:
      baseSnapshotId === undefined
        ? [snapshotId, cursor, boundedAggregatePageLimit(limit)]
        : [snapshotId, cursor, baseSnapshotId, cursor, snapshotId, snapshotId, boundedAggregatePageLimit(limit)],
    text: `WITH page AS (${page}) ${ANALYSIS_EDGE_AGGREGATE_SELECT}`,
  };
}

const EMBEDDING_SYMBOL_KINDS = [
  'class',
  'document',
  'function',
  'heading',
  'interface',
  'method',
  'module',
  'package',
  'type',
] as const;

const selectEmbeddingSymbolCount = Effect.fn('codeGraph.selectEmbeddingSymbolCount')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<{readonly count: number}>(
    `${effectiveSymbolsCte()}
     SELECT COUNT(*) AS count
     FROM effective_symbols
     WHERE exported = 1 OR kind IN (${EMBEDDING_SYMBOL_KINDS.map(() => '?').join(', ')})`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...EMBEDDING_SYMBOL_KINDS],
  );
  return Number(rows[0]?.count ?? 0);
});

const selectEmbeddingSymbolPage = Effect.fn('codeGraph.selectEmbeddingSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const eligibility = `exported = 1 OR kind IN (${EMBEDDING_SYMBOL_KINDS.map(() => '?').join(', ')})`;
  const parameters = [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...EMBEDDING_SYMBOL_KINDS];
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (${eligibility})
           AND (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...parameters, cursor.path, cursor.qualifiedName, cursor.id, boundedPageLimit(limit)],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE ${eligibility}
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...parameters, boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

const selectVisualizationCatalog = Effect.fn('codeGraph.selectVisualizationCatalog')(function* (
  viewWorktreeId?: string,
  metrics: 'complete' | 'deferred' = 'complete',
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow & {readonly activated_at: unknown; readonly display_name: string}>`
    SELECT snapshots.*, repositories.display_name, active_snapshots.activated_at
     FROM snapshots
     JOIN repositories ON repositories.id = snapshots.repository_id
     LEFT JOIN active_snapshots ON active_snapshots.snapshot_id = snapshots.id
     WHERE snapshots.state = 'ready'
       AND (
         ${viewWorktreeId ?? null} IS NULL
         OR active_snapshots.worktree_id = ${viewWorktreeId ?? null}
         OR (active_snapshots.worktree_id IS NULL AND snapshots.worktree_id = ${viewWorktreeId ?? null})
       )
     ORDER BY
       CASE WHEN active_snapshots.snapshot_id IS NULL THEN 1 ELSE 0 END,
       active_snapshots.activated_at DESC,
       snapshots.completed_at DESC,
       snapshots.id
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(row.base_snapshot_id));
  const activatedAt = Option.getOrUndefined(sqlTextOption(row.activated_at));
  const hasWorkspaceCatalog =
    (yield* tableExists(sql, 'workspace_components')) &&
    Number(
      (yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${row.id}
        `)[0]?.count ?? 0,
    ) > 0;
  if (metrics === 'deferred') {
    if (hasWorkspaceCatalog) {
      const [workspaces, components, dependencies] = yield* Effect.all(
        [
          sql<{
            readonly build_system: CodeGraphWorkspaceBuildSystem;
            readonly id: string;
            readonly name: string;
            readonly provenance: CodeGraphWorkspaceProvenance;
            readonly root: string;
          }>`
            SELECT id, build_system, name, root, provenance
            FROM workspace_scopes
            WHERE snapshot_id = ${row.id}
            ORDER BY root, id
          `,
          sql<{
            readonly build_system: CodeGraphWorkspaceBuildSystem;
            readonly id: string;
            readonly kind: CodeGraphWorkspaceComponentKind;
            readonly name: string;
            readonly provenance: CodeGraphWorkspaceProvenance;
            readonly workspace_id: string;
          }>`
            SELECT id, workspace_id, build_system, kind, name, provenance
            FROM workspace_components
            WHERE snapshot_id = ${row.id}
            ORDER BY name, root, id
          `,
          sql<{
            readonly evidence: unknown;
            readonly provenance: CodeGraphWorkspaceProvenance;
            readonly source_component_id: string;
            readonly target_component_id: string;
          }>`
            SELECT source_component_id, target_component_id, provenance, evidence
            FROM workspace_component_dependencies
            WHERE snapshot_id = ${row.id}
            ORDER BY source_component_id, target_component_id, provenance
          `,
        ],
        {concurrency: 1},
      );
      const dependenciesBySource = new Map<string, Array<(typeof dependencies)[number]>>();
      for (const dependency of dependencies) {
        const current = dependenciesBySource.get(dependency.source_component_id);
        if (current) current.push(dependency);
        else dependenciesBySource.set(dependency.source_component_id, [dependency]);
      }
      const projects: CodeGraphVisualizationProject[] = components.map(component => ({
        buildSystem: component.build_system,
        dependencies: (dependenciesBySource.get(component.id) ?? []).map(dependency => ({
          ...(typeof dependency.evidence === 'string' ? {evidence: dependency.evidence} : {}),
          provenance: dependency.provenance,
          targetId: dependency.target_component_id,
        })),
        diagnostics: [],
        fileCount: 0,
        id: component.id,
        kind: component.kind,
        label: component.name,
        languages: [],
        model: 'component',
        provenance: component.provenance,
        sourceRoots: [],
        symbolCount: 0,
        workspaceId: component.workspace_id,
        workspaceRoots: [],
      }));
      projects.push({
        dependencies: [],
        diagnostics: [],
        fileCount: 0,
        id: 'facet:unscoped',
        kind: 'legacy-group',
        label: 'Unscoped code and documentation',
        languages: [],
        model: 'facet',
        provenance: 'inferred',
        sourceRoots: [],
        symbolCount: 0,
        workspaceRoots: [],
      });
      return {
        accounting: {
          attributedSymbols: 0,
          componentSymbols: 0,
          fallbackSymbols: 0,
          omittedSymbols: Number(row.symbol_count),
          totalSymbols: Number(row.symbol_count),
        },
        ...(activatedAt ? {activatedAt} : {}),
        metrics: 'deferred',
        model: 'workspace',
        projects,
        repository: {displayName: row.display_name, repositoryId: row.repository_id},
        snapshot: snapshotFromRow(row),
        viewWorktreeId: viewWorktreeId ?? row.worktree_id,
        workspaces: workspaces.map(workspace => ({
          buildSystem: workspace.build_system,
          diagnostics: [],
          id: workspace.id,
          name: workspace.name,
          provenance: workspace.provenance,
          root: workspace.root,
        })),
      } satisfies CodeGraphVisualizationCatalog;
    }
    return {
      accounting: {
        attributedSymbols: Number(row.symbol_count),
        componentSymbols: 0,
        fallbackSymbols: Number(row.symbol_count),
        omittedSymbols: 0,
        totalSymbols: Number(row.symbol_count),
      },
      ...(activatedAt ? {activatedAt} : {}),
      metrics: 'deferred',
      model: 'legacy-fallback',
      projects: [
        {
          dependencies: [],
          diagnostics: [],
          fileCount: Number(row.file_count),
          id: 'facet:repository',
          kind: 'legacy-group',
          label: 'Repository symbols',
          languages: [],
          model: 'legacy-fallback',
          provenance: 'legacy',
          sourceRoots: [],
          symbolCount: Number(row.symbol_count),
          workspaceRoots: [],
        },
      ],
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: viewWorktreeId ?? row.worktree_id,
      workspaces: [],
    } satisfies CodeGraphVisualizationCatalog;
  }
  if (hasWorkspaceCatalog) {
    const [workspaces, components, unscopedGroups, dependencies] = yield* Effect.all(
      [
        sql<{
          readonly build_system: CodeGraphWorkspaceBuildSystem;
          readonly diagnostics_json: string;
          readonly id: string;
          readonly name: string;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly root: string;
        }>`
          SELECT id, build_system, name, root, provenance, diagnostics_json
          FROM workspace_scopes
          WHERE snapshot_id = ${row.id}
          ORDER BY root, id
        `,
        sql.unsafe<{
          readonly build_system: CodeGraphWorkspaceBuildSystem;
          readonly diagnostics_json: string;
          readonly file_count: number;
          readonly id: string;
          readonly kind: CodeGraphWorkspaceComponentKind;
          readonly languages_json: string;
          readonly name: string;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly resolution_domain: string;
          readonly root: string;
          readonly source_roots_json: string;
          readonly symbol_count: number;
          readonly workspace_id: string;
          readonly workspace_roots_json: string;
        }>(
          `${effectiveSymbolsCte()}
           SELECT component.id, component.workspace_id, component.build_system, component.kind,
             component.name, component.root, component.resolution_domain, component.languages_json,
             component.source_roots_json, component.workspace_roots_json, component.provenance,
             component.diagnostics_json,
             COUNT(symbol.id) AS symbol_count, COUNT(DISTINCT symbol.path) AS file_count
           FROM workspace_components AS component
           LEFT JOIN effective_symbols AS symbol ON symbol.resolution_scope_id = component.id
           WHERE component.snapshot_id = ?
           GROUP BY component.id, component.workspace_id, component.build_system, component.kind,
             component.name, component.root, component.resolution_domain, component.languages_json,
             component.source_roots_json, component.workspace_roots_json, component.provenance,
             component.diagnostics_json
           ORDER BY component.name, component.root, component.id`,
          [...effectiveSnapshotParameters(row.id, baseSnapshotId), row.id],
        ),
        sql.unsafe<{
          readonly file_count: number;
          readonly languages: string;
          readonly scope_type: 'documentation' | 'package' | 'path';
          readonly scope_value: string;
          readonly symbol_count: number;
        }>(
          `${effectiveSymbolsCte()}
           SELECT
             CASE
               WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'documentation'
               WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package'
               ELSE 'path'
             END AS scope_type,
             CASE
               WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'unscoped-documentation'
               WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN package_name
               WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
               ELSE '(root)'
             END AS scope_value,
             GROUP_CONCAT(DISTINCT language) AS languages,
             COUNT(*) AS symbol_count,
             COUNT(DISTINCT path) AS file_count
           FROM effective_symbols
           WHERE resolution_scope_id IS NULL
           GROUP BY 1, 2
           ORDER BY symbol_count DESC, scope_type, scope_value`,
          effectiveSnapshotParameters(row.id, baseSnapshotId),
        ),
        sql<{
          readonly evidence: unknown;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly source_component_id: string;
          readonly target_component_id: string;
        }>`
          SELECT source_component_id, target_component_id, provenance, evidence
          FROM workspace_component_dependencies
          WHERE snapshot_id = ${row.id}
          ORDER BY source_component_id, target_component_id, provenance
        `,
      ],
      {concurrency: 1},
    );
    const dependenciesBySource = new Map<string, Array<(typeof dependencies)[number]>>();
    for (const dependency of dependencies) {
      const current = dependenciesBySource.get(dependency.source_component_id);
      if (current) current.push(dependency);
      else dependenciesBySource.set(dependency.source_component_id, [dependency]);
    }
    const projects: CodeGraphVisualizationProject[] = components.map(component => ({
      buildSystem: component.build_system,
      dependencies: (dependenciesBySource.get(component.id) ?? []).map(dependency => ({
        ...(typeof dependency.evidence === 'string' ? {evidence: dependency.evidence} : {}),
        provenance: dependency.provenance,
        targetId: dependency.target_component_id,
      })),
      diagnostics: parseStringArray(component.diagnostics_json),
      fileCount: Number(component.file_count),
      id: component.id,
      kind: component.kind,
      label: component.name,
      languages: parseStringArray(component.languages_json),
      model: 'component',
      provenance: component.provenance,
      resolutionDomain: component.resolution_domain,
      root: component.root,
      sourceRoots: parseStringArray(component.source_roots_json),
      symbolCount: Number(component.symbol_count),
      workspaceId: component.workspace_id,
      workspaceRoots: parseStringArray(component.workspace_roots_json),
    }));
    projects.push(
      ...unscopedGroups.map(group => ({
        dependencies: [],
        diagnostics: [],
        fileCount: Number(group.file_count),
        id:
          group.scope_type === 'documentation'
            ? 'facet:unscoped-documentation'
            : `${group.scope_type}:${group.scope_value}`,
        kind: group.scope_type === 'documentation' ? ('documentation' as const) : ('legacy-group' as const),
        label: group.scope_type === 'documentation' ? 'Unscoped documentation' : group.scope_value,
        languages: group.languages ? group.languages.split(',').sort(compareCodeUnits) : [],
        model: 'facet' as const,
        provenance: 'inferred' as const,
        sourceRoots: [],
        symbolCount: Number(group.symbol_count),
        workspaceRoots: [],
      })),
    );
    const componentSymbols = components.reduce((total, component) => total + Number(component.symbol_count), 0);
    const fallbackSymbols = unscopedGroups.reduce((total, group) => total + Number(group.symbol_count), 0);
    const totalSymbols = Number(row.symbol_count);
    const attributedSymbols = componentSymbols + fallbackSymbols;
    return {
      accounting: {
        attributedSymbols,
        componentSymbols,
        fallbackSymbols,
        omittedSymbols: Math.max(0, totalSymbols - attributedSymbols),
        totalSymbols,
      },
      ...(activatedAt ? {activatedAt} : {}),
      metrics: 'complete',
      model: 'workspace',
      projects,
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: viewWorktreeId ?? row.worktree_id,
      workspaces: workspaces.map(workspace => ({
        buildSystem: workspace.build_system,
        diagnostics: parseStringArray(workspace.diagnostics_json),
        id: workspace.id,
        name: workspace.name,
        provenance: workspace.provenance,
        root: workspace.root,
      })),
    } satisfies CodeGraphVisualizationCatalog;
  }
  const projects = yield* sql.unsafe<{
    readonly file_count: number;
    readonly scope_type: 'package' | 'path';
    readonly scope_value: string;
    readonly symbol_count: number;
  }>(
    `${effectiveSymbolsCte()}
     SELECT
       CASE
         WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package'
         ELSE 'path'
       END AS scope_type,
       CASE
         WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN package_name
         WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
         ELSE '(root)'
       END AS scope_value,
       COUNT(*) AS symbol_count,
       COUNT(DISTINCT path) AS file_count
     FROM effective_symbols
     GROUP BY 1, 2
     ORDER BY symbol_count DESC, scope_value`,
    effectiveSnapshotParameters(row.id, baseSnapshotId),
  );
  return {
    accounting: {
      attributedSymbols: Number(row.symbol_count),
      componentSymbols: 0,
      fallbackSymbols: Number(row.symbol_count),
      omittedSymbols: 0,
      totalSymbols: Number(row.symbol_count),
    },
    projects: projects.map(project => ({
      dependencies: [],
      diagnostics: [],
      fileCount: Number(project.file_count),
      id: `${project.scope_type}:${project.scope_value}`,
      kind: 'legacy-group',
      label: project.scope_value,
      languages: [],
      model: 'legacy-fallback',
      provenance: 'legacy',
      sourceRoots: [],
      symbolCount: Number(project.symbol_count),
      workspaceRoots: [],
    })),
    ...(activatedAt ? {activatedAt} : {}),
    metrics: 'complete',
    model: 'legacy-fallback',
    repository: {
      displayName: row.display_name,
      repositoryId: row.repository_id,
    },
    snapshot: snapshotFromRow(row),
    viewWorktreeId: viewWorktreeId ?? row.worktree_id,
    workspaces: [],
  } satisfies CodeGraphVisualizationCatalog;
});

const selectVisualizationCatalogs = Effect.fn('codeGraph.selectVisualizationCatalogs')(function* (
  metrics: 'complete' | 'deferred' = 'complete',
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const worktrees = yield* sql<{readonly worktree_id: string}>`
    SELECT DISTINCT COALESCE(active_snapshots.worktree_id, snapshots.worktree_id) AS worktree_id
    FROM snapshots
    LEFT JOIN active_snapshots ON active_snapshots.snapshot_id = snapshots.id
    WHERE snapshots.state = 'ready'
    ORDER BY worktree_id
  `;
  return (yield* Effect.forEach(worktrees, row => selectVisualizationCatalog(row.worktree_id, metrics), {
    concurrency: 1,
  })).flatMap(catalog => (catalog ? [catalog] : []));
});

const selectVisualizationScopeEdges = Effect.fn('codeGraph.selectVisualizationScopeEdges')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const hasWorkspaceCatalog =
    (yield* tableExists(sql, 'workspace_components')) &&
    Number(
      (yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${snapshotId}
        `)[0]?.count ?? 0,
    ) > 0;
  const graphRows = yield* sql.unsafe<{
    readonly confidence: number;
    readonly count: number;
    readonly provenance: CodeGraphProvenance;
    readonly relation: CodeGraphEdge['relation'];
    readonly source_scope_id: string;
    readonly target_scope_id: string;
  }>(
    `${effectiveGraphCtes()}
     , scoped_symbols AS (
       SELECT id,
         ${hasWorkspaceCatalog ? "CASE WHEN resolution_scope_id IS NOT NULL THEN resolution_scope_id WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'facet:unscoped-documentation' WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END" : "CASE WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END"} AS scope_id
       FROM effective_symbols
     )
     SELECT source.scope_id AS source_scope_id, target.scope_id AS target_scope_id,
       edge.provenance, edge.relation, COUNT(*) AS count, MAX(edge.confidence) AS confidence
     FROM effective_edges AS edge
     JOIN scoped_symbols AS source ON source.id = edge.source_id
     JOIN scoped_symbols AS target ON target.id = edge.target_id
     WHERE source.scope_id IS NOT NULL AND target.scope_id IS NOT NULL
       AND source.scope_id <> target.scope_id
     GROUP BY source.scope_id, target.scope_id, edge.provenance, edge.relation
     ORDER BY source.scope_id, target.scope_id, edge.provenance, edge.relation`,
    effectiveGraphParameters(snapshotId, baseSnapshotId),
  );
  const sourceRelationships: CodeGraphVisualizationScopeEdge[] = graphRows.map(row => ({
    confidence: Number(row.confidence),
    count: Number(row.count),
    provenance: row.provenance,
    relation: row.relation,
    sourceId: row.source_scope_id,
    targetId: row.target_scope_id,
    type: 'source-relationship',
  }));
  if (!hasWorkspaceCatalog) return sourceRelationships;
  const dependencies = yield* sql<{
    readonly provenance: CodeGraphWorkspaceProvenance;
    readonly source_component_id: string;
    readonly target_component_id: string;
  }>`
    SELECT source_component_id, target_component_id, provenance
    FROM workspace_component_dependencies
    WHERE snapshot_id = ${snapshotId}
    ORDER BY source_component_id, target_component_id, provenance
  `;
  return [
    ...dependencies.map(
      dependency =>
        ({
          confidence: 1,
          count: 1,
          provenance: 'declared',
          relation: 'depends_on',
          sourceId: dependency.source_component_id,
          targetId: dependency.target_component_id,
          type: 'declared-build-dependency',
        }) satisfies CodeGraphVisualizationScopeEdge,
    ),
    ...sourceRelationships,
  ];
});

export interface CodeGraphSqlQueryStatement {
  readonly parameters: readonly (number | string)[];
  readonly text: string;
}

export function codeGraphVisualizationSymbolsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  scope: CodeGraphVisualizationScope,
  limit: number,
): CodeGraphSqlQueryStatement {
  const current = visualizationScopePredicate(scope, 'current_symbols');
  const base = visualizationScopePredicate(scope, 'base_symbols');
  const scopeIndex = scope.type === 'all' ? ' INDEXED BY symbols_export_order' : ' INDEXED BY symbols_resolution_scope';
  const order =
    scope.type === 'all'
      ? 'path, qualified_name, id'
      : `exported DESC,
      CASE kind
        WHEN 'package' THEN 0
        WHEN 'module' THEN 1
        WHEN 'class' THEN 2
        WHEN 'interface' THEN 3
        WHEN 'function' THEN 4
        WHEN 'method' THEN 5
        ELSE 6
      END,
      path,
      qualified_name,
      id`;
  return {
    parameters: [
      snapshotId,
      ...current.parameters,
      baseSnapshotId ?? '',
      ...base.parameters,
      snapshotId,
      snapshotId,
      Math.max(1, Math.min(500, Math.floor(limit))),
    ],
    text: `WITH effective_symbols AS (
      SELECT current_symbols.*
      FROM symbols AS current_symbols${scopeIndex}
      WHERE current_symbols.snapshot_id = ? AND ${current.text}
      UNION ALL
      SELECT base_symbols.*
      FROM symbols AS base_symbols${scopeIndex}
      WHERE base_symbols.snapshot_id = ? AND ${base.text}
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )
    )
    SELECT *
    FROM effective_symbols
    ORDER BY ${order}
    LIMIT ?`,
  };
}

function visualizationScopePredicate(scope: CodeGraphVisualizationScope, alias: string): CodeGraphSqlQueryStatement {
  const pathScope = `CASE WHEN instr(${alias}.path, '/') > 0 THEN substr(${alias}.path, 1, instr(${alias}.path, '/') - 1) ELSE '(root)' END`;
  switch (scope.type) {
    case 'all':
      return {parameters: [], text: '1 = 1'};
    case 'component':
      return {parameters: [scope.value], text: `${alias}.resolution_scope_id = ?`};
    case 'documentation-facet':
      return {
        parameters: [],
        text: `${alias}.resolution_scope_id IS NULL AND (${alias}.language = 'markdown' OR ${alias}.kind IN ('document', 'heading', 'section'))`,
      };
    case 'package':
      return {
        parameters: [scope.value],
        text: `${alias}.resolution_scope_id IS NULL AND ${alias}.package_name = ?`,
      };
    case 'path':
      return {
        parameters: [scope.value],
        text: `${alias}.resolution_scope_id IS NULL AND (${alias}.package_name IS NULL OR trim(${alias}.package_name) = '') AND ${pathScope} = ?`,
      };
    case 'unscoped':
      return {parameters: [], text: `${alias}.resolution_scope_id IS NULL`};
  }
}

const selectVisualizationSymbols = Effect.fn('codeGraph.selectVisualizationSymbols')(function* (
  snapshotId: string,
  scope: CodeGraphVisualizationScope,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphVisualizationSymbolsQueryStatement(snapshotId, baseSnapshotId, scope, limit);
  const rows = yield* sql.unsafe<SymbolRow>(statement.text, statement.parameters);
  return rows.map(symbolFromRow);
});

const selectEdgePage = Effect.fn('codeGraph.selectEdgePage')(function* (
  snapshotId: string,
  cursor: CodeGraphEdgeCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         WHERE (source_name, relation, target_name, id) > (?, ?, ?, ?)
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.sourceName,
          cursor.relation,
          cursor.targetName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(edgeFromRow);
});

const selectSearchSymbols = Effect.fn('codeGraph.selectSearchSymbols')(function* (
  snapshotId: string,
  query: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit);
});

interface SearchSymbolRow extends SymbolRow {
  readonly exact_rank: number;
  readonly score: number;
}

const EXACT_SYMBOL_FIELDS = [
  {column: 'name', index: 'symbols_name_nocase', insensitiveRank: 4, sensitiveRank: 6},
  {column: 'qualified_name', index: 'symbols_qualified_nocase', insensitiveRank: 3, sensitiveRank: 5},
  {column: 'path', index: 'symbols_path_nocase', insensitiveRank: 1, sensitiveRank: 2},
] as const;

/**
 * Build exact-match candidates with the equality predicate inside every
 * current/base branch. Keeping the predicate outside effectiveSymbolsCte()
 * makes SQLite scan every symbol in a large snapshot before applying LIMIT.
 */
export function codeGraphExactSymbolQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
): CodeGraphSqlQueryStatement {
  const branches: string[] = [];
  const parameters: Array<number | string> = [];
  for (const field of EXACT_SYMBOL_FIELDS) {
    branches.push(`SELECT current_symbols.*,
        CASE WHEN current_symbols.${field.column} = ? THEN ${field.sensitiveRank} ELSE ${field.insensitiveRank} END AS exact_rank
      FROM symbols AS current_symbols INDEXED BY ${field.index}
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.${field.column} = ? COLLATE NOCASE`);
    parameters.push(query, snapshotId, query);
    branches.push(`SELECT base_symbols.*,
        CASE WHEN base_symbols.${field.column} = ? THEN ${field.sensitiveRank} ELSE ${field.insensitiveRank} END AS exact_rank
      FROM symbols AS base_symbols INDEXED BY ${field.index}
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.${field.column} = ? COLLATE NOCASE
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )`);
    parameters.push(query, baseSnapshotId ?? '', query, snapshotId, snapshotId);
  }
  parameters.push(Math.max(1, Math.min(500, Math.floor(limit))));
  return {
    parameters,
    text: `WITH exact_candidates AS (
        ${branches.join('\n        UNION ALL\n        ')}
      ),
      ranked_exact_symbols AS (
        SELECT exact_candidates.*,
          ROW_NUMBER() OVER (PARTITION BY id ORDER BY exact_rank DESC) AS exact_row
        FROM exact_candidates
      )
      SELECT ranked_exact_symbols.*,
        CASE exact_rank
          WHEN 6 THEN 100 WHEN 5 THEN 99 WHEN 4 THEN 98
          WHEN 3 THEN 97 WHEN 2 THEN 90 ELSE 89
        END AS score
      FROM ranked_exact_symbols
      WHERE exact_row = 1
      ORDER BY exact_rank DESC, exported DESC,
        CASE kind
          WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'protocol' THEN 2
          WHEN 'struct' THEN 3 WHEN 'enum' THEN 4 WHEN 'type_alias' THEN 5
          WHEN 'function' THEN 6 WHEN 'method' THEN 7 WHEN 'constructor' THEN 8
          WHEN 'module' THEN 9 WHEN 'package' THEN 10 WHEN 'field' THEN 11
          WHEN 'property' THEN 12 ELSE 13
        END,
        name, path, id
      LIMIT ?`,
  };
}

function legacyLexicalTermBranch(alias: string, placeholders: string, base: boolean): string {
  const suppression = base
    ? `AND NOT EXISTS (
         SELECT 1 FROM symbols AS overrides
         WHERE overrides.snapshot_id = ? AND overrides.id = ${alias}.symbol_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_symbol_deletions AS deletions
         WHERE deletions.snapshot_id = ? AND deletions.symbol_id = ${alias}.symbol_id
       )`
    : '';
  const termPredicate = placeholders.length === 0 ? '' : `AND ${alias}.term IN (${placeholders})`;
  return `SELECT ${alias}.term, ${alias}.symbol_id, ${alias}.weight
    FROM symbol_terms AS ${alias} INDEXED BY sqlite_autoindex_symbol_terms_1
    WHERE ${alias}.snapshot_id = ?
      ${termPredicate}
      AND NOT EXISTS (
        SELECT 1 FROM lexical_storage_formats AS storage
        WHERE storage.snapshot_id = ${alias}.snapshot_id
      )
      ${suppression}`;
}

function compactLexicalTermBranch(alias: string, placeholders: string, base: boolean): string {
  const suppression = base
    ? `AND NOT EXISTS (
         SELECT 1 FROM symbols AS overrides
         WHERE overrides.snapshot_id = ? AND overrides.id = ${alias}_symbols.symbol_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_symbol_deletions AS deletions
         WHERE deletions.snapshot_id = ? AND deletions.symbol_id = ${alias}_symbols.symbol_id
       )`
    : '';
  const termPredicate = placeholders.length === 0 ? '' : `AND ${alias}_terms.term IN (${placeholders})`;
  return `SELECT ${alias}_terms.term, ${alias}_symbols.symbol_id, ${alias}_postings.weight
    FROM lexical_compact_snapshots AS ${alias}_snapshot
    JOIN lexical_storage_formats AS ${alias}_format
      ON ${alias}_format.snapshot_id = ${alias}_snapshot.snapshot_id
     AND ${alias}_format.format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
    JOIN lexical_compact_terms AS ${alias}_terms INDEXED BY sqlite_autoindex_lexical_compact_terms_1
      ON ${alias}_terms.snapshot_key = ${alias}_snapshot.snapshot_key
    CROSS JOIN lexical_compact_postings AS ${alias}_postings
    CROSS JOIN lexical_compact_symbols AS ${alias}_symbols
    WHERE ${alias}_snapshot.snapshot_id = ?
      AND ${alias}_postings.snapshot_key = ${alias}_snapshot.snapshot_key
      AND ${alias}_postings.term_key = ${alias}_terms.term_key
      AND ${alias}_symbols.snapshot_key = ${alias}_snapshot.snapshot_key
      AND ${alias}_symbols.symbol_key = ${alias}_postings.symbol_key
      ${termPredicate}
      ${suppression}`;
}

export function codeGraphEffectiveSymbolTermsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
): CodeGraphSqlQueryStatement {
  const baseId = baseSnapshotId ?? '';
  return {
    parameters: [snapshotId, snapshotId, baseId, snapshotId, snapshotId, baseId, snapshotId, snapshotId],
    text: `WITH effective_terms AS (
      ${legacyLexicalTermBranch('current_legacy_terms', '', false)}
      UNION ALL
      ${compactLexicalTermBranch('current_compact', '', false)}
      UNION ALL
      ${legacyLexicalTermBranch('base_legacy_terms', '', true)}
      UNION ALL
      ${compactLexicalTermBranch('base_compact', '', true)}
    )
    SELECT term, symbol_id, weight FROM effective_terms
    ORDER BY term, symbol_id`,
  };
}

/** Build lexical candidates across independently versioned current/base snapshots. */
export function codeGraphTermCandidateQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  terms: readonly string[],
  limit: number,
): CodeGraphSqlQueryStatement {
  const uniqueTerms = [...new Set(terms)].slice(0, 24);
  const placeholders = uniqueTerms.map(() => '?').join(', ');
  const baseId = baseSnapshotId ?? '';
  return {
    parameters: [
      snapshotId,
      ...uniqueTerms,
      snapshotId,
      ...uniqueTerms,
      baseId,
      ...uniqueTerms,
      snapshotId,
      snapshotId,
      baseId,
      ...uniqueTerms,
      snapshotId,
      snapshotId,
      Math.max(1, Math.min(2_000, Math.floor(limit))),
    ],
    text: `WITH effective_terms AS (
      ${legacyLexicalTermBranch('current_legacy_terms', placeholders, false)}
      UNION ALL
      ${compactLexicalTermBranch('current_compact', placeholders, false)}
      UNION ALL
      ${legacyLexicalTermBranch('base_legacy_terms', placeholders, true)}
      UNION ALL
      ${compactLexicalTermBranch('base_compact', placeholders, true)}
    )
    SELECT symbol_id, SUM(weight) AS score
    FROM effective_terms
    GROUP BY symbol_id
    ORDER BY score DESC, symbol_id
    LIMIT ?`,
  };
}

function compareSearchSymbolRows(left: SearchSymbolRow, right: SearchSymbolRow): number {
  return (
    right.exact_rank - left.exact_rank ||
    right.score - left.score ||
    right.exported - left.exported ||
    searchSymbolKindOrder(left.kind) - searchSymbolKindOrder(right.kind) ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.id, right.id)
  );
}

function searchSymbolKindOrder(kind: string): number {
  switch (kind) {
    case 'class':
      return 0;
    case 'interface':
      return 1;
    case 'protocol':
      return 2;
    case 'struct':
      return 3;
    case 'enum':
      return 4;
    case 'type_alias':
      return 5;
    case 'function':
      return 6;
    case 'method':
      return 7;
    case 'constructor':
      return 8;
    case 'module':
      return 9;
    case 'package':
      return 10;
    case 'field':
      return 11;
    case 'property':
      return 12;
    default:
      return 13;
  }
}

export function codeGraphSymbolsByIdsQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
): CodeGraphSqlQueryStatement {
  const uniqueIds = [...new Set(ids)].slice(0, 400);
  const placeholders = uniqueIds.map(() => '?').join(', ');
  return {
    parameters: [snapshotId, ...uniqueIds, baseSnapshotId ?? '', ...uniqueIds, snapshotId, snapshotId],
    text: `WITH matching_symbols AS (
      SELECT current_symbols.*
      FROM symbols AS current_symbols INDEXED BY sqlite_autoindex_symbols_1
      WHERE current_symbols.snapshot_id = ?
        AND current_symbols.id IN (${placeholders})
      UNION ALL
      SELECT base_symbols.*
      FROM symbols AS base_symbols INDEXED BY sqlite_autoindex_symbols_1
      WHERE base_symbols.snapshot_id = ?
        AND base_symbols.id IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM symbols AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
        )
    )
    SELECT * FROM matching_symbols
    ORDER BY path, qualified_name, id`,
  };
}

const selectSymbolsByIdsWithSql = Effect.fn('codeGraph.selectSymbolsByIdsWithSql')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  ids: readonly string[],
) {
  const output: SymbolRow[] = [];
  for (const values of chunk([...new Set(ids)], 400)) {
    const statement = codeGraphSymbolsByIdsQueryStatement(snapshotId, baseSnapshotId, values);
    const rows = yield* sql.unsafe<SymbolRow>(statement.text, statement.parameters);
    output.push(...rows);
  }
  return output;
});

const selectSearchSymbolsWithSql = Effect.fn('codeGraph.selectSearchSymbolsWithSql')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
) {
  const terms = normalizedTerms(query).slice(0, 24);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const exactPath = normalizeExactSearchPath(query);
  const exactStatement = codeGraphExactSymbolQueryStatement(snapshotId, baseSnapshotId, exactPath ?? query, safeLimit);
  const exactRows = yield* sql.unsafe<SearchSymbolRow>(exactStatement.text, exactStatement.parameters);
  if (
    exactPath !== undefined &&
    exactRows.some(row => normalizeExactSearchPath(row.path)?.toLocaleLowerCase() === exactPath.toLocaleLowerCase())
  ) {
    return [...exactRows]
      .sort(compareSearchSymbolRows)
      .slice(0, safeLimit)
      .map(row => ({...symbolFromRow(row), score: Math.max(0, Math.min(1, row.score / 100))}));
  }
  const candidateLimit = Math.min(2_000, Math.max(100, safeLimit * 20));
  const termStatement =
    terms.length === 0
      ? undefined
      : codeGraphTermCandidateQueryStatement(snapshotId, baseSnapshotId, terms, candidateLimit);
  const termCandidates =
    termStatement === undefined
      ? []
      : yield* sql.unsafe<{readonly score: number; readonly symbol_id: string}>(
          termStatement.text,
          termStatement.parameters,
        );
  const termScores = new Map(termCandidates.map(candidate => [candidate.symbol_id, Number(candidate.score)]));
  const termRows = (yield* selectSymbolsByIdsWithSql(
    sql,
    snapshotId,
    baseSnapshotId,
    termCandidates.map(candidate => candidate.symbol_id),
  )).map(row => ({...row, score: termScores.get(row.id) ?? 0}));
  const byId = new Map<string, SearchSymbolRow>();
  for (const row of [...termRows.map(row => ({...row, exact_rank: 0})), ...exactRows]) {
    const current = byId.get(row.id);
    if (!current || compareSearchSymbolRows(row, current) < 0) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort(compareSearchSymbolRows)
    .slice(0, safeLimit)
    .map(row => ({...symbolFromRow(row), score: Math.max(0, Math.min(1, row.score / 100))}));
});

export function isCanonicalAbsoluteBazelLabel(value: string): boolean {
  return /^(?:@@?[^/\\\s:]+)?\/\/[^\\\s:]*:[^\\\s:]+$/u.test(value);
}

function normalizeExactSearchPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (isCanonicalAbsoluteBazelLabel(trimmed)) return undefined;
  const normalized = trimmed
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
  return normalized.includes('/') ? normalized : undefined;
}

const selectSearchSymbolsMany = Effect.fn('codeGraph.selectSearchSymbolsMany')(function* (
  snapshotId: string,
  queries: readonly string[],
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* Effect.forEach(
    queries,
    query => selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit),
    {concurrency: 1},
  );
});

const selectSymbolsByPaths = Effect.fn('codeGraph.selectSymbolsByPaths')(function* (
  snapshotId: string,
  paths: readonly string[],
  limitPerPath: number,
) {
  if (paths.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const normalizedPaths = [...new Set(paths)];
  const grouped = new Map<string, CodeGraphQueryNode[]>();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limitPerPath)));
  for (const pathBatch of chunk(normalizedPaths, 300)) {
    const placeholders = pathBatch.map(() => '?').join(', ');
    const rows = yield* sql.unsafe<SymbolRow & {readonly path_rank: number}>(
      `WITH effective_path_symbols AS (
         SELECT current_symbols.*
         FROM symbols AS current_symbols INDEXED BY symbols_path
         WHERE current_symbols.snapshot_id = ?
           AND current_symbols.path IN (${placeholders})
         UNION ALL
         SELECT base_symbols.*
         FROM symbols AS base_symbols INDEXED BY symbols_path
         WHERE base_symbols.snapshot_id = ?
           AND base_symbols.path IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM symbols AS overrides
             WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM snapshot_symbol_deletions AS deletions
             WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
           )
       ),
       ranked_symbols AS (
         SELECT effective_path_symbols.*,
           ROW_NUMBER() OVER (
             PARTITION BY path
             ORDER BY exported DESC, qualified_name, id
           ) AS path_rank
         FROM effective_path_symbols
       )
       SELECT * FROM ranked_symbols
       WHERE path_rank <= ?
       ORDER BY path, path_rank`,
      [snapshotId, ...pathBatch, baseSnapshotId ?? '', ...pathBatch, snapshotId, snapshotId, safeLimit],
    );
    for (const row of rows) {
      const values = grouped.get(row.path) ?? [];
      values.push({...symbolFromRow(row), score: 1});
      grouped.set(row.path, values);
    }
  }
  return paths.map(sourcePath => grouped.get(sourcePath) ?? []);
});

const selectSymbolsByPathAndName = Effect.fn('codeGraph.selectSymbolsByPathAndName')(function* (
  snapshotId: string,
  sourcePath: string,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<SymbolRow>(
    `WITH matching_symbols AS (
       SELECT current_symbols.*
       FROM symbols AS current_symbols INDEXED BY symbols_path_nocase
       WHERE current_symbols.snapshot_id = ?
         AND current_symbols.path = ? COLLATE NOCASE
         AND (current_symbols.name = ? COLLATE NOCASE OR current_symbols.qualified_name = ? COLLATE NOCASE)
       UNION ALL
       SELECT base_symbols.*
       FROM symbols AS base_symbols INDEXED BY symbols_path_nocase
       WHERE base_symbols.snapshot_id = ?
         AND base_symbols.path = ? COLLATE NOCASE
         AND (base_symbols.name = ? COLLATE NOCASE OR base_symbols.qualified_name = ? COLLATE NOCASE)
         AND NOT EXISTS (
           SELECT 1 FROM symbols AS overrides
           WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_symbol_deletions AS deletions
           WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
         )
     )
     SELECT * FROM matching_symbols
     ORDER BY exported DESC, qualified_name, id
     LIMIT 20`,
    [snapshotId, sourcePath, name, name, baseSnapshotId ?? '', sourcePath, name, name, snapshotId, snapshotId],
  );
  return rows.map(row => ({...symbolFromRow(row), score: 1}));
});

const selectSymbolsByIds = Effect.fn('codeGraph.selectSymbolsByIds')(function* (
  snapshotId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return (yield* selectSymbolsByIdsWithSql(sql, snapshotId, baseSnapshotId, ids)).map(symbolFromRow);
});

function effectiveAdjacentEdgesCte(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  allowedProvenances: readonly CodeGraphProvenance[],
  branchLimit?: number,
): CodeGraphSqlQueryStatement {
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const provenances = [...new Set(allowedProvenances)];
  const idPlaceholders = ids.map(() => '?').join(', ');
  const provenancePlaceholders = provenances.map(() => '?').join(', ');
  const axes =
    direction === 'incoming'
      ? ([{column: 'target_id', index: 'edges_target'}] as const)
      : direction === 'outgoing'
        ? ([{column: 'source_id', index: 'edges_source'}] as const)
        : ([
            {column: 'source_id', index: 'edges_source'},
            {column: 'target_id', index: 'edges_target'},
          ] as const);
  const branches: string[] = [];
  const parameters: Array<number | string> = [];
  const boundedBranchLimit =
    branchLimit === undefined ? undefined : Math.max(1, Math.min(5_000, Math.floor(branchLimit)));
  for (const axis of axes) {
    const currentBranch = `SELECT current_edges.*
      FROM edges AS current_edges INDEXED BY ${axis.index}
      WHERE current_edges.snapshot_id = ?
        AND current_edges.${axis.column} IN (${idPlaceholders})
        AND current_edges.provenance IN (${provenancePlaceholders})`;
    branches.push(
      boundedBranchLimit === undefined
        ? currentBranch
        : `SELECT * FROM (${currentBranch}
          ORDER BY ${edgePriorityOrder('current_edges')}
          LIMIT ?)`,
    );
    parameters.push(snapshotId, ...ids, ...provenances);
    if (boundedBranchLimit !== undefined) parameters.push(boundedBranchLimit);
    const baseBranch = `SELECT base_edges.*
      FROM edges AS base_edges INDEXED BY ${axis.index}
      WHERE base_edges.snapshot_id = ?
        AND base_edges.${axis.column} IN (${idPlaceholders})
        AND base_edges.provenance IN (${provenancePlaceholders})
        AND NOT EXISTS (
          SELECT 1 FROM edges AS overrides
          WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_edge_deletions AS deletions
          WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
        )`;
    branches.push(
      boundedBranchLimit === undefined
        ? baseBranch
        : `SELECT * FROM (${baseBranch}
          ORDER BY ${edgePriorityOrder('base_edges')}
          LIMIT ?)`,
    );
    parameters.push(baseSnapshotId ?? '', ...ids, ...provenances, snapshotId, snapshotId);
    if (boundedBranchLimit !== undefined) parameters.push(boundedBranchLimit);
  }
  return {
    parameters,
    // UNION (rather than UNION ALL) is needed only for `both`: a self-loop is
    // found through both directional indexes but remains one logical edge.
    text: `WITH adjacent_edges AS (
      ${branches.join(direction === 'both' ? '\n      UNION\n      ' : '\n      UNION ALL\n      ')}
    )`,
  };
}

function edgePriorityOrder(alias: string): string {
  return `CASE ${alias}.provenance WHEN 'declared' THEN 0 WHEN 'resolved' THEN 1 WHEN 'syntactic' THEN 2 ELSE 3 END,
    ${alias}.confidence DESC, ${alias}.source_name, ${alias}.relation, ${alias}.target_name, ${alias}.id`;
}

/** Build bounded adjacency SQL whose branches seek the directional indexes. */
export function codeGraphAdjacencyQueryStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
): CodeGraphSqlQueryStatement {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const adjacent = effectiveAdjacentEdgesCte(
    snapshotId,
    baseSnapshotId,
    nodeIds,
    direction,
    allowedProvenances,
    safeLimit,
  );
  return {
    parameters: [...adjacent.parameters, safeLimit],
    text: `${adjacent.text}
      SELECT * FROM adjacent_edges
      ORDER BY
        CASE provenance WHEN 'declared' THEN 0 WHEN 'resolved' THEN 1 WHEN 'syntactic' THEN 2 ELSE 3 END,
        confidence DESC, source_name, relation, target_name, id
      LIMIT ?`,
  };
}

const selectEdgesForNodes = Effect.fn('codeGraph.selectEdgesForNodes')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (nodeIds.length === 0 || limit <= 0 || allowedProvenances.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const statement = codeGraphAdjacencyQueryStatement(
    snapshotId,
    baseSnapshotId,
    ids,
    direction,
    limit,
    allowedProvenances,
  );
  const rows = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
  return rows.map(edgeFromRow);
});

const selectRelationshipSummaryForNode = Effect.fn('codeGraph.selectRelationshipSummaryForNode')(function* (
  snapshotId: string,
  nodeId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (allowedProvenances.length === 0) {
    return {incoming: 0, outgoing: 0, provenances: [], relations: []};
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const adjacent = effectiveAdjacentEdgesCte(snapshotId, baseSnapshotId, [nodeId], 'both', allowedProvenances);
  const rows = yield* sql.unsafe<{
    readonly count: number;
    readonly incoming: number;
    readonly outgoing: number;
    readonly provenance: CodeGraphProvenance;
    readonly relation: CodeGraphEdge['relation'];
  }>(
    `${adjacent.text}
     SELECT relation, provenance, COUNT(*) AS count,
       SUM(CASE WHEN target_id = ? THEN 1 ELSE 0 END) AS incoming,
       SUM(CASE WHEN source_id = ? THEN 1 ELSE 0 END) AS outgoing
     FROM adjacent_edges
     GROUP BY relation, provenance
     ORDER BY count DESC, relation, provenance`,
    [...adjacent.parameters, nodeId, nodeId],
  );
  const relationCounts = new Map<CodeGraphEdge['relation'], {count: number; incoming: number; outgoing: number}>();
  const provenanceCounts = new Map<CodeGraphProvenance, number>();
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    const relation = relationCounts.get(row.relation) ?? {count: 0, incoming: 0, outgoing: 0};
    relation.count += row.count;
    relation.incoming += row.incoming;
    relation.outgoing += row.outgoing;
    relationCounts.set(row.relation, relation);
    provenanceCounts.set(row.provenance, (provenanceCounts.get(row.provenance) ?? 0) + row.count);
    incoming += row.incoming;
    outgoing += row.outgoing;
  }
  return {
    incoming,
    outgoing,
    provenances: [...provenanceCounts]
      .map(([provenance, count]) => ({count, provenance}))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.provenance, right.provenance)),
    relations: [...relationCounts]
      .map(([relation, counts]) => ({...counts, relation}))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.relation, right.relation)),
  };
});

const upsertRepository = Effect.fn('codeGraph.upsertRepository')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
) {
  const now = new Date().toISOString();
  yield* sql`
    INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
    VALUES (${identity.repositoryId}, ${identity.displayName}, ${identity.objectFormat}, ${now}, ${now})
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      object_format = excluded.object_format,
      last_used_at = excluded.last_used_at
  `;
});

function symbolTerms(symbol: CodeGraphSymbol): readonly (readonly [string, number])[] {
  const weighted = new Map<string, number>();
  addTerms(weighted, symbol.name, 5);
  addTerms(weighted, symbol.qualifiedName, 4);
  addTerms(weighted, symbol.path, 3);
  addTerms(weighted, symbol.packageName ?? '', 3);
  addTerms(weighted, symbol.signature ?? '', 2);
  addTerms(weighted, symbol.documentation ?? '', 1);
  return [...weighted].sort(([left], [right]) => compareCodeUnits(left, right));
}

function addTerms(target: Map<string, number>, value: string, weight: number): void {
  for (const term of normalizedTerms(value)) {
    target.set(term, Math.max(target.get(term) ?? 0, weight));
  }
}

export function normalizedTerms(value: string): readonly string[] {
  const expanded = value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return [...new Set(expanded.match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? [])].slice(0, 32);
}

function snapshotFromRow(row: SnapshotRow): CodeGraphSnapshot {
  return {
    baseSnapshotId: Option.getOrUndefined(sqlTextOption(row.base_snapshot_id)),
    commit: row.commit_id,
    completedAt: Option.getOrUndefined(sqlTextOption(row.completed_at)),
    dirty: row.dirty === 1,
    edgeCount: row.edge_count,
    extractorSet: row.extractor_set,
    fileCount: row.file_count,
    id: row.id,
    overlayFingerprint: Option.getOrUndefined(sqlTextOption(row.overlay_fingerprint)),
    repositoryId: row.repository_id,
    state: row.state,
    symbolCount: row.symbol_count,
    worktreeId: row.worktree_id,
  };
}

function symbolFromRow(row: SymbolRow): CodeGraphSymbol {
  const arity = typeof row.arity === 'number' && Number.isSafeInteger(row.arity) ? row.arity : undefined;
  const resolutionDomain = Option.getOrUndefined(sqlTextOption(row.resolution_domain));
  const resolutionScopeId = Option.getOrUndefined(sqlTextOption(row.resolution_scope_id));
  return {
    ...(arity === undefined ? {} : {arity}),
    contentHash: row.content_hash,
    documentation: Option.getOrUndefined(sqlTextOption(row.documentation)),
    exported: row.exported === 1,
    id: row.id,
    kind: row.kind,
    language: row.language,
    lookupKeys: parseLookupKeys(row.lookup_keys_json),
    name: row.name,
    packageName: Option.getOrUndefined(sqlTextOption(row.package_name)),
    path: row.path,
    qualifiedName: row.qualified_name,
    ...(resolutionDomain === undefined ? {} : {resolutionDomain}),
    ...(resolutionScopeId === undefined ? {} : {resolutionScopeId}),
    signature: Option.getOrUndefined(sqlTextOption(row.signature)),
    span: JSON.parse(row.span_json) as CodeGraphSymbol['span'],
  };
}

function edgeFromRow(row: EdgeRow): CodeGraphEdge {
  return {
    confidence: row.confidence,
    evidencePath: row.evidence_path,
    evidenceSpan: JSON.parse(row.evidence_span_json) as CodeGraphEdge['evidenceSpan'],
    id: row.id,
    provenance: row.provenance,
    relation: row.relation,
    sourceId: Option.getOrUndefined(sqlTextOption(row.source_id)),
    sourceName: row.source_name,
    targetId: Option.getOrUndefined(sqlTextOption(row.target_id)),
    targetName: row.target_name,
  };
}

function sqlTextOption(value: unknown): Option.Option<string> {
  return typeof value === 'string' ? Option.some(value) : Option.none();
}

function boundedPageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(2_000, value)) : 500;
}

function boundedAggregatePageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(250_000, value)) : 50_000;
}

function* chunk<const Value>(values: readonly Value[], size: number): Generator<readonly Value[]> {
  for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size);
}

function sortedBy<Value>(values: readonly Value[], key: (value: Value) => string): readonly Value[] {
  return [...values].sort((left, right) => compareCodeUnits(key(left), key(right)));
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): readonly Value[] {
  const output = new Map<string, Value>();
  for (const value of values) {
    const identity = key(value);
    if (!output.has(identity)) output.set(identity, value);
  }
  return [...output.values()];
}

function parseLookupKeys(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 4_096))]
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}

function tableExists(sql: SqlClient.SqlClient, table: string): Effect.Effect<boolean, SqlError.SqlError> {
  return sql<{readonly name: string}>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table} LIMIT 1
  `.pipe(Effect.map(rows => rows.length > 0));
}

function lookupDomain(key: string, fallback: string | undefined): string {
  const separator = key.indexOf(':');
  return separator > 0 ? key.slice(0, separator) : (fallback ?? 'generic');
}

function activationEdgeId(
  sourceId: string | undefined,
  sourceName: string,
  relation: string,
  targetId: string | undefined,
  targetName: string,
  provenance: string,
  path: string,
): string {
  return `cge_${sha256HexSync(
    `edge-v1\n${sourceId ?? sourceName}\n${relation}\n${targetId ?? targetName}\n${provenance}\n${path}`,
  ).slice(0, 32)}`;
}

function storeError(operation: string, cause: unknown): CodeGraphStoreError {
  if (cause instanceof CodeGraphStoreError) return cause;
  return new CodeGraphStoreError(`${operation} failed: ${storeCauseSummary(cause)}`);
}

function storeCauseSummary(cause: unknown): string {
  if (!SqlError.isSqlError(cause)) {
    return sanitizeCodeGraphStoreDiagnostic(cause instanceof Error ? cause.message : String(cause));
  }
  const native = cause.reason.cause;
  const code = sqliteCauseCode(native);
  const nativeMessage =
    native instanceof Error
      ? native.message
      : typeof native === 'object' && native !== null && 'message' in native && typeof native.message === 'string'
        ? native.message
        : undefined;
  const detail = [
    cause.reason._tag,
    code,
    nativeMessage === undefined ? undefined : sanitizeCodeGraphStoreDiagnostic(nativeMessage),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('; ');
  return detail.length === 0
    ? sanitizeCodeGraphStoreDiagnostic(cause.message)
    : `${sanitizeCodeGraphStoreDiagnostic(cause.message)} (${detail})`;
}

function sqliteCauseCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  const code = cause.code;
  const normalized = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  return normalized !== undefined && /^[A-Z0-9_:-]{1,80}$/u.test(normalized) ? normalized : undefined;
}

/** Keep SQLite diagnostics useful without persisting paths, statement values, or unbounded native output. */
export function sanitizeCodeGraphStoreDiagnostic(value: string): string {
  return (
    value
      .replace(/[\r\n\t]+/g, ' ')
      // Native database errors do not reliably quote paths. Once an absolute
      // path starts, conservatively consume through the next quote/delimiter (or
      // the end) so a literal-space suffix can never survive redaction.
      .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`<>\r\n]*/g, '<local-path>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
  );
}
