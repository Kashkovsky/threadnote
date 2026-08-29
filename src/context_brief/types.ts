import type {CodeGraphProvenance, CodeGraphRelation, CodeGraphSpan} from '../code_graph/types.js';
import type {AgentToolResponseMeasurement} from '../evaluation/agent-response.js';
import type {MemoryCodeCitationV1} from '../memory/code_citation.js';
import type {MemoryAuthority, MemoryTrust} from '../memory/document.js';

export const CONTEXT_BRIEF_LEGACY_VERSION = 2 as const;
export const CONTEXT_BRIEF_VERSION = 3 as const;
export const CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION = 2 as const;
export const CONTEXT_BRIEF_PROJECTOR_VERSION = 3 as const;
export const CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION = 1 as const;
export const CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS = 8 as const;
export const CONTEXT_BRIEF_MAXIMUM_PUBLIC_CODE_RELATIONS = 1 as const;
export const CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES = 96 as const;
export const CONTEXT_BRIEF_MAXIMUM_CODE_REFS = 8 as const;
export const CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS = 1_250 as const;
export const CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS = 1_500 as const;
export const CONTEXT_BRIEF_MODES = ['brief', 'locate', 'explain', 'trace', 'impact'] as const;

export type ContextBriefMode = (typeof CONTEXT_BRIEF_MODES)[number];
export type ContextBriefFreshness = 'fresh' | 'stale' | 'unknown';
export type ContextBriefPreciseEvidenceStatus = 'exact' | 'relocated' | 'changed' | 'deleted' | 'unknown';
export type ContextBriefResponseVersion = typeof CONTEXT_BRIEF_LEGACY_VERSION | typeof CONTEXT_BRIEF_VERSION;
export type ContextBriefProjectorVersion =
  typeof CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION | typeof CONTEXT_BRIEF_PROJECTOR_VERSION;

export type ContextBriefCitationValidationReasonV2 =
  | 'ambiguous-relocation'
  | 'citation-limit'
  | 'exact'
  | 'extractor-mismatch'
  | 'graph-incomplete'
  | 'graph-stale'
  | 'malformed-citation'
  | 'relocated'
  | 'repository-ambiguous'
  | 'repository-unavailable'
  | 'source-changed'
  | 'source-deleted'
  | 'validation-error';

/** @internal Detailed compiler receipt; public Context Briefs project only bounded audit fields. */
export interface ContextBriefCitationValidationReceiptV2 {
  readonly candidateCount: number;
  readonly citationId: string;
  readonly coverage: 'current-complete' | 'incomplete';
  readonly kind: MemoryCodeCitationV1['target']['kind'] | 'malformed';
  /** Wall-clock time at which this validation result was observed. */
  readonly observedAt: string;
  readonly observedLocator?: {
    readonly kind: string;
    readonly language: string;
    readonly name: string;
    readonly qualifiedName: string;
  };
  readonly observedNodeId?: string;
  readonly observedPath?: string;
  readonly observedSpan?: CodeGraphSpan;
  readonly reason: ContextBriefCitationValidationReasonV2;
  readonly repositoryId?: string;
  readonly snapshotCommit?: string;
  /** Snapshot publication time, distinct from the validation observation. */
  readonly snapshotCompletedAt?: string;
  readonly snapshotId?: string;
  readonly sourcePath?: string;
  readonly status: ContextBriefPreciseEvidenceStatus;
  readonly strategy: 'content-hash' | 'file-path' | 'node-id' | 'none' | 'semantic-locator';
  readonly validatorVersion: typeof CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION;
}

/** Bounded public audit receipt. Repository, snapshot, commit, and full-path details stay private. */
export interface ContextBriefCitationReceiptV2 {
  readonly citationId: string;
  readonly observedNodeId?: string;
  readonly reason: ContextBriefCitationValidationReasonV2;
  readonly relocationHint?: string;
  readonly status: ContextBriefPreciseEvidenceStatus;
}

export interface ContextBriefCitationSummaryV2 {
  readonly coverage: 'current-complete' | 'incomplete';
  readonly exact: number;
  readonly relocated: number;
  /** Changed and deleted citations share the safety-equivalent stale bucket. */
  readonly stale: number;
  readonly unknown: number;
  readonly validatorVersion: typeof CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION;
}

