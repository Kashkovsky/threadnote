export const CODE_GRAPH_SCHEMA_VERSION = 2 as const;
export const CODE_GRAPH_RESULT_VERSION = 1 as const;
export const CODE_GRAPH_EXTRACTOR_SET_VERSION = 'native-code-graph-5' as const;

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
  readonly content?: string;
  readonly contentHash: string;
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
  readonly contentHash: string;
  readonly documentation?: string;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly packageName?: string;
  readonly path: string;
  readonly qualifiedName: string;
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
  readonly diagnostics: readonly string[];
  readonly edges: readonly CodeGraphEdge[];
  readonly path: string;
  readonly symbols: readonly CodeGraphSymbol[];
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
      readonly accepted: number;
      readonly phase: 'scanning';
      readonly skipped: number;
      readonly visited: number;
    }
  | {
      readonly completed: number;
      readonly phase: 'parsing';
      readonly reused: number;
      readonly total: number;
    }
  | {
      readonly edges: number;
      readonly phase: 'resolving';
      readonly symbols: number;
    }
  | {
      readonly phase: 'activating';
      readonly snapshotId: string;
    }
  | {
      readonly embedded: number;
      readonly phase: 'embedding';
      readonly reused: number;
      readonly total: number;
    };

export interface CodeGraphIndexSummary {
  readonly diagnostics: readonly string[];
  readonly durationMs: number;
  readonly identity: RepositoryIdentity;
  readonly reusedFiles: number;
  readonly skippedFiles: number;
  readonly snapshot: CodeGraphSnapshot;
}

export interface CodeGraphQueryNode extends CodeGraphSymbol {
  readonly score: number;
}

export interface CodeGraphQueryResult {
  readonly edges: readonly CodeGraphEdge[];
  readonly freshness: 'current' | 'stale';
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly operation: 'explain' | 'impact' | 'path' | 'query';
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
  readonly edgeLimit?: number;
  readonly from?: string;
  readonly includeHeuristic?: boolean;
  readonly includeModelAssociations?: boolean;
  readonly nodeLimit?: number;
  readonly operation: CodeGraphQueryResult['operation'];
  readonly query?: string;
  readonly symbol?: string;
  readonly to?: string;
}

export interface CodeGraphStatus {
  readonly databasePath: string;
  readonly identity: RepositoryIdentity;
  readonly readySnapshot?: CodeGraphSnapshot;
  readonly stale: boolean;
}

export interface CodeGraphBudgets {
  readonly maximumEdges: number;
  readonly maximumFileBytes: number;
  readonly maximumFiles: number;
  readonly maximumSymbols: number;
  readonly maximumTotalBytes: number;
}

export const DEFAULT_CODE_GRAPH_BUDGETS: CodeGraphBudgets = {
  maximumEdges: 1_000_000,
  maximumFileBytes: 1_048_576,
  maximumFiles: 50_000,
  maximumSymbols: 500_000,
  maximumTotalBytes: 128 * 1_048_576,
};

export class CodeGraphRepositoryError extends Error {
  override readonly name = 'CodeGraphRepositoryError';
}

export class CodeGraphBudgetExceeded extends Error {
  override readonly name = 'CodeGraphBudgetExceeded';
}

export class CodeGraphSnapshotUnavailable extends Error {
  override readonly name = 'CodeGraphSnapshotUnavailable';
}

export class CodeGraphStoreError extends Error {
  override readonly name = 'CodeGraphStoreError';
}
