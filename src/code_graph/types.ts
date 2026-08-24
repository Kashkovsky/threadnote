import type {CodeGraphScanningMetrics, CodeGraphSourceSizeBucket} from './progress_telemetry.js';
import type {CodeGraphMonikerV1} from './cross_repository/types.js';

export const CODE_GRAPH_SCHEMA_VERSION = 3 as const;
/** Additive persistent surfaces that preserve the public graph-v3 row contract. */
export const CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION = 14 as const;
export const CODE_GRAPH_RESULT_VERSION = 1 as const;
export const CODE_GRAPH_EXTRACTOR_GENERATION = 13 as const;
export const CODE_GRAPH_EXTRACTOR_SET_VERSION = `native-code-graph-${CODE_GRAPH_EXTRACTOR_GENERATION}` as const;

export type CodeGraphProvenance = 'declared' | 'heuristic' | 'model' | 'resolved' | 'syntactic';
export type CodeGraphRelation =
  | 'calls'
  | 'configures'
  | 'constructs'
  | 'contains'
  | 'declares'
  | 'depends_on'
  | 'documents'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'imports'
  | 'overrides'
  | 'reads_or_writes'
  | 'references'
  | 'reexports'
  | 'semantic_association'
  | 'tests';

export interface RepositoryIdentity {
  /** Local-only current branch when HEAD is attached. */
  readonly branch?: string;
  readonly caseMode: 'insensitive' | 'sensitive';
  readonly checkoutId: string;
  readonly displayName: string;
  readonly gitCommonDirectory: string;
  readonly headCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly remoteIdentity?: string;
  readonly repoRoot: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export interface RepositoryIdentityExpectation {
  readonly checkoutId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export interface CodeGraphInventoryFile {
  readonly blobId: string;
  /** Binary source bytes are retained only for the extraction batch that requested them. */
  readonly bytes?: Uint8Array;
  readonly content?: string;
  readonly contentHash: string;
  readonly contentOmittedReason?: 'metadata-only' | 'size-budget';
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
  readonly source: 'commit' | 'worktree';
}

export interface CodeGraphSpan {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface CodeGraphSymbol {
  readonly arity?: number;
  readonly contentHash: string;
  readonly documentation?: string;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeys?: readonly string[];
  readonly name: string;
  readonly packageName?: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly resolutionDomain?: string;
  readonly resolutionScopeId?: string;
  readonly signature?: string;
  readonly span: CodeGraphSpan;
}

export interface CodeGraphEdge {
  readonly confidence: number;
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphSpan;
  readonly id: string;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly sourceId?: string;
  readonly sourceName: string;
  readonly targetId?: string;
  readonly targetName: string;
}

export interface CodeGraphFileFacts {
  /** Compact parser-time inputs retained for derivations that run after source content is released. */
  readonly derivationInputs?: CodeGraphDerivationInputs;
  readonly diagnostics: readonly string[];
  readonly edges: readonly CodeGraphEdge[];
  readonly monikers?: readonly CodeGraphMonikerV1[];
  readonly path: string;
  readonly references?: readonly CodeGraphReference[];
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphDerivationInputs {
  readonly rationale?: readonly CodeGraphRationaleInput[];
}

export interface CodeGraphRationaleInput {
  readonly documentation: string;
  readonly line: number;
  readonly marker: string;
  readonly name: string;
}

export interface CodeGraphReference {
  readonly aliasLookupKeys?: readonly string[];
  readonly arity?: number;
  readonly edgeId: string;
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphSpan;
  readonly exportedOnly?: boolean;
  readonly lookupTiers: readonly (readonly string[])[];
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphRelation;
  readonly resolutionDomain: string;
  readonly sourceId?: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphSnapshot {
  readonly baseSnapshotId?: string;
  readonly commit: string;
  readonly completedAt?: string;
  readonly dirty: boolean;
  readonly edgeCount: number;
  readonly extractorSet: string;
  readonly fileCount: number;
  /** Content-addressed graph input identity, independent of commit and worktree pointers. */
  readonly graphContentId?: string;
  readonly id: string;
  readonly overlayFingerprint?: string;
  readonly repositoryId: string;
  readonly state: 'building' | 'failed' | 'ready' | 'retired';
  readonly symbolCount: number;
  readonly worktreeId: string;
}

/** Privacy-safe row cardinality emitted while cached facts are materialized. */
export interface CodeGraphMaterializationRows {
  readonly deduplicatedEdges?: number;
  readonly deduplicatedReferences?: number;
  readonly edges?: number;
  readonly lookupKeys?: number;
  readonly referenceCandidates?: number;
  readonly references?: number;
  readonly reexports?: number;
  readonly symbols?: number;
  readonly terms?: number;
}

/**
 * Cumulative wall time for attribution and adjacent final-batch preparation.
 * Attribution compute, shard serialization, persistence, and association are
 * mutually non-overlapping. The existing `attributing` stage remains an
 * inclusive cumulative timer; grouped shard persistence is recorded exactly
 * once rather than being divided speculatively across its logical batches. A
 * final shard-association flush can follow it.
 * Final-batch preparation spans the transition into row preparation. Keeping
 * them separate prevents codec and SQLite costs from hiding behind one
 * aggregate timer.
 */
export interface CodeGraphMaterializationSubphaseMilliseconds {
  readonly attributionCompute: number;
  readonly factBatchPreparation: number;
  readonly shardAssociation: number;
  readonly shardPersistence: number;
  readonly shardSerialization: number;
}

/**
 * Batch-local materialization activity. Paths, symbol names, and repository
 * content are deliberately excluded because this shape is persisted and
 * exposed through the CLI and Manager.
 */
export interface CodeGraphMaterializationActivity {
  /** Number of fully committed batches before the active batch. */
  readonly batchCompleted: number;
  readonly batchTotal: number;
  readonly cachedFactBytes?: number;
  readonly elapsedMilliseconds?: number;
  /** Exact UTF-8 JSON bytes of final attributed facts in this staging transaction. */
  readonly factsBytes?: number;
  readonly rows?: CodeGraphMaterializationRows;
  readonly sourceBytes: number;
  /** Batch-local cumulative wall time attributed to this bounded stage. */
  readonly stageElapsedMilliseconds?: number;
  readonly stage:
    | 'attributing'
    | 'committing'
    | 'loading-cache'
    | 'preparing-rows'
    | 'restoring-indexes'
    | 'writing-analysis'
    | 'writing-candidates'
    | 'writing-edges'
    | 'writing-facts'
    | 'writing-lookups'
    | 'writing-references'
    | 'writing-receipt'
    | 'writing-symbols'
    | 'writing-terms';
  readonly transactionMilliseconds?: number;
}

/** Cumulative, privacy-safe measurements for the current materialization phase. */
export interface CodeGraphMaterializationMetrics {
  /** Files whose parser facts were postprocessed and attributed during this materialization. */
  readonly attributedFilesCompleted?: number;
  readonly attributionMilliseconds?: number;
  readonly batchesCompleted: number;
  readonly batchesTotal: number;
  readonly cachedFactBytesCompleted?: number;
  readonly cachedFactBytesTotal?: number;
  /** Saturating sum of materialized-shard and raw-fact replay bytes. */
  readonly cachedFactReplayBytesCompleted?: number;
  /** Exact consumed cached-fact bytes for current paths changed from the committed inventory. */
  readonly changedFactBytesCompleted?: number;
  /** Files selected from future cross-generation materialized-shard batches; zero until eligibility exists. */
  readonly crossGenerationShardFilesCompleted?: number;
  /** Files selected from complete materialized-shard batches for the current exact derivation. */
  readonly exactGenerationShardFilesCompleted?: number;
  /** Exact bounded reason a repository-wide rewrite was selected, when known. */
  readonly fallbackReason?: CodeGraphOverlayFallbackReason;
  /** Exact UTF-8 JSON bytes of final postprocessed and attributed facts. */
  readonly factsBytesCompleted?: number;
  readonly factsBytesTotal?: number;
  readonly loadingMilliseconds?: number;
  /** Exact UTF-8 bytes decoded from materialized shards, including inspected shards later discarded by batch fallback. */
  readonly materializedShardReplayBytesCompleted?: number;
  /** Files intentionally kept on raw-fact replay instead of duplicating a large derived shard cache. */
  readonly materializedShardCacheDeferredFilesCompleted?: number;
  /** Raw-fact bytes covered by the intentional derived-shard cache deferral. */
  readonly materializedShardCacheDeferredRawFactBytesCompleted?: number;
  readonly mode?: 'full' | 'incremental-clean' | 'incremental-overlay';
  /** Exact UTF-8 bytes decoded from raw parser-fact cache rows for attribution. */
  readonly rawFactReplayBytesCompleted?: number;
  /** Closed, path-free evidence for the declaration-publication gate. */
  readonly resolutionLookupKeyForm?: import('./resolution_surface.js').CodeGraphResolutionLookupKeyForm;
  /** Closed, path-free evidence for the declaration-publication gate. */
  readonly resolutionPublicationGate?: import('./resolution_surface.js').CodeGraphResolutionPublicationGate;
  readonly rows?: CodeGraphMaterializationRows;
  readonly sourceBytesCompleted: number;
  readonly sourceBytesTotal: number;
  /** Cumulative wall time attributed to privacy-safe materialization stages. */
  readonly stageMilliseconds?: Readonly<Partial<Record<CodeGraphMaterializationActivity['stage'], number>>>;
  readonly subphaseMilliseconds?: CodeGraphMaterializationSubphaseMilliseconds;
  readonly storage?: {
    /** Legacy combined value, present only when durable and TEMP data share one filesystem. */
    readonly availableBytes?: number;
    readonly durableAvailableBytes?: number;
    /** Allocated durable graph database pages observed during direct staging. */
    readonly durableDatabaseBytes?: number;
    readonly durableDatabaseHighWaterBytes?: number;
    /** On-disk main database size when materialization began. */
    readonly durableDatabaseStartBytes?: number;
    /** Current and peak main-database growth attributable to this build. */
    readonly durableDatabaseGrowthBytes?: number;
    readonly durableDatabaseGrowthHighWaterBytes?: number;
    readonly durableDatabaseFileBytes?: number;
    readonly durableDatabaseFileHighWaterBytes?: number;
    /** Main database plus observable WAL, SHM, and rollback-journal files. */
    readonly durableFilesystemBytes?: number;
    readonly durableFilesystemHighWaterBytes?: number;
    readonly durableJournalBytes?: number;
    readonly durableJournalHighWaterBytes?: number;
    readonly durableSharedMemoryBytes?: number;
    readonly durableSharedMemoryHighWaterBytes?: number;
    readonly durableWalBytes?: number;
    readonly durableWalHighWaterBytes?: number;
    readonly estimateBasis?: 'cached-fact-bytes' | 'final-fact-bytes' | 'source-bytes-fallback';
    /** Allowance for one other repository/worktree build sharing the same disk. */
    readonly estimatedConcurrentBuildBytes?: number;
    readonly estimatedDurableFilesystemRequiredBytes?: number;
    readonly estimatedDurableSnapshotBytes?: number;
    readonly estimatedJournalBytes?: number;
    /** Combined estimate when all storage shares one filesystem; never a hard limit. */
    readonly estimatedRequiredBytes?: number;
    readonly estimatedTemporaryFilesystemRequiredBytes?: number;
    readonly estimatedTemporaryDatabaseBytes?: number;
    /** Whether SQLite TEMP and the durable graph database are on the same filesystem. */
    readonly filesystemsShared?: boolean;
    readonly materializationMode?: 'direct-persistent' | 'temporary-staged';
    readonly temporaryAvailableBytes?: number;
    /** Allocated SQLite TEMP database pages; rollback journals and subjournals are excluded. */
    readonly temporaryDatabaseBytes: number;
    readonly temporaryDatabaseHighWaterBytes: number;
  };
  readonly transactionMilliseconds?: number;
}

/**
 * Privacy-safe progress for the bounded reference-resolution pass. The
 * current-pass counters provide an honest finite denominator while
 * referencesExamined, pagesCompleted, and resolved remain cumulative across
 * alias-expansion passes.
 */
export interface CodeGraphResolutionActivity {
  readonly aliasesDiscovered: number;
  readonly elapsedMilliseconds: number;
  /** Longest completed SQLite resolution transaction in this build. */
  readonly longestTransactionMilliseconds?: number;
  readonly matchingMilliseconds: number;
  readonly pageCompleted: number;
  readonly pageTotal: number;
  readonly pagesCompleted: number;
  readonly pass: number;
  readonly referencesCompleted: number;
  readonly referencesExamined: number;
  readonly referencesTotal: number;
  readonly resolved: number;
  readonly transactionMilliseconds: number;
  readonly transactionStageMilliseconds?: CodeGraphResolutionTransactionStageMilliseconds;
}

export interface CodeGraphResolutionTransactionStageMilliseconds {
  readonly preparingBatch: number;
  readonly retiringReferences: number;
  readonly updatingAnalysis: number;
  readonly writingAliases: number;
  readonly writingEdges: number;
}

/** Privacy-safe progress for copying a staged graph into its durable snapshot. */
export interface CodeGraphActivationActivity {
  readonly elapsedMilliseconds: number;
  readonly rows?: number;
  readonly stage:
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
  readonly stageElapsedMilliseconds: number;
  readonly state: 'completed' | 'progress' | 'started';
  /** Duration of the most recently committed bounded copy transaction. */
  readonly transactionMilliseconds?: number;
}

/** Path-free observation of the cache-authority admission gate. */
export interface CodeGraphRegistrationActivity {
  readonly elapsedMilliseconds: number;
  readonly generations: number;
  readonly keys: number;
  readonly stage: 'loading-cache';
}

export type CodeGraphProgress =
  | {
      readonly activity?: CodeGraphRegistrationActivity;
      readonly phase: 'registering';
    }
  | {
      readonly phase: 'waiting';
      readonly reason?:
        | 'database-writer'
        | 'disk-capacity'
        | 'home-builder-cap'
        | 'repository-lock'
        | 'request-lock'
        | 'snapshot-build';
    }
  | {
      readonly completed: number;
      readonly pagesCompleted: number;
      readonly phase: 'reclaiming';
      readonly rowsDeleted: number;
      readonly total: number;
      readonly unit: 'snapshots';
    }
  | {
      readonly accepted: number;
      readonly activity?: {
        /** Batch-local progress; repository-derived paths never enter persisted build status. */
        readonly batchCompleted: number;
        readonly batchTotal: number;
        readonly bytes: number;
        readonly classifier?: string;
        readonly degraded?: boolean;
        readonly degradationReason?: import('./parser_worker.js').ParserWorkerFailureReason;
        readonly factsBytes?: number;
        readonly language: string;
        readonly parseMilliseconds?: number;
        readonly path: string;
        readonly persistMilliseconds?: number;
        readonly relations?: number;
        readonly role?: string;
        readonly sizeBucket?: CodeGraphSourceSizeBucket;
        readonly stage: 'extracting' | 'persisting' | 'reading';
        readonly symbols?: number;
      };
      readonly completed: number;
      readonly excluded: number;
      /** Cumulative, path-free extraction workload for class-weighted phase ETA. */
      readonly metrics?: CodeGraphScanningMetrics;
      readonly phase: 'scanning';
      readonly skipped: number;
      readonly timings?: {
        readonly extractionMilliseconds: number;
        readonly persistenceMilliseconds: number;
        readonly readingMilliseconds: number;
        readonly serializationMilliseconds: number;
      };
      readonly total: number;
      readonly unit: 'files';
    }
  | {
      readonly activity?: CodeGraphMaterializationActivity;
      readonly completed: number;
      readonly metrics?: CodeGraphMaterializationMetrics;
      readonly phase: 'materializing';
      readonly reused: number;
      readonly total: number;
      readonly unit: 'files';
    }
  | {
      readonly activity?: CodeGraphResolutionActivity;
      readonly phase: 'resolving';
      readonly subphase: 'references';
    }
  | {
      readonly edges: number;
      readonly phase: 'resolving';
      readonly resolved: number;
      readonly subphase: 'complete';
      readonly symbols: number;
    }
  | {
      readonly activity?: CodeGraphActivationActivity;
      readonly phase: 'activating';
      readonly snapshotId: string;
      readonly subphase?:
        | 'complete'
        | 'promoting'
        | 'structural-ready'
        | 'summarizing-analysis'
        | 'validating-input'
        | 'writing-and-checkpointing';
    }
  | {
      readonly completed: number;
      readonly embedded: number;
      readonly phase: 'embedding';
      readonly reused: number;
      readonly total: number;
      readonly unit: 'symbols';
    };

export interface CodeGraphIndexSummary {
  readonly diagnostics: readonly string[];
  readonly durationMs: number;
  readonly identity: RepositoryIdentity;
  readonly incrementalWork?: import('./incremental_work.js').CodeGraphIncrementalWork;
  readonly materialization?: {
    readonly closureProjects?: number;
    readonly fallbackReason?: CodeGraphOverlayFallbackReason;
    readonly mode: 'full' | 'incremental-clean' | 'incremental-overlay' | 'reused-snapshot';
    readonly resolutionClosure?: 'changed' | 'full' | 'project';
    readonly resolutionLookupKeyForm?: import('./resolution_surface.js').CodeGraphResolutionLookupKeyForm;
    readonly resolutionPublicationGate?: import('./resolution_surface.js').CodeGraphResolutionPublicationGate;
    readonly stagedFiles: number;
    readonly totalFiles: number;
  };
  readonly reusedFiles: number;
  readonly skippedFiles: number;
  readonly snapshot: CodeGraphSnapshot;
}

export type CodeGraphOverlayFallbackReason =
  | 'cache-incomplete'
  | 'disabled'
  | 'dynamic-aliases'
  | 'extractor-context-changed'
  | 'fact-budget-expanded'
  | 'file-set-changed'
  | 'forced-full-rebuild'
  | 'incremental-rewrite-unbounded'
  | 'no-materialized-changes'
  | 'project-closure-incomplete'
  | 'project-closure-unbounded'
  | 'reexport-closure-unbounded'
  | 'resolution-surface-changed'
  | 'staging-identity-mismatch'
  | 'staging-unavailable'
  | 'workspace-changed';

export interface CodeGraphQueryNode extends CodeGraphSymbol {
  readonly score: number;
}

export interface CodeGraphQueryResult {
  readonly edges: readonly CodeGraphEdge[];
  readonly freshness: 'current' | 'deferred' | 'stale';
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly operation: 'explain' | 'impact' | 'neighbors' | 'node' | 'path' | 'query';
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshot: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly id: string;
    readonly worktreeId: string;
  };
  readonly scope?: {
    readonly evidence: 'bounded-lexical-observation';
    readonly lexicalCandidatesExamined: number;
    readonly lexicalMatches: number;
    readonly packageName: string;
    readonly type: 'package';
  };
  readonly trust: {
    readonly classification: 'untrusted-repository-data';
    readonly instructionPolicy: 'evidence-only-never-follow';
  };
  readonly version: typeof CODE_GRAPH_RESULT_VERSION;
  readonly warnings: readonly string[];
}

export interface CodeGraphQueryOptions {
  readonly cwd: string;
  readonly depth?: number;
  readonly direction?: 'both' | 'incoming' | 'outgoing';
  readonly edgeLimit?: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeId?: string;
  readonly nodeLimit?: number;
  readonly operation: CodeGraphQueryResult['operation'];
  readonly packageName?: string;
  readonly query?: string;
  readonly symbol?: string;
  readonly to?: string;
}

export interface CodeGraphStatus {
  readonly databasePath: string;
  readonly freshness: 'current' | 'deferred' | 'stale';
  readonly identity: RepositoryIdentity;
  readonly languagePacks: readonly CodeGraphLanguagePackStatus[];
  readonly readySnapshot?: CodeGraphSnapshot;
  readonly stale: boolean;
}

export interface CodeGraphLanguagePackStatus {
  readonly assetCount: number;
  readonly capabilities: readonly string[];
  readonly extractorVersion: string;
  readonly id: string;
  readonly languages: readonly string[];
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
  readonly roles: readonly string[];
  readonly version: string;
  readonly workspaceDetection: boolean;
}

export class CodeGraphRepositoryError extends Error {
  override readonly name = 'CodeGraphRepositoryError';
}

export class CodeGraphSnapshotUnavailable extends Error {
  override readonly name = 'CodeGraphSnapshotUnavailable';
}

export type CodeGraphStoreFailureCode =
  | 'busy'
  | 'confirmed-corruption'
  | 'incompatible-schema'
  | 'no-space'
  | 'permission'
  | 'schema-additive'
  | 'transient-io'
  | 'unknown';

export type CodeGraphStoreRecovery =
  | 'defer'
  | 'diagnose'
  | 'fix-permissions'
  | 'free-space'
  | 'manual-migration'
  | 'manual-rebuild'
  | 'migrate-additive'
  | 'reconnect-runtime'
  | 'retry-read-only';

export interface CodeGraphStoreErrorMetadata {
  readonly code?: CodeGraphStoreFailureCode;
  readonly operation?: string;
  readonly recovery?: CodeGraphStoreRecovery;
  readonly retryable?: boolean;
}

export class CodeGraphStoreError extends Error {
  override readonly name: string = 'CodeGraphStoreError';
  readonly code: CodeGraphStoreFailureCode;
  readonly operation: string;
  readonly recovery: CodeGraphStoreRecovery;
  readonly retryable: boolean;

  constructor(message: string, metadata: CodeGraphStoreErrorMetadata = {}) {
    super(message);
    this.code = metadata.code ?? 'unknown';
    this.operation = metadata.operation ?? 'code graph storage';
    this.recovery = metadata.recovery ?? 'diagnose';
    this.retryable = metadata.retryable ?? false;
  }
}

export class CodeGraphStoreBusyError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStoreBusyError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'busy', recovery: 'defer', retryable: true});
  }
}

