import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as SqlError from 'effect/unstable/sql/SqlError';
import {sha256HexSync} from '../crypto/sha256.js';
import {isFileLockTimeout, withExclusiveFileLock} from '../effect/file_lock.js';
import {SystemInfo} from '../effect/system.js';
import {
  classifyCodeGraphBuildOwner,
  type CodeGraphBuildOwnerIdentity,
  type CodeGraphBuildOwnerLiveness,
} from './build_owner.js';
import {corroborateCodeGraphBuildOwnerStatus} from './build_status.js';
import {
  CODE_GRAPH_CACHE_TRANSACTION_LIMITS,
  codeGraphFileBlobCapacityBytes,
  codeGraphMaterializedShardCapacityBytes,
  codeGraphTextFieldsCapacityBytes,
  planCodeGraphCacheCapacityChunks,
  type CodeGraphCacheCapacityChunk,
  type CodeGraphCacheCapacityRow,
} from './cache_capacity.js';
import {
  codeGraphUtf8ByteLength,
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {
  areCodeGraphLookupTiersWithinCandidateBudget,
  CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM,
  ensureBoundedCodeGraphFact,
  isCodeGraphReferenceWithinCandidateBudget,
  type BoundedCodeGraphFact,
  type CodeGraphCacheFactInput,
} from './fact_budget.js';
import {compareCodeUnits} from './ordering.js';
import {codeGraphMaintenanceIntentActive} from './maintenance_gate.js';
import {codeGraphLayout, codeGraphSnapshotBuildLockPath} from './layout.js';
import {
  classifyCodeGraphStoreFailure,
  codeGraphStoreBusyFailure,
  sanitizeCodeGraphStoreDiagnostic as sanitizeStoreDiagnostic,
} from './store_failure.js';
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
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphStoreError,
} from './types.js';
export {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION} from './types.js';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspace,
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProject,
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
  readonly graph_content_id: unknown;
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

export interface CodeGraphReusableCleanBase {
  readonly files: readonly CodeGraphInventoryFile[];
  readonly receipt: CodeGraphReusableBaseReceipt;
  readonly snapshot: CodeGraphSnapshot;
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

export type CodeGraphRoutineMaintenanceResult =
  | {
      readonly cleanup:
        | 'abandoned-build'
        | 'completed-build'
        | 'none'
        | 'reconciliation-index'
        | 'removed-worktree-view'
        | 'retired-snapshot';
      readonly expiredLeases: number;
      readonly remaining: boolean;
      readonly retiredSnapshots: number;
      readonly rowsDeleted: number;
      readonly state: 'completed';
    }
  | {
      readonly reason:
        | 'external-maintenance'
        | 'home-tick-active'
        | 'owner-changed'
        | 'owner-protected'
        | 'snapshot-busy'
        | 'worktree-busy'
        | 'writer-busy';
      readonly state: 'deferred';
    }
  | {
      readonly reason: 'database-missing' | 'schema-unavailable' | 'writer-lock-unavailable';
      readonly state: 'skipped';
    };

export interface CodeGraphRoutineMaintenanceOptions {
  /** Stable checkout identity required for exact abandoned-owner reconciliation. */
  readonly checkoutId?: string;
  /** Threadnote home required to derive target worktree and logical-snapshot locks. */
  readonly threadnoteHome?: string;
  /** Checkout-wide writer gate. Production callers pass the path from CodeGraphLayout. */
  readonly writerLockPath?: string;
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

export interface CodeGraphPersistentBuildClaim {
  readonly logicalSnapshotId: string;
  readonly owner: CodeGraphBuildOwnerIdentity;
}

interface PersistentBuildOwnerCandidate extends CodeGraphBuildOwnerIdentity {
  readonly evidenceValid: boolean;
  readonly logicalSnapshotId: string;
  readonly ownerToken: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
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

export interface CodeGraphStagingBatch {
  readonly batchIndex: number;
  readonly edges: readonly CodeGraphEdge[];
  /** Exact UTF-8 JSON bytes of the attributed facts represented by this batch. */
  readonly finalFactBytes?: number;
  readonly references: readonly CodeGraphReference[];
  readonly symbols: readonly CodeGraphSymbol[];
}

export type CodeGraphDirectPersistentCapacityProtector = <A, E, R>(
  boundary: CodeGraphDirectPersistentCapacityBoundary,
  transaction: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CodeGraphStoreError, R>;

export type CodeGraphStagingBatchProgressCallback = (
  batchIndex: number,
  progress: CodeGraphStagingProgress,
) => Effect.Effect<void, never>;

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
  readonly projectCount: number;
  readonly projects: readonly CodeGraphVisualizationProject[];
  readonly projectsTruncated: boolean;
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshot: CodeGraphSnapshot;
  readonly viewWorktreeId: string;
  readonly workspaceCount: number;
  readonly workspaces: readonly CodeGraphVisualizationWorkspace[];
  readonly workspacesTruncated: boolean;
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
  readonly sampledEdges: number;
  readonly truncated: boolean;
}

export interface CodeGraphVisualizationScopeEdgeSummary {
  readonly edges: readonly CodeGraphVisualizationScopeEdge[];
  readonly sampledScopes: number;
  readonly truncated: boolean;
}

export interface CodeGraphVisualizationEdgePage {
  readonly edges: readonly CodeGraphEdge[];
  readonly truncated: boolean;
}

export interface CodeGraphVisualizationCatalogOptions {
  readonly includeDependencies?: boolean;
  readonly projectOffset?: number;
  readonly projectId?: Option.Option<string>;
  readonly projectLimit?: number;
  readonly projectQuery?: Option.Option<string>;
  readonly snapshotId?: Option.Option<string>;
  readonly viewLimit?: number;
  readonly viewOffset?: number;
  readonly viewQuery?: Option.Option<string>;
  readonly workspaceLimit?: number;
  readonly workspaceOffset?: number;
  readonly workspaceQuery?: Option.Option<string>;
}

interface DeferredVisualizationComponentRow {
  readonly build_system: CodeGraphWorkspaceBuildSystem;
  readonly id: string;
  readonly kind: CodeGraphWorkspaceComponentKind;
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly workspace_id: string;
}

export type CodeGraphVisualizationScope =
  | {readonly type: 'all'}
  | {readonly type: 'component'; readonly value: string}
  | {readonly type: 'documentation-facet'}
  | {readonly type: 'package'; readonly value: string}
  | {readonly type: 'path'; readonly value: string}
  | {readonly type: 'unscoped'};

export interface CodeGraphSnapshotLeaseWriterOptions {
  /** Maximum time to wait for another checkout writer. Omit to preserve the unbounded background-worker contract. */
  readonly waitTimeoutMilliseconds?: number;
}

export interface CodeGraphSnapshotPromotionOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** @internal Capacity reservation wrapped outside the checkout writer gate. */
  readonly persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector;
}

export interface CodeGraphSnapshotLeaseAcquireOptions extends CodeGraphSnapshotLeaseWriterOptions {
  readonly retireWhenInactive?: boolean;
}

export interface CodeGraphViewSnapshotLeaseRetainOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Existing process-owned lease token to validate or renew under the same writer gate as the view observation. */
  readonly existingToken?: string;
  /** Minimum remaining lifetime required before an existing token may be reused without renewal. */
  readonly minimumRemainingMilliseconds?: number;
  /** Deterministic test interlock executed after observation while the cross-process writer gate remains held. */
  readonly afterViewObserved?: () => Effect.Effect<void, unknown, never>;
}

export type CodeGraphViewSnapshotLeaseRetainResult =
  | {
      readonly expiresAt: number;
      readonly state: 'retained';
      readonly token: string;
    }
  | {
      readonly observation: CodeGraphViewObservationResult;
      readonly state: 'view-unavailable';
    };

export type CodeGraphViewSnapshotLeaseValidationResult =
  {readonly expiresAt: number; readonly state: 'valid'} | {readonly state: 'invalid'};

export interface CodeGraphViewRemovalStoreOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof run while the checkout writer gate is held and immediately before SQLite is opened. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
  /** Exact path-free provenance evidence captured before the core removal CAS. */
  readonly cleanupEvidence?: CodeGraphRemovedViewCleanupEvidence;
  /** @internal Require the exact automatic-reconciliation schema again inside the final writer transaction. */
  readonly requireReconciliationSchema?: true;
}

export interface CodeGraphWorktreeReconciliationClaimOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof run under the writer gate immediately before SQLite is opened. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
}

export interface CodeGraphWorktreeReconciliationCandidate {
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES = [
  'vector-pointers',
  'build-status',
  'provenance',
  'complete',
] as const;

export type CodeGraphRemovedViewCleanupPhase = (typeof CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES)[number];

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES = [
  'busy',
  'evidence-unavailable',
  'invalid-sidecar',
  'io-error',
  'permission-denied',
  'schema-incompatible',
] as const;

export type CodeGraphRemovedViewCleanupBlockedCode = (typeof CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES)[number];

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS = 30_000;
export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS = 32;

export interface CodeGraphRemovedViewCleanupEvidence {
  readonly recordDigest: string;
  readonly recordIdentity: string;
  readonly repositoryId: string;
}

/** Path-free durable cleanup epoch selected from one immutable tombstone. */
export interface CodeGraphRemovedViewCleanupEntry {
  readonly attempts: number;
  readonly blockedCode?: CodeGraphRemovedViewCleanupBlockedCode;
  readonly cursorToken?: string;
  readonly epoch: number;
  readonly expectedSnapshotId: string;
  readonly nextAttemptAt: number;
  readonly phase: CodeGraphRemovedViewCleanupPhase;
  readonly provenanceRecordDigest?: string;
  readonly provenanceRecordIdentity?: string;
  readonly removedAt: string;
  readonly repositoryId?: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly worktreeId: string;
}

export interface CodeGraphRemovedViewCleanupUpdate {
  readonly attempts: number;
  readonly blockedCode?: CodeGraphRemovedViewCleanupBlockedCode;
  readonly cursorToken?: string;
  readonly nextAttemptAt: number;
  readonly phase: CodeGraphRemovedViewCleanupPhase;
  readonly updatedAt: string;
}

export type CodeGraphRemovedViewCleanupAuthorizationResult =
  | {readonly entry: CodeGraphRemovedViewCleanupEntry; readonly state: 'authorized'}
  | {readonly observedSnapshotId: string; readonly state: 'active-pointer-changed'}
  | {readonly state: 'stale'};

export type CodeGraphRemovedViewCleanupUpdateResult =
  | {readonly entry: CodeGraphRemovedViewCleanupEntry; readonly state: 'updated'}
  | {readonly observedSnapshotId: string; readonly state: 'active-pointer-changed'}
  | {readonly state: 'stale'};

export interface CodeGraphRemovedViewCleanupStoreOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof run under the checkout writer gate immediately before SQLite is opened. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
}

export type CodeGraphWorktreeReconciliationIndexPreparationResult =
  | {readonly state: 'ready'}
  | {readonly index: string; readonly state: 'prepared'}
  | {readonly reason: 'incompatible-schema'; readonly state: 'deferred'};

export type CodeGraphViewRemovalResult =
  | {
      readonly expectedSnapshotId: string;
      readonly retiredSnapshots: number;
      readonly state: 'already-removed' | 'removed';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly observedSnapshotId: string;
      readonly observedState: 'active' | 'removed';
      readonly state: 'stale-target';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly state: 'not-found';
    };

export type CodeGraphViewObservationResult =
  | {
      readonly expectedSnapshotId: string;
      readonly state: 'already-removed' | 'ready';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly observedSnapshotId: string;
      readonly observedState: 'active' | 'removed';
      readonly state: 'stale-target';
    }
  | {
      readonly expectedSnapshotId: string;
      readonly state: 'not-found';
    };

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
    persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
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
  readonly initialize: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
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
  readonly loadMaterializedFileShards: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
    derivationIdentity: string,
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
  readonly reusableCleanBase?: (
    databasePath: string,
    repositoryId: string,
    extractorSet: string,
    workspaceFingerprint: string,
    fileSetFingerprint: string,
    graphContentId?: string,
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

interface CodeGraphDatabaseSessionShape extends CodeGraphDatabaseSessionOptions {
  readonly databasePath: string;
  schemaInitialized: boolean;
  readonly sql: SqlClient.SqlClient;
}

class CodeGraphDatabaseSession extends Context.Service<CodeGraphDatabaseSession, CodeGraphDatabaseSessionShape>()(
  'threadnote/codeGraph/CodeGraphDatabaseSession',
) {}

class CodeGraphPromotionCapacityPlanChanged extends Error {
  override readonly name = 'CodeGraphPromotionCapacityPlanChanged';
}

class CodeGraphCacheCapacityPlanChanged extends Error {
  override readonly name = 'CodeGraphCacheCapacityPlanChanged';
}

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
      const withWriterGate = <A, E, R>(
        databasePath: string,
        effect: Effect.Effect<A, E, R>,
        waitTimeoutMilliseconds?: number,
      ) =>
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
                waitTimeoutMilliseconds: normalizedWriterGateWaitTimeout(waitTimeoutMilliseconds),
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
      const leaseSchemasInitialized = new Set<string>();
      const ensureLeaseSchemaInitialized = (databasePath: string, sql: SqlClient.SqlClient) => {
        if (leaseSchemasInitialized.has(databasePath)) return Effect.void;
        return initializeSchema(sql).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              leaseSchemasInitialized.add(databasePath);
            }),
          ),
        );
      };
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
      const retiredSnapshotCleanupScheduled = new Set<string>();
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
      const scheduleRetiredSnapshotCleanup = (databasePath: string) =>
        Effect.gen(function* () {
          if (retiredSnapshotCleanupScheduled.has(databasePath)) return;
          retiredSnapshotCleanupScheduled.add(databasePath);
          const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
          const options =
            Option.isSome(session) && session.value.databasePath === databasePath ? session.value : undefined;
          const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
          const cleanupSweep = Effect.gen(function* () {
            // Open SQLite only while holding the checkout writer gate. Purge
            // owns the same gate, so a detached collector cannot retain a
            // Windows handle or recreate a database after targeted deletion.
            if (!(yield* fs.exists(databasePath))) return {deleted: 0, remaining: false};
            return yield* useDatabaseDirect(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* configureConnection(sql);
                return yield* pruneRetiredSnapshotRowsPage(sql);
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
            // Pointer publication and lease release stay latency-bounded. Give
            // the foreground operation one polling window to finish before the
            // opportunistic collector attempts its first page.
            yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
            for (;;) {
              const result = yield* runSweep;
              // This collector is opportunistic and bounded to one table page
              // per writer-gate acquisition. Foreground work always wins; the
              // next lease/index/maintenance pass resumes any remaining rows.
              if (Option.isNone(result) || !result.value.remaining) return;
              yield* Effect.sleep(CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS);
            }
          }).pipe(Effect.ensuring(Effect.sync(() => retiredSnapshotCleanupScheduled.delete(databasePath))));
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
                  yield* preflightRemovedViewCleanupSchema(sql);
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
        acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds, options) =>
          Effect.gen(function* () {
            const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
            const acquired = yield* prepare(databasePath).pipe(
              Effect.andThen(
                withWriterGate(
                  databasePath,
                  useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* ensureLeaseSchemaInitialized(databasePath, sql);
                      const acquiredToken = yield* acquireSnapshotLease(
                        snapshotId,
                        durationMilliseconds,
                        token,
                        options?.retireWhenInactive === true,
                      );
                      const cleanup = yield* pruneRetiredSnapshotRowsPage();
                      return {cleanup, token: acquiredToken};
                    }),
                  ),
                  options?.waitTimeoutMilliseconds,
                ),
              ),
              Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause)),
            );
            if (acquired.cleanup.remaining) yield* scheduleRetiredSnapshotCleanup(databasePath);
            return acquired.token;
          }).pipe(Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause))),
        retainViewSnapshotLease: (databasePath, worktreeId, snapshotId, durationMilliseconds, options) =>
          Effect.gen(function* () {
            yield* validateViewRemovalTarget(worktreeId, snapshotId);
            const candidateToken = `${system.processId}:${yield* crypto.randomUUIDv4}`;
            return yield* withWriterGate(
              databasePath,
              Effect.gen(function* () {
                // The writer gate also serializes whole-checkout quarantine.
                // Recheck containment only after it is held so a purged store
                // cannot be recreated by SQLite between an outer stat and open.
                if (!(yield* fs.exists(databasePath))) {
                  return {
                    observation: {expectedSnapshotId: snapshotId, state: 'not-found'},
                    state: 'view-unavailable',
                  } satisfies CodeGraphViewSnapshotLeaseRetainResult;
                }
                if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                  return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
                }
                if ((yield* fs.stat(databasePath)).type !== 'File') {
                  return yield* Effect.fail(
                    new CodeGraphStoreError('Code graph database target is not a regular file.'),
                  );
                }
                return yield* useDatabase(
                  databasePath,
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* ensureLeaseSchemaInitialized(databasePath, sql);
                    return yield* retainViewSnapshotLease(
                      sql,
                      worktreeId,
                      snapshotId,
                      durationMilliseconds,
                      candidateToken,
                      options,
                    );
                  }),
                );
              }),
              options?.waitTimeoutMilliseconds,
            );
          }).pipe(Effect.mapError(cause => storeError('retain code graph view snapshot lease', cause))),
        validateViewSnapshotLease: (databasePath, worktreeId, snapshotId, token, minimumRemainingMilliseconds) =>
          Effect.gen(function* () {
            yield* validateViewRemovalTarget(worktreeId, snapshotId);
            if (
              token.length === 0 ||
              token.length > 1_024 ||
              token.includes('\0') ||
              !Number.isSafeInteger(minimumRemainingMilliseconds) ||
              minimumRemainingMilliseconds < 0 ||
              minimumRemainingMilliseconds > 60 * 60_000
            ) {
              return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
            }
            if (!(yield* fs.exists(databasePath))) {
              return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
            }
            if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
              return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
            }
            if ((yield* fs.stat(databasePath)).type !== 'File') {
              return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
            }
            return yield* useDatabaseDirect(
              databasePath,
              validateViewSnapshotLease(worktreeId, snapshotId, token, minimumRemainingMilliseconds),
              true,
            );
          }).pipe(Effect.mapError(cause => storeError('validate code graph view snapshot lease', cause))),
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
          persistentCapacityProtector,
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
                      reusableBaseReceipt,
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
                    persistentCapacityProtector,
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
        activateCleanSnapshotAlias: (databasePath, identity, snapshot, baseSnapshotId) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureSchemaInitialized(databasePath, sql);
                  yield* withWriterGate(
                    databasePath,
                    activateCleanSnapshotAlias(sql, identity, snapshot, baseSnapshotId),
                  );
                }),
              ),
            ),
            Effect.mapError(cause => storeError('activate clean code graph snapshot alias', cause)),
          ),
        cacheFacts: (databasePath, files, facts, extractorSet, persistentCapacityProtector) =>
          Effect.gen(function* () {
            const chunks = yield* Effect.try({
              catch: cause => cacheCapacityPlanningError('file facts', cause),
              try: () =>
                prepareFreshFactCacheChunks(
                  files,
                  facts.map(ensureBoundedCodeGraphFact),
                  extractorSet,
                  new Date().toISOString(),
                ),
            });
            yield* prepare(databasePath);
            yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureSchemaInitialized(databasePath, sql);
              }),
            );
            for (const chunk of chunks) {
              yield* persistentCapacityProtector(
                chunk.boundary,
                withWriterGate(
                  databasePath,
                  useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* sql.withTransaction(storeFreshFactRows(sql, chunk.rows));
                    }),
                  ),
                ),
              );
            }
          }).pipe(Effect.mapError(cause => storeError('cache code graph file facts', cause))),
        cacheMaterializedFileShards: (
          databasePath,
          files,
          facts,
          extractorSet,
          derivationIdentity,
          persistentCapacityProtector,
        ) =>
          Effect.gen(function* () {
            const chunks = yield* Effect.try({
              catch: cause => cacheCapacityPlanningError('materialized file shards', cause),
              try: () =>
                prepareMaterializedShardCacheChunks(
                  files,
                  facts.map(ensureBoundedCodeGraphFact),
                  extractorSet,
                  derivationIdentity,
                  new Date().toISOString(),
                ),
            });
            yield* prepare(databasePath);
            yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureSchemaInitialized(databasePath, sql);
              }),
            );
            for (const chunk of chunks) {
              yield* writeMaterializedShardCacheRows({
                databasePath,
                persistentCapacityProtector,
                rows: chunk.rows,
                withWriterGate,
              });
            }
          }).pipe(Effect.mapError(cause => storeError('cache materialized code graph file shards', cause))),
        promote: (databasePath, identity, snapshotId, options) =>
          Effect.gen(function* () {
            yield* prepare(databasePath);
            yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* ensureSchemaInitialized(databasePath, sql);
              }),
            );
            let retired = 0;
            for (;;) {
              const plan = yield* useDatabase(databasePath, prepareSnapshotPromotionCapacity(identity, snapshotId));
              const transaction = withWriterGate(
                databasePath,
                useDatabase(databasePath, promoteSnapshot(identity, snapshotId, plan)),
                options?.waitTimeoutMilliseconds,
              );
              const attempted = yield* (
                options?.persistentCapacityProtector
                  ? options.persistentCapacityProtector(plan.boundary, transaction)
                  : transaction
              ).pipe(
                Effect.map(value => ({state: 'completed' as const, value})),
                Effect.catch(error =>
                  error instanceof CodeGraphPromotionCapacityPlanChanged
                    ? Effect.succeed({state: 'retry' as const})
                    : Effect.fail(error),
                ),
              );
              if (attempted.state === 'retry') {
                yield* Effect.yieldNow;
                continue;
              }
              retired = attempted.value;
              break;
            }
            if (retired > 0) yield* scheduleRetiredSnapshotCleanup(databasePath);
          }).pipe(Effect.mapError(cause => storeError('promote code graph snapshot', cause))),
        observeView: (databasePath, worktreeId, expectedSnapshotId) =>
          Effect.gen(function* () {
            yield* validateViewRemovalTarget(worktreeId, expectedSnapshotId);
            if (!(yield* fs.exists(databasePath))) {
              return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewObservationResult;
            }
            if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
              return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
            }
            if ((yield* fs.stat(databasePath)).type !== 'File') {
              return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
            }
            return yield* useReadOnlyDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql.unsafe('PRAGMA busy_timeout = 0');
                return yield* sql.withTransaction(observeActiveView(sql, worktreeId, expectedSnapshotId));
              }),
            );
          }).pipe(Effect.mapError(cause => storeError('observe code graph view', cause))),
        claimWorktreeReconciliationCandidates: (databasePath, limit, options) =>
          withWriterGate(
            databasePath,
            Effect.gen(function* () {
              yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
              if (!(yield* fs.exists(databasePath))) return [];
              if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
              }
              if ((yield* fs.stat(databasePath)).type !== 'File') {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
              }
              return yield* useExistingDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe('PRAGMA busy_timeout = 0');
                  return yield* claimWorktreeReconciliationCandidates(sql, limit);
                }),
              );
            }),
            options?.waitTimeoutMilliseconds ?? 0,
          ).pipe(Effect.mapError(cause => storeError('claim code graph reconciliation candidates', cause))),
        prepareWorktreeReconciliationIndexes: (databasePath, options) =>
          withWriterGate(
            databasePath,
            Effect.gen(function* () {
              yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
              if (!(yield* fs.exists(databasePath))) {
                return {reason: 'incompatible-schema', state: 'deferred'} as const;
              }
              if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
              }
              if ((yield* fs.stat(databasePath)).type !== 'File') {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
              }
              return yield* useExistingDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe('PRAGMA foreign_keys = ON');
                  yield* sql.unsafe('PRAGMA busy_timeout = 0');
                  return yield* sql.withTransaction(prepareWorktreeReconciliationIndex(sql));
                }),
              );
            }),
            options?.waitTimeoutMilliseconds ?? 0,
          ).pipe(Effect.mapError(cause => storeError('prepare code graph reconciliation indexes', cause))),
        removeView: (databasePath, worktreeId, expectedSnapshotId, options) =>
          withWriterGate(
            databasePath,
            Effect.gen(function* () {
              yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
              if (!(yield* fs.exists(databasePath))) {
                return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewRemovalResult;
              }
              if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
              }
              if ((yield* fs.stat(databasePath)).type !== 'File') {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
              }
              const remove = Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                if (options?.requireReconciliationSchema === true) {
                  yield* sql.unsafe('PRAGMA foreign_keys = ON');
                  yield* sql.unsafe('PRAGMA busy_timeout = 0');
                } else {
                  yield* initializeSchema(sql);
                }
                return yield* removeActiveView(
                  sql,
                  worktreeId,
                  expectedSnapshotId,
                  options?.requireReconciliationSchema === true,
                  options?.cleanupEvidence,
                );
              });
              const result = yield* options?.requireReconciliationSchema === true
                ? useExistingDatabase(databasePath, remove)
                : useDatabase(databasePath, remove);
              return result as CodeGraphViewRemovalResult;
            }),
            // View removal is opportunistic foreground maintenance. Never
            // queue it behind a checkout writer unless an internal caller
            // explicitly opts into a bounded wait.
            options?.waitTimeoutMilliseconds ?? 0,
          ).pipe(
            Effect.tap(result =>
              options?.requireReconciliationSchema !== true &&
              'retiredSnapshots' in result &&
              result.retiredSnapshots > 0
                ? scheduleRetiredSnapshotCleanup(databasePath)
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('remove code graph view', cause)),
          ),
        claimRemovedViewCleanupCandidates: (databasePath, nowMilliseconds, limit, options) =>
          withWriterGate(
            databasePath,
            Effect.gen(function* () {
              yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
              if (!(yield* fs.exists(databasePath))) return [];
              if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
              }
              if ((yield* fs.stat(databasePath)).type !== 'File') {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
              }
              return yield* useExistingDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe('PRAGMA foreign_keys = ON');
                  yield* sql.unsafe('PRAGMA busy_timeout = 0');
                  return yield* claimRemovedViewCleanupCandidates(sql, nowMilliseconds, limit);
                }),
              );
            }),
            options?.waitTimeoutMilliseconds ?? 0,
          ).pipe(Effect.mapError(cause => storeError('claim removed code graph view cleanup', cause))),
        authorizeRemovedViewCleanup: (databasePath, entry, options) =>
          withWriterGate(
            databasePath,
            Effect.gen(function* () {
              yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
              if (!(yield* fs.exists(databasePath))) return {state: 'stale'} as const;
              if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
              }
              if ((yield* fs.stat(databasePath)).type !== 'File') {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
              }
              return yield* useExistingDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe('PRAGMA foreign_keys = ON');
                  yield* sql.unsafe('PRAGMA busy_timeout = 0');
                  return yield* authorizeRemovedViewCleanup(sql, entry);
                }),
              );
            }),
            options?.waitTimeoutMilliseconds ?? 0,
          ).pipe(Effect.mapError(cause => storeError('authorize removed code graph view cleanup', cause))),
        updateRemovedViewCleanup: (databasePath, entry, update, options) =>
          withWriterGate(
            databasePath,
            Effect.gen(function* () {
              yield* options?.beforeDatabaseOpen?.() ?? Effect.void;
              if (!(yield* fs.exists(databasePath))) return {state: 'stale'} as const;
              if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is a symbolic link.'));
              }
              if ((yield* fs.stat(databasePath)).type !== 'File') {
                return yield* Effect.fail(new CodeGraphStoreError('Code graph database target is not a regular file.'));
              }
              return yield* useExistingDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe('PRAGMA foreign_keys = ON');
                  yield* sql.unsafe('PRAGMA busy_timeout = 0');
                  return yield* updateRemovedViewCleanup(sql, entry, update);
                }),
              );
            }),
            options?.waitTimeoutMilliseconds ?? 0,
          ).pipe(Effect.mapError(cause => storeError('update removed code graph view cleanup', cause))),
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
                      persistentCapacityProtector,
                    );
                  }
                }),
              ),
            ),
            Effect.mapError(cause => storeError('prepare staged code graph activation', cause)),
          ),
        finalizePersistentMaterializationPlan: (databasePath, expectedBatchCount, persistentCapacityProtector) =>
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
                }),
              ),
            ),
            Effect.mapError(cause => storeError('finalize persistent code graph materialization plan', cause)),
          ),
        preparePersistedIncrementalActivation: (databasePath, baseSnapshotId, files, facts, options) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* ensureSchemaInitialized(databasePath, sql);
                  return yield* preparePersistedIncrementalActivation(baseSnapshotId, files, facts, options);
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
        loadMaterializedFileShards: (databasePath, files, extractorSet, derivationIdentity) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useReadOnlyDatabase(databasePath, selectMaterializedFileShards(files, extractorSet, derivationIdentity)),
            ),
            Effect.mapError(cause => storeError('load materialized code graph file shards', cause)),
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
        loadVisualizationCatalog: (databasePath, metrics = 'complete', options = {}) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useReadOnlyDatabase(databasePath, selectVisualizationCatalog(undefined, metrics, options))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load code graph visualization catalog', cause)),
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
              exists
                ? useReadOnlyDatabase(databasePath, selectVisualizationScopeEdges(snapshotId))
                : Effect.succeed([]),
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
              exists
                ? useReadOnlyDatabase(databasePath, selectResumableBuildById(snapshotId))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load resumable code graph snapshot by identity', cause)),
          ),
        retireIncompleteWorktreeSnapshots: (databasePath, repositoryId, worktreeId, retainedSnapshotIds, onProgress) =>
          Effect.gen(function* () {
            yield* prepare(databasePath);
            return yield* useDatabase(
              databasePath,
              retireIncompleteWorktreeSnapshots(
                repositoryId,
                worktreeId,
                retainedSnapshotIds,
                effect => withWriterGate(databasePath, effect),
                onProgress,
              ),
            );
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
        reusableCleanBase: (
          databasePath,
          repositoryId,
          extractorSet,
          workspaceFingerprint,
          fileSetFingerprint,
          graphContentId,
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
                    ),
                  )
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load reusable clean code graph base', cause)),
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
        repair: (databasePath, dryRun = false) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, repairDatabase(dryRun)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('repair code graph database', cause)),
          ),
        runRoutineMaintenance: (databasePath, options) =>
          Effect.gen(function* () {
            const writerLockPath = options?.writerLockPath ?? inferredCodeGraphWriterLockPath(path, databasePath);
            if (writerLockPath === undefined) {
              return {reason: 'writer-lock-unavailable', state: 'skipped'} as const;
            }
            if (!(yield* fs.exists(databasePath))) {
              return {reason: 'database-missing', state: 'skipped'} as const;
            }
            const runPage = Effect.gen(function* () {
              // Purge owns the same checkout gate. Re-check only after acquiring
              // it and open SQLite within the critical section, so maintenance
              // cannot recreate a removed database or retain a Windows handle.
              if (!(yield* fs.exists(databasePath))) {
                return {reason: 'database-missing', state: 'skipped'} as const;
              }
              return yield* useDatabaseDirect(databasePath, runRoutineMaintenancePage());
            });
            const withWriterLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              withExclusiveFileLock(fs, writerLockPath, CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS, effect);
            const ownerReconciliationAvailable =
              options?.threadnoteHome !== undefined &&
              options.checkoutId !== undefined &&
              /^[0-9a-f]{64}$/u.test(options.checkoutId);
            if (!ownerReconciliationAvailable) {
              return yield* withWriterLock(runPage).pipe(
                Effect.catch(error =>
                  isFileLockTimeout(error)
                    ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                    : Effect.fail(error),
                ),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              );
            }

            const probe = yield* withWriterLock(
              Effect.gen(function* () {
                if (!(yield* fs.exists(databasePath))) {
                  return {kind: 'result', result: {reason: 'database-missing', state: 'skipped'} as const} as const;
                }
                return yield* useDatabaseDirect(
                  databasePath,
                  Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    if (!(yield* initializeRoutineMaintenanceSchema(sql))) {
                      return {
                        kind: 'result',
                        result: {reason: 'schema-unavailable', state: 'skipped'} as const,
                      } as const;
                    }
                    const candidates = yield* selectPersistentBuildOwnerCandidates(sql);
                    return candidates.length > 0
                      ? ({candidates, kind: 'candidates'} as const)
                      : ({kind: 'result', result: yield* runRoutineMaintenancePage()} as const);
                  }),
                );
              }),
            ).pipe(
              Effect.catch(error =>
                isFileLockTimeout(error)
                  ? Effect.succeed({
                      kind: 'result',
                      result: {reason: 'writer-busy', state: 'deferred'} as const,
                    } as const)
                  : Effect.fail(error),
              ),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, system),
            );
            if (probe.kind === 'result') return probe.result;

            const validCandidates = probe.candidates.filter(persistentBuildOwnerCandidateValid);
            let candidate = validCandidates.find(owner => !system.isProcessRunning(owner.processId));
            if (candidate === undefined) {
              const selected = validCandidates[0];
              if (selected !== undefined && (yield* observePersistentBuildOwner(selected)) === 'dead') {
                candidate = selected;
              }
            }
            if (candidate === undefined) {
              return yield* withWriterLock(runPage).pipe(
                Effect.catch(error =>
                  isFileLockTimeout(error)
                    ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                    : Effect.fail(error),
                ),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              );
            }

            const ownerLayout = codeGraphLayout(
              path,
              options.threadnoteHome!,
              options.checkoutId!,
              candidate.worktreeId,
            );
            if (ownerLayout.databasePath !== databasePath || ownerLayout.databaseWriteLockPath !== writerLockPath) {
              return {reason: 'writer-lock-unavailable', state: 'skipped'} as const;
            }
            const worktreeLockPath = ownerLayout.lockPath;
            const snapshotLockPath = codeGraphSnapshotBuildLockPath(
              path,
              options.threadnoteHome!,
              options.checkoutId!,
              candidate.logicalSnapshotId,
            );
            const retire = withExclusiveFileLock(
              fs,
              worktreeLockPath,
              CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
              withExclusiveFileLock(
                fs,
                snapshotLockPath,
                CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
                Effect.gen(function* () {
                  if (yield* codeGraphMaintenanceIntentActive(options.threadnoteHome!)) {
                    return {reason: 'external-maintenance', state: 'deferred'} as const;
                  }
                  if (
                    (yield* corroborateCodeGraphBuildOwnerStatus(ownerLayout, candidate.worktreeId, candidate)) ===
                    'mismatch'
                  ) {
                    return {reason: 'owner-changed', state: 'deferred'} as const;
                  }
                  // The liveness proof must still hold after both target locks.
                  // A PID that appeared in the interval without an exact start
                  // identity changes the observation to unknown and refuses.
                  const liveness: CodeGraphBuildOwnerLiveness = yield* observePersistentBuildOwner(candidate);
                  if (liveness !== 'dead') return {reason: 'owner-changed', state: 'deferred'} as const;
                  return yield* withExclusiveFileLock(
                    fs,
                    writerLockPath,
                    CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS,
                    Effect.gen(function* () {
                      if (!(yield* fs.exists(databasePath))) {
                        return {reason: 'database-missing', state: 'skipped'} as const;
                      }
                      const outcome = yield* useDatabaseDirect(databasePath, retireAbandonedPersistentBuild(candidate));
                      if (outcome === 'retired') {
                        return {
                          cleanup: 'abandoned-build',
                          expiredLeases: 0,
                          remaining: true,
                          retiredSnapshots: 1,
                          rowsDeleted: 0,
                          state: 'completed',
                        } as const;
                      }
                      return {
                        reason: outcome === 'protected' ? ('owner-protected' as const) : ('owner-changed' as const),
                        state: 'deferred',
                      } as const;
                    }),
                  ).pipe(
                    Effect.catch(error =>
                      isFileLockTimeout(error)
                        ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                        : Effect.fail(error),
                    ),
                  );
                }),
              ).pipe(
                Effect.catch(error =>
                  isFileLockTimeout(error)
                    ? Effect.succeed({reason: 'snapshot-busy', state: 'deferred'} as const)
                    : Effect.fail(error),
                ),
              ),
            ).pipe(
              Effect.catch(error =>
                isFileLockTimeout(error)
                  ? Effect.succeed({reason: 'worktree-busy', state: 'deferred'} as const)
                  : Effect.fail(error),
              ),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, system),
            );
            const ownerResult = yield* retire;
            if (
              ownerResult.state === 'deferred' &&
              ['owner-changed', 'owner-protected', 'snapshot-busy', 'worktree-busy'].includes(ownerResult.reason)
            ) {
              const ordinary = yield* withWriterLock(runPage).pipe(
                Effect.catch(error =>
                  isFileLockTimeout(error)
                    ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                    : Effect.fail(error),
                ),
              );
              if (
                ordinary.state === 'completed' &&
                (ordinary.cleanup !== 'none' ||
                  ordinary.expiredLeases > 0 ||
                  ordinary.retiredSnapshots > 0 ||
                  ordinary.rowsDeleted > 0)
              ) {
                return ordinary;
              }
            }
            return ownerResult;
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
            Effect.mapError(cause => storeError('run routine code graph maintenance', cause)),
          ),
        releaseSnapshotLease: (databasePath, token, options) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? withWriterGate(
                    databasePath,
                    useDatabase(
                      databasePath,
                      Effect.gen(function* () {
                        const sql = yield* SqlClient.SqlClient;
                        yield* ensureLeaseSchemaInitialized(databasePath, sql);
                        yield* releaseSnapshotLease(token);
                        return yield* pruneRetiredSnapshotRowsPage();
                      }),
                    ),
                    options?.waitTimeoutMilliseconds,
                  ).pipe(
                    Effect.tap(cleanup =>
                      cleanup.remaining ? scheduleRetiredSnapshotCleanup(databasePath) : Effect.void,
                    ),
                    Effect.asVoid,
                  )
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('release code graph snapshot lease', cause)),
          ),
        renewSnapshotLease: (databasePath, token, durationMilliseconds, options) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? withWriterGate(
                    databasePath,
                    useDatabase(
                      databasePath,
                      Effect.gen(function* () {
                        const sql = yield* SqlClient.SqlClient;
                        yield* ensureLeaseSchemaInitialized(databasePath, sql);
                        yield* renewSnapshotLease(token, durationMilliseconds);
                        return yield* pruneRetiredSnapshotRowsPage();
                      }),
                    ),
                    options?.waitTimeoutMilliseconds,
                  ).pipe(
                    Effect.tap(cleanup =>
                      cleanup.remaining ? scheduleRetiredSnapshotCleanup(databasePath) : Effect.void,
                    ),
                    Effect.asVoid,
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
        stageActivationFactBatches: (databasePath, batches, onProgress, persistentCapacityProtector) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const mode = yield* activationMode(sql);
                  if (mode?.mode !== 'persisted-full') {
                    return yield* Effect.fail(
                      new CodeGraphStoreError('Grouped fact staging requires a persistent full build.'),
                    );
                  }
                  let prepared: readonly PreparedPersistedFullFactBatch[] | undefined;
                  if (persistentCapacityProtector) {
                    const preparation = preparePersistedFullFactCapacity(batches);
                    prepared = preparation.batches;
                    const transaction = withWriterGate(
                      databasePath,
                      stagePersistedFullFactBatches(
                        sql,
                        mode.snapshotId,
                        mode.ownerToken,
                        batches,
                        batchIndex =>
                          activationStagingObserver(
                            sql,
                            onProgress ? progress => onProgress(batchIndex, progress) : undefined,
                            'main',
                          ),
                        prepared,
                      ),
                    );
                    yield* persistentCapacityProtector(preparation.capacity, transaction);
                    return;
                  }
                  yield* withWriterGate(
                    databasePath,
                    stagePersistedFullFactBatches(
                      sql,
                      mode.snapshotId,
                      mode.ownerToken,
                      batches,
                      batchIndex =>
                        activationStagingObserver(
                          sql,
                          onProgress ? progress => onProgress(batchIndex, progress) : undefined,
                          'main',
                        ),
                      prepared,
                    ),
                  );
                }),
              ),
            ),
            Effect.mapError(cause => storeError('stage grouped code graph facts', cause)),
          ),
        stageWorkspaceCatalog: (databasePath, workspace, persistentCapacityProtector) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const mode = yield* activationMode(sql);
                  if (mode?.mode === 'persisted-full') {
                    const prepared = preparePersistedFullWorkspace(mode.snapshotId, workspace);
                    const transaction = withWriterGate(
                      databasePath,
                      stagePersistedFullWorkspace(sql, mode.snapshotId, mode.ownerToken, prepared),
                    );
                    yield* persistentCapacityProtector
                      ? persistentCapacityProtector(prepared.capacity, transaction)
                      : transaction;
                  } else {
                    yield* stageActivationWorkspace(workspace);
                  }
                }),
              ),
            ),
            Effect.mapError(cause => storeError('stage code graph workspace catalog', cause)),
          ),
        resolveStagedReferences: (databasePath, onProgress, persistentCapacityProtector) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                resolveActivationReferences(
                  onProgress,
                  effect => withWriterGate(databasePath, effect),
                  persistentCapacityProtector,
                ),
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

function useExistingDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    effect.pipe(
      Effect.provide(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readonly: false,
          readwrite: true,
        }),
      ),
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
    : SqliteClient.layer({disableWAL: true, filename: databasePath});
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

const CODE_GRAPH_ABANDONED_BUILD_LOCK_OPTIONS = {
  ...CODE_GRAPH_DETACHED_CLEANUP_LOCK_OPTIONS,
  recoverReusedProcessIdImmediately: true,
} as const;

const CODE_GRAPH_ABANDONED_BUILD_CANDIDATE_LIMIT = 64;
const CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY = 'routine_abandoned_build_owner_cursor';

const CODE_GRAPH_CLEANUP_YIELD_MILLISECONDS = CODE_GRAPH_SQL_WRITER_LOCK_OPTIONS.retryIntervalMilliseconds * 2;

function normalizedWriterGateWaitTimeout(waitTimeoutMilliseconds: number | undefined): number {
  if (waitTimeoutMilliseconds === undefined || waitTimeoutMilliseconds === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(waitTimeoutMilliseconds)) return 0;
  return Math.max(0, Math.floor(waitTimeoutMilliseconds));
}

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

type PersistentExtensionGroup = 'analysis' | 'build' | 'lexical' | 'shards';

export type CodeGraphPersistentSchemaMigrationPhase =
  | 'added-build-owner-instance'
  | 'added-materialization-plan'
  | 'added-removed-view-cleanup'
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
      requiredColumn('owner_token', 'TEXT'),
      requiredColumn('build_id', 'TEXT'),
      requiredColumn('process_id', 'INTEGER'),
      optionalColumn('process_start_identity', 'TEXT'),
      requiredColumn('logical_snapshot_id', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_build_owner_instances (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshot_build_owners(snapshot_id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      build_id TEXT NOT NULL,
      process_id INTEGER NOT NULL CHECK (process_id > 0),
      process_start_identity TEXT,
      logical_snapshot_id TEXT NOT NULL
    ) WITHOUT ROWID`,
    foreignKeys: [{from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshot_build_owners', to: 'snapshot_id'}],
    group: 'build',
    name: 'snapshot_build_owner_instances',
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
  {
    columns: [
      requiredColumn('id', 'TEXT', 1),
      requiredColumn('content_hash', 'TEXT'),
      requiredColumn('extractor_set', 'TEXT'),
      requiredColumn('derivation_identity', 'TEXT'),
      requiredColumn('path_hint', 'TEXT'),
      requiredColumn('facts_json', 'TEXT'),
      requiredColumn('created_at', 'TEXT'),
      requiredColumn('last_used_at', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS materialized_file_shards (
      id TEXT PRIMARY KEY NOT NULL,
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      derivation_identity TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE (content_hash, extractor_set, derivation_identity, path_hint)
    ) WITHOUT ROWID`,
    foreignKeys: [],
    group: 'shards',
    name: 'materialized_file_shards',
    uniqueKeys: [['content_hash', 'extractor_set', 'derivation_identity', 'path_hint']],
  },
  {
    columns: [
      requiredColumn('snapshot_id', 'TEXT', 1),
      requiredColumn('path', 'TEXT', 2),
      requiredColumn('shard_id', 'TEXT'),
    ],
    createSql: `CREATE TABLE IF NOT EXISTS snapshot_file_shards (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      shard_id TEXT NOT NULL REFERENCES materialized_file_shards(id) ON DELETE CASCADE,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID`,
    foreignKeys: [
      {from: 'snapshot_id', onDelete: 'CASCADE', table: 'snapshots', to: 'id'},
      {from: 'shard_id', onDelete: 'CASCADE', table: 'materialized_file_shards', to: 'id'},
    ],
    group: 'shards',
    name: 'snapshot_file_shards',
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
const REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY = 'removed_view_cleanup_admission_cursor';
const REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY = 'removed_view_cleanup_epoch_sequence';
const REMOVED_VIEW_CLEANUP_LEGACY_MAXIMUM_METADATA_ROWS = 64;
const REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS = 66;
const MAXIMUM_CANONICAL_DATE_MILLISECONDS = 253_402_300_799_999;

const REMOVED_VIEWS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS removed_views (
  worktree_id TEXT PRIMARY KEY NOT NULL,
  expected_snapshot_id TEXT NOT NULL,
  removed_at TEXT NOT NULL
) WITHOUT ROWID`;

const REMOVED_VIEW_CLEANUP_TABLE_SQL = `CREATE TABLE IF NOT EXISTS removed_view_cleanup (
  worktree_id TEXT NOT NULL CHECK (
    typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
  ),
  expected_snapshot_id TEXT NOT NULL CHECK (
    typeof(expected_snapshot_id) = 'text'
    AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
  ),
  removed_at TEXT NOT NULL CHECK (
    typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
  ),
  epoch INTEGER NOT NULL CHECK (
    typeof(epoch) = 'integer' AND epoch BETWEEN 1 AND 9007199254740991
  ),
  repository_id TEXT CHECK (
    repository_id IS NULL
    OR (typeof(repository_id) = 'text' AND length(CAST(repository_id AS BLOB)) = 64)
  ),
  provenance_record_digest TEXT CHECK (
    provenance_record_digest IS NULL
    OR (
      typeof(provenance_record_digest) = 'text'
      AND length(CAST(provenance_record_digest AS BLOB)) = 64
    )
  ),
  provenance_record_identity TEXT CHECK (
    provenance_record_identity IS NULL
    OR (
      typeof(provenance_record_identity) = 'text'
      AND length(CAST(provenance_record_identity AS BLOB)) = 64
    )
  ),
  phase TEXT NOT NULL CHECK (
    typeof(phase) = 'text'
    AND length(CAST(phase AS BLOB)) <= 15
    AND phase IN ('vector-pointers', 'build-status', 'provenance', 'complete')
  ),
  cursor_token TEXT CHECK (
    cursor_token IS NULL
    OR (typeof(cursor_token) = 'text' AND length(CAST(cursor_token AS BLOB)) BETWEEN 1 AND 512)
  ),
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991
  ),
  attempts INTEGER NOT NULL CHECK (
    typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at INTEGER NOT NULL CHECK (
    typeof(next_attempt_at) = 'integer' AND next_attempt_at BETWEEN 0 AND 253402300799999
  ),
  blocked_code TEXT CHECK (
    blocked_code IS NULL
    OR (
      typeof(blocked_code) = 'text'
      AND length(CAST(blocked_code AS BLOB)) BETWEEN 1 AND 32
      AND blocked_code IN (
        'busy', 'evidence-unavailable', 'invalid-sidecar',
        'io-error', 'permission-denied', 'schema-incompatible'
      )
    )
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24
  ),
  PRIMARY KEY (worktree_id, expected_snapshot_id),
  CHECK (phase <> 'complete' OR (cursor_token IS NULL AND blocked_code IS NULL)),
  CHECK (
    (repository_id IS NULL AND provenance_record_digest IS NULL AND provenance_record_identity IS NULL)
    OR (
      repository_id IS NOT NULL
      AND provenance_record_digest IS NOT NULL
      AND provenance_record_identity IS NOT NULL
    )
  )
) WITHOUT ROWID`;

const REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL = REMOVED_VIEW_CLEANUP_TABLE_SQL.replace(
  'CREATE TABLE IF NOT EXISTS',
  'CREATE TABLE',
);
const REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL_LITERAL = `'${REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL.replaceAll("'", "''")}'`;

const REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS removed_view_cleanup_due
  ON removed_view_cleanup (next_attempt_at, worktree_id, expected_snapshot_id)
  WHERE phase <> 'complete'`;

const REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL = `SELECT CASE
      WHEN (
        SELECT COUNT(*)
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'removed_view_cleanup' COLLATE NOCASE
          LIMIT 2
        )
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'removed_view_cleanup' COLLATE NOCASE
          LIMIT 2
        )
        WHERE name = 'removed_view_cleanup'
          AND type = 'table'
          AND tbl_name = 'removed_view_cleanup'
          AND sql = ${REMOVED_VIEW_CLEANUP_STORED_TABLE_SQL_LITERAL}
      )
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT seqno, cid, name, "desc", coll, "key"
          FROM pragma_index_xinfo('sqlite_autoindex_removed_view_cleanup_1')
          LIMIT 3
        )
        WHERE (
          seqno = 0 AND cid = 0 AND name = 'worktree_id'
            AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 1 AND cid = 1 AND name = 'expected_snapshot_id'
            AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 2 AND cid = 2 AND name = 'removed_at'
            AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
        )
      ) <> 3
      THEN RAISE(ABORT, 'code graph removed view cleanup authority is incompatible')
    END;`;

const REMOVED_VIEW_CLEANUP_REVOKE_DELETE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS removed_views_cleanup_revoke_delete
  AFTER DELETE ON removed_views
  BEGIN
    ${REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL}
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = OLD.worktree_id
      AND expected_snapshot_id = OLD.expected_snapshot_id
      AND removed_at = OLD.removed_at;
  END`;

const SNAPSHOT_LEASE_BATON_INDEX_TRIGGER_GUARD_SQL = `SELECT CASE
      WHEN (
        SELECT COUNT(*)
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'snapshot_leases_snapshot_expiry' COLLATE NOCASE
          LIMIT 2
        )
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM (
          SELECT name, type, tbl_name,
                 CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql ELSE NULL END AS sql
          FROM sqlite_master
          WHERE name = 'snapshot_leases_snapshot_expiry' COLLATE NOCASE
          LIMIT 2
        )
        WHERE name = 'snapshot_leases_snapshot_expiry'
          AND type = 'index'
          AND tbl_name = 'snapshot_leases'
          AND typeof(sql) = 'text'
          AND length(CAST(sql AS BLOB)) <= 1024
          AND sql = 'CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)'
      )
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT seqno, cid, name, "desc", coll, "key"
          FROM pragma_index_xinfo('snapshot_leases_snapshot_expiry')
          LIMIT 4
        )
      ) <> 3
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT seqno, cid, name, "desc", coll, "key"
          FROM pragma_index_xinfo('snapshot_leases_snapshot_expiry')
          LIMIT 4
        )
        WHERE (
          seqno = 0 AND name = 'snapshot_id' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 1 AND name = 'expires_at' AND "desc" = 0 AND coll = 'BINARY' AND "key" = 1
        ) OR (
          seqno = 2 AND cid = -1 AND name IS NULL AND "desc" = 0 AND coll = 'BINARY' AND "key" = 0
        )
      ) <> 3
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT
            typeof(token) AS token_type,
            length(CAST(token AS BLOB)) AS token_bytes,
            typeof(snapshot_id) AS snapshot_type,
            length(CAST(snapshot_id AS BLOB)) AS snapshot_bytes,
            CASE
              WHEN typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 253402300799999
              THEN 1 ELSE 0
            END AS expires_valid,
            CASE
              WHEN typeof(retire_when_inactive) = 'integer' AND retire_when_inactive IN (0, 1)
              THEN 1 ELSE 0
            END AS retire_valid
          FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
          WHERE snapshot_id = NEW.expected_snapshot_id
            AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
          ORDER BY expires_at
          LIMIT 1
        )
        WHERE token_type <> 'text'
          OR token_bytes NOT BETWEEN 1 AND 1024
          OR snapshot_type <> 'text'
          OR snapshot_bytes NOT BETWEEN 1 AND 1024
          OR expires_valid <> 1
          OR retire_valid <> 1
      )
      THEN RAISE(ABORT, 'code graph snapshot lease baton index is incompatible')
    END;`
  .replace(/\s+/gu, ' ')
  .trim();

const REMOVED_VIEW_CLEANUP_REVOKE_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS removed_views_cleanup_revoke_insert
  AFTER INSERT ON removed_views
  BEGIN
    ${REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL}
    ${SNAPSHOT_LEASE_BATON_INDEX_TRIGGER_GUARD_SQL}
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = NEW.worktree_id
      AND expected_snapshot_id = NEW.expected_snapshot_id;
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = (
      SELECT rowid
      FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
      WHERE snapshot_id = NEW.expected_snapshot_id
        AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ORDER BY expires_at
      LIMIT 1
    );
  END`;

const REMOVED_VIEW_CLEANUP_REVOKE_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS removed_views_cleanup_revoke_update
  AFTER UPDATE OF worktree_id, expected_snapshot_id, removed_at ON removed_views
  WHEN OLD.worktree_id <> NEW.worktree_id
    OR OLD.expected_snapshot_id <> NEW.expected_snapshot_id
    OR OLD.removed_at <> NEW.removed_at
  BEGIN
    ${REMOVED_VIEW_CLEANUP_PRIMARY_KEY_TRIGGER_GUARD_SQL}
    ${SNAPSHOT_LEASE_BATON_INDEX_TRIGGER_GUARD_SQL}
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = OLD.worktree_id
      AND expected_snapshot_id = OLD.expected_snapshot_id
      AND removed_at = OLD.removed_at
      AND phase <> 'complete';
    DELETE FROM removed_view_cleanup
    WHERE worktree_id = NEW.worktree_id
      AND expected_snapshot_id = NEW.expected_snapshot_id;
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = (
      SELECT rowid
      FROM snapshot_leases INDEXED BY snapshot_leases_snapshot_expiry
      WHERE snapshot_id = NEW.expected_snapshot_id
        AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ORDER BY expires_at
      LIMIT 1
    );
  END`;

const REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS = [
  {name: 'removed_views_cleanup_revoke_delete', sql: REMOVED_VIEW_CLEANUP_REVOKE_DELETE_TRIGGER_SQL},
  {name: 'removed_views_cleanup_revoke_insert', sql: REMOVED_VIEW_CLEANUP_REVOKE_INSERT_TRIGGER_SQL},
  {name: 'removed_views_cleanup_revoke_update', sql: REMOVED_VIEW_CLEANUP_REVOKE_UPDATE_TRIGGER_SQL},
] as const;

const REMOVED_VIEW_CLEANUP_COLUMNS = [
  {name: 'worktree_id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
  {name: 'expected_snapshot_id', notNull: true, primaryKeyPosition: 2, type: 'TEXT'},
  {name: 'removed_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'epoch', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'repository_id', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'provenance_record_digest', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'provenance_record_identity', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'phase', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'cursor_token', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'revision', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'attempts', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'next_attempt_at', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  {name: 'blocked_code', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  {name: 'updated_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
] as const;

const SCHEMA_METADATA_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
)`;

const inspectBoundedSchemaMetadataRowCount = Effect.fn('codeGraph.inspectBoundedSchemaMetadataRowCount')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe(
    `SELECT 1 FROM schema_metadata LIMIT ${REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS + 1}`,
  );
  return rows.length > REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS ? undefined : rows.length;
});

const inspectBoundedSchemaMetadataValue = Effect.fn('codeGraph.inspectBoundedSchemaMetadataValue')(function* (
  sql: SqlClient.SqlClient,
  key: string,
  maximumValueBytes: number,
) {
  if ((yield* inspectBoundedSchemaMetadataRowCount(sql)) === undefined) {
    return {state: 'invalid'} as const;
  }
  const rows = yield* sql.unsafe<{
    readonly bounded_key: unknown;
    readonly bounded_value: unknown;
    readonly key_bytes: unknown;
    readonly key_type: unknown;
    readonly value_bytes: unknown;
    readonly value_type: unknown;
  }>(
    `SELECT
       CASE
         WHEN typeof(key) = 'text' AND length(CAST(key AS BLOB)) <= ? THEN key
         ELSE NULL
       END AS bounded_key,
       CASE
         WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? THEN value
         ELSE NULL
       END AS bounded_value,
       typeof(key) AS key_type,
       length(CAST(key AS BLOB)) AS key_bytes,
       typeof(value) AS value_type,
       length(CAST(value AS BLOB)) AS value_bytes
     FROM schema_metadata
     WHERE key = ? COLLATE NOCASE
     LIMIT 3`,
    [key.length, maximumValueBytes, key],
  );
  if (rows.length === 0) return {state: 'missing'} as const;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.bounded_key !== key ||
    row.key_type !== 'text' ||
    row.key_bytes !== key.length ||
    row.value_type !== 'text' ||
    typeof row.value_bytes !== 'number' ||
    !Number.isSafeInteger(row.value_bytes) ||
    row.value_bytes < 0 ||
    row.value_bytes > maximumValueBytes ||
    typeof row.bounded_value !== 'string'
  ) {
    return {state: 'invalid'} as const;
  }
  return {state: 'recorded', value: row.bounded_value} as const;
});

const removedViewAuthorityTableState = Effect.fn('codeGraph.removedViewAuthorityTableState')(function* (
  sql: SqlClient.SqlClient,
) {
  const objects = yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 512 THEN sql
              ELSE NULL
            END AS sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = 'removed_views' COLLATE NOCASE
     LIMIT 2`,
  );
  if (objects.length === 0) return 'absent' as const;
  const object = objects[0];
  if (
    objects.length !== 1 ||
    object?.name !== 'removed_views' ||
    object.type !== 'table' ||
    object.tbl_name !== 'removed_views' ||
    typeof object.sql_bytes !== 'number' ||
    !Number.isSafeInteger(object.sql_bytes) ||
    object.sql_bytes > 512 ||
    typeof object.sql !== 'string' ||
    normalizeSchemaDefinition(object.sql) !== normalizeSchemaDefinition(REMOVED_VIEWS_TABLE_SQL)
  ) {
    return 'incompatible' as const;
  }
  const columns = yield* sql.unsafe<{
    readonly dflt_value: unknown;
    readonly hidden: unknown;
    readonly name: unknown;
    readonly notnull: unknown;
    readonly pk: unknown;
    readonly type: unknown;
  }>(`SELECT * FROM pragma_table_xinfo('removed_views') LIMIT 4`);
  const expected = [
    {name: 'worktree_id', pk: 1},
    {name: 'expected_snapshot_id', pk: 0},
    {name: 'removed_at', pk: 0},
  ] as const;
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const contract = expected[index];
      return (
        contract === undefined ||
        column.name !== contract.name ||
        column.type !== 'TEXT' ||
        column.notnull !== 1 ||
        column.pk !== contract.pk ||
        column.hidden !== 0 ||
        column.dflt_value !== null
      );
    }) ||
    (yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_views') LIMIT 1`)).length !== 0
  ) {
    return 'incompatible' as const;
  }
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique: unknown;
  }>(`SELECT name, origin, partial, "unique" AS "unique" FROM pragma_index_list('removed_views') LIMIT 2`);
  if (
    indexes.length !== 1 ||
    indexes[0]?.name !== 'sqlite_autoindex_removed_views_1' ||
    indexes[0]?.origin !== 'pk' ||
    indexes[0]?.unique !== 1 ||
    indexes[0]?.partial !== 0
  ) {
    return 'incompatible' as const;
  }
  const primary = yield* sql.unsafe<{
    readonly cid: unknown;
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT * FROM pragma_index_xinfo('sqlite_autoindex_removed_views_1') LIMIT 4`);
  return primary.length === 3 &&
    primary[0]?.seqno === 0 &&
    primary[0]?.cid === 0 &&
    primary[0]?.name === 'worktree_id' &&
    primary[0]?.desc === 0 &&
    primary[0]?.coll === 'BINARY' &&
    primary[0]?.key === 1 &&
    primary
      .slice(1)
      .every(
        (column, index) =>
          column.seqno === index + 1 &&
          column.cid === index + 1 &&
          column.name === expected[index + 1]?.name &&
          column.desc === 0 &&
          column.coll === 'BINARY' &&
          column.key === 0,
      )
    ? ('compatible' as const)
    : ('incompatible' as const);
});

const removedViewCleanupSchemaState = Effect.fn('codeGraph.removedViewCleanupSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  const objects = yield* sql.unsafe<{
    readonly name: string;
    readonly sql: string | null;
    readonly sql_bytes: number | null;
    readonly tbl_name: string;
    readonly type: string;
  }>(
    `SELECT type, name, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
              ELSE NULL
            END AS sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE lower(name) IN ('removed_view_cleanup', 'removed_view_cleanup_due')
        OR (type = 'trigger' AND tbl_name = 'removed_views' COLLATE NOCASE)
     ORDER BY name, type
     LIMIT 6`,
  );
  const expectedNames = new Set([
    'removed_view_cleanup',
    'removed_view_cleanup_due',
    ...REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => trigger.name),
  ]);
  if (
    objects.some(
      object =>
        object.name !== object.name.toLowerCase() ||
        !expectedNames.has(object.name) ||
        typeof object.sql_bytes !== 'number' ||
        !Number.isSafeInteger(object.sql_bytes) ||
        object.sql_bytes > 8192,
    )
  ) {
    return 'incompatible' as const;
  }
  const tables = objects.filter(object => object.name === 'removed_view_cleanup');
  const dueObjects = objects.filter(object => object.name === 'removed_view_cleanup_due');
  const triggerObjects = objects.filter(object =>
    REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.some(trigger => trigger.name === object.name),
  );
  if (tables.length === 0) {
    return dueObjects.length === 0 && triggerObjects.length === 0 ? ('absent' as const) : ('incompatible' as const);
  }
  if (
    tables.length !== 1 ||
    tables[0]?.type !== 'table' ||
    tables[0]?.tbl_name !== 'removed_view_cleanup' ||
    typeof tables[0]?.sql !== 'string' ||
    dueObjects.some(object => object.type !== 'index' || object.tbl_name !== 'removed_view_cleanup') ||
    triggerObjects.length !== REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.length ||
    REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.some(expected => {
      const observed = triggerObjects.find(object => object.name === expected.name);
      return (
        observed?.type !== 'trigger' ||
        observed.tbl_name !== 'removed_views' ||
        typeof observed.sql !== 'string' ||
        normalizeSchemaDefinition(observed.sql) !== normalizeSchemaDefinition(expected.sql)
      );
    })
  ) {
    return 'incompatible' as const;
  }
  const columns = yield* sql.unsafe<{
    readonly hidden: number;
    readonly name: string;
    readonly notnull: number;
    readonly pk: number;
    readonly type: string;
  }>(`SELECT * FROM pragma_table_xinfo('removed_view_cleanup') LIMIT ${REMOVED_VIEW_CLEANUP_COLUMNS.length + 1}`);
  const compatibleColumns =
    columns.length === REMOVED_VIEW_CLEANUP_COLUMNS.length &&
    columns.every((column, index) => {
      const expected = REMOVED_VIEW_CLEANUP_COLUMNS[index];
      return (
        expected !== undefined &&
        Number(column.hidden) === 0 &&
        column.name === expected.name &&
        column.type.toUpperCase() === expected.type &&
        Number(column.notnull) === Number(expected.notNull) &&
        Number(column.pk) === expected.primaryKeyPosition
      );
    });
  const compatibleDefinition =
    normalizeSchemaDefinition(tables[0].sql) === normalizeSchemaDefinition(REMOVED_VIEW_CLEANUP_TABLE_SQL);
  const foreignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_view_cleanup') LIMIT 1`);
  const triggers = yield* sql.unsafe(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND tbl_name = 'removed_view_cleanup' COLLATE NOCASE
     LIMIT 1`,
  );
  if (!compatibleColumns || !compatibleDefinition || foreignKeys.length !== 0 || triggers.length !== 0) {
    return 'incompatible' as const;
  }

  const indexes = yield* sql.unsafe<{
    readonly name: string;
    readonly origin: string;
    readonly partial: number;
    readonly unique: number;
  }>(`SELECT name, origin, partial, "unique" AS "unique"
      FROM pragma_index_list('removed_view_cleanup') LIMIT 3`);
  const primary = indexes.find(index => index.origin === 'pk');
  const due = indexes.find(index => index.name === 'removed_view_cleanup_due');
  if (due === undefined) {
    // Building this index over an existing queue would be unbounded startup
    // work. Revision 8 creates the empty table and index atomically instead.
    return 'incompatible' as const;
  }
  if (primary?.name !== 'sqlite_autoindex_removed_view_cleanup_1') return 'incompatible' as const;
  const primaryColumns = yield* sql.unsafe<{
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(
    `SELECT seqno, name, desc, coll, key
     FROM pragma_index_xinfo('sqlite_autoindex_removed_view_cleanup_1')
     LIMIT ${REMOVED_VIEW_CLEANUP_COLUMNS.length + 1}`,
  );
  if (
    primaryColumns.length !== REMOVED_VIEW_CLEANUP_COLUMNS.length ||
    primaryColumns.some(
      (column, index) =>
        column.seqno !== index ||
        column.name !== REMOVED_VIEW_CLEANUP_COLUMNS[index]?.name ||
        column.desc !== 0 ||
        column.coll !== 'BINARY' ||
        column.key !== (index < 2 ? 1 : 0),
    )
  ) {
    return 'incompatible' as const;
  }
  return dueObjects.length === 1 &&
    indexes.length === 2 &&
    primary !== undefined &&
    Number(primary.unique) === 1 &&
    Number(primary.partial) === 0 &&
    Number(due.unique) === 0 &&
    due.origin === 'c' &&
    Number(due.partial) === 1 &&
    normalizeSchemaDefinition(dueObjects[0]?.sql ?? '') ===
      normalizeSchemaDefinition(REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL)
    ? ('compatible' as const)
    : ('incompatible' as const);
});

const removedViewCleanupRecordedRevision = Effect.fn('codeGraph.removedViewCleanupRecordedRevision')(function* (
  sql: SqlClient.SqlClient,
) {
  const metadataObjects = yield* sql.unsafe<{
    readonly name: unknown;
    readonly sql: unknown;
    readonly sql_bytes: unknown;
    readonly sql_type: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 256 THEN sql
              ELSE NULL
            END AS sql,
            typeof(sql) AS sql_type,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = 'schema_metadata' COLLATE NOCASE
     ORDER BY type
     LIMIT 2`,
  );
  if (metadataObjects.length === 0) return {metadataPresent: false, state: 'missing'};
  if (
    metadataObjects.length !== 1 ||
    metadataObjects[0]?.name !== 'schema_metadata' ||
    metadataObjects[0]?.type !== 'table' ||
    metadataObjects[0]?.tbl_name !== 'schema_metadata' ||
    metadataObjects[0]?.sql_type !== 'text' ||
    typeof metadataObjects[0]?.sql_bytes !== 'number' ||
    !Number.isSafeInteger(metadataObjects[0].sql_bytes) ||
    metadataObjects[0].sql_bytes > 256 ||
    typeof metadataObjects[0]?.sql !== 'string' ||
    normalizeSchemaDefinition(metadataObjects[0].sql) !== normalizeSchemaDefinition(SCHEMA_METADATA_TABLE_SQL)
  ) {
    return {state: 'invalid'};
  }
  const columns = yield* sql.unsafe<{
    readonly dflt_value: unknown;
    readonly hidden: unknown;
    readonly name: unknown;
    readonly notnull: unknown;
    readonly pk: unknown;
    readonly type: unknown;
  }>(`SELECT * FROM pragma_table_xinfo('schema_metadata') LIMIT 3`);
  if (
    columns.length !== 2 ||
    columns[0]?.name !== 'key' ||
    columns[0]?.type !== 'TEXT' ||
    Number(columns[0]?.notnull) !== 1 ||
    Number(columns[0]?.pk) !== 1 ||
    Number(columns[0]?.hidden) !== 0 ||
    columns[0]?.dflt_value !== null ||
    columns[1]?.name !== 'value' ||
    columns[1]?.type !== 'TEXT' ||
    Number(columns[1]?.notnull) !== 1 ||
    Number(columns[1]?.pk) !== 0 ||
    Number(columns[1]?.hidden) !== 0 ||
    columns[1]?.dflt_value !== null
  ) {
    return {state: 'invalid'};
  }
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly origin: unknown;
    readonly partial: unknown;
    readonly unique: unknown;
  }>(`SELECT name, origin, partial, "unique" AS "unique" FROM pragma_index_list('schema_metadata') LIMIT 2`);
  if (
    indexes.length !== 1 ||
    indexes[0]?.name !== 'sqlite_autoindex_schema_metadata_1' ||
    indexes[0]?.origin !== 'pk' ||
    Number(indexes[0]?.unique) !== 1 ||
    Number(indexes[0]?.partial) !== 0
  ) {
    return {state: 'invalid'};
  }
  const keyIndex = yield* sql.unsafe<{
    readonly cid: unknown;
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT * FROM pragma_index_xinfo('sqlite_autoindex_schema_metadata_1') LIMIT 3`);
  if (
    keyIndex.length !== 2 ||
    Number(keyIndex[0]?.seqno) !== 0 ||
    Number(keyIndex[0]?.cid) !== 0 ||
    keyIndex[0]?.name !== 'key' ||
    Number(keyIndex[0]?.desc) !== 0 ||
    keyIndex[0]?.coll !== 'BINARY' ||
    Number(keyIndex[0]?.key) !== 1 ||
    Number(keyIndex[1]?.seqno) !== 1 ||
    Number(keyIndex[1]?.cid) !== -1 ||
    keyIndex[1]?.name !== null ||
    Number(keyIndex[1]?.desc) !== 0 ||
    keyIndex[1]?.coll !== 'BINARY' ||
    Number(keyIndex[1]?.key) !== 0
  ) {
    return {state: 'invalid'};
  }
  const foreignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('schema_metadata') LIMIT 1`);
  const triggers = yield* sql.unsafe(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'schema_metadata' COLLATE NOCASE LIMIT 1",
  );
  if (foreignKeys.length !== 0 || triggers.length !== 0) return {state: 'invalid'};

  const revision = yield* inspectBoundedSchemaMetadataValue(sql, 'persistent_extension_schema_revision', 16);
  if (revision.state === 'missing') return {metadataPresent: true, state: 'missing'};
  if (
    revision.state === 'invalid' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(revision.value) ||
    !Number.isSafeInteger(Number(revision.value))
  ) {
    return {state: 'invalid'};
  }
  return {state: 'recorded', value: Number(revision.value)};
});

