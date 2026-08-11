import {sha256HexSync} from '../crypto/sha256.js';
import {
  CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_VERSION,
  parseContextBriefRequestV1,
  type ContextBriefContextIssueV1,
  type ContextBriefFollowUpV1,
  type ContextBriefFreshness,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefLogicalResultV1,
  type ContextBriefMemoryEvidenceV1,
  type ContextBriefMemoryRetrievalV1,
  type ContextBriefPlanV1,
  type ContextBriefRequestV1,
} from './types.js';
import {classifyMemoryFreshness} from './memory_evidence.js';

const MAXIMUM_ISSUES = 24;
const MAXIMUM_FOLLOW_UPS = 24;

/** Build a deterministic private retrieval plan. This is not a user-facing query language or output field. */
export function planContextBrief(input: ContextBriefRequestV1 | unknown): ContextBriefPlanV1 {
  const request = parseContextBriefRequestV1(input);
  const modeShape =
    request.mode === 'impact' || request.mode === 'trace'
      ? {edgeLimit: 64, evidenceCards: 10, nodeLimit: 24}
      : request.mode === 'explain'
        ? {edgeLimit: 48, evidenceCards: 8, nodeLimit: 20}
        : {edgeLimit: 32, evidenceCards: 8, nodeLimit: 16};
  return {
    graph: {
      ...modeShape,
      maximumEstimatedTokens: CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
      query: request.task,
      scope: request.scope,
    },
    memory: {
      candidateLimit: 24,
      ...(request.scope.project === undefined ? {} : {project: request.scope.project}),
      query: request.task,
    },
    mode: request.mode,
    outputBudgetTokens: request.budgetTokens,
    scope: request.scope,
    task: request.task,
  };
}

export function assembleContextBriefLogicalResult(input: {
  readonly graph: ContextBriefGraphEvidenceV1;
  readonly memory: ContextBriefMemoryRetrievalV1;
  readonly plan: ContextBriefPlanV1;
}): ContextBriefLogicalResultV1 {
  const memories = input.memory.candidates.map(candidate => ({
    ...candidate,
    freshness: classifyMemoryFreshness(candidate.sourceCommit, input.graph.resolvedSnapshots),
  })) satisfies readonly ContextBriefMemoryEvidenceV1[];
  const durableDecisions = stableMemories(memories.filter(memory => memory.kind === 'durable'));
  const handoffs = stableMemories(memories.filter(memory => memory.kind === 'handoff'));
  const issues = contextIssues(memories);
  const gaps = stableUnique([
    ...input.graph.gaps,
    ...input.memory.gaps,
    ...(input.graph.cards.length === 0 ? ['no-graph-evidence'] : []),
    ...(memories.length === 0 ? ['no-relevant-active-memory'] : []),
    ...(memories.some(memory => memory.freshness === 'unknown') ? ['memory-freshness-unknown'] : []),
  ]).slice(0, 24);
  const freshness = scopeFreshness(input.graph);
  return {
    coverage: {
      gaps,
      graph: input.graph.coverage,
      memory: {
        consideredCandidates: input.memory.consideredCandidates,
        durableCandidates: durableDecisions.length,
        fresh: memories.filter(memory => memory.freshness === 'fresh').length,
        handoffCandidates: handoffs.length,
        stale: memories.filter(memory => memory.freshness === 'stale').length,
        unknown: memories.filter(memory => memory.freshness === 'unknown').length,
      },
    },
    durableDecisions,
    recommendedFollowUps: exactFollowUps(input.graph, memories, input.plan),
    graph: input.graph,
    activeHandoffs: handoffs,
    stalenessAndConflicts: issues,
    mode: input.plan.mode,
    scope: {
      freshness,
      kind: input.plan.scope.kind,
      name: input.plan.scope.kind === 'workset' ? input.plan.scope.name : 'current-repository',
      readyRepositories: input.graph.coverage.readyRepositories,
      requestedRepositories: input.graph.coverage.requestedRepositories,
    },
    task: input.plan.task,
    trust: {
      compiler: {modelsRequired: false, queryPlanExposed: false},
      graph: input.graph.trust,
      memory: input.memory.trust,
    },
    type: 'context-brief',
    version: CONTEXT_BRIEF_VERSION,
  };
}

function stableMemories(memories: readonly ContextBriefMemoryEvidenceV1[]): readonly ContextBriefMemoryEvidenceV1[] {
  return [...memories]
    .sort((left, right) => left.rank - right.rank || compareText(left.uri, right.uri))
    .map((memory, rank) => ({...memory, rank}));
}