export class CodeGraphStoreSchemaAdditiveError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStoreSchemaAdditiveError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'schema-additive', recovery: 'migrate-additive', retryable: false});
  }
}

export class CodeGraphStoreNoSpaceError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStoreNoSpaceError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'no-space', recovery: 'free-space', retryable: false});
  }
}

export class CodeGraphStorePermissionError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStorePermissionError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'permission', recovery: 'fix-permissions', retryable: false});
  }
}

export class CodeGraphStoreTransientIoError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStoreTransientIoError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'transient-io', recovery: 'retry-read-only', retryable: true});
  }
}

export class CodeGraphStoreCorruptionError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStoreCorruptionError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'confirmed-corruption', recovery: 'manual-rebuild', retryable: false});
  }
}

export class CodeGraphStoreIncompatibleSchemaError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphStoreIncompatibleSchemaError';

  constructor(message: string, metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super(message, {...metadata, code: 'incompatible-schema', recovery: 'manual-migration', retryable: false});
  }
}

/** A long-lived process observed storage written by a newer Threadnote runtime. */
export class CodeGraphRuntimeReconnectRequiredError extends CodeGraphStoreError {
  override readonly name = 'CodeGraphRuntimeReconnectRequiredError';

  constructor(metadata: Pick<CodeGraphStoreErrorMetadata, 'operation'> = {}) {
    super('Code graph storage was upgraded by a newer Threadnote runtime. Reconnect this Threadnote process.', {
      ...metadata,
      code: 'incompatible-schema',
      recovery: 'reconnect-runtime',
      retryable: false,
    });
  }
}