const preflightRemovedViewCleanupSchema = Effect.fn('codeGraph.preflightRemovedViewCleanupSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  const removedViewAuthority = yield* removedViewAuthorityTableState(sql);
  if (removedViewAuthority === 'incompatible') {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority schema is incompatible.'));
  }
  const schema = yield* removedViewCleanupSchemaState(sql);
  if (schema === 'incompatible') {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is incompatible.'));
  }
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const recordedRevision = revision.state === 'recorded' ? revision.value : undefined;
  if (recordedRevision !== undefined && recordedRevision > CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph persistent extension schema ${recordedRevision} is newer than ${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}.`,
      ),
    );
  }
  const leaseObjects = yield* sql.unsafe<{readonly name: unknown; readonly type: unknown}>(
    `SELECT name, type
     FROM sqlite_master
     WHERE name = 'snapshot_leases' COLLATE NOCASE
     LIMIT 2`,
  );
  if (
    leaseObjects.length > 1 ||
    (leaseObjects.length === 1 && (leaseObjects[0]?.name !== 'snapshot_leases' || leaseObjects[0]?.type !== 'table'))
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease schema is incompatible.'));
  }
  if (leaseObjects.length === 1) {
    const expiryIndexState = yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX);
    if (expiryIndexState === 'incompatible') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease expiry index is incompatible.'));
    }
    if (expiryIndexState === 'missing') {
      const rows = yield* sql.unsafe('SELECT 1 FROM snapshot_leases LIMIT 1');
      if (revision.state !== 'missing' || rows.length !== 0) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease expiry index is unavailable.'));
      }
    }
  }
  const metadataPresent = revision.state === 'recorded' || (revision.state === 'missing' && revision.metadataPresent);
  const metadataRowCount = metadataPresent ? yield* inspectBoundedSchemaMetadataRowCount(sql) : 0;
  const epochSequence = metadataPresent
    ? yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16)
    : ({state: 'missing'} as const);
  const admissionCursor = metadataPresent
    ? yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY, 64)
    : ({state: 'missing'} as const);
  const epochSequenceCurrent =
    epochSequence.state === 'recorded' &&
    /^(?:0|[1-9][0-9]*)$/u.test(epochSequence.value) &&
    Number.isSafeInteger(Number(epochSequence.value));
  const cursorCurrent =
    admissionCursor.state === 'missing' ||
    (admissionCursor.state === 'recorded' && /^[0-9a-f]{64}$/u.test(admissionCursor.value));
  const ownerInstanceMarkerObjects =
    schema === 'absent' && revision.state === 'missing'
      ? yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE name = 'snapshot_build_owner_instances' COLLATE NOCASE
           LIMIT 1`,
        )
      : [];
  const coreAuthorityCurrent =
    recordedRevision !== undefined && recordedRevision >= 7
      ? yield* codeGraphWorktreeReconciliationSchemaCompatible(
          sql,
          schema === 'compatible',
          false,
          removedViewAuthority === 'compatible',
        )
      : true;
  if (
    revision.state === 'invalid' ||
    metadataRowCount === undefined ||
    epochSequence.state === 'invalid' ||
    (epochSequence.state === 'recorded' && !epochSequenceCurrent) ||
    !cursorCurrent ||
    (schema === 'absent' &&
      recordedRevision !== undefined &&
      recordedRevision >= CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION) ||
    (schema === 'absent' && (epochSequence.state !== 'missing' || admissionCursor.state !== 'missing')) ||
    (schema === 'absent' &&
      metadataRowCount >
        REMOVED_VIEW_CLEANUP_LEGACY_MAXIMUM_METADATA_ROWS -
          (revision.state === 'missing' && revision.metadataPresent ? 1 : 0)) ||
    (schema === 'compatible' &&
      (recordedRevision !== CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION || !epochSequenceCurrent)) ||
    (schema === 'compatible' && removedViewAuthority !== 'compatible') ||
    (schema === 'compatible' &&
      metadataRowCount >
        (admissionCursor.state === 'missing'
          ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
          : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS)) ||
    ownerInstanceMarkerObjects.length > 0 ||
    !coreAuthorityCurrent
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is incompatible.'));
  }
  // Table and index creation plus r8 recording are one transaction. A partial
  // state is drift, not a recovery surface, and must never be self-healed.
});

const removedViewCleanupSchemaCurrent = Effect.fn('codeGraph.removedViewCleanupSchemaCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  return (yield* removedViewCleanupSchemaState(sql)) === 'compatible';
});

const inspectRemovedViewCleanupAdmissionCursor = Effect.fn('codeGraph.inspectRemovedViewCleanupAdmissionCursor')(
  function* (sql: SqlClient.SqlClient) {
    const inspection = yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY, 64);
    if (inspection.state === 'missing') return {current: true, cursor: undefined} as const;
    if (inspection.state === 'invalid' || !/^[0-9a-f]{64}$/u.test(inspection.value)) {
      return {current: false, cursor: undefined} as const;
    }
    return {current: true, cursor: inspection.value} as const;
  },
);

const removedViewCleanupEpochSequenceCurrent = Effect.fn('codeGraph.removedViewCleanupEpochSequenceCurrent')(function* (
  sql: SqlClient.SqlClient,
) {
  const inspection = yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16);
  return (
    inspection.state === 'recorded' &&
    /^(?:0|[1-9][0-9]*)$/u.test(inspection.value) &&
    Number.isSafeInteger(Number(inspection.value))
  );
});

interface CodeGraphRemovedViewCleanupSchemaAdmission {
  readonly current: boolean;
  readonly persistentExtensionSchemaRevision: number | undefined;
}

/** Exact read-only admission shared by cleanup writers and both health paths. */
export const codeGraphRemovedViewCleanupSchemaAdmission: (
  sql: SqlClient.SqlClient,
) => Effect.Effect<CodeGraphRemovedViewCleanupSchemaAdmission, SqlError.SqlError> = Effect.fn(
  'codeGraph.removedViewCleanupSchemaAdmission',
)(function* (sql: SqlClient.SqlClient) {
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const persistentExtensionSchemaRevision = revision.state === 'recorded' ? revision.value : undefined;
  if (persistentExtensionSchemaRevision !== CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION) {
    return {current: false, persistentExtensionSchemaRevision} as const;
  }
  if (!(yield* removedViewCleanupEpochSequenceCurrent(sql))) {
    return {current: false, persistentExtensionSchemaRevision} as const;
  }
  const metadataRowCount = yield* inspectBoundedSchemaMetadataRowCount(sql);
  if (metadataRowCount === undefined) {
    return {current: false, persistentExtensionSchemaRevision} as const;
  }
  const admissionCursor = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
  return {
    current:
      admissionCursor.current &&
      metadataRowCount <=
        (admissionCursor.cursor === undefined
          ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
          : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS) &&
      (yield* removedViewAuthorityTableState(sql)) === 'compatible' &&
      (yield* removedViewCleanupSchemaCurrent(sql)) &&
      (yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, true, false)),
    persistentExtensionSchemaRevision,
  } as const;
});

const ensureRemovedViewCleanupSchema = Effect.fn('codeGraph.ensureRemovedViewCleanupSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* preflightRemovedViewCleanupSchema(sql);
  yield* sql.unsafe(REMOVED_VIEW_CLEANUP_TABLE_SQL);
  yield* sql.unsafe(REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL);
  for (const trigger of REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS) yield* sql.unsafe(trigger.sql);
  if (!(yield* removedViewCleanupSchemaCurrent(sql))) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is incompatible.'));
  }
});
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
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, true, false))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph cleanup authority schema is incompatible.'));
      }
      const cleanupSchemaState = yield* removedViewCleanupSchemaState(sql);
      yield* ensureRemovedViewCleanupSchema(sql);
      if (cleanupSchemaState === 'absent') {
        yield* sql`
          INSERT INTO schema_metadata (key, value)
          VALUES (${REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY}, '0')
        `;
        yield* observe?.('added-removed-view-cleanup') ?? Effect.void;
      }
      if (recordedRevision === 6) {
        const ownerInstances = PERSISTENT_EXTENSION_TABLES.find(
          table => table.name === 'snapshot_build_owner_instances',
        );
        if (ownerInstances === undefined) {
          return yield* Effect.fail(new CodeGraphStoreError('Persistent build owner instance schema is unavailable.'));
        }
        const inspection = yield* persistentExtensionTableInspection(sql, ownerInstances);
        if (!inspection.exists) {
          // Revision 7 adds only exact owner-instance evidence. Never infer it
          // from legacy PID-bearing tokens: an old writer may still replace the
          // parent row, and the strict token join must then fail closed.
          yield* sql.unsafe(ownerInstances.createSql);
          yield* observe?.('added-build-owner-instance') ?? Effect.void;
        }
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
      if ((recordedRevision === 7 || recordedRevision === 8) && extensionSchemaCompatible) {
        if (recordedRevision !== CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION) {
          yield* sql`
            INSERT INTO schema_metadata (key, value)
            VALUES ('persistent_extension_schema_revision', ${String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `;
          yield* observe?.('recorded-revision') ?? Effect.void;
        }
        if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
        }
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
      if (recordedRevision >= 5 && (incompatibleGroups.has('lexical') || lexicalReadSurfaceMissing)) {
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
      if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
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

const ensureSnapshotLeaseSchema = Effect.fn('codeGraph.ensureSnapshotLeaseSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_leases (
      token TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      retire_when_inactive INTEGER NOT NULL DEFAULT 0 CHECK (retire_when_inactive IN (0, 1))
    )
  `);
  const addedLeaseRetirement = yield* ensureColumn(
    sql,
    'snapshot_leases',
    'retire_when_inactive',
    'INTEGER NOT NULL DEFAULT 0 CHECK (retire_when_inactive IN (0, 1))',
  );
  if (!addedLeaseRetirement) return;
  const now = yield* Clock.currentTimeMillis;
  // Existing runtimes did not record whether a lease pinned an active view.
  // Preserve live non-active consumers, but migrate current pointers and
  // already-expired displaced pointers so the upgrade can reclaim their
  // abandoned history on the next lease sweep.
  if (yield* tableExists(sql, 'removed_views')) {
    yield* sql`
      UPDATE snapshot_leases AS lease
      SET retire_when_inactive = 1
      WHERE EXISTS (
        SELECT 1 FROM active_snapshots AS active
        WHERE active.snapshot_id = lease.snapshot_id
          AND NOT EXISTS (
            SELECT 1 FROM removed_views AS removed
            WHERE removed.worktree_id = active.worktree_id
              AND removed.expected_snapshot_id = active.snapshot_id
          )
      ) OR (
        lease.expires_at <= ${now}
        AND EXISTS (
          SELECT 1
          FROM snapshots AS candidate
          JOIN active_snapshots AS active ON active.worktree_id = candidate.worktree_id
          WHERE candidate.id = lease.snapshot_id
        )
      )
    `;
    return;
  }
  // Partial and mixed-version schemas may not have the additive tombstone
  // table yet. Keep the legacy active-pointer migration conservative without
  // creating unrelated schema as a side effect of lease maintenance.
  yield* sql`
    UPDATE snapshot_leases AS lease
    SET retire_when_inactive = 1
    WHERE EXISTS (
      SELECT 1 FROM active_snapshots AS active
      WHERE active.snapshot_id = lease.snapshot_id
    ) OR (
      lease.expires_at <= ${now}
      AND EXISTS (
        SELECT 1
        FROM snapshots AS candidate
        JOIN active_snapshots AS active ON active.worktree_id = candidate.worktree_id
        WHERE candidate.id = lease.snapshot_id
      )
    )
  `;
});

const CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL = `CREATE TRIGGER active_snapshots_require_current_extractor
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
  END`;

const initializeSchema = Effect.fn('codeGraph.initializeSchema')(function* (sql: SqlClient.SqlClient) {
  yield* configureConnection(sql);
  // Refuse a drifted cleanup authority surface before any initialization DDL
  // or graph-row mutation. Unlike reconstructible build extensions, this
  // queue is coupled to immutable removal tombstones and is never dropped.
  yield* preflightRemovedViewCleanupSchema(sql);
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
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const admittedSchemaVersion = yield* inspectBoundedSchemaMetadataValue(sql, 'schema_version', 16);
  if (admittedSchemaVersion.state !== 'recorded' || admittedSchemaVersion.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph schema ${admittedSchemaVersion.state === 'recorded' ? admittedSchemaVersion.value : 'unknown'} is incompatible with ${CODE_GRAPH_SCHEMA_VERSION}.`,
      ),
    );
  }
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
      graph_content_id TEXT,
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
  yield* ensureColumn(sql, 'snapshots', 'graph_content_id', 'TEXT');
  // Older graph-v3 databases predate explicit content identity. Their snapshot
  // ID is a collision-safe migration sentinel; freshly observed snapshots use
  // the commit-independent cgc_ identity generated by the indexer.
  yield* sql.unsafe('UPDATE snapshots SET graph_content_id = id WHERE graph_content_id IS NULL');
  // The cleanup extension installs bounded revocation triggers on this durable
  // tombstone authority, so the core table must exist before the atomic r8
  // table/index/trigger/sequence publication transaction begins.
  yield* sql.unsafe(REMOVED_VIEWS_TABLE_SQL);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_extractor_generations (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )
  `);
  // This intentionally has no snapshot foreign key. The removal evidence must
  // survive bounded physical reclamation so an older runtime cannot resurrect
  // a removed view by republishing its legacy active pointer.
  yield* sql.unsafe(REMOVED_VIEWS_TABLE_SQL);
  yield* sql.unsafe(
    CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL.replace('CREATE TRIGGER', 'CREATE TRIGGER IF NOT EXISTS'),
  );
  yield* ensureSnapshotLeaseSchema(sql);
  yield* ensureInitialReconciliationIndexes(sql);
  yield* migratePersistentExtensionTables(sql);
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
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_base_state_id ON snapshots(base_snapshot_id, state, id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshots_graph_content ON snapshots(repository_id, graph_content_id, state)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_files_blob ON snapshot_files(path, content_hash)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(snapshot_id, name)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path ON symbols(snapshot_id, path)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_resolution_scope ON symbols(snapshot_id, resolution_scope_id)');
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_visualization_scope');
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_visualization_package');
  yield* sql.unsafe('DROP INDEX IF EXISTS symbols_visualization_path');
  const visualizationKindOrder = `CASE kind
    WHEN 'package' THEN 0 WHEN 'module' THEN 1 WHEN 'class' THEN 2 WHEN 'interface' THEN 3
    WHEN 'function' THEN 4 WHEN 'method' THEN 5 ELSE 6 END`;
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS symbols_visualization_scope_v2
    ON symbols(snapshot_id, resolution_scope_id, exported DESC, (${visualizationKindOrder}), id)
  `);
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS symbols_visualization_package_v2
    ON symbols(
      snapshot_id, resolution_scope_id, package_name, exported DESC,
      (${visualizationKindOrder}), id
    )
    WHERE resolution_scope_id IS NULL
  `);
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS symbols_visualization_path_v2
    ON symbols(
      snapshot_id,
      resolution_scope_id,
      (CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '(root)' END),
      exported DESC,
      (${visualizationKindOrder}),
      id
    )
    WHERE resolution_scope_id IS NULL AND (package_name IS NULL OR trim(package_name) = '')
  `);
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
  if (columns.some(candidate => candidate.name === column)) return false;
  yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  return true;
});

const diagnoseDatabase = Effect.fn('codeGraph.diagnoseDatabase')(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const integrityRows = yield* sql.unsafe<{readonly integrity_check: string}>('PRAGMA integrity_check(10)');
  const schemaRows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
  const cleanupAdmission = yield* codeGraphRemovedViewCleanupSchemaAdmission(sql);
  const persistentExtensionSchemaRevision = cleanupAdmission.persistentExtensionSchemaRevision;
  const persistentExtensionCurrent =
    persistentExtensionSchemaRevision === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
    (yield* codeGraphPersistentExtensionSchemaCompatible(sql)) &&
    cleanupAdmission.current;
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
    persistentExtensionSchemaRevision,
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

const CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE = 100;

interface RoutineExpiredLeasePage {
  readonly candidates: readonly string[];
  readonly deleted: number;
  readonly remaining: boolean;
}

const routineMaintenanceColumnsAvailable = Effect.fn('codeGraph.routineMaintenanceColumnsAvailable')(function* (
  sql: SqlClient.SqlClient,
  table: string,
  required: readonly string[],
) {
  if (!/^[a-z_]+$/u.test(table)) return false;
  const columns = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info("${table}")`);
  const available = new Set(columns.map(column => column.name));
  return required.every(column => available.has(column));
});

const initializeRoutineMaintenanceSchema = Effect.fn('codeGraph.initializeRoutineMaintenanceSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* configureConnection(sql);
  // Routine maintenance may repair the additive lease surface, but it must not
  // publish a partially initialized graph or run the replacement migrations
  // owned by an index/explicit repair session.
  if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'active_snapshots'))) return false;
  if (
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshots', [
      'base_snapshot_id',
      'id',
      'state',
      'worktree_id',
    ])) ||
    !(yield* routineMaintenanceColumnsAvailable(sql, 'active_snapshots', ['snapshot_id', 'worktree_id']))
  ) {
    return false;
  }
  if (
    (yield* tableExists(sql, 'snapshot_leases')) &&
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_leases', ['expires_at', 'snapshot_id', 'token']))
  ) {
    return false;
  }
  const leaseTableExists = yield* tableExists(sql, 'snapshot_leases');
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  if (revision.state === 'invalid') return false;
  const recordedRevision = revision.state === 'recorded' ? revision.value : undefined;
  const successorIndexState = leaseTableExists
    ? yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES[2])
    : ('missing' as const);
  if (
    successorIndexState === 'incompatible' ||
    (recordedRevision !== undefined &&
      recordedRevision >= CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
      successorIndexState !== 'ready')
  ) {
    return false;
  }
  let createExpiryIndex = !leaseTableExists;
  if (leaseTableExists) {
    const expiryIndexState = yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX);
    if (expiryIndexState === 'incompatible') return false;
    if (expiryIndexState === 'missing') {
      const rows = yield* sql.unsafe('SELECT 1 FROM snapshot_leases LIMIT 1');
      if (revision.state !== 'missing' || rows.length !== 0) return false;
      createExpiryIndex = true;
    }
  }
  yield* ensureSnapshotLeaseSchema(sql);
  if (createExpiryIndex) {
    yield* sql.unsafe(CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX.definition);
  }
  if ((yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready') {
    return false;
  }
  return true;
});

const selectPersistentBuildOwnerCandidates = Effect.fn('codeGraph.selectPersistentBuildOwnerCandidates')(function* (
  sql: SqlClient.SqlClient,
) {
  if (
    !(yield* tableExists(sql, 'schema_metadata')) ||
    !(yield* tableExists(sql, 'snapshot_build_owners')) ||
    !(yield* tableExists(sql, 'snapshot_build_owner_instances')) ||
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_build_owners', ['owner_token', 'snapshot_id'])) ||
    !(yield* routineMaintenanceColumnsAvailable(sql, 'snapshot_build_owner_instances', [
      'build_id',
      'logical_snapshot_id',
      'owner_token',
      'process_id',
      'process_start_identity',
      'snapshot_id',
    ]))
  ) {
    // Legacy and partially migrated writers provide no exact process-instance
    // evidence. Keep their builds untouched until a current writer reclaims
    // them through an ordinary explicit build.
    return [];
  }
  const rows = yield* sql.withTransaction(
    Effect.gen(function* () {
      const cursors = yield* sql<{readonly value: string}>`
        SELECT value FROM schema_metadata WHERE key = ${CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY} LIMIT 1
      `;
      const cursor = cursors[0]?.value ?? '';
      const candidates = yield* sql<{
        readonly build_id: string;
        readonly logical_snapshot_id: string;
        readonly owner_token: string;
        readonly process_id: number;
        readonly process_start_identity: unknown;
        readonly snapshot_id: string;
        readonly worktree_id: string;
      }>`
        SELECT
          instance.snapshot_id,
          instance.owner_token,
          instance.build_id,
          instance.process_id,
          instance.process_start_identity,
          instance.logical_snapshot_id,
          snapshot.worktree_id
        FROM snapshot_build_owner_instances AS instance
        JOIN snapshot_build_owners AS owner
          ON owner.snapshot_id = instance.snapshot_id
         AND owner.owner_token = instance.owner_token
        JOIN snapshots AS snapshot ON snapshot.id = instance.snapshot_id
        WHERE snapshot.state IN ('building', 'failed')
        ORDER BY CASE WHEN instance.snapshot_id > ${cursor} THEN 0 ELSE 1 END, instance.snapshot_id
        LIMIT ${CODE_GRAPH_ABANDONED_BUILD_CANDIDATE_LIMIT}
      `;
      const examined = candidates[0]?.snapshot_id;
      if (examined !== undefined) {
        yield* sql`
          INSERT INTO schema_metadata (key, value)
          VALUES (${CODE_GRAPH_ABANDONED_BUILD_CURSOR_KEY}, ${examined})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `;
      }
      return candidates;
    }),
  );
  return rows.map(
    row =>
      ({
        buildId: row.build_id,
        evidenceValid:
          row.process_start_identity == null ||
          (typeof row.process_start_identity === 'string' &&
            row.process_start_identity.length > 0 &&
            row.process_start_identity.length <= 256),
        logicalSnapshotId: row.logical_snapshot_id,
        ownerToken: row.owner_token,
        processId: Number(row.process_id),
        ...(typeof row.process_start_identity === 'string' ? {processStartIdentity: row.process_start_identity} : {}),
        snapshotId: row.snapshot_id,
        worktreeId: row.worktree_id,
      }) satisfies PersistentBuildOwnerCandidate,
  );
});

const retireAbandonedPersistentBuild = Effect.fn('codeGraph.retireAbandonedPersistentBuild')(function* (
  candidate: PersistentBuildOwnerCandidate,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* initializeRoutineMaintenanceSchema(sql))) return 'changed' as const;
  const now = yield* Clock.currentTimeMillis;
  const completedAt = new Date(now).toISOString();
  const retired = yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{readonly id: string}>`
        UPDATE snapshots
        SET state = 'retired',
            completed_at = COALESCE(completed_at, ${completedAt}),
            failure_summary = COALESCE(
              failure_summary,
              'Automatic maintenance retired a build whose exact owner process exited.'
            )
        WHERE id = ${candidate.snapshotId}
          AND worktree_id = ${candidate.worktreeId}
          AND state IN ('building', 'failed')
          AND EXISTS (
            SELECT 1
            FROM snapshot_build_owners AS owner
            JOIN snapshot_build_owner_instances AS instance ON instance.snapshot_id = owner.snapshot_id
            WHERE owner.snapshot_id = snapshots.id
              AND owner.owner_token = ${candidate.ownerToken}
              AND instance.owner_token = owner.owner_token
              AND instance.build_id = ${candidate.buildId}
              AND instance.process_id = ${candidate.processId}
              AND instance.process_start_identity IS ${candidate.processStartIdentity ?? null}
              AND instance.logical_snapshot_id = ${candidate.logicalSnapshotId}
          )
          AND NOT EXISTS (SELECT 1 FROM active_snapshots WHERE snapshot_id = snapshots.id)
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases WHERE snapshot_id = snapshots.id AND expires_at > ${now}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM snapshots AS dependent
            WHERE dependent.base_snapshot_id = snapshots.id AND dependent.state <> 'retired'
          )
        RETURNING id
      `;
      if (rows.length === 0) return false;
      yield* sql`
        DELETE FROM snapshot_build_owners
        WHERE snapshot_id = ${candidate.snapshotId} AND owner_token = ${candidate.ownerToken}
      `;
      return true;
    }),
  );
  if (retired) return 'retired' as const;
  const exact = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshot_build_owners AS owner
    JOIN snapshot_build_owner_instances AS instance ON instance.snapshot_id = owner.snapshot_id
    JOIN snapshots AS snapshot ON snapshot.id = owner.snapshot_id
    WHERE owner.snapshot_id = ${candidate.snapshotId}
      AND owner.owner_token = ${candidate.ownerToken}
      AND instance.owner_token = owner.owner_token
      AND instance.build_id = ${candidate.buildId}
      AND instance.process_id = ${candidate.processId}
      AND instance.process_start_identity IS ${candidate.processStartIdentity ?? null}
      AND instance.logical_snapshot_id = ${candidate.logicalSnapshotId}
      AND snapshot.worktree_id = ${candidate.worktreeId}
      AND snapshot.state IN ('building', 'failed')
  `;
  return Number(exact[0]?.count ?? 0) === 1 ? ('protected' as const) : ('changed' as const);
});

function persistentBuildOwnerCandidateValid(candidate: PersistentBuildOwnerCandidate): boolean {
  return (
    candidate.evidenceValid &&
    /^cgsn_[0-9a-f]{40}$/u.test(candidate.logicalSnapshotId) &&
    /^[0-9a-f]{64}$/u.test(candidate.worktreeId) &&
    /^[0-9a-f-]{16,64}$/u.test(candidate.buildId) &&
    Number.isSafeInteger(candidate.processId) &&
    candidate.processId > 0 &&
    candidate.ownerToken.length > 0 &&
    candidate.ownerToken.length <= 256 &&
    persistentSnapshotMatchesLogicalIdentity(candidate.snapshotId, candidate.logicalSnapshotId) &&
    (candidate.processStartIdentity === undefined ||
      (candidate.processStartIdentity.length > 0 && candidate.processStartIdentity.length <= 256))
  );
}

function persistentSnapshotMatchesLogicalIdentity(snapshotId: string, logicalSnapshotId: string): boolean {
  return (
    snapshotId === logicalSnapshotId ||
    snapshotId === `${logicalSnapshotId}-direct` ||
    new RegExp(`^${logicalSnapshotId}-full-[0-9a-f]{16}$`, 'u').test(snapshotId)
  );
}

const observePersistentBuildOwner = Effect.fn('codeGraph.observePersistentBuildOwner')(function* (
  candidate: PersistentBuildOwnerCandidate,
) {
  const system = yield* SystemInfo;
  const isRunning = system.isProcessRunning(candidate.processId);
  const processStartIdentity =
    isRunning && candidate.processStartIdentity !== undefined
      ? yield* system.processStartIdentity(candidate.processId)
      : undefined;
  return classifyCodeGraphBuildOwner(candidate, {isRunning, processStartIdentity});
});

interface BoundedSnapshotLeaseRow {
  readonly expires_at: unknown;
  readonly retire_when_inactive: unknown;
  readonly snapshot_id: unknown;
  readonly token: unknown;
}

interface SnapshotLeaseManifest {
  readonly expiresAt: number;
  readonly retireWhenInactive: 0 | 1;
  readonly snapshotId: string;
  readonly token: string;
}

function boundedSnapshotLeaseProjection(alias: string): string {
  return `CASE
      WHEN typeof(${alias}.token) = 'text'
        AND length(CAST(${alias}.token AS BLOB)) BETWEEN 1 AND 1024
      THEN ${alias}.token ELSE NULL END AS token,
    CASE
      WHEN typeof(${alias}.snapshot_id) = 'text'
        AND length(CAST(${alias}.snapshot_id AS BLOB)) BETWEEN 1 AND 1024
      THEN ${alias}.snapshot_id ELSE NULL END AS snapshot_id,
    CASE
      WHEN typeof(${alias}.expires_at) = 'integer'
        AND ${alias}.expires_at BETWEEN 0 AND ${MAXIMUM_CANONICAL_DATE_MILLISECONDS}
      THEN ${alias}.expires_at ELSE NULL END AS expires_at,
    CASE
      WHEN typeof(${alias}.retire_when_inactive) = 'integer'
        AND ${alias}.retire_when_inactive IN (0, 1)
      THEN ${alias}.retire_when_inactive ELSE NULL END AS retire_when_inactive`;
}

function decodeSnapshotLeaseManifest(row: BoundedSnapshotLeaseRow): SnapshotLeaseManifest | undefined {
  if (
    typeof row.token !== 'string' ||
    row.token.length === 0 ||
    row.token.length > 1_024 ||
    row.token.includes('\0') ||
    typeof row.snapshot_id !== 'string' ||
    row.snapshot_id.length === 0 ||
    row.snapshot_id.length > 1_024 ||
    row.snapshot_id.includes('\0') ||
    typeof row.expires_at !== 'number' ||
    !Number.isSafeInteger(row.expires_at) ||
    row.expires_at < 0 ||
    row.expires_at > MAXIMUM_CANONICAL_DATE_MILLISECONDS ||
    (row.retire_when_inactive !== 0 && row.retire_when_inactive !== 1)
  ) {
    return undefined;
  }
  return {
    expiresAt: row.expires_at,
    retireWhenInactive: row.retire_when_inactive,
    snapshotId: row.snapshot_id,
    token: row.token,
  };
}