function scopeFreshness(graph: ContextBriefGraphEvidenceV1): ContextBriefFreshness {
  if (graph.coverage.requestedRepositories === 0 || graph.coverage.readyRepositories === 0) return 'unknown';
  if (!graph.coverage.complete || graph.coverage.readyRepositories < graph.coverage.requestedRepositories)
    return 'stale';
  if (graph.resolvedSnapshots.length === 1) return graph.resolvedSnapshots[0]!.freshness;
  const stale =
    (graph.coverage.states.stale ?? 0) + (graph.coverage.states.missing ?? 0) + (graph.coverage.states.failed ?? 0);
  return stale > 0 ? 'stale' : 'fresh';
}

function contextIssues(memories: readonly ContextBriefMemoryEvidenceV1[]): readonly ContextBriefContextIssueV1[] {
  const issues: ContextBriefContextIssueV1[] = [];
  for (const memory of memories) {
    if (memory.freshness === 'fresh') continue;
    const kind = memory.freshness === 'stale' ? 'stale-memory' : 'unknown-memory-freshness';
    issues.push({
      id: issueId(kind, [memory.uri]),
      kind,
      rank: issues.length,
      summary:
        memory.freshness === 'stale'
          ? `Source commit differs for ${memory.topic ?? memory.uri}.`
          : `Source commit cannot be resolved unambiguously for ${memory.topic ?? memory.uri}.`,
      uris: [memory.uri],
    });
  }

  const byIdentity = new Map<string, ContextBriefMemoryEvidenceV1[]>();
  for (const memory of memories) {
    if (!memory.project || !memory.topic) continue;
    const key = `${memory.kind}\u0000${memory.project.normalize('NFKC').toLowerCase()}\u0000${memory.topic
      .normalize('NFKC')
      .toLowerCase()}`;
    const group = byIdentity.get(key) ?? [];
    group.push(memory);
    byIdentity.set(key, group);
  }
  for (const group of byIdentity.values()) {
    const identities = new Set(group.map(memory => `${memory.sourceCommit ?? ''}\u0000${memory.excerpt}`));
    if (group.length < 2 || identities.size < 2) continue;
    const uris = group.map(memory => memory.uri).sort(compareText);
    issues.push({
      id: issueId('candidate-conflict', uris),
      kind: 'candidate-conflict',
      rank: issues.length,
      summary: `Multiple active memories disagree for ${group[0]!.project}/${group[0]!.topic}.`,
      uris,
    });
  }
  return issues
    .sort((left, right) => issuePriority(left.kind) - issuePriority(right.kind) || compareText(left.id, right.id))
    .slice(0, MAXIMUM_ISSUES)
    .map((issue, rank) => ({...issue, rank}));
}

function exactFollowUps(
  graph: ContextBriefGraphEvidenceV1,
  memories: readonly ContextBriefMemoryEvidenceV1[],
  plan: ContextBriefPlanV1,
): readonly ContextBriefFollowUpV1[] {
  const followUps: ContextBriefFollowUpV1[] = [];
  for (const card of [...graph.cards].sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))) {
    followUps.push({
      id: followUpId('inspect-node', card.ref),
      operation: 'inspect-node',
      rank: followUps.length,
      ref: card.ref,
    });
  }
  for (const memory of stableMemories(memories)) {
    followUps.push({
      id: followUpId('read-memory', memory.uri),
      operation: 'read-memory',
      rank: followUps.length,
      uri: memory.uri,
    });
  }
  if (graph.continuation !== undefined) {
    followUps.push({
      cursor: graph.continuation.cursor,
      id: followUpId('continue-workset', graph.continuation.cursor),
      operation: 'continue-workset',
      rank: followUps.length,
    });
  }
  if (!graph.coverage.complete && plan.scope.kind === 'workset') {
    followUps.push({
      id: followUpId('prepare-workset', plan.scope.name),
      operation: 'prepare-workset',
      rank: followUps.length,
      workset: plan.scope.name,
    });
  }
  if (graph.coverage.readyRepositories === 0) {
    followUps.push({
      id: followUpId('graph-status', plan.scope.kind),
      operation: 'graph-status',
      rank: followUps.length,
      scope: plan.scope.kind,
    });
  }
  return followUps.slice(0, MAXIMUM_FOLLOW_UPS).map((followUp, rank) => ({...followUp, rank}));
}

function issuePriority(kind: ContextBriefContextIssueV1['kind']): number {
  return kind === 'candidate-conflict' ? 0 : kind === 'stale-memory' ? 1 : 2;
}

function issueId(kind: ContextBriefContextIssueV1['kind'], uris: readonly string[]): string {
  return `cbci_${sha256HexSync(`${kind}\u0000${uris.join('\u0000')}`).slice(0, 24)}`;
}

function followUpId(kind: string, target: string): string {
  return `cbfu_${sha256HexSync(`${kind}\u0000${target}`).slice(0, 24)}`;
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