export type ContextBriefScopeV1 =
  | {
      readonly callerCwd: string;
      readonly kind: 'repository';
      readonly project?: string;
    }
  | {
      readonly kind: 'workset';
      readonly name: string;
      readonly project?: string;
    };

export interface ContextBriefRequestV1 {
  readonly budgetTokens: number;
  readonly codeRefs?: readonly string[];
  readonly mode: ContextBriefMode;
  readonly scope: ContextBriefScopeV1;
  readonly task: string;
}

export interface ContextBriefPlanV1 {
  readonly codeAnchors: {
    readonly candidateLimit: number;
    readonly codeRefs: readonly string[];
    readonly project?: string;
    readonly scope: ContextBriefScopeV1;
  };
  readonly graph: {
    readonly edgeLimit: number;
    readonly evidenceCards: number;
    readonly maximumEstimatedTokens: number;
    readonly nodeLimit: number;
    readonly query: string;
    readonly scope: ContextBriefScopeV1;
  };
  readonly memory: {
    readonly candidateLimit: number;
    readonly project?: string;
    readonly query: string;
  };
  readonly mode: ContextBriefMode;
  readonly outputBudgetTokens: number;
  readonly scope: ContextBriefScopeV1;
  readonly task: string;
}

export interface ContextBriefSnapshotV1 {
  readonly commit: string;
  readonly dirty: boolean;
  readonly freshness: ContextBriefFreshness;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

/** @internal Point-in-time graph identity carried only between compiler phases. */
export type ContextBriefCitationValidationFenceV2 =
  | {
      readonly kind: 'repository';
      readonly repositoryId: string;
      readonly snapshotId: string;
    }
  | {
      readonly generation: {readonly digest: string; readonly id: string};
      readonly kind: 'workset';
      readonly workset: string;
    };

export interface ContextBriefGraphCardV1 {
  readonly id: string;
  readonly rank: number;
  readonly reason: string;
  readonly ref: string;
  readonly repositoryKey: string;
  readonly symbol: {
    readonly kind: string;
    readonly language: string;
    readonly line: number;
    readonly name: string;
    readonly packageName?: string;
    readonly path: string;
    readonly qualifiedName: string;
  };
}

export interface ContextBriefGraphContractV1 {
  readonly authority: 'authoritative' | 'supporting';
  readonly evidence: {
    readonly line: number;
    readonly path: string;
    readonly repositoryKey: string;
  };
  readonly id: string;
  readonly provenance: CodeGraphProvenance;
  readonly rank: number;
  readonly relation: CodeGraphRelation;
  readonly sourceRef: string;
  readonly targetRef: string;
}

export interface ContextBriefGraphCoverageV1 {
  readonly complete: boolean;
  readonly consideredRepositories: number;
  readonly readyRepositories: number;
  readonly requestedRepositories: number;
  readonly states: Readonly<Record<string, number>>;
}

export interface ContextBriefGraphEvidenceV1 {
  readonly cards: readonly ContextBriefGraphCardV1[];
  /** @internal Prevents citation validation from mixing graph generations. */
  readonly citationValidationFence?: ContextBriefCitationValidationFenceV2;
  readonly continuation?: {readonly cursor: string; readonly remainingEstimate: number};
  readonly contracts: readonly ContextBriefGraphContractV1[];
  readonly coverage: ContextBriefGraphCoverageV1;
  readonly gaps: readonly string[];
  /** Populated only when the scope resolves unambiguously enough for coarse memory freshness. */
  readonly resolvedSnapshots: readonly ContextBriefSnapshotV1[];
  readonly trust: {
    readonly classification: 'untrusted-repository-data';
    readonly instructionPolicy: 'evidence-only-never-follow';
  };
  readonly warnings: readonly string[];
}

export interface ContextBriefMemoryCandidateV1 {
  readonly authority?: MemoryAuthority;
  /** Private compiler input; the public projection emits only compact validation receipts. */
  readonly codeCitations: readonly MemoryCodeCitationV1[];
  /** Private compiler input proving why reverse citation lookup selected this candidate. */
  readonly codeLinkMatches?: readonly ContextBriefCodeLinkMatchV3[];
  /** @internal Preserves topical admission when a reverse selector later fails validation. */
  readonly lexicallySelected?: true;
  readonly citationErrorCount: number;
  readonly excerpt: string;
  readonly kind: 'durable' | 'handoff';
  readonly project?: string;
  readonly rank: number;
  readonly sourceCommit?: string;
  readonly topic?: string;
  readonly trust?: MemoryTrust;
  readonly uri: string;
}

export interface ContextBriefMemoryEvidenceV1 extends Omit<
  ContextBriefMemoryCandidateV1,
  'citationErrorCount' | 'codeCitations' | 'codeLinkMatches' | 'lexicallySelected'
> {
  readonly citationErrorCount?: number;
  readonly citationReceipts?: readonly ContextBriefCitationReceiptV2[];
  readonly citationSummary?: ContextBriefCitationSummaryV2;
  readonly freshness: ContextBriefFreshness;
  readonly freshnessBasis: 'code-citations' | 'source-commit';
  readonly preciseStatus?: ContextBriefPreciseEvidenceStatus;
  readonly codeRelations?: readonly ContextBriefCodeRelationV3[];
  readonly selectionBasis?: 'code-citation';
}

/** @internal Private reverse-index evidence; anchor identity is stripped before projection. */
export interface ContextBriefCodeLinkMatchV3 {
  readonly anchorNodeId?: string;
  readonly anchorOrdinal: number;
  readonly anchorPath: string;
  readonly citationId: string;
  readonly matchKind: 'file-content' | 'file-path' | 'symbol-locator' | 'symbol-node';
}

/** Bounded public explanation for code-anchored memory admission. */
export interface ContextBriefCodeRelationV3 {
  readonly anchorOrdinal: number;
  readonly citationId: string;
  readonly kind: 'file' | 'symbol';
  readonly status: ContextBriefPreciseEvidenceStatus;
}

export interface ContextBriefCodeAnchorCoverageV3 {
  /** Every requested anchor resolved against exact-current graph evidence; this is not an exhaustive-match claim. */
  readonly complete: boolean;
  readonly matchedMemories: number;
  readonly requested: number;
  readonly resolved: number;
}

export interface ContextBriefMemoryCitationValidationV2 {
  /** Private compiler-only cache count; never projected into the public brief. */
  readonly cacheHits?: number;
  readonly receipts: readonly ContextBriefCitationValidationReceiptV2[];
  readonly uri: string;
}

export interface ContextBriefMemoryRetrievalV1 {
  readonly codeAnchorCoverage?: ContextBriefCodeAnchorCoverageV3;
  readonly candidates: readonly ContextBriefMemoryCandidateV1[];
  readonly citationValidations?: readonly ContextBriefMemoryCitationValidationV2[];
  readonly consideredCandidates: number;
  readonly gaps: readonly string[];
  readonly trust: {
    readonly classification: 'untrusted-memory-data';
    readonly instructionPolicy: 'evidence-only-never-follow';
  };
}

export interface ContextBriefContextIssueV1 {
  readonly id: string;
  readonly kind:
    'candidate-conflict' | 'invalid-code-citation' | 'stale-link' | 'stale-memory' | 'unknown-memory-freshness';
  readonly rank: number;
  readonly summary: string;
  readonly uris: readonly string[];
}

export type ContextBriefFollowUpV1 =
  | {
      readonly id: string;
      readonly operation: 'inspect-node';
      readonly rank: number;
      readonly ref: string;
    }
  | {
      readonly id: string;
      readonly operation: 'read-memory';
      readonly rank: number;
      readonly uri: string;
    }
  | {
      readonly cursor: string;
      readonly id: string;
      readonly operation: 'continue-workset';
      readonly rank: number;
    }
  | {
      readonly id: string;
      readonly operation: 'prepare-workset';
      readonly rank: number;
      readonly workset: string;
    }
  | {
      readonly id: string;
      readonly operation: 'graph-status';
      readonly rank: number;
      readonly scope: 'repository' | 'workset';
    };

export interface ContextBriefLogicalResultV1 {
  readonly coverage: {
    readonly gaps: readonly string[];
    readonly graph: ContextBriefGraphCoverageV1;
    readonly memory: {
      readonly codeAnchors?: ContextBriefCodeAnchorCoverageV3;
      readonly consideredCandidates: number;
      readonly durableCandidates: number;
      readonly fresh: number;
      readonly handoffCandidates: number;
      readonly stale: number;
      readonly unknown: number;
    };
  };
  readonly durableDecisions: readonly ContextBriefMemoryEvidenceV1[];
  readonly recommendedFollowUps: readonly ContextBriefFollowUpV1[];
  readonly graph: ContextBriefGraphEvidenceV1;
  readonly activeHandoffs: readonly ContextBriefMemoryEvidenceV1[];
  readonly stalenessAndConflicts: readonly ContextBriefContextIssueV1[];
  readonly mode: ContextBriefMode;
  readonly scope: {
    readonly freshness: ContextBriefFreshness;
    readonly kind: ContextBriefScopeV1['kind'];
    readonly name: string;
    readonly readyRepositories: number;
    readonly requestedRepositories: number;
  };
  readonly task: string;
  readonly trust: {
    readonly compiler: {
      readonly modelsRequired: false;
      readonly queryPlanExposed: false;
    };
    readonly graph: ContextBriefGraphEvidenceV1['trust'];
    readonly memory: ContextBriefMemoryRetrievalV1['trust'];
  };
  readonly type: 'context-brief';
  readonly version: ContextBriefResponseVersion;
}

export interface ContextBriefV1 {
  readonly coverage: ContextBriefLogicalResultV1['coverage'] & {
    readonly omissions: {
      readonly durableDecisions: number;
      readonly recommendedFollowUps: number;
      readonly graphCards: number;
      readonly graphContracts: number;
      readonly activeHandoffs: number;
      readonly stalenessAndConflicts: number;
    };
  };
  readonly durableDecisions: readonly ContextBriefMemoryEvidenceV1[];
  readonly recommendedFollowUps: readonly ContextBriefFollowUpV1[];
  readonly graph: {
    readonly cards: readonly ContextBriefGraphCardV1[];
    readonly continuation?:
      | {readonly cursor: string; readonly remainingEstimate: number; readonly state: 'available'}
      | {
          readonly omittedCards: number;
          readonly state: 'rerun-required';
          readonly upstreamRemainingEstimate?: number;
        };
    readonly contracts: readonly ContextBriefGraphContractV1[];
  };
  readonly activeHandoffs: readonly ContextBriefMemoryEvidenceV1[];
  readonly stalenessAndConflicts: readonly ContextBriefContextIssueV1[];
  readonly mode: ContextBriefMode;
  readonly output: {
    readonly omittedItems: number;
    readonly projectorVersion: ContextBriefProjectorVersion;
    readonly returnedItems: number;
    readonly truncated: boolean;
  };
  readonly scope: ContextBriefLogicalResultV1['scope'];
  readonly task: {
    readonly summary: string;
    readonly truncated: boolean;
  };
  readonly trust: ContextBriefLogicalResultV1['trust'];
  readonly type: 'context-brief';
  readonly version: ContextBriefResponseVersion;
}

export interface ProjectedContextBriefV1 {
  readonly maximumBytes: number;
  readonly measurement: AgentToolResponseMeasurement;
  readonly structuredContent: ContextBriefV1;
  readonly text: string;
}

/** Public semantic aliases while the original type names remain source-compatible. */
export type ContextBriefV2 = Omit<ContextBriefV1, 'output' | 'version'> & {
  readonly output: Omit<ContextBriefV1['output'], 'projectorVersion'> & {
    readonly projectorVersion: typeof CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION;
  };
  readonly version: typeof CONTEXT_BRIEF_LEGACY_VERSION;
};
export type ContextBriefV3 = Omit<ContextBriefV1, 'output' | 'version'> & {
  readonly output: Omit<ContextBriefV1['output'], 'projectorVersion'> & {
    readonly projectorVersion: typeof CONTEXT_BRIEF_PROJECTOR_VERSION;
  };
  readonly version: typeof CONTEXT_BRIEF_VERSION;
};
export type ContextBriefLogicalResultV2 = Omit<ContextBriefLogicalResultV1, 'version'> & {
  readonly version: typeof CONTEXT_BRIEF_LEGACY_VERSION;
};
export type ContextBriefLogicalResultV3 = Omit<ContextBriefLogicalResultV1, 'version'> & {
  readonly version: typeof CONTEXT_BRIEF_VERSION;
};
export type ProjectedContextBriefV2 = Omit<ProjectedContextBriefV1, 'structuredContent'> & {
  readonly structuredContent: ContextBriefV2;
};
export type ProjectedContextBriefV3 = Omit<ProjectedContextBriefV1, 'structuredContent'> & {
  readonly structuredContent: ContextBriefV3;
};

const UTF8 = new TextEncoder();
const REQUEST_KEYS = new Set(['budgetTokens', 'codeRefs', 'mode', 'scope', 'task']);
const REPOSITORY_SCOPE_KEYS = new Set(['callerCwd', 'kind', 'project']);
const WORKSET_SCOPE_KEYS = new Set(['kind', 'name', 'project']);

/** Strict transport parser: unknown keys are rejected instead of silently becoming a private query language. */
export function parseContextBriefRequestV1(value: unknown): ContextBriefRequestV1 {
  const object = record(value, 'Context Brief request');
  exactKeys(object, REQUEST_KEYS, 'Context Brief request');
  const task = boundedText(object.task, 'task', 4_096);
  const codeRefs = parseCodeRefs(object.codeRefs);
  const mode = object.mode === undefined ? 'brief' : contextBriefMode(object.mode);
  const budgetTokens = object.budgetTokens === undefined ? CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS : object.budgetTokens;
  if (
    !Number.isSafeInteger(budgetTokens) ||
    (budgetTokens as number) < 1 ||
    (budgetTokens as number) > CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS
  ) {
    throw invalid(`budgetTokens must be an integer from 1 to ${CONTEXT_BRIEF_MAXIMUM_ESTIMATED_TOKENS}.`);
  }
  const scope = parseScope(object.scope);
  return {
    budgetTokens: budgetTokens as number,
    ...(codeRefs.length === 0 ? {} : {codeRefs}),
    mode,
    scope,
    task,
  };
}

function parseCodeRefs(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('codeRefs must be an array.');
  if (value.length > CONTEXT_BRIEF_MAXIMUM_CODE_REFS) {
    throw invalid(`codeRefs may contain at most ${CONTEXT_BRIEF_MAXIMUM_CODE_REFS} entries.`);
  }
  const refs = value.map((ref, index) => boundedText(ref, `codeRefs[${index}]`, 4_096, false));
  return [...new Set(refs)];
}

function parseScope(value: unknown): ContextBriefScopeV1 {
  const object = record(value, 'Context Brief scope');
  if (object.kind === 'repository') {
    exactKeys(object, REPOSITORY_SCOPE_KEYS, 'repository scope');
    const callerCwd = boundedText(object.callerCwd, 'callerCwd', 4_096, false);
    if (!callerCwd.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(callerCwd)) {
      throw invalid('callerCwd must be an absolute path.');
    }
    return {
      callerCwd,
      kind: 'repository',
      ...(object.project === undefined ? {} : {project: boundedText(object.project, 'project', 256)}),
    };
  }
  if (object.kind === 'workset') {
    exactKeys(object, WORKSET_SCOPE_KEYS, 'workset scope');
    return {
      kind: 'workset',
      name: boundedText(object.name, 'workset name', 256),
      ...(object.project === undefined ? {} : {project: boundedText(object.project, 'project', 256)}),
    };
  }
  throw invalid('scope.kind must be repository or workset.');
}

function contextBriefMode(value: unknown): ContextBriefMode {
  if (typeof value === 'string' && (CONTEXT_BRIEF_MODES as readonly string[]).includes(value)) {
    return value as ContextBriefMode;
  }
  throw invalid(`mode must be one of ${CONTEXT_BRIEF_MODES.join(', ')}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw invalid(`${label} has unsupported field ${JSON.stringify(unknown.sort()[0])}.`);
}

function boundedText(value: unknown, label: string, maximumBytes: number, normalize = true): string {
  if (typeof value !== 'string') throw invalid(`${label} must be a string.`);
  const text = normalize ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : value.trim();
  if (!text || UTF8.encode(text).byteLength > maximumBytes || hasUnsupportedControlCharacter(text)) {
    throw invalid(`${label} must be non-empty, bounded UTF-8 text without control characters.`);
  }
  return text;
}

function hasUnsupportedControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}

function invalid(message: string): Error {
  return new Error(`Invalid Context Brief request: ${message}`);
}