const reapExpiredSnapshotLeasesPage = Effect.fn('codeGraph.reapExpiredSnapshotLeasesPage')(function* (
  sql: SqlClient.SqlClient,
  now: number,
) {
  if (!(yield* authorityPrimaryKeyBinary(sql, 'snapshot_leases', 'token'))) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease capability schema is invalid.'));
  }
  if ((yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready') {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease expiry index is invalid.'));
  }
  const rows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
    `SELECT ${boundedSnapshotLeaseProjection('lease')}
     FROM snapshot_leases AS lease
     WHERE lease.expires_at <= ?
     ORDER BY lease.expires_at
     LIMIT ?`,
    [now, CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE],
  );
  if (rows.length === 0) {
    return {candidates: [], deleted: 0, remaining: false} satisfies RoutineExpiredLeasePage;
  }
  const leases = rows.map(decodeSnapshotLeaseManifest);
  if (leases.some(lease => lease === undefined)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease manifest is invalid.'));
  }
  const decodedLeases = leases as readonly SnapshotLeaseManifest[];
  const retirementAuthorityCurrent = yield* codeGraphWorktreeReconciliationSchemaCompatible(sql);
  const successorIndexReady =
    (yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES[2])) === 'ready';
  const flaggedSnapshotIds = [
    ...new Set(decodedLeases.filter(lease => lease.retireWhenInactive === 1).map(lease => lease.snapshotId)),
  ];
  const candidates: string[] = [];
  const preservedTokens = new Set<string>();
  if (!successorIndexReady) {
    for (const lease of decodedLeases) {
      if (lease.retireWhenInactive === 1) preservedTokens.add(lease.token);
    }
  }
  for (const snapshotId of flaggedSnapshotIds) {
    if (!successorIndexReady) continue;
    const successorRows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
      `SELECT ${boundedSnapshotLeaseProjection('lease')}
       FROM snapshot_leases AS lease
       WHERE lease.snapshot_id = ? AND lease.expires_at > ?
       ORDER BY lease.expires_at
       LIMIT 1`,
      [snapshotId, now],
    );
    const successor = successorRows[0] === undefined ? undefined : decodeSnapshotLeaseManifest(successorRows[0]);
    if (successorRows[0] !== undefined && successor === undefined) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease manifest is invalid.'));
    }
    if (successor === undefined) {
      if (retirementAuthorityCurrent) {
        candidates.push(snapshotId);
      } else {
        const carrier = decodedLeases.find(lease => lease.snapshotId === snapshotId && lease.retireWhenInactive === 1);
        if (carrier !== undefined) preservedTokens.add(carrier.token);
      }
      continue;
    }
    yield* sql`
      UPDATE snapshot_leases
      SET retire_when_inactive = 1
      WHERE token = ${successor.token}
    `;
  }
  const tokens = decodedLeases.filter(lease => !preservedTokens.has(lease.token)).map(lease => lease.token);
  if (tokens.length > 0) {
    yield* sql`DELETE FROM snapshot_leases WHERE ${sql.in('token', tokens)}`;
  }
  return {
    candidates,
    deleted: tokens.length > 0 ? yield* lastStatementChangeCount(sql) : 0,
    // A full page is conservatively reported as remaining. The next ordinary
    // tick cheaply proves whether another page exists.
    remaining: preservedTokens.size > 0 || rows.length === CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE,
  } satisfies RoutineExpiredLeasePage;
});

const reapAndRetireExpiredSnapshotLeasesPage = Effect.fn('codeGraph.reapAndRetireExpiredSnapshotLeasesPage')(function* (
  sql: SqlClient.SqlClient,
  now: number,
) {
  const expired = yield* reapExpiredSnapshotLeasesPage(sql, now);
  yield* retireRoutineLeaseCandidates(sql, expired.candidates, now);
  return expired;
});

const retireRoutineLeaseCandidates = Effect.fn('codeGraph.retireRoutineLeaseCandidates')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  now: number,
) {
  const candidates = [...new Set(snapshotIds)].slice(0, CODE_GRAPH_ROUTINE_EXPIRED_LEASE_PAGE_SIZE);
  if (candidates.length === 0) return 0;
  // Retire only the bounded lease targets. Their detached bases remain a safe
  // warm cache and can be reconsidered by ordinary pointer reconciliation.
  return yield* retireReadySnapshotsIfUnused(sql, candidates, now);
});

const runRoutineMaintenancePage = Effect.fn('codeGraph.runRoutineMaintenancePage')(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* initializeRoutineMaintenanceSchema(sql))) {
    return {reason: 'schema-unavailable', state: 'skipped'} as const;
  }
  const now = yield* Clock.currentTimeMillis;
  const leasePage = yield* sql.withTransaction(
    Effect.gen(function* () {
      const expired = yield* reapExpiredSnapshotLeasesPage(sql, now);
      const retiredSnapshots = yield* retireRoutineLeaseCandidates(sql, expired.candidates, now);
      return {...expired, retiredSnapshots};
    }),
  );
  // The expired-token batch is itself this tick's bounded page. Leave all
  // physical row reclamation for the next trigger so one tick never combines
  // independent cleanup pages behind a single writer-gate acquisition.
  if (leasePage.deleted > 0 || leasePage.remaining) {
    return {
      cleanup: 'none',
      expiredLeases: leasePage.deleted,
      remaining: true,
      retiredSnapshots: leasePage.retiredSnapshots,
      rowsDeleted: 0,
      state: 'completed',
    } satisfies CodeGraphRoutineMaintenanceResult;
  }
  const completed = yield* drainCompletedPersistentBuildRowsPage(sql);
  if (completed.deleted > 0) {
    return {
      cleanup: 'completed-build',
      expiredLeases: leasePage.deleted,
      remaining: true,
      retiredSnapshots: leasePage.retiredSnapshots,
      rowsDeleted: completed.deleted,
      state: 'completed',
    } satisfies CodeGraphRoutineMaintenanceResult;
  }
  const retired = yield* pruneRetiredSnapshotRowsPage(sql);
  return {
    cleanup: retired.deleted > 0 ? 'retired-snapshot' : 'none',
    expiredLeases: leasePage.deleted,
    remaining: leasePage.remaining || retired.remaining,
    retiredSnapshots: leasePage.retiredSnapshots,
    rowsDeleted: retired.deleted,
    state: 'completed',
  } satisfies CodeGraphRoutineMaintenanceResult;
});

const acquireSnapshotLease = Effect.fn('codeGraph.acquireSnapshotLease')(function* (
  snapshotId: string,
  durationMilliseconds: number,
  token: string,
  retireWhenInactive: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease authority schema is invalid.'));
      }
      const ready = yield* sql<{readonly id: string}>`
        SELECT id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
      `;
      if (!ready[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} is no longer available.`));
      }
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
        VALUES (
          ${token}, ${snapshotId}, ${now + duration},
          CASE WHEN ${retireWhenInactive ? 1 : 0} = 1 OR EXISTS (
            SELECT 1
            FROM active_snapshots AS active
            WHERE active.snapshot_id = ${snapshotId}
              AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active.worktree_id
                  AND removed.expected_snapshot_id = active.snapshot_id
              )
          ) THEN 1 ELSE 0 END
        )
      `;
      // The new lease protects its target before expired readers are reaped.
      // This makes the next ordinary graph read self-heal snapshots left by a
      // crashed process without racing a caller that is reacquiring that view.
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
    }),
  );
  return token;
});

const retainViewSnapshotLease = Effect.fn('codeGraph.retainViewSnapshotLease')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  snapshotId: string,
  durationMilliseconds: number,
  candidateToken: string,
  options?: CodeGraphViewSnapshotLeaseRetainOptions,
) {
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  const minimumRemaining = Math.max(0, Math.min(duration, Math.floor(options?.minimumRemainingMilliseconds ?? 0)));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease authority schema is invalid.'));
      }
      const observation = yield* observeActiveView(sql, worktreeId, snapshotId);
      yield* options?.afterViewObserved?.() ?? Effect.void;
      if (observation.state !== 'ready') {
        return {observation, state: 'view-unavailable'} satisfies CodeGraphViewSnapshotLeaseRetainResult;
      }

      if (options?.existingToken) {
        const existing = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
          `SELECT ${boundedSnapshotLeaseProjection('lease')}
           FROM snapshot_leases AS lease
           WHERE lease.token = ?
           LIMIT 1`,
          [options.existingToken],
        );
        const row = existing[0] === undefined ? undefined : decodeSnapshotLeaseManifest(existing[0]);
        if (existing[0] !== undefined && row === undefined) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease manifest is invalid.'));
        }
        const expiresAt = row?.expiresAt ?? 0;
        if (row?.snapshotId === snapshotId && expiresAt > now) {
          if (expiresAt > now + minimumRemaining) {
            return {
              expiresAt,
              state: 'retained',
              token: row.token,
            } satisfies CodeGraphViewSnapshotLeaseRetainResult;
          }
          const renewedUntil = now + duration;
          yield* sql`
            UPDATE snapshot_leases
            SET expires_at = ${renewedUntil}, retire_when_inactive = 1
            WHERE token = ${row.token} AND snapshot_id = ${snapshotId} AND expires_at > ${now}
          `;
          if ((yield* lastStatementChangeCount(sql)) === 1) {
            yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
            return {
              expiresAt: renewedUntil,
              state: 'retained',
              token: row.token,
            } satisfies CodeGraphViewSnapshotLeaseRetainResult;
          }
        }
      }

      const expiresAt = now + duration;
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
        VALUES (${candidateToken}, ${snapshotId}, ${expiresAt}, 1)
      `;
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
      return {
        expiresAt,
        state: 'retained',
        token: candidateToken,
      } satisfies CodeGraphViewSnapshotLeaseRetainResult;
    }),
  );
});

/**
 * Read-only linearization point for Manager's writer-busy fallback. A cached
 * process token is reusable only while the exact active view and the exact
 * unexpired lease coexist in one SQLite snapshot and no exact tombstone does.
 */
const validateViewSnapshotLease = Effect.fn('codeGraph.validateViewSnapshotLease')(function* (
  worktreeId: string,
  snapshotId: string,
  token: string,
  minimumRemainingMilliseconds: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA busy_timeout = 0');
  yield* sql.unsafe('PRAGMA query_only = ON');
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return {state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult;
      }
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{readonly expires_at: number}>`
        SELECT CASE
          WHEN typeof(lease.expires_at) = 'integer'
            AND lease.expires_at BETWEEN 0 AND ${MAXIMUM_CANONICAL_DATE_MILLISECONDS}
          THEN lease.expires_at ELSE NULL END AS expires_at
        FROM active_snapshots AS active
        JOIN snapshots AS snapshot
          ON snapshot.id = active.snapshot_id
         AND snapshot.state = 'ready'
        JOIN snapshot_leases AS lease
          ON lease.token = ${token}
         AND lease.snapshot_id = active.snapshot_id
        WHERE active.worktree_id = ${worktreeId}
          AND active.snapshot_id = ${snapshotId}
          AND lease.expires_at > ${now + minimumRemainingMilliseconds}
          AND NOT EXISTS (
            SELECT 1 FROM removed_views AS removed
            WHERE removed.worktree_id = active.worktree_id
              AND removed.expected_snapshot_id = active.snapshot_id
          )
        LIMIT 1
      `;
      const expiresAt = Number(rows[0]?.expires_at ?? 0);
      return Number.isSafeInteger(expiresAt) && expiresAt > now + minimumRemainingMilliseconds
        ? ({expiresAt, state: 'valid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult)
        : ({state: 'invalid'} as const satisfies CodeGraphViewSnapshotLeaseValidationResult);
    }),
  );
});

const releaseSnapshotLease = Effect.fn('codeGraph.releaseSnapshotLease')(function* (token: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease authority schema is invalid.'));
      }
      const now = yield* Clock.currentTimeMillis;
      const releasedRows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
        `SELECT ${boundedSnapshotLeaseProjection('lease')}
         FROM snapshot_leases AS lease
         WHERE lease.token = ?
         LIMIT 1`,
        [token],
      );
      const releasedCandidates: string[] = [];
      const row = releasedRows[0] === undefined ? undefined : decodeSnapshotLeaseManifest(releasedRows[0]);
      if (releasedRows[0] !== undefined && row === undefined) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease manifest is invalid.'));
      }
      if (row?.retireWhenInactive === 1) {
        const successorRows = yield* sql.unsafe<BoundedSnapshotLeaseRow>(
          `SELECT ${boundedSnapshotLeaseProjection('lease')}
           FROM snapshot_leases AS lease
           WHERE lease.snapshot_id = ?
             AND lease.token <> ?
             AND lease.expires_at > ?
           ORDER BY lease.expires_at
           LIMIT 1`,
          [row.snapshotId, token, now],
        );
        const successor = successorRows[0] === undefined ? undefined : decodeSnapshotLeaseManifest(successorRows[0]);
        if (successorRows[0] !== undefined && successor === undefined) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease manifest is invalid.'));
        }
        if (successor === undefined) {
          releasedCandidates.push(row.snapshotId);
        } else {
          yield* sql`
            UPDATE snapshot_leases
            SET retire_when_inactive = 1
            WHERE token = ${successor.token}
          `;
        }
      }
      if (row !== undefined) {
        yield* sql`
          DELETE FROM snapshot_leases
          WHERE token = ${token}
        `;
      }
      yield* retireRoutineLeaseCandidates(sql, releasedCandidates, now);
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
    }),
  );
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
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease authority schema is invalid.'));
      }
      const active = yield* sql<{readonly present: number}>`
        SELECT 1 AS present FROM snapshot_leases WHERE token = ${token} AND expires_at > ${now} LIMIT 1
      `;
      if (!active[0]) {
        return yield* Effect.fail(new CodeGraphStoreError('The code graph snapshot lease expired before renewal.'));
      }
      yield* sql`
        UPDATE snapshot_leases SET expires_at = ${now + duration} WHERE token = ${token}
      `;
      yield* reapAndRetireExpiredSnapshotLeasesPage(sql, now);
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
      yield* associateSnapshotFileShards(sql, snapshot.id, snapshot.extractorSet, reusableBaseReceipt);
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
        if (baseSnapshotId) yield* inheritSnapshotFileShards(sql, snapshot.id, baseSnapshotId);
        yield* associateSnapshotFileShards(sql, snapshot.id, snapshot.extractorSet, reusableBaseReceipt);
      }
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

interface CompletedBuildCleanupPage {
  readonly deleted: number;
}

/** Reclaim exactly one bounded build-only table page, if one is available. */
const drainCompletedPersistentBuildRowsPage = Effect.fn('codeGraph.drainCompletedPersistentBuildRowsPage')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const spec of COMPLETED_PERSISTENT_BUILD_DRAIN_SPECS) {
    // A killed schema publisher can leave an additive extension absent. A
    // routine tick skips it; ordinary indexing owns extension publication.
    if (!(yield* tableExists(sql, spec.table))) continue;
    const key = `(${spec.keyColumns.join(', ')})`;
    const deleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `DELETE FROM ${spec.table}
             WHERE ${key} IN (
               SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               FROM ${spec.table} AS candidate
               JOIN snapshots AS snapshot ON snapshot.id = candidate.snapshot_id
               WHERE snapshot.state <> 'building'
               ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
               LIMIT ?
             )`,
          [spec.batchRows],
        );
        return yield* lastStatementChangeCount(sql);
      }),
    );
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Completed build cleanup returned an invalid count.'));
    }
    if (deleted > 0) return {deleted} satisfies CompletedBuildCleanupPage;
  }
  return {deleted: 0} satisfies CompletedBuildCleanupPage;
});

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
          yield* associateSnapshotFileShards(sql, snapshot.id, snapshot.extractorSet, reusableBaseReceipt);
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
      base.file_count
        - (
            SELECT COUNT(*)
            FROM snapshot_files AS file
            JOIN activation_incremental_paths AS changed ON changed.path = file.path
            WHERE file.snapshot_id = base.id
          )
        + (SELECT COUNT(*) FROM activation_files) AS files,
      base.symbol_count
        - (
            SELECT COUNT(*)
            FROM symbols AS symbol
            JOIN activation_incremental_paths AS changed ON changed.path = symbol.path
            WHERE symbol.snapshot_id = base.id
          )
        + (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      base.edge_count
        - (
            SELECT COUNT(*)
            FROM edges AS edge
            JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
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

const activatePersistedIncrementalSnapshot = Effect.fn('codeGraph.activatePersistedIncrementalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  baseSnapshotId: string,
  reusableBaseReceipt: CodeGraphReusableBaseReceiptInput | undefined,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
  onProgress?: CodeGraphActivationProgressCallback,
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
      if (!(yield* selectReusableBaseReceipt(baseSnapshotId))) {
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
        yield* observe('copying-workspace', 'completed');
        yield* observe('copying-files', 'started');
        yield* sql`
          INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
          SELECT ${snapshot.id}, path, content_hash, language, mode, size, source
          FROM activation_files
        `;
        yield* sql`
          INSERT INTO snapshot_file_deletions (snapshot_id, path)
          SELECT ${snapshot.id}, base.path
          FROM snapshot_files AS base
          JOIN activation_incremental_paths AS changed ON changed.path = base.path
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND NOT EXISTS (SELECT 1 FROM activation_files AS current WHERE current.path = base.path)
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
          JOIN activation_incremental_paths AS changed ON changed.path = base.path
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
          JOIN activation_incremental_paths AS changed ON changed.path = base.evidence_path
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND NOT EXISTS (SELECT 1 FROM activation_edges AS current WHERE current.id = base.id)
        `;
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
        yield* inheritSnapshotFileShards(sql, snapshot.id, baseSnapshotId);
        yield* associateSnapshotFileShards(sql, snapshot.id, snapshot.extractorSet, reusableBaseReceipt);
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

interface PlannedFreshFactCacheRow extends CodeGraphCacheCapacityRow {
  readonly contentHash: string;
  readonly createdAt: string;
  readonly extractorSet: string;
  readonly factsJson: string;
  readonly path: string;
}

interface PlannedMaterializedShardCacheRow extends CodeGraphCacheCapacityRow {
  readonly contentHash: string;
  readonly createdAt: string;
  readonly derivationIdentity: string;
  readonly extractorSet: string;
  readonly factsJson: string;
  readonly id: string;
  readonly lastUsedAt: string;
  readonly path: string;
}

function cacheCapacityPlanningError(label: string, cause: unknown): CodeGraphStoreError {
  if (cause instanceof CodeGraphStoreError) return cause;
  const reason = cause instanceof Error && cause.message.includes('payload ceiling') ? ' payload ceiling' : ' input';
  return new CodeGraphStoreError(`Code graph cache ${label}${reason} is invalid.`);
}

function prepareFreshFactCacheChunks(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  extractorSet: string,
  createdAt: string,
): readonly CodeGraphCacheCapacityChunk<PlannedFreshFactCacheRow>[] {
  const inputs = pairCacheInputs(files, facts, 'Fresh parser facts');
  return planCodeGraphCacheCapacityChunks(
    'cache code graph file facts',
    inputs.map(({bounded, file}) => {
      const row = {
        contentHash: file.contentHash,
        createdAt,
        extractorSet,
        factsJson: bounded.json,
        key: file.path,
        path: file.path,
      };
      return {...row, payloadBytes: codeGraphFileBlobCapacityBytes(row)};
    }),
  );
}

function storeFreshFactRows(sql: SqlClient.SqlClient, rows: readonly PlannedFreshFactCacheRow[]) {
  return Effect.gen(function* () {
    for (const row of rows) {
      yield* sql`
        INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
        VALUES (
          ${row.contentHash}, ${row.extractorSet}, ${row.path},
          ${row.factsJson}, ${row.createdAt}
        )
        ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET
          facts_json = excluded.facts_json,
          created_at = excluded.created_at
      `;
    }
  });
}

export function materializedShardDerivationIdentity(
  extractorSet: string,
  workspaceFingerprint: string,
  fileSetFingerprint: string,
): string {
  return `cgfd_${sha256HexSync(
    `materialized-file-derivation-v1\n${extractorSet}\n${workspaceFingerprint}\n${fileSetFingerprint}`,
  ).slice(0, 40)}`;
}

export function materializedFileShardIdentity(
  contentHash: string,
  extractorSet: string,
  derivationIdentity: string,
  path: string,
): string {
  return `cgfs_${sha256HexSync(
    `materialized-file-shard-v1\n${contentHash}\n${extractorSet}\n${derivationIdentity}\n${path}`,
  ).slice(0, 40)}`;
}

const associateSnapshotFileShards = Effect.fn('codeGraph.associateSnapshotFileShards')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  extractorSet: string,
  receipt: CodeGraphReusableBaseReceiptInput | undefined,
) {
  if (!receipt) return;
  const derivationIdentity = materializedShardDerivationIdentity(
    extractorSet,
    receipt.workspaceFingerprint,
    receipt.fileSetFingerprint,
  );
  yield* sql`
    INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
    SELECT ${snapshotId}, file.path, shard.id
    FROM snapshot_files AS file
    JOIN materialized_file_shards AS shard
      ON shard.content_hash = file.content_hash
     AND shard.path_hint = file.path
     AND shard.extractor_set = ${extractorSet}
     AND shard.derivation_identity = ${derivationIdentity}
    WHERE file.snapshot_id = ${snapshotId}
    ON CONFLICT(snapshot_id, path) DO UPDATE SET shard_id = excluded.shard_id
  `;
});

const inheritSnapshotFileShards = Effect.fn('codeGraph.inheritSnapshotFileShards')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string,
) {
  yield* sql`
    INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
    SELECT ${snapshotId}, base.path, base.shard_id
    FROM snapshot_file_shards AS base
    WHERE base.snapshot_id = ${baseSnapshotId}
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_files AS current
        WHERE current.snapshot_id = ${snapshotId} AND current.path = base.path
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_file_deletions AS deleted
        WHERE deleted.snapshot_id = ${snapshotId} AND deleted.path = base.path
      )
    ON CONFLICT(snapshot_id, path) DO NOTHING
  `;
});

function prepareMaterializedShardCacheChunks(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  extractorSet: string,
  derivationIdentity: string,
  now: string,
): readonly CodeGraphCacheCapacityChunk<PlannedMaterializedShardCacheRow>[] {
  const inputs = pairCacheInputs(files, facts, 'Materialized file shard');
  return planCodeGraphCacheCapacityChunks(
    'cache materialized code graph file shards',
    inputs.map(({bounded, file}) => {
      const row = {
        contentHash: file.contentHash,
        createdAt: now,
        derivationIdentity,
        extractorSet,
        factsJson: bounded.json,
        id: materializedFileShardIdentity(file.contentHash, extractorSet, derivationIdentity, file.path),
        key: file.path,
        lastUsedAt: now,
        path: file.path,
      };
      return {...row, payloadBytes: codeGraphMaterializedShardCapacityBytes(row)};
    }),
  );
}

function pairCacheInputs(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly BoundedCodeGraphFact[],
  label: string,
): readonly {readonly bounded: BoundedCodeGraphFact; readonly file: CodeGraphInventoryFile}[] {
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const factsByPath = new Map(facts.map(bounded => [bounded.facts.path, bounded]));
  if (
    files.length !== facts.length ||
    filesByPath.size !== files.length ||
    factsByPath.size !== facts.length ||
    [...filesByPath.keys()].some(path => !factsByPath.has(path))
  ) {
    throw new CodeGraphStoreError(`${label} inputs are inconsistent.`);
  }
  return [...filesByPath]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([path, file]) => ({bounded: factsByPath.get(path)!, file}));
}

interface MaterializedShardMetadataRow {
  readonly content_hash: string;
  readonly created_at: string;
  readonly derivation_identity: string;
  readonly extractor_set: string;
  readonly facts_bytes: number;
  readonly id: string;
  readonly last_used_at: string;
  readonly path_hint: string;
}

interface RawMaterializedShardMetadataRow {
  readonly content_hash: unknown;
  readonly created_at: unknown;
  readonly derivation_identity: unknown;
  readonly extractor_set: unknown;
  readonly facts_bytes: unknown;
  readonly id: unknown;
  readonly last_used_at: unknown;
  readonly path_hint: unknown;
}

interface MaterializedShardAssociationRow {
  readonly path: string;
  readonly shard_id: string;
  readonly snapshot_id: string;
}

interface RawMaterializedShardAssociationPageRow {
  readonly association_count: unknown;
  readonly path: unknown;
  readonly shard_id: unknown;
  readonly snapshot_id: unknown;
}

type MaterializedShardRepairPlan =
  | {
      readonly associations: readonly MaterializedShardAssociationRow[];
      readonly associationCount: number;
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly conflicts: readonly MaterializedShardMetadataRow[];
      readonly mode: 'drain';
      readonly row: PlannedMaterializedShardCacheRow;
    }
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly conflicts: readonly MaterializedShardMetadataRow[];
      readonly mode: 'final';
      readonly row: PlannedMaterializedShardCacheRow;
    }
  | {readonly mode: 'normal'};

type CodeGraphCacheWriterGate = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, unknown, R>;

interface MaterializedShardCacheWriteInput {
  readonly databasePath: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly withWriterGate: CodeGraphCacheWriterGate;
}

const writeMaterializedShardCacheRows = Effect.fn('codeGraph.writeMaterializedShardCacheRows')(function* (input: {
  readonly databasePath: string;
  readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
  readonly rows: readonly PlannedMaterializedShardCacheRow[];
  readonly withWriterGate: CodeGraphCacheWriterGate;
}) {
  let pending = [...input.rows];
  while (pending.length > 0) {
    const collisionIndex = yield* useDatabase(
      input.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const existing = yield* materializedShardMetadata(sql, pending);
        return pending.findIndex(row => materializedShardConflicts(row, existing).length > 0);
      }),
    );
    if (collisionIndex > 0) {
      if (!(yield* writeNormalMaterializedShardCacheRows(input, pending.slice(0, collisionIndex)))) {
        yield* Effect.yieldNow;
        continue;
      }
      pending = pending.slice(collisionIndex);
      continue;
    }
    if (collisionIndex === 0) {
      if (yield* repairMaterializedShardCacheRow(input, pending[0]!)) {
        pending = pending.slice(1);
      }
      continue;
    }

    if (yield* writeNormalMaterializedShardCacheRows(input, pending)) return;
    yield* Effect.yieldNow;
  }
});

const writeNormalMaterializedShardCacheRows = Effect.fn('codeGraph.writeNormalMaterializedShardCacheRows')(function* (
  input: MaterializedShardCacheWriteInput,
  rows: readonly PlannedMaterializedShardCacheRow[],
) {
  const chunk = planCodeGraphCacheCapacityChunks('cache materialized code graph file shards', rows)[0]!;
  return yield* input
    .persistentCapacityProtector(
      chunk.boundary,
      input.withWriterGate(
        input.databasePath,
        useDatabase(
          input.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(storeNormalMaterializedShardRows(sql, chunk.rows));
          }),
        ),
      ),
    )
    .pipe(
      Effect.as(true),
      Effect.catch(error =>
        error instanceof CodeGraphCacheCapacityPlanChanged ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
});

const repairMaterializedShardCacheRow = Effect.fn('codeGraph.repairMaterializedShardCacheRow')(function* (
  input: {
    readonly databasePath: string;
    readonly persistentCapacityProtector: CodeGraphDirectPersistentCapacityProtector;
    readonly withWriterGate: CodeGraphCacheWriterGate;
  },
  row: PlannedMaterializedShardCacheRow,
) {
  for (;;) {
    const plan = yield* useDatabase(
      input.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* prepareMaterializedShardRepairPlan(sql, row);
      }),
    );
    if (plan.mode === 'normal') return false;
    const completed = yield* input
      .persistentCapacityProtector(
        plan.boundary,
        input.withWriterGate(
          input.databasePath,
          useDatabase(
            input.databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(applyMaterializedShardRepairPlan(sql, plan));
            }),
          ),
        ),
      )
      .pipe(
        Effect.as(true),
        Effect.catch(error =>
          error instanceof CodeGraphCacheCapacityPlanChanged ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
    if (!completed) {
      yield* Effect.yieldNow;
      continue;
    }
    if (plan.mode === 'final') return true;
    yield* Effect.yieldNow;
  }
});

function storeNormalMaterializedShardRows(sql: SqlClient.SqlClient, rows: readonly PlannedMaterializedShardCacheRow[]) {
  return Effect.gen(function* () {
    for (const row of rows) {
      const stored = yield* sql<{readonly id: string}>`
          INSERT INTO materialized_file_shards (
            id, content_hash, extractor_set, derivation_identity, path_hint,
            facts_json, created_at, last_used_at
          ) VALUES (
            ${row.id}, ${row.contentHash}, ${row.extractorSet}, ${row.derivationIdentity}, ${row.path},
            ${row.factsJson}, ${row.createdAt}, ${row.lastUsedAt}
          )
          ON CONFLICT(id) DO UPDATE SET
            facts_json = excluded.facts_json,
            last_used_at = excluded.last_used_at
          WHERE materialized_file_shards.content_hash = excluded.content_hash
            AND materialized_file_shards.extractor_set = excluded.extractor_set
            AND materialized_file_shards.derivation_identity = excluded.derivation_identity
            AND materialized_file_shards.path_hint = excluded.path_hint
          ON CONFLICT(content_hash, extractor_set, derivation_identity, path_hint) DO NOTHING
          RETURNING id
        `;
      if (stored.length !== 1 || stored[0]?.id !== row.id) {
        return yield* Effect.fail(new CodeGraphCacheCapacityPlanChanged());
      }
    }
  });
}

const prepareMaterializedShardRepairPlan = Effect.fn('codeGraph.prepareMaterializedShardRepairPlan')(function* (
  sql: SqlClient.SqlClient,
  row: PlannedMaterializedShardCacheRow,
) {
  const existing = yield* materializedShardMetadata(sql, [row]);
  const conflicts = materializedShardConflicts(row, existing);
  if (conflicts.length === 0) return {mode: 'normal'} as const satisfies MaterializedShardRepairPlan;
  if (conflicts.length > 2) {
    return yield* Effect.fail(new CodeGraphStoreError(`Materialized file shard identity collision: ${row.id}.`));
  }
  const conflictIds = conflicts.map(conflict => conflict.id);
  const associationPage = yield* materializedShardAssociationPage(
    sql,
    conflictIds,
    CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows,
  );
  const associationCount = associationPage.associationCount;
  if (associationCount > 0) {
    const page: MaterializedShardAssociationRow[] = [];
    let payloadBytes = 0;
    for (const association of associationPage.associations) {
      const candidateBytes = codeGraphTextFieldsCapacityBytes(
        association.snapshot_id,
        association.path,
        association.shard_id,
      );
      if (candidateBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Materialized file shard association exceeds the repair payload ceiling.`),
        );
      }
      if (payloadBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes - candidateBytes) break;
      page.push(association);
      payloadBytes += candidateBytes;
    }
    if (page.length === 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Materialized file shard repair could not make progress.'));
    }
    return {
      associations: page,
      associationCount,
      boundary: {
        finalFactBytes: payloadBytes,
        operation: 'cache materialized code graph file shards',
        rowCount: page.length,
      },
      conflicts,
      mode: 'drain',
      row,
    } as const satisfies MaterializedShardRepairPlan;
  }

  const conflictBytes = conflicts.reduce(
    (total, conflict) => saturatingCapacityAdd(total, materializedShardMetadataCapacityBytes(conflict)),
    0,
  );
  const payloadBytes = saturatingCapacityAdd(conflictBytes, row.payloadBytes);
  if (payloadBytes > CODE_GRAPH_CACHE_TRANSACTION_LIMITS.payloadBytes) {
    return yield* Effect.fail(
      new CodeGraphStoreError('Materialized file shard collision exceeds the repair payload ceiling.'),
    );
  }
  return {
    boundary: {
      finalFactBytes: payloadBytes,
      operation: 'cache materialized code graph file shards',
      rowCount: conflicts.length + 1,
    },
    conflicts,
    mode: 'final',
    row,
  } as const satisfies MaterializedShardRepairPlan;
});

const applyMaterializedShardRepairPlan = Effect.fn('codeGraph.applyMaterializedShardRepairPlan')(function* (
  sql: SqlClient.SqlClient,
  plan: Exclude<MaterializedShardRepairPlan, {readonly mode: 'normal'}>,
) {
  const current = materializedShardConflicts(plan.row, yield* materializedShardMetadata(sql, [plan.row]));
  if (!sameMaterializedShardMetadata(current, plan.conflicts)) {
    return yield* Effect.fail(new CodeGraphCacheCapacityPlanChanged());
  }
  const conflictIds = plan.conflicts.map(conflict => conflict.id);
  const associationPage = yield* materializedShardAssociationPage(
    sql,
    conflictIds,
    plan.mode === 'drain' ? plan.associations.length : 1,
  );
  const associationCount = associationPage.associationCount;
  if (plan.mode === 'drain') {
    if (
      associationCount !== plan.associationCount ||
      !sameMaterializedShardAssociations(associationPage.associations, plan.associations)
    ) {
      return yield* Effect.fail(new CodeGraphCacheCapacityPlanChanged());
    }
    for (const association of plan.associations) {
      yield* sql`
        DELETE FROM snapshot_file_shards
        WHERE snapshot_id = ${association.snapshot_id}
          AND path = ${association.path}
          AND shard_id = ${association.shard_id}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new CodeGraphCacheCapacityPlanChanged());
      }
    }
    return;
  }
  if (associationCount !== 0) {
    return yield* Effect.fail(new CodeGraphCacheCapacityPlanChanged());
  }
  for (const conflict of plan.conflicts) {
    yield* sql`
      DELETE FROM materialized_file_shards
      WHERE id = ${conflict.id}
        AND content_hash = ${conflict.content_hash}
        AND extractor_set = ${conflict.extractor_set}
        AND derivation_identity = ${conflict.derivation_identity}
        AND path_hint = ${conflict.path_hint}
        AND created_at = ${conflict.created_at}
        AND last_used_at = ${conflict.last_used_at}
        AND length(CAST(facts_json AS BLOB)) = ${conflict.facts_bytes}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* Effect.fail(new CodeGraphCacheCapacityPlanChanged());
    }
  }
  yield* storeNormalMaterializedShardRows(sql, [plan.row]);
});

