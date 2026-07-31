export const CODE_GRAPH_SCHEMA_VERSION = 3 as const;
export const CODE_GRAPH_RESULT_VERSION = 1 as const;
export const CODE_GRAPH_EXTRACTOR_GENERATION = 9 as const;
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

export interface CodeGraphInventoryFile {
  readonly blobId: string;
  /** Binary source bytes are retained only for the extraction batch that requested them. */
  readonly bytes?: Uint8Array;
  readonly content?: string;
  readonly contentHash: string;
  readonly contentOmittedReason?: 'size-budget';
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
  readonly id: string;
  readonly overlayFingerprint?: string;
  readonly repositoryId: string;
  readonly state: 'building' | 'failed' | 'ready' | 'retired';
  readonly symbolCount: number;
  readonly worktreeId: string;
}

export type CodeGraphProgress =
  | {
      readonly phase: 'registering';
    }
  | {
      readonly phase: 'waiting';
    }
  | {
      readonly accepted: number;
      readonly completed: number;
      readonly excluded: number;
      readonly phase: 'scanning';
      readonly skipped: number;
      readonly total: number;
      readonly unit: 'files';
    }
  | {
      readonly completed: number;
      readonly phase: 'materializing';
      readonly reused: number;
      readonly total: number;
      readonly unit: 'files';
    }
  | {
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
      readonly phase: 'activating';
      readonly snapshotId: string;
      readonly subphase?: 'complete' | 'promoting' | 'validating-input' | 'writing-and-checkpointing';
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
  readonly materialization?: {
    readonly fallbackReason?: CodeGraphOverlayFallbackReason;
    readonly mode: 'full' | 'incremental-overlay' | 'reused-snapshot';
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
  | 'file-set-changed'
  | 'forced-full-rebuild'
  | 'no-materialized-changes'
  | 'resolution-surface-changed'
  | 'staging-identity-mismatch'
  | 'staging-unavailable'
  | 'workspace-changed';

export interface CodeGraphQueryNode extends CodeGraphSymbol {
  readonly score: number;
}

export interface CodeGraphQueryResult {
  readonly edges: readonly CodeGraphEdge[];
  readonly freshness: 'current' | 'stale';
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
  readonly query?: string;
  readonly symbol?: string;
  readonly to?: string;
}

export interface CodeGraphStatus {
  readonly databasePath: string;
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

export class CodeGraphStoreError extends Error {
  override readonly name = 'CodeGraphStoreError';
}
