import type {Effect, Option} from 'effect';
import type {CodeGraphBuildOwnerIdentity} from './build_owner.js';
import type {CodeGraphDirectPersistentCapacityBoundary} from './disk_capacity.js';
import type {
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProvenance,
} from './languages/types.js';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphProvenance,
  type CodeGraphReference,
  type CodeGraphResolutionActivity,
  type CodeGraphSnapshot,
  type CodeGraphStoreError,
  type CodeGraphSymbol,
} from './types.js';

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
        | 'build-status-history'
        | 'completed-build'
        | 'file-blob-cache'
        | 'materialized-shard-cache'
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
        | 'status-sidecar-unavailable'
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

/** Bounded active-pointer identity used by cheap cross-process catalog invalidation. */
export interface CodeGraphActiveViewIdentity {
  readonly activatedAt?: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
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

export const CODE_GRAPH_SNAPSHOT_PURGE_GRAPH_BLOCKER_CODES = [
  'active-view',
  'alias-snapshot',
  'base-required',
  'build-owned',
  'cleanup-pending',
  'live-lease',
  'unsupported-state',
] as const;

export type CodeGraphSnapshotPurgeGraphBlockerCode = (typeof CODE_GRAPH_SNAPSHOT_PURGE_GRAPH_BLOCKER_CODES)[number];

export interface CodeGraphSnapshotPurgeLeaseEvidence {
  readonly expiresAt: number;
  /** SHA-256 of the private lease token; the token itself never leaves Store. */
  readonly identity: string;
}

export interface CodeGraphSnapshotPurgeGraphEvidence {
  readonly activeViewIds: readonly string[];
  readonly blockers: readonly CodeGraphSnapshotPurgeGraphBlockerCode[];
  readonly buildOwnerIds: readonly string[];
  readonly childSnapshotIds: readonly string[];
  readonly cleanupEpochs: readonly string[];
  readonly graphEvidenceDigest: string;
  readonly liveLeases: readonly CodeGraphSnapshotPurgeLeaseEvidence[];
  readonly snapshot: CodeGraphSnapshot;
}

export type CodeGraphSnapshotPurgeObservationResult =
  | {readonly snapshotId: string; readonly state: 'not-found'}
  | {readonly evidence: CodeGraphSnapshotPurgeGraphEvidence; readonly snapshotId: string; readonly state: 'observed'};

export type CodeGraphSnapshotPurgeStoreResult =
  | {readonly snapshotId: string; readonly state: 'not-found'}
  | {
      readonly evidence: CodeGraphSnapshotPurgeGraphEvidence;
      readonly snapshotId: string;
      readonly state: 'blocked' | 'state-changed';
    }
  | {
      readonly cleanupState: 'completed' | 'deferred';
      readonly remaining: boolean;
      readonly rowsDeleted: number;
      readonly snapshotId: string;
      readonly state: 'purged' | 'retired';
    };

export interface CodeGraphSnapshotPurgeStoreOptions extends CodeGraphSnapshotLeaseWriterOptions {
  /** Final containment proof while the checkout writer gate is held and before SQLite opens. */
  readonly beforeDatabaseOpen?: () => Effect.Effect<void, unknown>;
}

/** True only for a positive, bounded observation of storage newer than this runtime. */
export function codeGraphRuntimeSchemaRequiresReconnect(
  observedSchemaVersion: number | undefined,
  observedPersistentExtensionRevision: number | undefined,
): boolean {
  return (
    (typeof observedSchemaVersion === 'number' &&
      Number.isSafeInteger(observedSchemaVersion) &&
      observedSchemaVersion > CODE_GRAPH_SCHEMA_VERSION) ||
    (typeof observedPersistentExtensionRevision === 'number' &&
      Number.isSafeInteger(observedPersistentExtensionRevision) &&
      observedPersistentExtensionRevision > CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)
  );
}