function materializedShardMetadata(sql: SqlClient.SqlClient, rows: readonly PlannedMaterializedShardCacheRow[]) {
  if (rows.length === 0) return Effect.succeed([] as readonly MaterializedShardMetadataRow[]);
  const ids = rows.map(row => row.id);
  const requested = JSON.stringify(
    rows.map(row => ({
      contentHash: row.contentHash,
      derivationIdentity: row.derivationIdentity,
      extractorSet: row.extractorSet,
      path: row.path,
    })),
  );
  return Effect.gen(function* () {
    const [byId, byTuple] = yield* Effect.all(
      [
        sql<RawMaterializedShardMetadataRow>`
          SELECT id, content_hash, extractor_set, derivation_identity, path_hint,
            length(CAST(facts_json AS BLOB)) AS facts_bytes, created_at, last_used_at
          FROM materialized_file_shards
          WHERE ${sql.in('id', ids)}
        `,
        sql<RawMaterializedShardMetadataRow>`
          SELECT shard.id, shard.content_hash, shard.extractor_set, shard.derivation_identity, shard.path_hint,
            length(CAST(shard.facts_json AS BLOB)) AS facts_bytes, shard.created_at, shard.last_used_at
          FROM materialized_file_shards AS shard
          JOIN json_each(${requested}) AS requested
            ON shard.content_hash = json_extract(requested.value, '$.contentHash')
           AND shard.extractor_set = json_extract(requested.value, '$.extractorSet')
           AND shard.derivation_identity = json_extract(requested.value, '$.derivationIdentity')
           AND shard.path_hint = json_extract(requested.value, '$.path')
        `,
      ] as const,
      {concurrency: 1},
    );
    const unique = new Map<string, MaterializedShardMetadataRow>();
    for (const value of [...byId, ...byTuple]) {
      const decoded = yield* decodeMaterializedShardMetadata(value);
      unique.set(decoded.id, decoded);
    }
    return [...unique.values()].sort((left, right) => compareCodeUnits(left.id, right.id));
  });
}

function decodeMaterializedShardMetadata(row: RawMaterializedShardMetadataRow) {
  if (
    !validMaterializedShardText(row.id) ||
    !validMaterializedShardText(row.content_hash) ||
    !validMaterializedShardText(row.extractor_set) ||
    !validMaterializedShardText(row.derivation_identity) ||
    !validMaterializedShardText(row.path_hint) ||
    !validMaterializedShardText(row.created_at) ||
    !validMaterializedShardText(row.last_used_at) ||
    typeof row.facts_bytes !== 'number' ||
    !Number.isSafeInteger(row.facts_bytes) ||
    row.facts_bytes < 0
  ) {
    return Effect.fail(new CodeGraphStoreError('Materialized file shard metadata is invalid.'));
  }
  return Effect.succeed({
    content_hash: row.content_hash,
    created_at: row.created_at,
    derivation_identity: row.derivation_identity,
    extractor_set: row.extractor_set,
    facts_bytes: row.facts_bytes,
    id: row.id,
    last_used_at: row.last_used_at,
    path_hint: row.path_hint,
  } satisfies MaterializedShardMetadataRow);
}

function decodeMaterializedShardAssociationPageRow(row: RawMaterializedShardAssociationPageRow) {
  if (
    !validMaterializedShardText(row.snapshot_id) ||
    !validMaterializedShardText(row.path) ||
    !validMaterializedShardText(row.shard_id) ||
    typeof row.association_count !== 'number' ||
    !Number.isSafeInteger(row.association_count) ||
    row.association_count < 1
  ) {
    return Effect.fail(new CodeGraphStoreError('Materialized file shard association metadata is invalid.'));
  }
  return Effect.succeed({
    association: {path: row.path, shard_id: row.shard_id, snapshot_id: row.snapshot_id},
    associationCount: row.association_count,
  });
}

function validMaterializedShardText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function materializedShardConflicts(
  row: PlannedMaterializedShardCacheRow,
  existing: readonly MaterializedShardMetadataRow[],
): readonly MaterializedShardMetadataRow[] {
  return existing.filter(candidate => {
    const tupleMatches = materializedShardTupleMatches(row, candidate);
    const relevant = candidate.id === row.id || tupleMatches;
    return relevant && !(candidate.id === row.id && tupleMatches);
  });
}

function materializedShardTupleMatches(
  row: PlannedMaterializedShardCacheRow,
  candidate: MaterializedShardMetadataRow,
): boolean {
  return (
    candidate.content_hash === row.contentHash &&
    candidate.extractor_set === row.extractorSet &&
    candidate.derivation_identity === row.derivationIdentity &&
    candidate.path_hint === row.path
  );
}

function materializedShardMetadataCapacityBytes(row: MaterializedShardMetadataRow): number {
  return saturatingCapacityAdd(
    codeGraphTextFieldsCapacityBytes(
      row.id,
      row.content_hash,
      row.extractor_set,
      row.derivation_identity,
      row.path_hint,
      row.created_at,
      row.last_used_at,
    ),
    row.facts_bytes,
  );
}

function materializedShardAssociationPage(sql: SqlClient.SqlClient, shardIds: readonly string[], limit: number) {
  if (shardIds.length === 0 || limit <= 0) {
    return Effect.succeed({associationCount: 0, associations: [] as readonly MaterializedShardAssociationRow[]});
  }
  const statement = codeGraphMaterializedShardAssociationPageStatement(shardIds, limit);
  return sql.unsafe<RawMaterializedShardAssociationPageRow>(statement.text, statement.parameters).pipe(
    Effect.flatMap(rows =>
      Effect.gen(function* () {
        if (rows.length === 0) return {associationCount: 0, associations: [] as const};
        const associations: MaterializedShardAssociationRow[] = [];
        let associationCount: number | undefined;
        for (const row of rows) {
          const decoded = yield* decodeMaterializedShardAssociationPageRow(row);
          associationCount ??= decoded.associationCount;
          if (decoded.associationCount !== associationCount) {
            return yield* Effect.fail(
              new CodeGraphStoreError('Materialized file shard association metadata is invalid.'),
            );
          }
          associations.push(decoded.association);
        }
        return {associationCount: associationCount!, associations};
      }),
    ),
  );
}

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */
export function codeGraphMaterializedShardAssociationPageStatement(shardIds: readonly string[], limit: number) {
  return {
    parameters: [
      JSON.stringify(shardIds),
      Math.min(CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows, Math.max(1, Math.floor(limit))),
    ] as const,
    text: `
    SELECT snapshot_id, path, shard_id, COUNT(*) OVER () AS association_count
    FROM snapshot_file_shards
    WHERE shard_id IN (SELECT value FROM json_each(?))
    ORDER BY snapshot_id, path
    LIMIT ?
  `,
  };
}

function sameMaterializedShardMetadata(
  left: readonly MaterializedShardMetadataRow[],
  right: readonly MaterializedShardMetadataRow[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameMaterializedShardAssociations(
  left: readonly MaterializedShardAssociationRow[],
  right: readonly MaterializedShardAssociationRow[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function persistentSnapshotBuildIdentityMatches(current: CodeGraphSnapshot, requested: CodeGraphSnapshot): boolean {
  return (
    current.repositoryId === requested.repositoryId &&
    current.commit === requested.commit &&
    (current.graphContentId ?? current.id) === (requested.graphContentId ?? requested.id) &&
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
  claim: CodeGraphPersistentBuildClaim,
  writerGate?: CodeGraphWriterGate,
) {
  const sql = yield* SqlClient.SqlClient;
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  if (
    !/^[0-9a-f-]{16,64}$/u.test(claim.owner.buildId) ||
    !Number.isSafeInteger(claim.owner.processId) ||
    claim.owner.processId <= 0 ||
    (claim.owner.processStartIdentity !== undefined &&
      (claim.owner.processStartIdentity.length === 0 || claim.owner.processStartIdentity.length > 256)) ||
    !/^cgsn_[0-9a-f]{40}$/u.test(claim.logicalSnapshotId) ||
    (/^cgsn_[0-9a-f]{40}/u.test(snapshot.id) &&
      !persistentSnapshotMatchesLogicalIdentity(snapshot.id, claim.logicalSnapshotId))
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent build owner identity is invalid.'));
  }
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
            id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.graphContentId ?? snapshot.id}, ${snapshot.baseSnapshotId ?? null},
            ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
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
        yield* sql`
          INSERT INTO snapshot_build_owner_instances (
            snapshot_id, owner_token, build_id, process_id, process_start_identity, logical_snapshot_id
          ) VALUES (
            ${snapshot.id}, ${ownerToken}, ${claim.owner.buildId}, ${claim.owner.processId},
            ${claim.owner.processStartIdentity ?? null}, ${claim.logicalSnapshotId}
          )
          ON CONFLICT(snapshot_id) DO UPDATE SET
            owner_token = excluded.owner_token,
            build_id = excluded.build_id,
            process_id = excluded.process_id,
            process_start_identity = excluded.process_start_identity,
            logical_snapshot_id = excluded.logical_snapshot_id
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

const retireIncompleteWorktreeSnapshots = Effect.fn('codeGraph.retireIncompleteWorktreeSnapshots')(function* (
  repositoryId: string,
  worktreeId: string,
  retainedSnapshotIds: ReadonlySet<string>,
  writerGate?: CodeGraphWriterGate,
  onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
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
        const reclaimableIds = [...new Set(reclaimable.map(snapshot => snapshot.id))].sort(compareCodeUnits);
        for (const snapshotIds of chunk(reclaimableIds, 100)) {
          yield* sql`DELETE FROM snapshot_build_owners WHERE ${sql.in('snapshot_id', snapshotIds)}`;
        }
        return {reclaimable: reclaimableIds, retired: retired.length};
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
        SET state = ${targetState}, failure_summary = COALESCE(failure_summary, ${summary.slice(0, 2_000)}),
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

function persistentFullInventoryCapacityBoundary(
  snapshotId: string,
  files: readonly CodeGraphInventoryFile[],
): CodeGraphDirectPersistentCapacityBoundary {
  let finalFactBytes = saturatingCapacityMultiply(codeGraphUtf8ByteLength(snapshotId), files.length);
  for (const file of files) {
    finalFactBytes = saturatingCapacityAdd(
      finalFactBytes,
      codeGraphUtf8ByteLength(file.path),
      codeGraphUtf8ByteLength(file.contentHash),
      codeGraphUtf8ByteLength(file.language),
      codeGraphUtf8ByteLength(file.mode),
      codeGraphUtf8ByteLength(file.source),
    );
  }
  return {
    finalFactBytes,
    operation: 'stage persistent code graph inventory',
    // Numeric size values and SQLite/index overhead are covered by the
    // calibrated per-row floor rather than pretending their varint width is a
    // UTF-8 payload.
    rowCount: files.length,
  };
}

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

interface PreparedPersistedFullWorkspaceScope {
  readonly diagnosticsJson: string;
  readonly scope: CodeGraphBuildWorkspace;
}

interface PreparedPersistedFullWorkspaceProject {
  readonly diagnosticsJson: string;
  readonly languagesJson: string;
  readonly project: CodeGraphWorkspaceProject;
  readonly sourceRootsJson: string;
  readonly workspaceRootsJson: string;
}

interface PreparedPersistedFullWorkspace {
  readonly capacity: CodeGraphDirectPersistentCapacityBoundary;
  readonly projects: readonly PreparedPersistedFullWorkspaceProject[];
  readonly workspaces: readonly PreparedPersistedFullWorkspaceScope[];
}

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

function persistentBoundTextBytes(total: number, values: readonly (string | undefined)[]): number {
  for (const value of values) {
    if (value !== undefined) total = saturatingCapacityAdd(total, codeGraphUtf8ByteLength(value));
  }
  return total;
}

const stagePersistedFullWorkspace = Effect.fn('codeGraph.stagePersistedFullWorkspace')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  workspace: PreparedPersistedFullWorkspace,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      for (const entry of workspace.workspaces) {
        const {scope} = entry;
        yield* sql`
          INSERT OR REPLACE INTO workspace_scopes (
            snapshot_id, id, build_system, name, root, provenance, diagnostics_json
          ) VALUES (
            ${snapshotId}, ${scope.id}, ${scope.buildSystem}, ${scope.name}, ${scope.root},
            ${scope.provenance}, ${entry.diagnosticsJson}
          )
        `;
      }
      for (const entry of workspace.projects) {
        const {project: component} = entry;
        yield* sql`
          INSERT OR REPLACE INTO workspace_components (
            snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          ) VALUES (
            ${snapshotId}, ${component.id}, ${component.workspaceId}, ${component.buildSystem},
            ${component.kind}, ${component.name}, ${component.root}, ${component.resolutionDomain},
            ${entry.languagesJson}, ${entry.sourceRootsJson},
            ${entry.workspaceRootsJson}, ${component.provenance},
            ${entry.diagnosticsJson}
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
  preparedTerms?: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>,
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
    for (const [term, weight] of preparedTerms?.get(symbol) ?? symbolTerms(symbol)) {
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

interface PreparedPersistedFullFactBatch {
  readonly batch: CodeGraphStagingBatch;
  readonly boundedReferences: readonly CodeGraphReference[];
  readonly reexportsByReferenceBatch: readonly (readonly CodeGraphReusableReexport[])[];
  readonly symbolTerms: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>;
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

const stagePersistedFullFacts = Effect.fn('codeGraph.stagePersistedFullFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  batchIndex: number,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
  observer: ActivationStagingObserver,
  withinTransaction = false,
  prepared?: PreparedPersistedFullFactBatch,
) {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization batch identity is invalid.'));
  }
  const boundedReferences = prepared?.boundedReferences ?? references.filter(isCodeGraphReferenceWithinCandidateBudget);
  const batchFingerprint = yield* persistedFullBatchFingerprint(symbols, edges, boundedReferences);

  let lookupCount = 0;
  let termCount = 0;
  let candidateCount = 0;
  let reexportCount = 0;
  let compactBatchCounts: CompactLexicalFormatReceipt = {postingCount: 0, symbolCount: 0, termCount: 0};
  const runTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withinTransaction ? effect : sql.withTransaction(effect);
  const resumed = yield* runTransaction(
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

      compactBatchCounts = yield* stageCompactLexicalFacts(sql, snapshotId, symbols, observer, prepared?.symbolTerms);
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
      const referenceBatches = [
        ...chunk(
          prepared ? boundedReferences : sortedBy(boundedReferences, reference => reference.edgeId),
          ACTIVATION_REFERENCE_BATCH_ROWS,
        ),
      ];
      for (let referenceBatchIndex = 0; referenceBatchIndex < referenceBatches.length; referenceBatchIndex += 1) {
        const batch = referenceBatches[referenceBatchIndex]!;
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
        const reexports =
          prepared?.reexportsByReferenceBatch[referenceBatchIndex] ??
          [
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
      if (!withinTransaction) yield* observer('committing', 0, true);
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
  if (!withinTransaction) yield* observer('committed', 0, true);
});

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

const persistedIncrementalProjectFilesMatch = Effect.fn('codeGraph.persistedIncrementalProjectFilesMatch')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const invalid = yield* sql<{readonly path: string}>`
      SELECT changed.path
      FROM activation_incremental_paths AS changed
      LEFT JOIN activation_files AS current ON current.path = changed.path
      WHERE current.path IS NULL
      UNION ALL
      SELECT current.path
      FROM activation_files AS current
      LEFT JOIN snapshot_files AS base
        ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
      WHERE base.path IS NULL
         OR base.language IS NOT current.language
         OR base.mode IS NOT current.mode
      LIMIT 1
    `;
  return invalid.length === 0;
});

function isPersistedIncrementalResolutionClosure(value: unknown): value is 'changed' | 'full' | 'project' {
  return value === 'changed' || value === 'project' || value === 'full';
}

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
          FROM activation_incremental_paths AS changed
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

interface PersistentReexportAliasRow {
  readonly evidence_path: string;
  readonly exported: number;
  readonly lookup_key: string;
  readonly symbol_id: string;
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
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
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
    // Freeze the exact rows before capacity admission. The guarded transaction
    // inserts only this immutable page, so no writer that arrives between the
    // preflight read and receipt acquisition can expand its physical demand.
    const aliasRows = yield* sql.unsafe<PersistentReexportAliasRow>(
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
          SELECT lookup_key, symbol_id, exported, evidence_path
          FROM alias_rows
          ORDER BY lookup_key, symbol_id
        `,
      persistent ? [mode.snapshotId, mode.snapshotId] : [],
    );
    if (aliasRows.length === 0) {
      yield* onProgress?.(aliases) ?? Effect.void;
      yield* Effect.yieldNow;
      continue;
    }
    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        if (persistent) yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
        let inserted = 0;
        for (const batch of chunk(aliasRows, 500)) {
          if (persistent) {
            yield* sql.unsafe(
              `INSERT OR IGNORE INTO snapshot_symbol_lookup (
                 snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
                 provenance, evidence_edge_id, evidence_path
               ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
              batch.flatMap(row => [
                mode.snapshotId,
                row.lookup_key,
                row.symbol_id,
                'typescript',
                row.exported,
                'alias',
                null,
                row.evidence_path,
              ]),
            );
          } else {
            yield* sql.unsafe(
              `INSERT OR IGNORE INTO activation_symbol_lookup (
                 lookup_key, symbol_id, resolution_domain, exported,
                 provenance, evidence_edge_id, evidence_path
               ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
              batch.flatMap(row => [
                row.lookup_key,
                row.symbol_id,
                'typescript',
                row.exported,
                'alias',
                null,
                row.evidence_path,
              ]),
            );
          }
          const changed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          inserted = saturatingCapacityAdd(inserted, Number(changed[0]?.count ?? 0));
        }
        return inserted;
      }),
    );
    const gatedTransaction = persistent && writerGate ? writerGate(transaction) : transaction;
    aliases += yield* persistent && persistentCapacityProtector
      ? persistentCapacityProtector(
          persistentReexportAliasCapacityBoundary(mode.snapshotId, aliasRows),
          gatedTransaction,
        )
      : gatedTransaction;
    yield* onProgress?.(aliases) ?? Effect.void;
    yield* Effect.yieldNow;
  }
  yield* sql.unsafe('DELETE FROM activation_reexport_closure_page');
  return aliases;
});

function persistentReexportAliasCapacityBoundary(
  snapshotId: string,
  rows: readonly PersistentReexportAliasRow[],
): CodeGraphDirectPersistentCapacityBoundary {
  let finalFactBytes = 0;
  for (const row of rows) {
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      row.lookup_key,
      row.symbol_id,
      'typescript',
      'alias',
      row.evidence_path,
    ]);
  }
  return {
    finalFactBytes,
    operation: 'resolve persistent code graph reexport aliases',
    rowCount: rows.length,
  };
}

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
        yield* mode?.mode === 'persisted-full' && persistentCapacityProtector
          ? persistentCapacityProtector(
              persistentReferenceResolutionCapacityBoundary(mode.snapshotId, rows, resolutions, aliases),
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

function persistentReferenceResolutionCapacityBoundary(
  snapshotId: string,
  rows: readonly ResolvableActivationReferenceRow[],
  resolutions: readonly ActivationResolutionRow[],
  aliases: readonly (readonly [string, string, string, number, 'alias', string, string])[],
): CodeGraphDirectPersistentCapacityBoundary {
  let finalFactBytes = 0;
  for (const [index, resolution] of resolutions.entries()) {
    const row = rows[index];
    if (row === undefined)
      return {finalFactBytes: Number.NaN, operation: 'resolve persistent code graph references', rowCount: Number.NaN};
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      resolution.newEdgeId,
      typeof row.source_id === 'string' ? row.source_id : undefined,
      row.source_name,
      resolution.relation,
      resolution.targetId,
      resolution.targetName,
      resolution.provenance,
      row.evidence_path,
      row.evidence_span_json,
      // Both the before and after analysis histogram updates carry this
      // snapshot/group identity. Counting them per resolution is deliberately
      // conservative when many edges collapse into one aggregate row.
      snapshotId,
      row.provenance,
      row.relation,
      snapshotId,
      resolution.provenance,
      resolution.relation,
    ]);
  }
  for (const alias of aliases) {
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      alias[0],
      alias[1],
      alias[2],
      alias[4],
      alias[5],
      alias[6],
    ]);
  }
  return {
    finalFactBytes,
    operation: 'resolve persistent code graph references',
    // Per resolved edge: replacement insert, old-edge delete, reference
    // delete, two histogram upserts, bounded zero-group cleanup, and ample
    // headroom for SQLite replace/index row work. Alias attempts are exact.
    rowCount: saturatingCapacityAdd(saturatingCapacityMultiply(resolutions.length, 10), aliases.length),
  };
}

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

interface SnapshotPromotionCapacityPlan {
  readonly activatedAt: string;
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly maximumLeaseFactBytes: number;
  readonly maximumLeaseRows: number;
}

const snapshotPromotionLeaseCapacity = Effect.fn('codeGraph.snapshotPromotionLeaseCapacity')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  now: number,
) {
  const candidates = [...new Set(snapshotIds)];
  let factBytes = 0;
  let rows = 0;
  for (const candidate of candidates) {
    const leaseRows = yield* sql.unsafe<BoundedSnapshotLeaseRow & {readonly lease_rowid: unknown}>(
      `SELECT
         CASE WHEN typeof(lease.rowid) = 'integer' AND lease.rowid BETWEEN 1 AND 9007199254740991
           THEN lease.rowid ELSE NULL END AS lease_rowid,
         ${boundedSnapshotLeaseProjection('lease')}
       FROM snapshot_leases AS lease INDEXED BY snapshot_leases_snapshot_expiry
       WHERE lease.snapshot_id = ? AND lease.expires_at > ?
       ORDER BY lease.expires_at
       LIMIT 1`,
      [candidate, now],
    );
    if (leaseRows.length === 0) continue;
    const lease = decodeSnapshotLeaseManifest(leaseRows[0]!);
    if (
      lease === undefined ||
      lease.snapshotId !== candidate ||
      typeof leaseRows[0]?.lease_rowid !== 'number' ||
      !Number.isSafeInteger(leaseRows[0].lease_rowid) ||
      leaseRows[0].lease_rowid <= 0
    ) {
      return yield* Effect.fail(new CodeGraphStoreError('Ready snapshot promotion lease capacity is invalid.'));
    }
    rows += 1;
    factBytes = saturatingCapacityAdd(
      factBytes,
      saturatingCapacityAdd(codeGraphUtf8ByteLength(lease.token), codeGraphUtf8ByteLength(candidate)),
    );
  }
  return {factBytes, rows};
});

const promotionRemovedSnapshotId = Effect.fn('codeGraph.promotionRemovedSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
) {
  const rows = yield* sql.unsafe<{readonly expected_snapshot_id: unknown}>(
    `SELECT CASE
       WHEN typeof(expected_snapshot_id) = 'text'
            AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
       THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id
     FROM removed_views
     WHERE worktree_id = ?
     LIMIT 2`,
    [worktreeId],
  );
  if (rows.length === 0) return undefined;
  if (
    rows.length !== 1 ||
    typeof rows[0]?.expected_snapshot_id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(rows[0].expected_snapshot_id)
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
  }
  return rows[0].expected_snapshot_id;
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

const validateViewRemovalTarget = Effect.fn('codeGraph.validateViewRemovalTarget')(function* (
  worktreeId: string,
  expectedSnapshotId: string,
) {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph worktree identity is invalid.'));
  }
  if (!CODE_GRAPH_SNAPSHOT_ID.test(expectedSnapshotId)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot identity is invalid.'));
  }
});

const observeActiveView = Effect.fn('codeGraph.observeActiveView')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
) {
  const activeViewsAvailable = yield* tableExists(sql, 'active_snapshots');
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const active = activeViewsAvailable
    ? yield* sql.unsafe<{readonly snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN snapshot_id ELSE NULL END AS snapshot_id
         FROM active_snapshots WHERE worktree_id = ? LIMIT 2`,
        [worktreeId],
      )
    : [];
  const removed = removedViewsAvailable
    ? yield* sql.unsafe<{readonly expected_snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(expected_snapshot_id) = 'text'
                AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id
         FROM removed_views WHERE worktree_id = ? LIMIT 2`,
        [worktreeId],
      )
    : [];
  const activeSnapshotId = active[0]?.snapshot_id;
  const removedSnapshotId = removed[0]?.expected_snapshot_id;

  if (
    active.length > 1 ||
    removed.length > 1 ||
    (activeSnapshotId !== undefined &&
      (typeof activeSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(activeSnapshotId))) ||
    (removedSnapshotId !== undefined &&
      (typeof removedSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(removedSnapshotId)))
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph view authority is invalid.'));
  }

  if (activeSnapshotId !== undefined && activeSnapshotId !== expectedSnapshotId) {
    return {
      expectedSnapshotId,
      observedSnapshotId: activeSnapshotId,
      observedState: 'active',
      state: 'stale-target',
    } satisfies CodeGraphViewObservationResult;
  }
  if (activeSnapshotId === expectedSnapshotId) {
    return {
      expectedSnapshotId,
      state: removedSnapshotId === expectedSnapshotId ? 'already-removed' : 'ready',
    } satisfies CodeGraphViewObservationResult;
  }
  if (removedSnapshotId === expectedSnapshotId) {
    return {expectedSnapshotId, state: 'already-removed'} satisfies CodeGraphViewObservationResult;
  }
  if (removedSnapshotId !== undefined) {
    return {
      expectedSnapshotId,
      observedSnapshotId: removedSnapshotId,
      observedState: 'removed',
      state: 'stale-target',
    } satisfies CodeGraphViewObservationResult;
  }
  return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewObservationResult;
});

const claimWorktreeReconciliationCandidates = Effect.fn('codeGraph.claimWorktreeReconciliationCandidates')(function* (
  sql: SqlClient.SqlClient,
  requestedLimit: number,
) {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation schema is unavailable.'));
      }
      const cursorRows = yield* sql<{readonly value: string}>`
          SELECT value FROM schema_metadata WHERE key = 'worktree_reconciliation_cursor' LIMIT 1
        `;
      const recordedCursor = cursorRows[0]?.value;
      if (recordedCursor !== undefined && !/^[0-9a-f]{64}$/.test(recordedCursor)) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation cursor is invalid.'));
      }
      const cursor = recordedCursor;
      const selectPage = (boundary: 'after' | 'through', pageLimit: number) => {
        const statement = codeGraphWorktreeReconciliationCandidatePageStatement(cursor, boundary, pageLimit);
        return sql.unsafe<{
          readonly repository_id: string | null;
          readonly snapshot_id: string;
          readonly snapshot_state: string;
          readonly tombstoned: number;
          readonly worktree_id: string;
        }>(statement.text, statement.parameters);
      };
      const after = yield* selectPage('after', limit);
      const rows =
        cursor === undefined || after.length >= limit
          ? after
          : [...after, ...(yield* selectPage('through', limit - after.length))];
      const nextCursor = rows.at(-1)?.worktree_id;
      if (
        rows.some(
          row =>
            typeof row.repository_id !== 'string' ||
            !/^[0-9a-f]{64}$/.test(row.repository_id) ||
            !/^[0-9a-f]{64}$/.test(row.worktree_id) ||
            !/^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/.test(row.snapshot_id) ||
            !['building', 'failed', 'ready', 'retired'].includes(row.snapshot_state) ||
            (Number(row.tombstoned) !== 0 && Number(row.tombstoned) !== 1),
        )
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation candidate is invalid.'));
      }
      if (nextCursor !== undefined) {
        yield* sql`
            INSERT INTO schema_metadata (key, value)
            VALUES ('worktree_reconciliation_cursor', ${nextCursor})
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `;
      }
      return rows
        .filter(row => row.snapshot_state === 'ready' && Number(row.tombstoned) === 0)
        .map(row => ({
          repositoryId: row.repository_id!,
          snapshotId: row.snapshot_id,
          worktreeId: row.worktree_id,
        })) satisfies readonly CodeGraphWorktreeReconciliationCandidate[];
    }),
  );
});

/** @internal Indexed cursor-page statement retained for query-plan and high-cardinality regressions. */
export function codeGraphWorktreeReconciliationCandidatePageStatement(
  cursor: string | undefined,
  boundary: 'after' | 'through',
  requestedLimit: number,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(32, requestedLimit)) : 32;
  const cursorPredicate =
    cursor === undefined ? '' : boundary === 'after' ? 'WHERE worktree_id > ?' : 'WHERE worktree_id <= ?';
  return {
    parameters: cursor === undefined ? [limit] : [cursor, limit],
    text: `WITH raw_page AS MATERIALIZED (
        SELECT worktree_id, snapshot_id
        FROM active_snapshots
        ${cursorPredicate}
        ORDER BY worktree_id
        LIMIT ?
      )
      SELECT
        snapshots.repository_id,
        raw_page.snapshot_id,
        snapshots.state AS snapshot_state,
        CASE WHEN removed.worktree_id IS NULL THEN 0 ELSE 1 END AS tombstoned,
        raw_page.worktree_id
      FROM raw_page
      LEFT JOIN snapshots ON snapshots.id = raw_page.snapshot_id
      LEFT JOIN removed_views AS removed
        ON removed.worktree_id = raw_page.worktree_id
       AND removed.expected_snapshot_id = raw_page.snapshot_id
      ORDER BY raw_page.worktree_id`,
  };
}

interface CodeGraphReconciliationSchemaColumn {
  readonly defaultValue?: string;
  readonly name: string;
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
  readonly type: string;
}

const CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS = {
  active_snapshots: [
    {name: 'worktree_id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'snapshot_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'activated_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  removed_views: [
    {name: 'worktree_id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'expected_snapshot_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'removed_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  removed_view_cleanup: REMOVED_VIEW_CLEANUP_COLUMNS,
  schema_metadata: [
    {name: 'key', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'value', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  snapshots: [
    {name: 'id', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'repository_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'worktree_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'commit_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'graph_content_id', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'base_snapshot_id', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'extractor_set', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'dirty', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'overlay_fingerprint', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'state', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'file_count', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'symbol_count', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'edge_count', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {name: 'started_at', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'completed_at', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'failure_summary', notNull: false, primaryKeyPosition: 0, type: 'TEXT'},
  ],
  snapshot_leases: [
    {name: 'token', notNull: true, primaryKeyPosition: 1, type: 'TEXT'},
    {name: 'snapshot_id', notNull: true, primaryKeyPosition: 0, type: 'TEXT'},
    {name: 'expires_at', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
    {defaultValue: '0', name: 'retire_when_inactive', notNull: true, primaryKeyPosition: 0, type: 'INTEGER'},
  ],
} as const satisfies Record<string, readonly CodeGraphReconciliationSchemaColumn[]>;

type CodeGraphReconciliationTable = keyof typeof CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS;

const CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES = [
  {
    columns: ['snapshot_id', 'worktree_id'],
    definition: 'CREATE INDEX active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
    name: 'active_snapshots_snapshot_worktree',
    table: 'active_snapshots',
  },
  {
    columns: ['base_snapshot_id', 'state', 'id'],
    definition: 'CREATE INDEX snapshots_base_state_id ON snapshots(base_snapshot_id, state, id)',
    name: 'snapshots_base_state_id',
    table: 'snapshots',
  },
  {
    columns: ['snapshot_id', 'expires_at'],
    definition: 'CREATE INDEX snapshot_leases_snapshot_expiry ON snapshot_leases(snapshot_id, expires_at)',
    name: 'snapshot_leases_snapshot_expiry',
    table: 'snapshot_leases',
  },
] as const;

const CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX = {
  columns: ['expires_at'],
  definition: 'CREATE INDEX snapshot_leases_expiry ON snapshot_leases(expires_at)',
  name: 'snapshot_leases_expiry',
  table: 'snapshot_leases',
} as const;

const authorityPrimaryKeyBinary = Effect.fn('codeGraph.authorityPrimaryKeyBinary')(function* (
  sql: SqlClient.SqlClient,
  table: 'active_snapshots' | 'snapshot_leases' | 'snapshots',
  column: 'id' | 'token' | 'worktree_id',
) {
  const expectedName = `sqlite_autoindex_${table}_1`;
  const indexes = yield* sql.unsafe<{
    readonly name: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, tbl_name, type
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [expectedName],
  );
  const name = indexes[0]?.name;
  if (
    indexes.length !== 1 ||
    typeof name !== 'string' ||
    name !== expectedName ||
    indexes[0]?.tbl_name !== table ||
    indexes[0]?.type !== 'index'
  ) {
    return false;
  }
  const columns = yield* sql.unsafe<{
    readonly cid: unknown;
    readonly coll: unknown;
    readonly desc: unknown;
    readonly key: unknown;
    readonly name: unknown;
    readonly seqno: unknown;
  }>(`SELECT * FROM pragma_index_xinfo(?) LIMIT 3`, [name]);
  return (
    columns.length === 2 &&
    columns[0]?.seqno === 0 &&
    columns[0]?.name === column &&
    columns[0]?.desc === 0 &&
    columns[0]?.coll === 'BINARY' &&
    columns[0]?.key === 1 &&
    columns[1]?.seqno === 1 &&
    columns[1]?.cid === -1 &&
    columns[1]?.name === null &&
    columns[1]?.desc === 0 &&
    columns[1]?.coll === 'BINARY' &&
    columns[1]?.key === 0
  );
});

const boundedAuthorityTableDefinition = Effect.fn('codeGraph.boundedAuthorityTableDefinition')(function* (
  sql: SqlClient.SqlClient,
  table: 'snapshot_leases' | 'snapshots',
) {
  const definitions = yield* sql.unsafe<{
    readonly bounded_sql: unknown;
    readonly name: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [table],
  );
  const definition = definitions[0];
  return definitions.length === 1 &&
    definition?.name === table &&
    definition.type === 'table' &&
    definition.tbl_name === table &&
    typeof definition.sql_bytes === 'number' &&
    Number.isSafeInteger(definition.sql_bytes) &&
    definition.sql_bytes <= 8192 &&
    typeof definition.bounded_sql === 'string'
    ? definition.bounded_sql
    : undefined;
});

const codeGraphWorktreeReconciliationSchemaCompatible: (
  sql: SqlClient.SqlClient,
  requireIndexes?: boolean,
  requireCleanup?: boolean,
  requireRemovedViewAuthority?: boolean,
) => Effect.Effect<boolean, SqlError.SqlError> = Effect.fn('codeGraph.worktreeReconciliationSchemaCompatible')(
  function* (
    sql: SqlClient.SqlClient,
    requireIndexes = true,
    requireCleanup = true,
    requireRemovedViewAuthority = true,
  ) {
    const extensionRevision = yield* removedViewCleanupRecordedRevision(sql);
    if (extensionRevision.state === 'invalid') return false;
    for (const table of Object.keys(CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS) as CodeGraphReconciliationTable[]) {
      if (table === 'removed_view_cleanup' && !requireCleanup) continue;
      if (table === 'removed_views' && !requireRemovedViewAuthority) continue;
      const columns = yield* sql.unsafe<{
        readonly dflt_value: unknown;
        readonly hidden: number;
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
        readonly type: string;
      }>(
        `SELECT * FROM pragma_table_xinfo('${table}')
         LIMIT ${CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table].length + 1}`,
      );
      const observed = columns
        .map(column => ({
          hidden: Number(column.hidden),
          defaultValue: column.dflt_value,
          name: column.name,
          notNull: Number(column.notnull) === 1,
          primaryKeyPosition: Number(column.pk),
          type: column.type.toUpperCase(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const expected = [...CODE_GRAPH_RECONCILIATION_TABLE_COLUMNS[table]].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      if (
        observed.length !== expected.length ||
        observed.some((column, index) => {
          const contract = expected[index];
          return (
            contract === undefined ||
            column.hidden !== 0 ||
            column.defaultValue !== ('defaultValue' in contract ? contract.defaultValue : null) ||
            column.name !== contract.name ||
            column.type !== contract.type ||
            column.notNull !== contract.notNull ||
            column.primaryKeyPosition !== contract.primaryKeyPosition
          );
        })
      ) {
        return false;
      }
    }
    if (
      !(yield* authorityPrimaryKeyBinary(sql, 'active_snapshots', 'worktree_id')) ||
      !(yield* authorityPrimaryKeyBinary(sql, 'snapshot_leases', 'token')) ||
      !(yield* authorityPrimaryKeyBinary(sql, 'snapshots', 'id')) ||
      (yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready'
    ) {
      return false;
    }
    const schemaVersion = yield* inspectBoundedSchemaMetadataValue(sql, 'schema_version', 16);
    if (schemaVersion.state !== 'recorded' || schemaVersion.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
      if (!(extensionRevision.state === 'missing' && schemaVersion.state === 'missing')) return false;
    }
    const activeForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('active_snapshots') LIMIT 2`);
    if (
      activeForeignKeys.length !== 1 ||
      activeForeignKeys[0]?.from !== 'snapshot_id' ||
      activeForeignKeys[0]?.to !== 'id' ||
      activeForeignKeys[0]?.table !== 'snapshots' ||
      activeForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      activeForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      activeForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const removedForeignKeys = yield* sql.unsafe(`SELECT 1 FROM pragma_foreign_key_list('removed_views') LIMIT 1`);
    if (removedForeignKeys.length !== 0) return false;
    if (requireCleanup && !(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) return false;
    const snapshotForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('snapshots') LIMIT 2`);
    if (
      snapshotForeignKeys.length !== 1 ||
      snapshotForeignKeys[0]?.from !== 'repository_id' ||
      snapshotForeignKeys[0]?.to !== 'id' ||
      snapshotForeignKeys[0]?.table !== 'repositories' ||
      snapshotForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      snapshotForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      snapshotForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const leaseForeignKeys = yield* sql.unsafe<{
      readonly from: string;
      readonly match: string;
      readonly on_delete: string;
      readonly on_update: string;
      readonly table: string;
      readonly to: string;
    }>(`SELECT * FROM pragma_foreign_key_list('snapshot_leases') LIMIT 2`);
    if (
      leaseForeignKeys.length !== 1 ||
      leaseForeignKeys[0]?.from !== 'snapshot_id' ||
      leaseForeignKeys[0]?.to !== 'id' ||
      leaseForeignKeys[0]?.table !== 'snapshots' ||
      leaseForeignKeys[0]?.on_delete.toUpperCase() !== 'CASCADE' ||
      leaseForeignKeys[0]?.on_update.toUpperCase() !== 'NO ACTION' ||
      leaseForeignKeys[0]?.match.toUpperCase() !== 'NONE'
    ) {
      return false;
    }
    const leaseDefinition = yield* boundedAuthorityTableDefinition(sql, 'snapshot_leases');
    const snapshotDefinition = yield* boundedAuthorityTableDefinition(sql, 'snapshots');
    if (!(
      (!requireRemovedViewAuthority || (yield* removedViewAuthorityTableState(sql)) === 'compatible') &&
      leaseDefinition !== undefined &&
      /\bretire_when_inactive\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*retire_when_inactive\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/iu.test(
        leaseDefinition,
      ) &&
      snapshotDefinition !== undefined &&
      exactCodeGraphSnapshotStateCheck(snapshotDefinition)
    )) {
      return false;
    }
    if (requireIndexes) {
      for (const index of CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES) {
        if ((yield* codeGraphReconciliationIndexState(sql, index)) !== 'ready') return false;
      }
    }
    const triggers = yield* sql.unsafe<{
      readonly bounded_sql: unknown;
      readonly name: unknown;
      readonly sql_bytes: unknown;
      readonly tbl_name: unknown;
    }>(`SELECT name, tbl_name,
               CASE
                 WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 8192 THEN sql
                 ELSE NULL
               END AS bounded_sql,
               length(CAST(sql AS BLOB)) AS sql_bytes
        FROM sqlite_master
        WHERE type = 'trigger'
          AND (tbl_name = 'schema_metadata' COLLATE NOCASE
            OR tbl_name = 'active_snapshots' COLLATE NOCASE
            OR tbl_name = 'removed_views' COLLATE NOCASE
            OR tbl_name = 'snapshots' COLLATE NOCASE
            OR tbl_name = 'snapshot_leases' COLLATE NOCASE)
        ORDER BY name
        LIMIT 5`);
    const activeTrigger = triggers.filter(trigger => trigger.name === 'active_snapshots_require_current_extractor');
    const cleanupTriggers = triggers.filter(trigger =>
      REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.some(expected => expected.name === trigger.name),
    );
    const expectedTriggerCount = 1 + cleanupTriggers.length;
    if (
      triggers.length !== expectedTriggerCount ||
      triggers.some(
        trigger =>
          typeof trigger.name !== 'string' ||
          trigger.name !== trigger.name.toLowerCase() ||
          typeof trigger.tbl_name !== 'string' ||
          trigger.tbl_name !== trigger.tbl_name.toLowerCase() ||
          typeof trigger.sql_bytes !== 'number' ||
          !Number.isSafeInteger(trigger.sql_bytes) ||
          trigger.sql_bytes > 8192 ||
          typeof trigger.bounded_sql !== 'string',
      ) ||
      activeTrigger.length !== 1 ||
      activeTrigger[0]?.tbl_name !== 'active_snapshots' ||
      normalizeSchemaDefinition((activeTrigger[0]?.bounded_sql as string) ?? '') !==
        normalizeSchemaDefinition(CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL) ||
      (cleanupTriggers.length !== 0 && cleanupTriggers.length !== REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.length) ||
      (requireCleanup && cleanupTriggers.length !== REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.length) ||
      cleanupTriggers.some(trigger => {
        const expected = REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.find(candidate => candidate.name === trigger.name);
        return (
          expected === undefined ||
          trigger.tbl_name !== 'removed_views' ||
          normalizeSchemaDefinition((trigger.bounded_sql as string) ?? '') !== normalizeSchemaDefinition(expected.sql)
        );
      })
    ) {
      return false;
    }
    return true;
  },
);

function exactCodeGraphSnapshotStateCheck(definition: string): boolean {
  const match = /\bstate\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*state\s+IN\s*\((?<values>[^)]*)\)\s*\)/iu.exec(definition);
  const values = match?.groups?.values;
  if (values === undefined || values.replace(/'[^']*'/gu, '').replace(/[\s,]/gu, '') !== '') return false;
  return (
    [...values.matchAll(/'([^']*)'/gu)].map(value => value[1]).join('\0') ===
    ['building', 'ready', 'failed', 'retired'].join('\0')
  );
}

const prepareRemovedViewCleanupExtension = Effect.fn('codeGraph.prepareRemovedViewCleanupExtension')(function* (
  sql: SqlClient.SqlClient,
) {
  const preflightReady = yield* preflightRemovedViewCleanupSchema(sql).pipe(
    Effect.as(true),
    Effect.catch(error => (error instanceof CodeGraphStoreError ? Effect.succeed(false) : Effect.fail(error))),
  );
  if (!preflightReady) return {reason: 'incompatible-schema', state: 'deferred'} as const;
  if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, true, false))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const revisions = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'
  `;
  if (revisions.length !== 1 || (revisions[0]?.value !== '7' && revisions[0]?.value !== '8')) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  if (!(yield* codeGraphPersistentExtensionSchemaCompatible(sql))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const wasCurrent = yield* removedViewCleanupSchemaCurrent(sql);
  yield* ensureRemovedViewCleanupSchema(sql);
  if (!wasCurrent) {
    yield* sql`
      INSERT INTO schema_metadata (key, value)
      VALUES (${REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY}, '0')
    `;
  }
  if (revisions[0]?.value !== String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)) {
    yield* sql`
      UPDATE schema_metadata
      SET value = ${String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)}
      WHERE key = 'persistent_extension_schema_revision' AND value = ${revisions[0]!.value}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph cleanup schema revision changed during setup.'));
    }
  }
  if (!(yield* codeGraphRemovedViewCleanupSchemaAdmission(sql)).current) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
  }
  return wasCurrent && revisions[0]?.value === String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)
    ? ({state: 'ready'} as const)
    : ({index: 'removed_view_cleanup_due', state: 'prepared'} as const);
});

const prepareWorktreeReconciliationIndex = Effect.fn('codeGraph.prepareWorktreeReconciliationIndex')(function* (
  sql: SqlClient.SqlClient,
) {
  const preflightReady = yield* preflightRemovedViewCleanupSchema(sql).pipe(
    Effect.as(true),
    Effect.catch(error => (error instanceof CodeGraphStoreError ? Effect.succeed(false) : Effect.fail(error))),
  );
  if (!preflightReady || !(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false, false))) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql, false))) {
    const cleanupState = yield* removedViewCleanupSchemaState(sql);
    if (cleanupState !== 'absent') return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const states = yield* Effect.forEach(
    CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES,
    index => codeGraphReconciliationIndexState(sql, index).pipe(Effect.map(state => ({index, state}))),
    {concurrency: 1},
  );
  if (states.some(observation => observation.state === 'incompatible')) {
    return {reason: 'incompatible-schema', state: 'deferred'} as const;
  }
  const missing = states.find(observation => observation.state === 'missing');
  if (missing !== undefined) {
    yield* sql.unsafe(missing.index.definition);
    if ((yield* codeGraphReconciliationIndexState(sql, missing.index)) !== 'ready') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation index changed during setup.'));
    }
    return {index: missing.index.name, state: 'prepared'} as const;
  }
  const cleanup = yield* prepareRemovedViewCleanupExtension(sql);
  if (cleanup.state !== 'ready') return cleanup;
  return {state: 'ready'} as const;
});

type CodeGraphReconciliationRequiredIndex =
  (typeof CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES)[number] | typeof CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX;

const codeGraphReconciliationIndexState = Effect.fn('codeGraph.reconciliationIndexState')(function* (
  sql: SqlClient.SqlClient,
  index: CodeGraphReconciliationRequiredIndex,
) {
  const definitions = yield* sql.unsafe<{
    readonly bounded_sql: unknown;
    readonly name: unknown;
    readonly sql_bytes: unknown;
    readonly tbl_name: unknown;
    readonly type: unknown;
  }>(
    `SELECT name, type, tbl_name,
            CASE
              WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= 1024 THEN sql
              ELSE NULL
            END AS bounded_sql,
            length(CAST(sql AS BLOB)) AS sql_bytes
     FROM sqlite_master
     WHERE name = ? COLLATE NOCASE
     LIMIT 2`,
    [index.name],
  );
  if (definitions.length === 0) return 'missing' as const;
  if (
    definitions.length !== 1 ||
    definitions[0]?.name !== index.name ||
    definitions[0]?.type !== 'index' ||
    definitions[0]?.tbl_name !== index.table ||
    typeof definitions[0]?.sql_bytes !== 'number' ||
    !Number.isSafeInteger(definitions[0].sql_bytes) ||
    definitions[0].sql_bytes > 1024 ||
    typeof definitions[0]?.bounded_sql !== 'string' ||
    normalizeSchemaDefinition(definitions[0].bounded_sql) !== normalizeSchemaDefinition(index.definition)
  ) {
    return 'incompatible' as const;
  }
  const xinfo = yield* sql.unsafe<{
    readonly coll: string;
    readonly desc: number;
    readonly key: number;
    readonly name: string | null;
    readonly seqno: number;
  }>(`SELECT * FROM pragma_index_xinfo(?) LIMIT ${index.columns.length + 2}`, [index.name]);
  const keyColumns = xinfo.filter(column => Number(column.key) === 1).sort((left, right) => left.seqno - right.seqno);
  return xinfo.length === index.columns.length + 1 &&
    keyColumns.length === index.columns.length &&
    keyColumns.every(
      (column, columnIndex) =>
        column.name === index.columns[columnIndex] &&
        column.coll.toUpperCase() === 'BINARY' &&
        Number(column.desc) === 0,
    )
    ? ('ready' as const)
    : ('incompatible' as const);
});

const ensureInitialReconciliationIndexes = Effect.fn('codeGraph.ensureInitialReconciliationIndexes')(function* (
  sql: SqlClient.SqlClient,
) {
  const revision = yield* removedViewCleanupRecordedRevision(sql);
  const expiryIndexState = yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX);
  if (expiryIndexState !== 'ready') {
    if (expiryIndexState === 'incompatible') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease expiry index is incompatible.'));
    }
    const rows = yield* sql.unsafe('SELECT 1 FROM snapshot_leases LIMIT 1');
    if (revision.state !== 'missing' || rows.length !== 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease expiry index is unavailable.'));
    }
    yield* sql.unsafe(CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX.definition);
    if ((yield* codeGraphReconciliationIndexState(sql, CODE_GRAPH_SNAPSHOT_LEASE_EXPIRY_INDEX)) !== 'ready') {
      return yield* Effect.fail(
        new CodeGraphStoreError('Code graph snapshot lease expiry index changed during setup.'),
      );
    }
  }
  for (const index of CODE_GRAPH_RECONCILIATION_REQUIRED_INDEXES) {
    const state = yield* codeGraphReconciliationIndexState(sql, index);
    if (state === 'ready') continue;
    if (state === 'incompatible') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation index is incompatible.'));
    }
    // Only an empty, not-yet-versioned core database may create all required
    // indexes synchronously. Existing databases prepare one missing index per
    // bounded maintenance tick before publishing revision 8.
    if (revision.state !== 'missing') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation index is unavailable.'));
    }
    const rows = yield* sql.unsafe(`SELECT 1 FROM "${index.table}" LIMIT 1`);
    if (rows.length !== 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation index requires preparation.'));
    }
    yield* sql.unsafe(index.definition);
    if ((yield* codeGraphReconciliationIndexState(sql, index)) !== 'ready') {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph reconciliation index changed during setup.'));
    }
  }
});

function normalizeSchemaDefinition(value: string): string {
  const quoted: string[] = [];
  let unquoted = '';
  for (let index = 0; index < value.length; index += 1) {
    const opener = value[index]!;
    const closer = opener === '[' ? ']' : opener;
    if (opener !== "'" && opener !== '"' && opener !== '`' && opener !== '[') {
      unquoted += opener;
      continue;
    }
    const start = index;
    for (index += 1; index < value.length; index += 1) {
      if (value[index] !== closer) continue;
      if (closer !== ']' && value[index + 1] === closer) {
        index += 1;
        continue;
      }
      break;
    }
    quoted.push(value.slice(start, Math.min(index + 1, value.length)));
    unquoted += `\u0000${quoted.length - 1}\u0000`;
  }
  return unquoted
    .toLowerCase()
    .replace(/\bif not exists\b/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim()
    .split('\u0000')
    .map((segment, index) => (index % 2 === 1 ? (quoted[Number(segment)] ?? '') : segment))
    .join('');
}

interface RemovedViewCleanupRow {
  readonly attempts: unknown;
  readonly blocked_code: unknown;
  readonly cursor_token: unknown;
  readonly epoch: unknown;
  readonly expected_snapshot_id: unknown;
  readonly next_attempt_at: unknown;
  readonly phase: unknown;
  readonly provenance_record_digest: unknown;
  readonly provenance_record_identity: unknown;
  readonly removed_at: unknown;
  readonly repository_id: unknown;
  readonly revision: unknown;
  readonly updated_at: unknown;
  readonly worktree_id: unknown;
}

const REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION = `
  CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
    THEN worktree_id ELSE NULL END AS worktree_id,
  CASE WHEN typeof(expected_snapshot_id) = 'text'
         AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
    THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
  CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
    THEN removed_at ELSE NULL END AS removed_at,
  CASE WHEN typeof(epoch) = 'integer' AND epoch BETWEEN 1 AND 9007199254740991
    THEN epoch ELSE NULL END AS epoch,
  CASE WHEN repository_id IS NULL OR (
         typeof(repository_id) = 'text' AND length(CAST(repository_id AS BLOB)) = 64
       ) THEN repository_id ELSE 0 END AS repository_id,
  CASE WHEN provenance_record_digest IS NULL OR (
         typeof(provenance_record_digest) = 'text'
         AND length(CAST(provenance_record_digest AS BLOB)) = 64
       ) THEN provenance_record_digest ELSE 0 END AS provenance_record_digest,
  CASE WHEN provenance_record_identity IS NULL OR (
         typeof(provenance_record_identity) = 'text'
         AND length(CAST(provenance_record_identity AS BLOB)) = 64
       ) THEN provenance_record_identity ELSE 0 END AS provenance_record_identity,
  CASE WHEN typeof(phase) = 'text' AND length(CAST(phase AS BLOB)) <= 15
    THEN phase ELSE NULL END AS phase,
  CASE WHEN cursor_token IS NULL OR (
         typeof(cursor_token) = 'text' AND length(CAST(cursor_token AS BLOB)) BETWEEN 1 AND 512
       ) THEN cursor_token ELSE 0 END AS cursor_token,
  CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991
    THEN revision ELSE NULL END AS revision,
  CASE WHEN typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 9007199254740991
    THEN attempts ELSE NULL END AS attempts,
  CASE WHEN typeof(next_attempt_at) = 'integer' AND next_attempt_at BETWEEN 0 AND 253402300799999
    THEN next_attempt_at ELSE NULL END AS next_attempt_at,
  CASE WHEN blocked_code IS NULL OR (
         typeof(blocked_code) = 'text' AND length(CAST(blocked_code AS BLOB)) BETWEEN 1 AND 32
       ) THEN blocked_code ELSE 0 END AS blocked_code,
  CASE WHEN typeof(updated_at) = 'text' AND length(CAST(updated_at AS BLOB)) = 24
    THEN updated_at ELSE NULL END AS updated_at`;

const CLEANUP_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/u;
const CODE_GRAPH_SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;

function validRemovedViewCleanupBlockedCode(value: string): value is CodeGraphRemovedViewCleanupBlockedCode {
  return CODE_GRAPH_REMOVED_VIEW_CLEANUP_BLOCKED_CODES.includes(value as CodeGraphRemovedViewCleanupBlockedCode);
}

function validCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    value.length === 24 &&
    Number.isFinite(milliseconds) &&
    milliseconds <= MAXIMUM_CANONICAL_DATE_MILLISECONDS &&
    new Date(milliseconds).toISOString() === value
  );
}

function validRemovedViewCleanupEvidence(evidence: CodeGraphRemovedViewCleanupEvidence): boolean {
  return (
    /^[0-9a-f]{64}$/u.test(evidence.repositoryId) &&
    /^[0-9a-f]{64}$/u.test(evidence.recordDigest) &&
    /^[0-9a-f]{64}$/u.test(evidence.recordIdentity)
  );
}

function decodeRemovedViewCleanupRow(row: RemovedViewCleanupRow): CodeGraphRemovedViewCleanupEntry | undefined {
  if (
    typeof row.worktree_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(row.worktree_id) ||
    typeof row.expected_snapshot_id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(row.expected_snapshot_id) ||
    typeof row.removed_at !== 'string' ||
    !validCanonicalTimestamp(row.removed_at) ||
    typeof row.epoch !== 'number' ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch <= 0 ||
    (row.repository_id !== null &&
      (typeof row.repository_id !== 'string' || !/^[0-9a-f]{64}$/u.test(row.repository_id))) ||
    (row.provenance_record_digest !== null &&
      (typeof row.provenance_record_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.provenance_record_digest))) ||
    (row.provenance_record_identity !== null &&
      (typeof row.provenance_record_identity !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(row.provenance_record_identity))) ||
    !(
      (row.repository_id === null &&
        row.provenance_record_digest === null &&
        row.provenance_record_identity === null) ||
      (typeof row.repository_id === 'string' &&
        typeof row.provenance_record_digest === 'string' &&
        typeof row.provenance_record_identity === 'string')
    ) ||
    typeof row.phase !== 'string' ||
    !CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.includes(row.phase as CodeGraphRemovedViewCleanupPhase) ||
    (row.cursor_token !== null && (typeof row.cursor_token !== 'string' || !CLEANUP_TOKEN.test(row.cursor_token))) ||
    (row.phase === 'complete' && (row.cursor_token !== null || row.blocked_code !== null)) ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.attempts !== 'number' ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 0 ||
    typeof row.next_attempt_at !== 'number' ||
    !Number.isSafeInteger(row.next_attempt_at) ||
    row.next_attempt_at < 0 ||
    row.next_attempt_at > MAXIMUM_CANONICAL_DATE_MILLISECONDS ||
    (row.blocked_code !== null &&
      (typeof row.blocked_code !== 'string' || !validRemovedViewCleanupBlockedCode(row.blocked_code))) ||
    typeof row.updated_at !== 'string' ||
    !validCanonicalTimestamp(row.updated_at)
  ) {
    return undefined;
  }
  return {
    attempts: row.attempts,
    ...(typeof row.blocked_code === 'string' ? {blockedCode: row.blocked_code} : {}),
    ...(typeof row.cursor_token === 'string' ? {cursorToken: row.cursor_token} : {}),
    epoch: row.epoch,
    expectedSnapshotId: row.expected_snapshot_id,
    nextAttemptAt: row.next_attempt_at,
    phase: row.phase as CodeGraphRemovedViewCleanupPhase,
    ...(typeof row.provenance_record_digest === 'string' ? {provenanceRecordDigest: row.provenance_record_digest} : {}),
    ...(typeof row.provenance_record_identity === 'string'
      ? {provenanceRecordIdentity: row.provenance_record_identity}
      : {}),
    removedAt: row.removed_at,
    ...(typeof row.repository_id === 'string' ? {repositoryId: row.repository_id} : {}),
    revision: row.revision,
    updatedAt: row.updated_at,
    worktreeId: row.worktree_id,
  };
}

function sameRemovedViewCleanupEntry(
  left: CodeGraphRemovedViewCleanupEntry,
  right: CodeGraphRemovedViewCleanupEntry,
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.expectedSnapshotId === right.expectedSnapshotId &&
    left.removedAt === right.removedAt &&
    left.epoch === right.epoch &&
    left.repositoryId === right.repositoryId &&
    left.provenanceRecordDigest === right.provenanceRecordDigest &&
    left.provenanceRecordIdentity === right.provenanceRecordIdentity &&
    left.phase === right.phase &&
    left.cursorToken === right.cursorToken &&
    left.revision === right.revision &&
    left.attempts === right.attempts &&
    left.nextAttemptAt === right.nextAttemptAt &&
    left.blockedCode === right.blockedCode &&
    left.updatedAt === right.updatedAt
  );
}

const selectRemovedViewCleanupEntry = Effect.fn('codeGraph.selectRemovedViewCleanupEntry')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
) {
  const rows = yield* sql.unsafe<RemovedViewCleanupRow>(
    `SELECT ${REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION}
     FROM removed_view_cleanup
     WHERE worktree_id = ? AND expected_snapshot_id = ?
     LIMIT 1`,
    [worktreeId, expectedSnapshotId],
  );
  if (rows.length === 0) return undefined;
  const entry = decodeRemovedViewCleanupRow(rows[0]!);
  if (entry === undefined) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup row is invalid.'));
  }
  return entry;
});

const validateRemovedViewSnapshotAuthority = Effect.fn('codeGraph.validateRemovedViewSnapshotAuthority')(function* (
  sql: SqlClient.SqlClient,
  expectedSnapshotId: string,
  requireSnapshot: boolean,
  evidence?: CodeGraphRemovedViewCleanupEvidence,
) {
  const snapshots = yield* sql.unsafe<{
    readonly id: unknown;
    readonly repository_id: unknown;
    readonly worktree_id: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) BETWEEN 45 AND 67
         THEN id ELSE NULL END AS id,
       CASE WHEN typeof(repository_id) = 'text' AND length(CAST(repository_id AS BLOB)) = 64
         THEN repository_id ELSE NULL END AS repository_id,
       CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
         THEN worktree_id ELSE NULL END AS worktree_id
     FROM snapshots WHERE id = ? LIMIT 2`,
    [expectedSnapshotId],
  );
  if (snapshots.length === 0) {
    if (!requireSnapshot) return;
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view snapshot authority is unavailable.'));
  }
  const snapshot = snapshots[0]!;
  if (
    snapshots.length !== 1 ||
    snapshot.id !== expectedSnapshotId ||
    typeof snapshot.id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(snapshot.id) ||
    typeof snapshot.repository_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.repository_id) ||
    typeof snapshot.worktree_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.worktree_id) ||
    (evidence !== undefined && evidence.repositoryId !== snapshot.repository_id)
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view snapshot authority is invalid.'));
  }
});

const allocateRemovedViewCleanupEpoch = Effect.fn('codeGraph.allocateRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
) {
  const sequence = yield* inspectBoundedSchemaMetadataValue(sql, REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY, 16);
  if (
    sequence.state !== 'recorded' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(sequence.value) ||
    !Number.isSafeInteger(Number(sequence.value)) ||
    Number(sequence.value) >= Number.MAX_SAFE_INTEGER
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup epoch sequence is invalid.'));
  }
  const epoch = Number(sequence.value) + 1;
  yield* sql`
    UPDATE schema_metadata
    SET value = ${String(epoch)}
    WHERE key = ${REMOVED_VIEW_CLEANUP_EPOCH_SEQUENCE_KEY}
      AND value = ${sequence.value}
  `;
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup epoch sequence changed.'));
  }
  return epoch;
});

const markSnapshotLeaseRetirementBaton = Effect.fn('codeGraph.markSnapshotLeaseRetirementBaton')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  now: number,
) {
  const rows = yield* sql.unsafe<BoundedSnapshotLeaseRow & {readonly lease_rowid: unknown}>(
    `SELECT
       CASE WHEN typeof(lease.rowid) = 'integer' AND lease.rowid BETWEEN 1 AND 9007199254740991
         THEN lease.rowid ELSE NULL END AS lease_rowid,
       ${boundedSnapshotLeaseProjection('lease')}
     FROM snapshot_leases AS lease INDEXED BY snapshot_leases_snapshot_expiry
     WHERE lease.snapshot_id = ? AND lease.expires_at > ?
     ORDER BY lease.expires_at
     LIMIT 1`,
    [snapshotId, now],
  );
  if (rows.length === 0) return 0;
  const lease = decodeSnapshotLeaseManifest(rows[0]!);
  const rowid = rows[0]?.lease_rowid;
  if (
    lease === undefined ||
    lease.snapshotId !== snapshotId ||
    typeof rowid !== 'number' ||
    !Number.isSafeInteger(rowid) ||
    rowid <= 0
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph snapshot lease baton is invalid.'));
  }
  yield* sql`
    UPDATE snapshot_leases
    SET retire_when_inactive = 1
    WHERE rowid = ${rowid}
  `;
  return yield* lastStatementChangeCount(sql);
});

const ensureRemovedViewCleanupEpoch = Effect.fn('codeGraph.ensureRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  updatedAt: string,
  bindNewEpochEvidence: boolean,
  evidence?: CodeGraphRemovedViewCleanupEvidence,
  requireExistingEvidenceMatch = false,
) {
  const existing = yield* selectRemovedViewCleanupEntry(sql, worktreeId, expectedSnapshotId);
  if (existing !== undefined) {
    if (existing.removedAt !== updatedAt) {
      yield* sql`
        DELETE FROM removed_view_cleanup
        WHERE worktree_id = ${worktreeId}
          AND expected_snapshot_id = ${expectedSnapshotId}
          AND removed_at = ${existing.removedAt}
          AND epoch = ${existing.epoch}
          AND revision = ${existing.revision}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup epoch changed.'));
      }
    } else {
      if (
        (bindNewEpochEvidence || requireExistingEvidenceMatch) &&
        existing.repositoryId !== undefined &&
        evidence !== undefined &&
        (existing.repositoryId !== evidence.repositoryId ||
          existing.provenanceRecordDigest !== evidence.recordDigest ||
          existing.provenanceRecordIdentity !== evidence.recordIdentity)
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup evidence changed.'));
      }
      // Epoch evidence is immutable. A later retry cannot attach current
      // sidecar evidence to a legacy tombstone that predates that evidence.
      if (!bindNewEpochEvidence) {
        yield* markSnapshotLeaseRetirementBaton(sql, expectedSnapshotId, yield* Clock.currentTimeMillis);
      }
      return;
    }
  }

  const boundEvidence = bindNewEpochEvidence ? evidence : undefined;
  const epoch = yield* allocateRemovedViewCleanupEpoch(sql);
  yield* sql`
    INSERT INTO removed_view_cleanup (
      worktree_id, expected_snapshot_id, removed_at, epoch, repository_id,
      provenance_record_digest, provenance_record_identity,
      phase, cursor_token, revision, attempts, next_attempt_at,
      blocked_code, updated_at
    ) VALUES (
      ${worktreeId}, ${expectedSnapshotId}, ${updatedAt}, ${epoch}, ${boundEvidence?.repositoryId ?? null},
      ${boundEvidence?.recordDigest ?? null}, ${boundEvidence?.recordIdentity ?? null},
      'vector-pointers', NULL, 0, 0, 0, NULL, ${updatedAt}
    )
  `;
  if (!bindNewEpochEvidence) {
    yield* markSnapshotLeaseRetirementBaton(sql, expectedSnapshotId, yield* Clock.currentTimeMillis);
  }
});

function validRemovedViewCleanupUpdate(
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
): boolean {
  const currentPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
  const nextPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(update.phase);
  const samePhase = nextPhase === currentPhase;
  const advancesPhase = nextPhase === currentPhase + 1;
  const progress =
    samePhase &&
    update.blockedCode === undefined &&
    update.cursorToken !== undefined &&
    update.cursorToken !== entry.cursorToken;
  const deferred = samePhase && update.blockedCode !== undefined;
  return (
    currentPhase >= 0 &&
    currentPhase < CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.length - 1 &&
    (samePhase || advancesPhase) &&
    entry.revision < Number.MAX_SAFE_INTEGER &&
    Number.isSafeInteger(update.attempts) &&
    Number.isSafeInteger(update.nextAttemptAt) &&
    update.nextAttemptAt >= 0 &&
    update.nextAttemptAt <= MAXIMUM_CANONICAL_DATE_MILLISECONDS &&
    (update.cursorToken === undefined || CLEANUP_TOKEN.test(update.cursorToken)) &&
    (update.blockedCode === undefined || validRemovedViewCleanupBlockedCode(update.blockedCode)) &&
    validCanonicalTimestamp(update.updatedAt) &&
    Date.parse(update.updatedAt) >= Date.parse(entry.updatedAt) &&
    ((progress && update.attempts === entry.attempts) ||
      (deferred &&
        entry.attempts < Number.MAX_SAFE_INTEGER &&
        update.attempts === entry.attempts + 1 &&
        update.cursorToken === entry.cursorToken &&
        update.nextAttemptAt > entry.nextAttemptAt) ||
      (advancesPhase &&
        update.attempts === 0 &&
        update.cursorToken === undefined &&
        update.blockedCode === undefined)) &&
    (update.phase !== 'complete' || (update.cursorToken === undefined && update.blockedCode === undefined))
  );
}

function validRemovedViewCleanupEntry(entry: CodeGraphRemovedViewCleanupEntry): boolean {
  const decoded = decodeRemovedViewCleanupRow({
    attempts: entry.attempts,
    blocked_code: entry.blockedCode ?? null,
    cursor_token: entry.cursorToken ?? null,
    epoch: entry.epoch,
    expected_snapshot_id: entry.expectedSnapshotId,
    next_attempt_at: entry.nextAttemptAt,
    phase: entry.phase,
    provenance_record_digest: entry.provenanceRecordDigest ?? null,
    provenance_record_identity: entry.provenanceRecordIdentity ?? null,
    removed_at: entry.removedAt,
    repository_id: entry.repositoryId ?? null,
    revision: entry.revision,
    updated_at: entry.updatedAt,
    worktree_id: entry.worktreeId,
  });
  return decoded !== undefined && sameRemovedViewCleanupEntry(decoded, entry);
}

/** @internal Bounded keyset page retained for admission query-plan and load regressions. */
export function codeGraphRemovedViewCleanupAdmissionPageStatement(
  cursor: string | undefined,
  boundary: 'after' | 'through',
  requestedLimit = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS, requestedLimit))
    : CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS;
  const predicate =
    cursor === undefined
      ? ''
      : boundary === 'after'
        ? 'WHERE removed.worktree_id > ?'
        : 'WHERE removed.worktree_id <= ?';
  return {
    parameters: cursor === undefined ? [limit] : [cursor, limit],
    text: `SELECT
        CASE WHEN typeof(worktree_id) = 'text' AND length(CAST(worktree_id AS BLOB)) = 64
          THEN worktree_id ELSE NULL END AS worktree_id,
        CASE WHEN typeof(expected_snapshot_id) = 'text'
               AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
          THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id,
        CASE WHEN typeof(removed_at) = 'text' AND length(CAST(removed_at AS BLOB)) = 24
          THEN removed_at ELSE NULL END AS removed_at
      FROM removed_views AS removed
      ${predicate}
      ORDER BY removed.worktree_id
      LIMIT ?`,
  };
}

/** @internal Indexed due page retained for query-plan and crash-fairness regressions. */
export function codeGraphRemovedViewCleanupDuePageStatement(
  nowMilliseconds: number,
  requestedLimit = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
): CodeGraphSqlQueryStatement {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS, requestedLimit))
    : CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS;
  return {
    parameters: [nowMilliseconds, limit],
    text: `SELECT ${REMOVED_VIEW_CLEANUP_BOUNDED_ROW_PROJECTION}
      FROM removed_view_cleanup AS cleanup INDEXED BY removed_view_cleanup_due
      WHERE cleanup.phase <> 'complete' AND cleanup.next_attempt_at <= ?
      ORDER BY cleanup.next_attempt_at, cleanup.worktree_id, cleanup.expected_snapshot_id
      LIMIT ?`,
  };
}

const admitRemovedViewCleanupEpoch = Effect.fn('codeGraph.admitRemovedViewCleanupEpoch')(function* (
  sql: SqlClient.SqlClient,
) {
  const cursorInspection = yield* inspectRemovedViewCleanupAdmissionCursor(sql);
  if (!cursorInspection.current) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup admission cursor is invalid.'));
  }
  const cursor = cursorInspection.cursor;
  const selectPage = (boundary: 'after' | 'through', limit: number) => {
    const statement = codeGraphRemovedViewCleanupAdmissionPageStatement(cursor, boundary, limit);
    return sql.unsafe<{
      readonly expected_snapshot_id: unknown;
      readonly removed_at: unknown;
      readonly worktree_id: unknown;
    }>(statement.text, statement.parameters);
  };
  const after = yield* selectPage('after', CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS);
  const rows =
    cursor === undefined || after.length >= CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS
      ? after
      : [...after, ...(yield* selectPage('through', CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS - after.length))];
  const tombstones = rows.map(row => {
    if (
      typeof row.worktree_id !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(row.worktree_id) ||
      typeof row.expected_snapshot_id !== 'string' ||
      !CODE_GRAPH_SNAPSHOT_ID.test(row.expected_snapshot_id) ||
      typeof row.removed_at !== 'string' ||
      !validCanonicalTimestamp(row.removed_at)
    ) {
      return undefined;
    }
    return {
      expectedSnapshotId: row.expected_snapshot_id,
      removedAt: row.removed_at,
      worktreeId: row.worktree_id,
    };
  });
  if (tombstones.some(tombstone => tombstone === undefined)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup admission row is invalid.'));
  }

  let nextCursor = tombstones.at(-1)?.worktreeId;
  for (const tombstone of tombstones as readonly {
    readonly expectedSnapshotId: string;
    readonly removedAt: string;
    readonly worktreeId: string;
  }[]) {
    const existing = yield* selectRemovedViewCleanupEntry(sql, tombstone.worktreeId, tombstone.expectedSnapshotId);
    if (existing !== undefined && existing.removedAt === tombstone.removedAt) continue;
    yield* validateRemovedViewSnapshotAuthority(sql, tombstone.expectedSnapshotId, false);
    yield* ensureRemovedViewCleanupEpoch(
      sql,
      tombstone.worktreeId,
      tombstone.expectedSnapshotId,
      tombstone.removedAt,
      false,
    );
    nextCursor = tombstone.worktreeId;
    break;
  }
  if (nextCursor !== undefined) {
    yield* sql`
      INSERT INTO schema_metadata (key, value)
      VALUES (${REMOVED_VIEW_CLEANUP_ADMISSION_CURSOR_KEY}, ${nextCursor})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }
});

const REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE = `worktree_id = ?
  AND expected_snapshot_id = ?
  AND removed_at = ?
  AND epoch = ?
  AND repository_id IS ?
  AND provenance_record_digest IS ?
  AND provenance_record_identity IS ?
  AND phase = ?
  AND cursor_token IS ?
  AND revision = ?
  AND attempts = ?
  AND next_attempt_at = ?
  AND blocked_code IS ?
  AND updated_at = ?`;

function removedViewCleanupEntryCasParameters(entry: CodeGraphRemovedViewCleanupEntry): readonly unknown[] {
  return [
    entry.worktreeId,
    entry.expectedSnapshotId,
    entry.removedAt,
    entry.epoch,
    entry.repositoryId ?? null,
    entry.provenanceRecordDigest ?? null,
    entry.provenanceRecordIdentity ?? null,
    entry.phase,
    entry.cursorToken ?? null,
    entry.revision,
    entry.attempts,
    entry.nextAttemptAt,
    entry.blockedCode ?? null,
    entry.updatedAt,
  ];
}

const revokeRemovedViewCleanupEntry = Effect.fn('codeGraph.revokeRemovedViewCleanupEntry')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
  yield* sql.unsafe(
    `DELETE FROM removed_view_cleanup WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
    removedViewCleanupEntryCasParameters(entry),
  );
  if ((yield* lastStatementChangeCount(sql)) !== 1) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup revocation changed.'));
  }
});

const claimRemovedViewCleanupCandidates = Effect.fn('codeGraph.claimRemovedViewCleanupCandidates')(function* (
  sql: SqlClient.SqlClient,
  nowMilliseconds: number,
  requestedLimit: number,
) {
  if (
    !Number.isSafeInteger(nowMilliseconds) ||
    nowMilliseconds < 0 ||
    nowMilliseconds > MAXIMUM_CANONICAL_DATE_MILLISECONDS - CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit <= 0
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup claim time is invalid.'));
  }
  const nextAttemptAt = nowMilliseconds + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
      yield* admitRemovedViewCleanupEpoch(sql);
      const statement = codeGraphRemovedViewCleanupDuePageStatement(nowMilliseconds, requestedLimit);
      const rows = yield* sql.unsafe<RemovedViewCleanupRow>(statement.text, statement.parameters);
      const entries = rows.map(decodeRemovedViewCleanupRow);
      if (
        entries.some(entry => entry === undefined) ||
        entries.some(entry => entry !== undefined && entry.revision >= Number.MAX_SAFE_INTEGER)
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup claim row is invalid.'));
      }
      const claimed: CodeGraphRemovedViewCleanupEntry[] = [];
      for (const entry of entries as readonly CodeGraphRemovedViewCleanupEntry[]) {
        const claimedAt = new Date(Math.max(nowMilliseconds, Date.parse(entry.updatedAt))).toISOString();
        yield* sql.unsafe(
          `UPDATE removed_view_cleanup
           SET revision = ?, next_attempt_at = ?, updated_at = ?
           WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
          [entry.revision + 1, nextAttemptAt, claimedAt, ...removedViewCleanupEntryCasParameters(entry)],
        );
        if ((yield* lastStatementChangeCount(sql)) !== 1) {
          return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup claim changed.'));
        }
        claimed.push({...entry, nextAttemptAt, revision: entry.revision + 1, updatedAt: claimedAt});
      }
      return claimed as readonly CodeGraphRemovedViewCleanupEntry[];
    }),
  );
});

const observeRemovedViewCleanupAuthority = Effect.fn('codeGraph.observeRemovedViewCleanupAuthority')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
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
    [entry.worktreeId],
  );
  if (removed.length === 0) return {state: 'stale'} as const;
  if (
    removed.length !== 1 ||
    typeof removed[0]?.expected_snapshot_id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(removed[0].expected_snapshot_id) ||
    typeof removed[0]?.removed_at !== 'string' ||
    !validCanonicalTimestamp(removed[0].removed_at)
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
  }
  if (removed[0].expected_snapshot_id !== entry.expectedSnapshotId || removed[0].removed_at !== entry.removedAt) {
    return {state: 'stale'} as const;
  }
  const evidence =
    entry.repositoryId !== undefined &&
    entry.provenanceRecordDigest !== undefined &&
    entry.provenanceRecordIdentity !== undefined
      ? {
          recordDigest: entry.provenanceRecordDigest,
          recordIdentity: entry.provenanceRecordIdentity,
          repositoryId: entry.repositoryId,
        }
      : undefined;
  yield* validateRemovedViewSnapshotAuthority(sql, entry.expectedSnapshotId, false, evidence);
  const active = yield* sql.unsafe<{readonly snapshot_id: unknown}>(
    `SELECT CASE
       WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
       THEN snapshot_id ELSE NULL END AS snapshot_id
     FROM active_snapshots WHERE worktree_id = ? LIMIT 2`,
    [entry.worktreeId],
  );
  const activeSnapshotId = active[0]?.snapshot_id;
  if (
    active.length > 1 ||
    (activeSnapshotId !== undefined &&
      (typeof activeSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(activeSnapshotId)))
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph active view authority is invalid.'));
  }
  return activeSnapshotId === undefined || activeSnapshotId === entry.expectedSnapshotId
    ? ({matchingActivePointer: activeSnapshotId === entry.expectedSnapshotId, state: 'authorized'} as const)
    : ({observedSnapshotId: activeSnapshotId, state: 'active-pointer-changed'} as const);
});

const removeMatchingLegacyCleanupPointer = Effect.fn('codeGraph.removeMatchingLegacyCleanupPointer')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
  matchingActivePointer: boolean,
) {
  if (matchingActivePointer) {
    yield* sql`
      DELETE FROM active_snapshots
      WHERE worktree_id = ${entry.worktreeId} AND snapshot_id = ${entry.expectedSnapshotId}
    `;
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* Effect.fail(new CodeGraphStoreError('Code graph active view pointer changed.'));
    }
  }
});

const authorizeRemovedViewCleanup = Effect.fn('codeGraph.authorizeRemovedViewCleanup')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
) {
  if (!validRemovedViewCleanupEntry(entry) || entry.phase === 'complete') {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup candidate is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
      const current = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (current === undefined || !sameRemovedViewCleanupEntry(current, entry)) return {state: 'stale'} as const;
      const authority = yield* observeRemovedViewCleanupAuthority(sql, entry);
      if (authority.state === 'stale') {
        yield* revokeRemovedViewCleanupEntry(sql, entry);
        return authority;
      }
      if (authority.state !== 'authorized') return authority;
      yield* removeMatchingLegacyCleanupPointer(sql, entry, authority.matchingActivePointer);
      return {entry, state: 'authorized'} as const;
    }),
  );
});

const updateRemovedViewCleanup = Effect.fn('codeGraph.updateRemovedViewCleanup')(function* (
  sql: SqlClient.SqlClient,
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
) {
  if (!validRemovedViewCleanupEntry(entry) || !validRemovedViewCleanupUpdate(entry, update)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup update is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup schema is unavailable.'));
      }
      const current = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (current === undefined || !sameRemovedViewCleanupEntry(current, entry)) return {state: 'stale'} as const;
      const authority = yield* observeRemovedViewCleanupAuthority(sql, entry);
      if (authority.state === 'stale') {
        yield* revokeRemovedViewCleanupEntry(sql, entry);
        return authority;
      }
      if (authority.state !== 'authorized') return authority;
      yield* sql.unsafe(
        `UPDATE removed_view_cleanup
         SET phase = ?, cursor_token = ?, revision = ?, attempts = ?,
             next_attempt_at = ?, blocked_code = ?, updated_at = ?
         WHERE ${REMOVED_VIEW_CLEANUP_FULL_ENTRY_PREDICATE}`,
        [
          update.phase,
          update.cursorToken ?? null,
          entry.revision + 1,
          update.attempts,
          update.nextAttemptAt,
          update.blockedCode ?? null,
          update.updatedAt,
          ...removedViewCleanupEntryCasParameters(entry),
        ],
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup update changed.'));
      }
      yield* removeMatchingLegacyCleanupPointer(sql, entry, authority.matchingActivePointer);
      const updated = yield* selectRemovedViewCleanupEntry(sql, entry.worktreeId, entry.expectedSnapshotId);
      if (updated === undefined) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup update disappeared.'));
      }
      return {entry: updated, state: 'updated'} as const;
    }),
  );
});

const removeActiveView = Effect.fn('codeGraph.removeActiveView')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
  expectedSnapshotId: string,
  requireReconciliationSchema = false,
  cleanupEvidence?: CodeGraphRemovedViewCleanupEvidence,
) {
  yield* validateViewRemovalTarget(worktreeId, expectedSnapshotId);
  if (cleanupEvidence !== undefined && !validRemovedViewCleanupEvidence(cleanupEvidence)) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view cleanup evidence is invalid.'));
  }
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* Effect.fail(
          new CodeGraphStoreError(
            requireReconciliationSchema
              ? 'Code graph reconciliation schema is unavailable.'
              : 'Code graph removal authority schema is unavailable.',
          ),
        );
      }
      const active = yield* sql.unsafe<{readonly snapshot_id: unknown}>(
        `SELECT CASE
           WHEN typeof(snapshot_id) = 'text' AND length(CAST(snapshot_id AS BLOB)) BETWEEN 45 AND 67
           THEN snapshot_id ELSE NULL END AS snapshot_id
         FROM active_snapshots WHERE worktree_id = ? LIMIT 2`,
        [worktreeId],
      );
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
        [worktreeId],
      );
      const activeSnapshotId = active[0]?.snapshot_id;
      const removedSnapshotId = removed[0]?.expected_snapshot_id;
      const removedAtValue = removed[0]?.removed_at;

      if (
        active.length > 1 ||
        (activeSnapshotId !== undefined &&
          (typeof activeSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(activeSnapshotId))) ||
        removed.length > 1 ||
        (removedSnapshotId !== undefined &&
          (typeof removedSnapshotId !== 'string' || !CODE_GRAPH_SNAPSHOT_ID.test(removedSnapshotId))) ||
        (removedAtValue !== undefined &&
          (typeof removedAtValue !== 'string' || !validCanonicalTimestamp(removedAtValue)))
      ) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
      }

      if (activeSnapshotId !== undefined && activeSnapshotId !== expectedSnapshotId) {
        return {
          expectedSnapshotId,
          observedSnapshotId: activeSnapshotId,
          observedState: 'active',
          state: 'stale-target',
        } satisfies CodeGraphViewRemovalResult;
      }
      if (activeSnapshotId === undefined) {
        if (removedSnapshotId === expectedSnapshotId) {
          if (typeof removedAtValue !== 'string') {
            return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
          }
          yield* validateRemovedViewSnapshotAuthority(sql, expectedSnapshotId, false);
          yield* ensureRemovedViewCleanupEpoch(
            sql,
            worktreeId,
            expectedSnapshotId,
            removedAtValue,
            false,
            cleanupEvidence,
            requireReconciliationSchema,
          );
          return {
            expectedSnapshotId,
            retiredSnapshots: 0,
            state: 'already-removed',
          } satisfies CodeGraphViewRemovalResult;
        }
        if (removedSnapshotId !== undefined) {
          return {
            expectedSnapshotId,
            observedSnapshotId: removedSnapshotId,
            observedState: 'removed',
            state: 'stale-target',
          } satisfies CodeGraphViewRemovalResult;
        }
        return {expectedSnapshotId, state: 'not-found'} satisfies CodeGraphViewRemovalResult;
      }

      const alreadyRemoved = removedSnapshotId === expectedSnapshotId;
      if (alreadyRemoved && typeof removedAtValue !== 'string') {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
      }
      yield* validateRemovedViewSnapshotAuthority(
        sql,
        expectedSnapshotId,
        true,
        alreadyRemoved ? undefined : cleanupEvidence,
      );
      const removedAt = alreadyRemoved ? removedAtValue! : new Date().toISOString();
      yield* sql`
        INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at)
        VALUES (${worktreeId}, ${expectedSnapshotId}, ${removedAt})
        ON CONFLICT(worktree_id) DO UPDATE SET
          expected_snapshot_id = excluded.expected_snapshot_id,
          removed_at = excluded.removed_at
      `;
      yield* sql`
        DELETE FROM active_snapshots
        WHERE worktree_id = ${worktreeId} AND snapshot_id = ${expectedSnapshotId}
      `;
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* Effect.fail(new CodeGraphStoreError('Code graph view pointer changed during removal.'));
      }
      yield* ensureRemovedViewCleanupEpoch(
        sql,
        worktreeId,
        expectedSnapshotId,
        removedAt,
        !alreadyRemoved,
        cleanupEvidence,
        requireReconciliationSchema,
      );
      const retiredSnapshots = yield* Clock.currentTimeMillis.pipe(
        Effect.flatMap(now => retireReadySnapshotsIfUnused(sql, [expectedSnapshotId], now)),
      );
      return {
        expectedSnapshotId,
        retiredSnapshots,
        state: alreadyRemoved ? 'already-removed' : 'removed',
      } satisfies CodeGraphViewRemovalResult;
    }),
  );
});

const retireReadySnapshotsIfUnused = Effect.fn('codeGraph.retireReadySnapshotsIfUnused')(function* (
  sql: SqlClient.SqlClient,
  snapshotIds: readonly string[],
  now: number,
) {
  const candidates = [...new Set(snapshotIds)];
  if (candidates.length === 0) return 0;
  const statement = codeGraphExactSnapshotRetirementStatement(candidates, now);
  yield* sql.unsafe(statement.text, statement.parameters);
  return yield* lastStatementChangeCount(sql);
});

/** @internal Target-rooted exact retirement retained for deterministic query-plan regressions. */
export function codeGraphExactSnapshotRetirementStatement(
  snapshotIds: readonly string[],
  now: number,
): CodeGraphSqlQueryStatement {
  const candidates = [...new Set(snapshotIds)];
  const placeholders = candidates.map(() => '?').join(', ');
  return {
    parameters: [...candidates, now],
    text: `UPDATE snapshots AS candidate
    SET state = 'retired'
    WHERE candidate.id IN (${placeholders})
      AND candidate.state = 'ready'
      AND NOT EXISTS (
        SELECT 1
        FROM active_snapshots AS active
        WHERE active.snapshot_id = candidate.id
          AND NOT EXISTS (
            SELECT 1
            FROM removed_views AS removed
            WHERE removed.worktree_id = active.worktree_id
              AND removed.expected_snapshot_id = active.snapshot_id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM snapshot_leases AS lease
        WHERE lease.snapshot_id = candidate.id
          AND lease.expires_at > ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM snapshots AS child INDEXED BY snapshots_base_state_id
        WHERE child.base_snapshot_id = candidate.id
        LIMIT 1
      )`,
  };
}

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
    table: 'snapshot_file_shards',
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

interface RetiredSnapshotCleanupPage {
  readonly deleted: number;
  readonly remaining: boolean;
}

/**
 * Reclaim at most one bounded table page. Lease acquire/release use this
 * foreground step, while pointer promotion schedules the same state machine as
 * a best-effort detached collector. Query completion therefore never cascades
 * a repository-sized snapshot delete, while repeated ordinary use still makes
 * durable progress if a short-lived CLI interrupts the detached fiber.
 */
const pruneRetiredSnapshotRowsPage = Effect.fn('codeGraph.pruneRetiredSnapshotRowsPage')(function* (
  providedSql?: SqlClient.SqlClient,
) {
  const sql = providedSql ?? (yield* SqlClient.SqlClient);
  const pending = yield* sql<{readonly present: number}>`
    SELECT EXISTS(SELECT 1 FROM snapshots WHERE state = 'retired' LIMIT 1) AS present
  `;
  if (Number(pending[0]?.present ?? 0) === 0) {
    return {deleted: 0, remaining: false} satisfies RetiredSnapshotCleanupPage;
  }

  const compactSchemaAvailable =
    (yield* tableExists(sql, 'lexical_compact_snapshots')) && (yield* tableExists(sql, 'lexical_storage_formats'));
  const compactTargets = compactSchemaAvailable
    ? yield* sql<CompactLexicalSnapshotKeyRow & {readonly snapshot_id: string}>`
        SELECT compact.snapshot_key, compact.snapshot_id
        FROM lexical_compact_snapshots AS compact
        JOIN snapshots AS snapshot ON snapshot.id = compact.snapshot_id
        WHERE snapshot.state = 'retired'
        ORDER BY compact.snapshot_id
        LIMIT 1
      `
    : [];
  const compactTarget = compactTargets[0];
  if (compactTarget !== undefined) {
    const compactSnapshotKey = yield* validatedCompactLexicalCount(compactTarget.snapshot_key, 'cleanup snapshot key');
    for (const spec of COMPACT_LEXICAL_CLEANUP_SPECS) {
      if (!(yield* tableExists(sql, spec.table))) continue;
      const deleted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const statement = compactLexicalCleanupPageStatement(
            spec,
            compactSnapshotKey,
            spec.batchRows,
            Option.some(compactTarget.snapshot_id),
          );
          yield* sql.unsafe(statement.text, statement.parameters);
          return yield* lastStatementChangeCount(sql);
        }),
      );
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid row count.'));
      }
      if (deleted > 0) return {deleted, remaining: true} satisfies RetiredSnapshotCleanupPage;
    }
    const metadataDeleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `DELETE FROM lexical_storage_formats
           WHERE snapshot_id = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
          [compactTarget.snapshot_id, compactTarget.snapshot_id],
        );
        const formatRows = yield* lastStatementChangeCount(sql);
        yield* sql.unsafe(
          `DELETE FROM lexical_compact_snapshots
           WHERE snapshot_key = ? AND snapshot_id = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE id = ? AND state = 'retired')`,
          [compactSnapshotKey, compactTarget.snapshot_id, compactTarget.snapshot_id],
        );
        return formatRows + (yield* lastStatementChangeCount(sql));
      }),
    );
    if (metadataDeleted > 0) {
      return {deleted: metadataDeleted, remaining: true} satisfies RetiredSnapshotCleanupPage;
    }
  }

  for (const spec of RETIRED_SNAPSHOT_CLEANUP_SPECS) {
    if (!(yield* tableExists(sql, spec.table))) continue;
    const deleted = yield* sql.withTransaction(
      Effect.gen(function* () {
        const key = `(${spec.keyColumns.join(', ')})`;
        yield* sql.unsafe(
          `DELETE FROM ${spec.table}
           WHERE ${key} IN (
             SELECT ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
             FROM ${spec.table} AS candidate
             WHERE candidate.snapshot_id IN (SELECT id FROM snapshots WHERE state = 'retired')
             ORDER BY ${spec.keyColumns.map(column => `candidate.${column}`).join(', ')}
             LIMIT ?
           )`,
          [spec.batchRows],
        );
        return yield* lastStatementChangeCount(sql);
      }),
    );
    if (!Number.isSafeInteger(deleted) || deleted < 0) {
      return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid row count.'));
    }
    if (deleted > 0) return {deleted, remaining: true} satisfies RetiredSnapshotCleanupPage;
  }

  const removed = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM snapshots WHERE id IN (
        SELECT id FROM snapshots WHERE state = 'retired' ORDER BY id LIMIT 100
      )`;
      return yield* lastStatementChangeCount(sql);
    }),
  );
  if (!Number.isSafeInteger(removed) || removed < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Retired snapshot cleanup returned an invalid count.'));
  }
  const remaining = yield* sql<{readonly present: number}>`
    SELECT EXISTS(SELECT 1 FROM snapshots WHERE state = 'retired' LIMIT 1) AS present
  `;
  return {
    deleted: removed,
    remaining: Number(remaining[0]?.present ?? 0) !== 0,
  } satisfies RetiredSnapshotCleanupPage;
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
    yield* pruneUnreferencedMaterializedFileShards(sql);
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
  yield* pruneUnreferencedMaterializedFileShards(sql);
});

const pruneUnreferencedMaterializedFileShards = Effect.fn('codeGraph.pruneUnreferencedMaterializedFileShards')(
  function* (sql: SqlClient.SqlClient) {
    yield* sql.unsafe(`
      DELETE FROM materialized_file_shards
      WHERE NOT EXISTS (
        SELECT 1 FROM snapshot_file_shards WHERE snapshot_file_shards.shard_id = materialized_file_shards.id
      )
    `);
  },
);

const selectReadySnapshot = Effect.fn('codeGraph.selectReadySnapshot')(function* (worktreeId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'active_snapshots')) || !(yield* tableExists(sql, 'snapshots'))) return undefined;
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const rows = yield* sql.unsafe<SnapshotRow>(
    `SELECT snapshots.*
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     WHERE active_snapshots.worktree_id = ?
       AND snapshots.state = 'ready'
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
     LIMIT 1`,
    [worktreeId],
  );
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
  if (!(yield* tableExists(sql, 'snapshots')) || !(yield* tableExists(sql, 'lexical_storage_formats'))) {
    return undefined;
  }
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

const selectReusableCleanBase = Effect.fn('codeGraph.selectReusableCleanBase')(function* (
  repositoryId: string,
  extractorSet: string,
  workspaceFingerprint: string,
  fileSetFingerprint: string,
  graphContentId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const candidates = yield* sql<SnapshotRow>`
    SELECT snapshot.*
    FROM snapshots AS snapshot
    JOIN snapshot_reuse_receipts AS receipt ON receipt.snapshot_id = snapshot.id
    WHERE snapshot.repository_id = ${repositoryId}
      AND snapshot.extractor_set = ${extractorSet}
      AND snapshot.state = 'ready'
      AND snapshot.dirty = 0
      AND snapshot.base_snapshot_id IS NULL
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = 1
      AND receipt.workspace_fingerprint = ${workspaceFingerprint}
    ORDER BY
      CASE WHEN snapshot.graph_content_id = ${graphContentId ?? null} THEN 0 ELSE 1 END,
      CASE WHEN receipt.file_set_fingerprint = ${fileSetFingerprint} THEN 0 ELSE 1 END,
      snapshot.completed_at DESC,
      snapshot.id
    LIMIT 1
  `;
  const row = candidates[0];
  if (!row) return undefined;
  const receipt = yield* selectReusableBaseReceipt(row.id);
  if (!receipt) return undefined;
  const files = yield* sql<{
    readonly content_hash: string;
    readonly language: string;
    readonly mode: string;
    readonly path: string;
    readonly size: number;
    readonly source: string;
  }>`
    SELECT content_hash, language, mode, path, size, source
    FROM snapshot_files
    WHERE snapshot_id = ${row.id}
    ORDER BY path
  `;
  if (files.length !== Number(row.file_count) || files.some(file => file.source !== 'commit')) return undefined;
  return {
    files: files.map(file => ({
      blobId: `snapshot:${file.content_hash}`,
      contentHash: file.content_hash,
      language: file.language,
      mode: file.mode,
      path: file.path,
      size: Number(file.size),
      source: 'commit' as const,
    })),
    receipt,
    snapshot: snapshotFromRow(row),
  } satisfies CodeGraphReusableCleanBase;
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
  maxRows = Number.MAX_SAFE_INTEGER,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* selectReusableBaseReceipt(snapshotId))) return undefined;
  const uniqueSeeds = uniqueBy(seeds, seed => `${seed.path}\0${seed.name}`);
  if (uniqueSeeds.length === 0) return [];
  if (!Number.isSafeInteger(maxRows) || maxRows < 0) return undefined;
  const output = new Map<string, CodeGraphReusableReexport>();
  for (const batch of chunk(uniqueSeeds, 200)) {
    if (output.size > maxRows) return undefined;
    const queryLimit = maxRows === Number.MAX_SAFE_INTEGER ? maxRows : maxRows + 1;
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
         LIMIT ?
       )
       SELECT source_path, local_name, target_path, imported_name
       FROM closure
       ORDER BY source_path, local_name, target_path, imported_name
       LIMIT ?`,
      [...batch.flatMap(seed => [seed.path, seed.name]), snapshotId, snapshotId, queryLimit, queryLimit],
    );
    if (rows.length > maxRows) {
      return rows.map(row => ({
        importedName: row.imported_name,
        localName: row.local_name,
        sourcePath: row.source_path,
        targetPath: row.target_path,
      }));
    }
    for (const row of rows) {
      const value = {
        importedName: row.imported_name,
        localName: row.local_name,
        sourcePath: row.source_path,
        targetPath: row.target_path,
      } satisfies CodeGraphReusableReexport;
      output.set(`${value.sourcePath}\0${value.localName}\0${value.targetPath}\0${value.importedName}`, value);
      if (output.size > maxRows) return [...output.values()];
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
        const facts = JSON.parse(row.facts_json) as CodeGraphFileFacts;
        if (facts.path !== row.path_hint) continue;
        output.set(row.path_hint, facts);
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

const selectMaterializedFileShards = Effect.fn('codeGraph.selectMaterializedFileShards')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
  derivationIdentity: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const output = new Map<string, CodeGraphFileFacts>();
  const bytesByPath = new Map<string, number>();
  const keys = new Set<string>();
  let bytes = 0;
  for (const batch of chunk(files, 200)) {
    if (batch.length === 0) continue;
    const rows = yield* sql.unsafe<{
      readonly content_hash: string;
      readonly facts_bytes: number;
      readonly facts_json: string;
      readonly id: string;
      readonly path_hint: string;
    }>(
      `SELECT id, content_hash, path_hint, facts_json, length(CAST(facts_json AS BLOB)) AS facts_bytes
       FROM materialized_file_shards
       WHERE extractor_set = ? AND derivation_identity = ?
         AND (${batch.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
      [extractorSet, derivationIdentity, ...batch.flatMap(file => [file.contentHash, file.path])],
    );
    for (const row of rows) {
      try {
        const bounded = ensureBoundedCodeGraphFact(JSON.parse(row.facts_json) as CodeGraphFileFacts);
        if (
          bounded.facts.path !== row.path_hint ||
          row.id !== materializedFileShardIdentity(row.content_hash, extractorSet, derivationIdentity, row.path_hint)
        ) {
          continue;
        }
        output.set(row.path_hint, bounded.facts);
        keys.add(row.path_hint);
        const factBytes = Number(row.facts_bytes);
        bytes += factBytes;
        bytesByPath.set(row.path_hint, factBytes);
      } catch {
        // Materialized shards are disposable; malformed rows are ignored and rebuilt.
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
      AND CASE
        WHEN json_valid(facts_json) THEN json_extract(facts_json, '$.path')
        ELSE NULL
      END = path_hint
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
  options: CodeGraphVisualizationCatalogOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const projectLimit = boundedVisualizationCatalogLimit(options.projectLimit, 160, 500);
  const projectOffset = boundedVisualizationCatalogOffset(options.projectOffset);
  const projectQuery = boundedVisualizationCatalogQuery(options.projectQuery);
  const workspaceLimit = boundedVisualizationCatalogLimit(options.workspaceLimit, 64, 128);
  const workspaceOffset = boundedVisualizationCatalogOffset(options.workspaceOffset);
  const workspaceQuery = boundedVisualizationCatalogQuery(options.workspaceQuery);
  const requestedProjectId = Option.getOrUndefined(options.projectId ?? Option.none());
  const requestedSnapshotId = Option.getOrUndefined(options.snapshotId ?? Option.none());
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const rows = yield* sql.unsafe<
    SnapshotRow & {readonly activated_at: unknown; readonly display_name: string; readonly view_worktree_id: string}
  >(
    `SELECT snapshots.*, repositories.display_name, active_snapshots.activated_at,
       active_snapshots.worktree_id AS view_worktree_id
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     JOIN repositories ON repositories.id = snapshots.repository_id
     WHERE snapshots.state = 'ready'
       AND (? IS NULL OR snapshots.id = ?)
       AND (? IS NULL OR active_snapshots.worktree_id = ?)
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
     ORDER BY active_snapshots.activated_at DESC, snapshots.completed_at DESC, snapshots.id
     LIMIT 1`,
    [requestedSnapshotId ?? null, requestedSnapshotId ?? null, viewWorktreeId ?? null, viewWorktreeId ?? null],
  );
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
      const requestedComponentId = requestedProjectId?.startsWith('cgp_') ? requestedProjectId : undefined;
      const unscopedMatchesQuery =
        projectQuery.length === 0 || 'unscoped code and documentation'.includes(projectQuery.toLocaleLowerCase());
      const componentQuery = visualizationCatalogComponentQueryPredicate(projectQuery);
      const includeUnscoped =
        (requestedProjectId === undefined && projectOffset === 0 && unscopedMatchesQuery) ||
        requestedProjectId === 'facet:unscoped';
      const componentLimit =
        requestedProjectId === 'facet:unscoped'
          ? 0
          : requestedProjectId === undefined
            ? Math.max(0, projectLimit - (includeUnscoped ? 1 : 0))
            : projectLimit;
      const componentsEffect =
        componentLimit === 0
          ? Effect.succeed<readonly DeferredVisualizationComponentRow[]>([])
          : requestedComponentId
            ? sql<DeferredVisualizationComponentRow>`
                SELECT id, workspace_id, build_system, kind, name, provenance
                FROM workspace_components
                WHERE snapshot_id = ${row.id} AND id = ${requestedComponentId}
                LIMIT ${componentLimit}
              `
            : Effect.gen(function* () {
                const statement = codeGraphVisualizationCatalogComponentStatement(
                  row.id,
                  projectQuery,
                  componentLimit,
                  projectOffset,
                );
                return yield* sql.unsafe<DeferredVisualizationComponentRow>(statement.text, statement.parameters);
              });
      const [workspaceCountRows, workspaces, componentCountRows, components] = yield* Effect.all(
        [
          sql.unsafe<{readonly count: number}>(
            `SELECT COUNT(*) AS count FROM workspace_scopes
             WHERE snapshot_id = ?
               ${workspaceQuery.length === 0 ? '' : "AND instr(lower(name || ' ' || root || ' ' || id), lower(?)) > 0"}`,
            [row.id, ...(workspaceQuery.length === 0 ? [] : [workspaceQuery])],
          ),
          sql.unsafe<{
            readonly build_system: CodeGraphWorkspaceBuildSystem;
            readonly id: string;
            readonly name: string;
            readonly provenance: CodeGraphWorkspaceProvenance;
            readonly root: string;
          }>(
            `SELECT id, build_system, name, root, provenance
             FROM workspace_scopes
             WHERE snapshot_id = ?
               ${workspaceQuery.length === 0 ? '' : "AND instr(lower(name || ' ' || root || ' ' || id), lower(?)) > 0"}
             ORDER BY root, id
             LIMIT ? OFFSET ?`,
            [row.id, ...(workspaceQuery.length === 0 ? [] : [workspaceQuery]), workspaceLimit, workspaceOffset],
          ),
          sql.unsafe<{readonly count: number}>(
            `SELECT COUNT(*) AS count FROM workspace_components AS component
             WHERE component.snapshot_id = ?
               ${componentQuery.text}`,
            [row.id, ...componentQuery.parameters],
          ),
          componentsEffect,
        ],
        {concurrency: 1},
      );
      const componentIds = components.map(component => component.id);
      const dependencies =
        options.includeDependencies === true && componentIds.length > 0
          ? yield* sql.unsafe<{
              readonly provenance: CodeGraphWorkspaceProvenance;
              readonly source_component_id: string;
              readonly target_component_id: string;
            }>(
              `SELECT source_component_id, target_component_id, provenance
               FROM workspace_component_dependencies
               WHERE snapshot_id = ?
                 AND source_component_id IN (${componentIds.map(() => '?').join(', ')})
                 AND target_component_id IN (${componentIds.map(() => '?').join(', ')})
               ORDER BY source_component_id, target_component_id, provenance`,
              [row.id, ...componentIds, ...componentIds],
            )
          : [];
      const dependenciesBySource = new Map<string, Array<(typeof dependencies)[number]>>();
      for (const dependency of dependencies) {
        const current = dependenciesBySource.get(dependency.source_component_id);
        if (current) current.push(dependency);
        else dependenciesBySource.set(dependency.source_component_id, [dependency]);
      }
      const projects: CodeGraphVisualizationProject[] = components.map(component => ({
        buildSystem: component.build_system,
        dependencies: (dependenciesBySource.get(component.id) ?? []).map(dependency => ({
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
      if (includeUnscoped && projects.length < projectLimit) {
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
      }
      const componentCount = Number(componentCountRows[0]?.count ?? 0);
      const workspaceCount = Number(workspaceCountRows[0]?.count ?? 0);
      const totalProjectCount = componentCount + (unscopedMatchesQuery ? 1 : 0);
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
        projectCount: totalProjectCount,
        projects,
        projectsTruncated: projectOffset + components.length < componentCount,
        repository: {displayName: row.display_name, repositoryId: row.repository_id},
        snapshot: snapshotFromRow(row),
        viewWorktreeId: row.view_worktree_id,
        workspaceCount,
        workspaces: workspaces.map(workspace => ({
          buildSystem: workspace.build_system,
          diagnostics: [],
          id: workspace.id,
          name: workspace.name,
          provenance: workspace.provenance,
          root: workspace.root,
        })),
        workspacesTruncated: workspaceOffset + workspaces.length < workspaceCount,
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
      projectCount: 1,
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
      projectsTruncated: false,
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: row.view_worktree_id,
      workspaceCount: 0,
      workspaces: [],
      workspacesTruncated: false,
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
      projectCount: projects.length,
      projects,
      projectsTruncated: false,
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: row.view_worktree_id,
      workspaceCount: workspaces.length,
      workspaces: workspaces.map(workspace => ({
        buildSystem: workspace.build_system,
        diagnostics: parseStringArray(workspace.diagnostics_json),
        id: workspace.id,
        name: workspace.name,
        provenance: workspace.provenance,
        root: workspace.root,
      })),
      workspacesTruncated: false,
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
    projectCount: projects.length,
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
    projectsTruncated: false,
    ...(activatedAt ? {activatedAt} : {}),
    metrics: 'complete',
    model: 'legacy-fallback',
    repository: {
      displayName: row.display_name,
      repositoryId: row.repository_id,
    },
    snapshot: snapshotFromRow(row),
    viewWorktreeId: row.view_worktree_id,
    workspaceCount: 0,
    workspaces: [],
    workspacesTruncated: false,
  } satisfies CodeGraphVisualizationCatalog;
});

const selectVisualizationCatalogs = Effect.fn('codeGraph.selectVisualizationCatalogs')(function* (
  metrics: 'complete' | 'deferred' = 'complete',
  options: CodeGraphVisualizationCatalogOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const viewLimit = boundedVisualizationCatalogLimit(options.viewLimit, 32, 64);
  const viewOffset = boundedVisualizationCatalogOffset(options.viewOffset);
  const viewQuery = boundedVisualizationCatalogQuery(options.viewQuery);
  const removedViewsAvailable = yield* tableExists(sql, 'removed_views');
  const worktrees = yield* sql.unsafe<{readonly worktree_id: string}>(
    `SELECT active_snapshots.worktree_id
     FROM active_snapshots
     JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
     JOIN repositories ON repositories.id = snapshots.repository_id
     WHERE snapshots.state = 'ready'
       ${
         removedViewsAvailable
           ? `AND NOT EXISTS (
                SELECT 1 FROM removed_views AS removed
                WHERE removed.worktree_id = active_snapshots.worktree_id
                  AND removed.expected_snapshot_id = active_snapshots.snapshot_id
              )`
           : ''
       }
       ${
         viewQuery.length === 0
           ? ''
           : "AND instr(lower(repositories.display_name || ' ' || snapshots.commit_id || ' ' || active_snapshots.worktree_id), lower(?)) > 0"
       }
     ORDER BY active_snapshots.activated_at DESC, active_snapshots.worktree_id
     LIMIT ? OFFSET ?`,
    [...(viewQuery.length === 0 ? [] : [viewQuery]), viewLimit, viewOffset],
  );
  return (yield* Effect.forEach(worktrees, row => selectVisualizationCatalog(row.worktree_id, metrics, options), {
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

const MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE = 6;
const MANAGER_SCOPE_SAMPLE_MAX_SCOPES = 500;
const MANAGER_SCOPE_SAMPLE_PROVENANCES: readonly CodeGraphProvenance[] = ['declared', 'resolved', 'syntactic'];
const MANAGER_SCOPE_SAMPLE_BATCH_SIZE = 64;

interface VisualizationScopeSampledSymbolRow extends SymbolRow {
  readonly sampled_scope_id: string;
}

interface VisualizationScopeSampledEdgeRow extends EdgeRow {
  readonly sampled_scope_id: string;
}

interface VisualizationScopeEndpointRow {
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly package_name: unknown;
  readonly path: string;
  readonly resolution_scope_id: unknown;
}

const selectVisualizationScopeEdgeSummary = Effect.fn('codeGraph.selectVisualizationScopeEdgeSummary')(function* (
  snapshotId: string,
  requestedScopeIds: readonly string[],
  limit: number,
) {
  const safeLimit = Math.max(1, Math.min(1_500, Math.floor(limit)));
  const scopeIds = [...new Set(requestedScopeIds)].slice(0, MANAGER_SCOPE_SAMPLE_MAX_SCOPES).sort(compareCodeUnits);
  if (scopeIds.length === 0) return {edges: [], sampledScopes: 0, truncated: false};
  const scopeSet = new Set(scopeIds);
  const perScopeEdgeLimit = Math.max(2, Math.min(16, Math.ceil(safeLimit / scopeIds.length) * 2));
  let truncated = requestedScopeIds.length > scopeIds.length;
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const symbolRows: VisualizationScopeSampledSymbolRow[] = [];
  for (const statement of codeGraphVisualizationScopeSymbolSampleStatements(
    snapshotId,
    baseSnapshotId,
    scopeIds,
    MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE + 1,
  )) {
    symbolRows.push(...(yield* sql.unsafe<VisualizationScopeSampledSymbolRow>(statement.text, statement.parameters)));
  }
  const seedsByScope = new Map<string, string[]>();
  for (const row of symbolRows) {
    const seeds = seedsByScope.get(row.sampled_scope_id) ?? [];
    if (seeds.length < MANAGER_SCOPE_SAMPLE_SYMBOLS_PER_SCOPE) seeds.push(row.id);
    else truncated = true;
    seedsByScope.set(row.sampled_scope_id, seeds);
  }
  const sampledScopes = seedsByScope.size;
  const sampledEdges = new Map<string, CodeGraphEdge>();
  const edgeRows: VisualizationScopeSampledEdgeRow[] = [];
  for (const statement of codeGraphVisualizationScopeEdgeSampleStatements(
    snapshotId,
    baseSnapshotId,
    [...seedsByScope].map(([scopeId, symbolIds]) => ({scopeId, symbolIds})),
    perScopeEdgeLimit + 1,
    MANAGER_SCOPE_SAMPLE_PROVENANCES,
  )) {
    edgeRows.push(...(yield* sql.unsafe<VisualizationScopeSampledEdgeRow>(statement.text, statement.parameters)));
  }
  const edgeCountsByScope = new Map<string, number>();
  for (const row of edgeRows) {
    const edgeCount = edgeCountsByScope.get(row.sampled_scope_id) ?? 0;
    if (edgeCount < perScopeEdgeLimit) sampledEdges.set(row.id, edgeFromRow(row));
    else truncated = true;
    edgeCountsByScope.set(row.sampled_scope_id, edgeCount + 1);
  }
  const endpointIds = [...new Set([...sampledEdges.values()].flatMap(edge => [edge.sourceId, edge.targetId]))].filter(
    isDefinedString,
  );
  const endpointRows =
    endpointIds.length === 0
      ? []
      : yield* Effect.gen(function* () {
          const statement = codeGraphVisualizationScopeEndpointStatement(snapshotId, baseSnapshotId, endpointIds);
          return yield* sql.unsafe<VisualizationScopeEndpointRow>(statement.text, statement.parameters);
        });
  const symbolsById = new Map(
    endpointRows.map(row => [
      row.id,
      {
        id: row.id,
        kind: row.kind,
        language: row.language,
        packageName: Option.getOrUndefined(sqlTextOption(row.package_name)),
        path: row.path,
        resolutionScopeId: Option.getOrUndefined(sqlTextOption(row.resolution_scope_id)),
      },
    ]),
  );
  const aggregated = new Map<string, CodeGraphVisualizationScopeEdge>();
  for (const edge of sampledEdges.values()) {
    if (!edge.sourceId || !edge.targetId) continue;
    const source = symbolsById.get(edge.sourceId);
    const target = symbolsById.get(edge.targetId);
    if (!source || !target) continue;
    const sourceId = visualizationScopeIdForSymbol(source, scopeSet);
    const targetId = visualizationScopeIdForSymbol(target, scopeSet);
    if (!sourceId || !targetId || sourceId === targetId || !scopeSet.has(sourceId) || !scopeSet.has(targetId)) continue;
    const key = `${sourceId}\0${targetId}\0${edge.provenance}\0${edge.relation}`;
    const current = aggregated.get(key);
    aggregated.set(key, {
      confidence: Math.max(current?.confidence ?? 0, edge.confidence),
      count: (current?.count ?? 0) + 1,
      provenance: edge.provenance,
      relation: edge.relation,
      sourceId,
      targetId,
      type: 'source-relationship',
    });
  }
  const ordered = [...aggregated.values()].sort(compareVisualizationScopeEdges);
  if (ordered.length > safeLimit) truncated = true;
  return {edges: ordered.slice(0, safeLimit), sampledScopes, truncated};
});

export function codeGraphVisualizationCatalogComponentStatement(
  snapshotId: string,
  projectQuery: string,
  limit: number,
  offset: number,
): CodeGraphSqlQueryStatement {
  const query = projectQuery.trim();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.min(1_000_000, Math.floor(offset)));
  const componentQuery = visualizationCatalogComponentQueryPredicate(query);
  if (query.length === 0) {
    return {
      parameters: [snapshotId, snapshotId, snapshotId, safeLimit, safeOffset],
      text: `WITH dependency_degree AS (
          SELECT component_id, COUNT(*) AS degree
          FROM (
            SELECT source_component_id AS component_id
            FROM workspace_component_dependencies
            WHERE snapshot_id = ?
            UNION ALL
            SELECT target_component_id AS component_id
            FROM workspace_component_dependencies
            WHERE snapshot_id = ?
          )
          GROUP BY component_id
        )
        SELECT component.id, component.workspace_id, component.build_system, component.kind,
          component.name, component.provenance
        FROM workspace_components AS component
        LEFT JOIN dependency_degree ON dependency_degree.component_id = component.id
        WHERE component.snapshot_id = ?
        ORDER BY COALESCE(dependency_degree.degree, 0) DESC, component.name, component.root, component.id
        LIMIT ? OFFSET ?`,
    };
  }
  return {
    parameters: [snapshotId, ...componentQuery.parameters, snapshotId, snapshotId, safeLimit, safeOffset],
    text: `WITH candidate_components AS MATERIALIZED (
        SELECT component.id, component.workspace_id, component.build_system, component.kind,
          component.name, component.root, component.provenance
        FROM workspace_components AS component
        WHERE component.snapshot_id = ?
          ${componentQuery.text}
      ), candidate_dependency_endpoints AS MATERIALIZED (
        SELECT outgoing.source_component_id AS component_id
        FROM candidate_components AS candidate
        JOIN workspace_component_dependencies AS outgoing
          ON outgoing.snapshot_id = ? AND outgoing.source_component_id = candidate.id
        UNION ALL
        SELECT incoming.target_component_id AS component_id
        FROM workspace_component_dependencies AS incoming
        JOIN candidate_components AS candidate ON candidate.id = incoming.target_component_id
        WHERE incoming.snapshot_id = ?
      ), dependency_degree AS MATERIALIZED (
        SELECT component_id, COUNT(*) AS degree
        FROM candidate_dependency_endpoints
        GROUP BY component_id
      )
      SELECT component.id, component.workspace_id, component.build_system, component.kind,
        component.name, component.provenance
      FROM candidate_components AS component
      LEFT JOIN dependency_degree ON dependency_degree.component_id = component.id
      ORDER BY COALESCE(dependency_degree.degree, 0) DESC, component.name, component.root, component.id
      LIMIT ? OFFSET ?`,
  };
}

function visualizationCatalogComponentQueryPredicate(projectQuery: string): CodeGraphSqlQueryStatement {
  return projectQuery.length === 0
    ? {parameters: [], text: ''}
    : {
        parameters: [projectQuery, projectQuery],
        text: `AND (
          instr(lower(component.name || ' ' || component.root || ' ' || component.id), lower(?)) > 0
          OR EXISTS (
            SELECT 1
            FROM workspace_scopes AS workspace
            WHERE workspace.snapshot_id = component.snapshot_id
              AND workspace.id = component.workspace_id
              AND instr(lower(workspace.name || ' ' || workspace.root || ' ' || workspace.id), lower(?)) > 0
          )
        )`,
      };
}

export function codeGraphVisualizationScopeSymbolSampleStatements(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  requestedScopeIds: readonly string[],
  perScopeLimit: number,
): readonly CodeGraphSqlQueryStatement[] {
  const safeScopeIds = [...new Set(requestedScopeIds)].slice(0, MANAGER_SCOPE_SAMPLE_MAX_SCOPES).sort(compareCodeUnits);
  return [...chunk(safeScopeIds, MANAGER_SCOPE_SAMPLE_BATCH_SIZE)].map(scopeBatch => {
    const branches: string[] = [];
    const parameters: Array<number | string> = [];
    for (const scopeId of scopeBatch) {
      const statement = codeGraphVisualizationSymbolsQueryStatement(
        snapshotId,
        baseSnapshotId,
        visualizationScopeFromProjectId(scopeId),
        perScopeLimit,
      );
      branches.push(`SELECT ? AS sampled_scope_id, sampled.* FROM (${statement.text}) AS sampled`);
      parameters.push(scopeId, ...statement.parameters);
    }
    return {parameters, text: branches.join('\nUNION ALL\n')};
  });
}

export function codeGraphVisualizationScopeEdgeSampleStatements(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  requestedScopes: readonly {readonly scopeId: string; readonly symbolIds: readonly string[]}[],
  perScopeLimit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
): readonly CodeGraphSqlQueryStatement[] {
  const safeScopes = requestedScopes
    .filter(scope => scope.symbolIds.length > 0)
    .slice(0, MANAGER_SCOPE_SAMPLE_MAX_SCOPES)
    .sort((left, right) => compareCodeUnits(left.scopeId, right.scopeId));
  return [...chunk(safeScopes, MANAGER_SCOPE_SAMPLE_BATCH_SIZE)].map(scopeBatch => {
    const branches: string[] = [];
    const parameters: Array<number | string> = [];
    for (const scope of scopeBatch) {
      const statement = codeGraphAdjacencyQueryStatement(
        snapshotId,
        baseSnapshotId,
        scope.symbolIds,
        'both',
        perScopeLimit,
        allowedProvenances,
      );
      branches.push(`SELECT ? AS sampled_scope_id, sampled.* FROM (${statement.text}) AS sampled`);
      parameters.push(scope.scopeId, ...statement.parameters);
    }
    return {parameters, text: branches.join('\nUNION ALL\n')};
  });
}

export function codeGraphVisualizationScopeEndpointStatement(
  snapshotId: string,
  baseSnapshotId: string | undefined,
  requestedEndpointIds: readonly string[],
): CodeGraphSqlQueryStatement {
  const endpointIds = [...new Set(requestedEndpointIds)].slice(0, 16_000).sort(compareCodeUnits);
  return {
    parameters: [JSON.stringify(endpointIds), snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId],
    text: `WITH endpoint_ids AS (
        SELECT CAST(value AS TEXT) AS id FROM json_each(?)
      ), effective_endpoint_symbols AS (
        SELECT current_symbols.id, current_symbols.resolution_scope_id, current_symbols.language,
          current_symbols.kind, current_symbols.package_name, current_symbols.path
        FROM endpoint_ids
        CROSS JOIN symbols AS current_symbols INDEXED BY sqlite_autoindex_symbols_1
        WHERE current_symbols.snapshot_id = ? AND current_symbols.id = endpoint_ids.id
        UNION ALL
        SELECT base_symbols.id, base_symbols.resolution_scope_id, base_symbols.language,
          base_symbols.kind, base_symbols.package_name, base_symbols.path
        FROM endpoint_ids
        CROSS JOIN symbols AS base_symbols INDEXED BY sqlite_autoindex_symbols_1
        WHERE base_symbols.snapshot_id = ? AND base_symbols.id = endpoint_ids.id
          AND NOT EXISTS (
            SELECT 1 FROM symbols AS overrides
            WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_symbol_deletions AS deletions
            WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
          )
      )
      SELECT * FROM effective_endpoint_symbols ORDER BY id`,
  };
}

export function codeGraphVisualizationScopeSummaryStatementCount(scopeCount: number): number {
  const safeScopes = Math.max(0, Math.min(MANAGER_SCOPE_SAMPLE_MAX_SCOPES, Math.floor(scopeCount)));
  if (safeScopes === 0) return 0;
  const batches = Math.ceil(safeScopes / MANAGER_SCOPE_SAMPLE_BATCH_SIZE);
  return batches * 2 + 1;
}

interface VisualizationScopeSymbolFields {
  readonly kind: string;
  readonly language: string;
  readonly packageName?: string;
  readonly path: string;
  readonly resolutionScopeId?: string;
}

function visualizationScopeIdForSymbol(
  symbol: VisualizationScopeSymbolFields,
  visibleScopes: ReadonlySet<string>,
): string | undefined {
  if (symbol.resolutionScopeId) return symbol.resolutionScopeId;
  if (visibleScopes.has('facet:unscoped')) return 'facet:unscoped';
  if (symbol.language === 'markdown' || ['document', 'heading', 'section'].includes(symbol.kind)) {
    return 'facet:unscoped-documentation';
  }
  const packageName = symbol.packageName?.trim();
  if (packageName) return `package:${packageName}`;
  return `path:${symbol.path.split('/')[0] || '(root)'}`;
}

function visualizationScopeFromProjectId(projectId: string): CodeGraphVisualizationScope {
  if (projectId.startsWith('cgp_')) return {type: 'component', value: projectId};
  if (projectId === 'facet:unscoped') return {type: 'unscoped'};
  if (projectId === 'facet:unscoped-documentation') return {type: 'documentation-facet'};
  if (projectId.startsWith('package:')) return {type: 'package', value: projectId.slice('package:'.length)};
  if (projectId.startsWith('path:')) return {type: 'path', value: projectId.slice('path:'.length)};
  return {type: 'all'};
}

function compareVisualizationScopeEdges(
  left: CodeGraphVisualizationScopeEdge,
  right: CodeGraphVisualizationScopeEdge,
): number {
  return (
    right.count - left.count ||
    right.confidence - left.confidence ||
    compareCodeUnits(left.sourceId, right.sourceId) ||
    compareCodeUnits(left.targetId, right.targetId) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.provenance, right.provenance)
  );
}

function isDefinedString(value: string | undefined): value is string {
  return typeof value === 'string';
}

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
  const scopeIndex = visualizationScopeIndex(scope);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const order =
    scope.type === 'all'
      ? 'path, qualified_name, id'
      : `exported DESC,
      CASE kind
        WHEN 'package' THEN 0 WHEN 'module' THEN 1 WHEN 'class' THEN 2 WHEN 'interface' THEN 3
        WHEN 'function' THEN 4 WHEN 'method' THEN 5 ELSE 6
      END,
      id`;
  return {
    parameters: [
      snapshotId,
      ...current.parameters,
      safeLimit,
      baseSnapshotId ?? '',
      ...base.parameters,
      snapshotId,
      snapshotId,
      safeLimit,
      safeLimit,
    ],
    text: `WITH effective_symbols AS (
      SELECT * FROM (
        SELECT current_symbols.*
        FROM symbols AS current_symbols${scopeIndex}
        WHERE current_symbols.snapshot_id = ? AND ${current.text}
        ORDER BY ${order}
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
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
        ORDER BY ${order}
        LIMIT ?
      )
    )
    SELECT *
    FROM effective_symbols
    ORDER BY ${order}
    LIMIT ?`,
  };
}

function visualizationScopeIndex(scope: CodeGraphVisualizationScope): string {
  switch (scope.type) {
    case 'all':
      return ' INDEXED BY symbols_export_order';
    case 'package':
    case 'path':
    case 'component':
    case 'unscoped':
      // These visualization indexes were added additively within graph-v3.
      // Let SQLite select them when present so a Manager-only session can
      // still read an older v3 database before the next writer initializes it.
      return '';
    case 'documentation-facet':
      return ' INDEXED BY symbols_resolution_scope';
  }
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

export type CodeGraphSymbolPathClass = 'documentation' | 'implementation' | 'test';

/**
 * Product names such as MCP tool identifiers appear verbatim in test fixtures
 * and agent-instruction documents as well as in the code that implements them.
 * Those copies match a bare symbol query just as strongly, so they are demoted
 * unless the query itself asks for a test or a document.
 */
const SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS: Readonly<Record<CodeGraphSymbolPathClass, number>> = {
  documentation: 0.55,
  implementation: 1,
  test: 0.7,
};
const DOCUMENTATION_PATH_DIRECTORIES = new Set(['doc', 'docs', 'documentation']);
const DOCUMENTATION_PATH_EXTENSIONS = new Set(['.adoc', '.markdown', '.md', '.mdx', '.rst', '.txt']);
const TEST_PATH_DIRECTORIES = new Set([
  '__mocks__',
  '__tests__',
  'fixtures',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);
const DOCUMENTATION_QUERY_TERMS = new Set([
  'adoc',
  'doc',
  'docs',
  'documentation',
  'guide',
  'markdown',
  'md',
  'mdx',
  'readme',
  'rst',
]);
const TEST_QUERY_TERMS = new Set([
  '__mocks__',
  '__tests__',
  'fixture',
  'fixtures',
  'mock',
  'mocks',
  'spec',
  'specs',
  'test',
  'testdata',
  'tests',
]);
const TEST_FILE_NAME_PATTERN = /(?:^|[._-])(?:spec|test)s?\.[^.]+$/;

export function codeGraphSymbolPathClass(path: string): CodeGraphSymbolPathClass {
  const segments = path.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  const fileName = segments.at(-1) ?? '';
  const directories = segments.slice(0, -1);
  const extensionIndex = fileName.lastIndexOf('.');
  const extension = extensionIndex === -1 ? '' : fileName.slice(extensionIndex);
  if (
    DOCUMENTATION_PATH_EXTENSIONS.has(extension) ||
    directories.some(segment => DOCUMENTATION_PATH_DIRECTORIES.has(segment))
  ) {
    return 'documentation';
  }
  if (directories.some(segment => TEST_PATH_DIRECTORIES.has(segment)) || TEST_FILE_NAME_PATTERN.test(fileName)) {
    return 'test';
  }
  return 'implementation';
}

export function codeGraphSymbolPathScoreMultiplier(path: string, queryTerms: readonly string[]): number {
  const pathClass = codeGraphSymbolPathClass(path);
  if (pathClass === 'implementation') return 1;
  const requestedTerms = pathClass === 'test' ? TEST_QUERY_TERMS : DOCUMENTATION_QUERY_TERMS;
  return queryTerms.some(term => requestedTerms.has(term)) ? 1 : SYMBOL_PATH_CLASS_SCORE_MULTIPLIERS[pathClass];
}

function searchSymbolRowComparator(
  queryTerms: readonly string[],
): (left: SearchSymbolRow, right: SearchSymbolRow) => number {
  return (left, right) =>
    right.exact_rank - left.exact_rank ||
    codeGraphSymbolPathScoreMultiplier(right.path, queryTerms) -
      codeGraphSymbolPathScoreMultiplier(left.path, queryTerms) ||
    right.score - left.score ||
    right.exported - left.exported ||
    searchSymbolKindOrder(left.kind) - searchSymbolKindOrder(right.kind) ||
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.id, right.id);
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
  const compareRows = searchSymbolRowComparator(terms);
  const rankedNode = (row: SearchSymbolRow) => ({
    ...symbolFromRow(row),
    score: Math.max(0, Math.min(1, (row.score / 100) * codeGraphSymbolPathScoreMultiplier(row.path, terms))),
  });
  const exactPath = normalizeExactSearchPath(query);
  const exactStatement = codeGraphExactSymbolQueryStatement(snapshotId, baseSnapshotId, exactPath ?? query, safeLimit);
  const exactRows = yield* sql.unsafe<SearchSymbolRow>(exactStatement.text, exactStatement.parameters);
  if (
    exactPath !== undefined &&
    exactRows.some(row => normalizeExactSearchPath(row.path)?.toLocaleLowerCase() === exactPath.toLocaleLowerCase())
  ) {
    return [...exactRows].sort(compareRows).slice(0, safeLimit).map(rankedNode);
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
    if (!current || compareRows(row, current) < 0) byId.set(row.id, row);
  }
  return [...byId.values()].sort(compareRows).slice(0, safeLimit).map(rankedNode);
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

const selectRepresentativeEdgesForNodes = Effect.fn('codeGraph.selectRepresentativeEdgesForNodes')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  const ids = [...new Set(nodeIds)].slice(0, 500).sort(compareCodeUnits);
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  if (ids.length === 0 || allowedProvenances.length === 0) return {edges: [], truncated: false};
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const perNodeLimit = Math.max(2, Math.min(16, Math.ceil(safeLimit / ids.length) * 2));
  const pages: Array<{readonly nodeId: string; readonly rows: readonly EdgeRow[]}> = [];
  let truncated = false;
  for (const nodeId of ids) {
    const statement = codeGraphAdjacencyQueryStatement(
      snapshotId,
      baseSnapshotId,
      [nodeId],
      direction,
      perNodeLimit + 1,
      allowedProvenances,
    );
    const rows = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
    if (rows.length > perNodeLimit) truncated = true;
    pages.push({nodeId, rows: rows.slice(0, perNodeLimit)});
  }
  const selected = representativeEdgeRows(pages, safeLimit);
  const uniqueCandidates = new Set(pages.flatMap(page => page.rows.map(row => row.id))).size;
  if (uniqueCandidates > selected.length) truncated = true;
  return {edges: selected.map(edgeFromRow), truncated};
});

function representativeEdgeRows(
  pages: readonly {readonly nodeId: string; readonly rows: readonly EdgeRow[]}[],
  limit: number,
): readonly EdgeRow[] {
  const output = new Map<string, EdgeRow>();
  const coveredNodes = new Set<string>();
  for (const page of pages) {
    const representative = page.rows[0];
    if (!representative) continue;
    coveredNodes.add(page.nodeId);
    if (!output.has(representative.id) && output.size < limit) output.set(representative.id, representative);
  }
  if (output.size >= limit) return [...output.values()];
  const remaining = pages
    .flatMap(page => page.rows.slice(coveredNodes.has(page.nodeId) ? 1 : 0))
    .sort(compareEdgeRowsByPriority);
  for (const row of remaining) {
    if (!output.has(row.id)) output.set(row.id, row);
    if (output.size >= limit) break;
  }
  return [...output.values()];
}

function compareEdgeRowsByPriority(left: EdgeRow, right: EdgeRow): number {
  const provenanceRank = (value: CodeGraphProvenance): number =>
    value === 'declared' ? 0 : value === 'resolved' ? 1 : value === 'syntactic' ? 2 : 3;
  return (
    provenanceRank(left.provenance) - provenanceRank(right.provenance) ||
    Number(right.confidence) - Number(left.confidence) ||
    compareCodeUnits(left.source_name, right.source_name) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(left.target_name, right.target_name) ||
    compareCodeUnits(left.id, right.id)
  );
}

const selectRelationshipSummaryForNode = Effect.fn('codeGraph.selectRelationshipSummaryForNode')(function* (
  snapshotId: string,
  nodeId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
  limit = 2_000,
) {
  if (allowedProvenances.length === 0) {
    return {incoming: 0, outgoing: 0, provenances: [], relations: [], sampledEdges: 0, truncated: false};
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
  const statement = codeGraphAdjacencyQueryStatement(
    snapshotId,
    baseSnapshotId,
    [nodeId],
    'both',
    safeLimit + 1,
    allowedProvenances,
  );
  const page = yield* sql.unsafe<EdgeRow>(statement.text, statement.parameters);
  const rows = page.slice(0, safeLimit);
  const relationCounts = new Map<CodeGraphEdge['relation'], {count: number; incoming: number; outgoing: number}>();
  const provenanceCounts = new Map<CodeGraphProvenance, number>();
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    const rowIncoming = row.target_id === nodeId ? 1 : 0;
    const rowOutgoing = row.source_id === nodeId ? 1 : 0;
    const relation = relationCounts.get(row.relation) ?? {count: 0, incoming: 0, outgoing: 0};
    relation.count += 1;
    relation.incoming += rowIncoming;
    relation.outgoing += rowOutgoing;
    relationCounts.set(row.relation, relation);
    provenanceCounts.set(row.provenance, (provenanceCounts.get(row.provenance) ?? 0) + 1);
    incoming += rowIncoming;
    outgoing += rowOutgoing;
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
    sampledEdges: rows.length,
    truncated: page.length > safeLimit,
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
    graphContentId: Option.getOrUndefined(sqlTextOption(row.graph_content_id)),
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

function boundedVisualizationCatalogLimit(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isSafeInteger(value)
    ? fallback
    : Math.max(1, Math.min(maximum, Math.floor(value)));
}

function boundedVisualizationCatalogOffset(value: number | undefined): number {
  return value === undefined || !Number.isSafeInteger(value) ? 0 : Math.max(0, Math.min(1_000_000, Math.floor(value)));
}

function boundedVisualizationCatalogQuery(value: Option.Option<string> | undefined): string {
  return Option.getOrElse(value ?? Option.none(), () => '')
    .trim()
    .slice(0, 256);
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
  return isFileLockTimeout(cause)
    ? codeGraphStoreBusyFailure(operation)
    : classifyCodeGraphStoreFailure(operation, cause);
}

/** Keep SQLite diagnostics useful without persisting paths, statement values, or unbounded native output. */
export function sanitizeCodeGraphStoreDiagnostic(value: string): string {
  return sanitizeStoreDiagnostic(value);
}
