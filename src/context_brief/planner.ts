import {sha256HexSync} from '../crypto/sha256.js';
import {
  CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES,
  CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
  CONTEXT_BRIEF_DEFAULT_ESTIMATED_TOKENS,
  CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS,
  CONTEXT_BRIEF_VERSION,
  parseContextBriefRequestV1,
  type ContextBriefCitationReceiptV2,
  type ContextBriefCitationSummaryV2,
  type ContextBriefContextIssueV1,
  type ContextBriefCitationValidationReceiptV2,
  type ContextBriefFollowUpV1,
  type ContextBriefFreshness,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefLogicalResultV1,
  type ContextBriefMemoryEvidenceV1,
  type ContextBriefMemoryRetrievalV1,
  type ContextBriefPlanV1,
  type ContextBriefRequestV1,
} from './types.js';
import {classifyMemoryFreshness, reconcileContextBriefMemoryFreshness} from './memory_evidence.js';

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
  readonly observedAt: string;
  readonly plan: ContextBriefPlanV1;
}): ContextBriefLogicalResultV1 {
  const validations = new Map((input.memory.citationValidations ?? []).map(validation => [validation.uri, validation]));
  const memories = input.memory.candidates.map(candidate => {
    const privateCitationReceipts = validationReceipts(
      candidate,
      validations.get(candidate.uri)?.receipts,
      input.observedAt,
    );
    const preciseStatus = aggregatePreciseStatus(privateCitationReceipts);
    const citationReceipts = publicCitationReceipts(privateCitationReceipts);
    const citationSummary = summarizeCitationReceipts(privateCitationReceipts);
    const coarse = classifyMemoryFreshness(candidate.sourceCommit, input.graph.resolvedSnapshots);
    const {citationErrorCount, codeCitations: _privateCodeCitations, ...publicCandidate} = candidate;
    return {
      ...publicCandidate,
      ...(citationErrorCount === 0 ? {} : {citationErrorCount}),
      ...(citationReceipts.length === 0 ? {} : {citationReceipts}),
      ...(citationSummary === undefined ? {} : {citationSummary}),
      freshness: preciseStatus === undefined ? coarse : reconcileContextBriefMemoryFreshness(coarse, preciseStatus),
      freshnessBasis: preciseStatus === undefined ? ('source-commit' as const) : ('code-citations' as const),
      ...(preciseStatus === undefined ? {} : {preciseStatus}),
    };
  }) satisfies readonly ContextBriefMemoryEvidenceV1[];
  const durableDecisions = stableMemories(memories.filter(memory => memory.kind === 'durable'));
  const handoffs = stableMemories(memories.filter(memory => memory.kind === 'handoff'));
  const issues = contextIssues(memories);
  const gaps = stableUnique([
    ...input.graph.gaps,
    ...input.memory.gaps,
    ...(input.graph.cards.length === 0 ? ['no-graph-evidence'] : []),
    ...(memories.length === 0 ? ['no-relevant-active-memory'] : []),
    ...(memories.some(memory => memory.freshness === 'unknown') ? ['memory-freshness-unknown'] : []),
    ...(memories.some(memory => (memory.citationErrorCount ?? 0) > 0) ? ['memory-code-citations-invalid'] : []),
    ...(memories.some(memory => memory.preciseStatus === 'relocated') ? ['memory-code-links-relocated'] : []),
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
    if ((memory.citationErrorCount ?? 0) > 0) {
      issues.push({
        id: issueId('invalid-code-citation', [memory.uri]),
        kind: 'invalid-code-citation',
        rank: issues.length,
        summary: `${memory.citationErrorCount ?? 0} malformed code citation line(s) were ignored for ${memory.topic ?? memory.uri}.`,
        uris: [memory.uri],
      });
    }
    if (memory.citationReceipts?.some(receipt => receipt.status === 'relocated')) {
      issues.push({
        id: issueId('stale-link', [memory.uri]),
        kind: 'stale-link',
        rank: issues.length,
        summary: `Cited code moved for ${memory.topic ?? memory.uri}; the memory remains fresh but its stored link is stale.`,
        uris: [memory.uri],
      });
    }
    if (memory.freshness === 'fresh') continue;
    const kind = memory.freshness === 'stale' ? 'stale-memory' : 'unknown-memory-freshness';
    issues.push({
      id: issueId(kind, [memory.uri]),
      kind,
      rank: issues.length,
      summary:
        memory.freshness === 'stale'
          ? memory.preciseStatus === 'changed' || memory.preciseStatus === 'deleted'
            ? `Cited code changed or was deleted for ${memory.topic ?? memory.uri}.`
            : `Source commit differs for ${memory.topic ?? memory.uri}.`
          : memory.preciseStatus === 'unknown' || (memory.citationErrorCount ?? 0) > 0
            ? `Cited code cannot be validated safely for ${memory.topic ?? memory.uri}.`
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
  const graphCardRefs = new Set(graph.cards.map(card => card.ref));
  const relocatedNodeIds = stableUnique(
    memories.flatMap(memory =>
      (memory.citationReceipts ?? []).flatMap(receipt =>
        receipt.status === 'relocated' && receipt.observedNodeId !== undefined ? [receipt.observedNodeId] : [],
      ),
    ),
  );
  for (const observedNodeId of relocatedNodeIds) {
    if (graphCardRefs.has(observedNodeId)) continue;
    followUps.push({
      id: followUpId('inspect-node', observedNodeId),
      operation: 'inspect-node',
      rank: followUps.length,
      ref: observedNodeId,
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
  switch (kind) {
    case 'candidate-conflict':
      return 0;
    case 'invalid-code-citation':
      return 1;
    case 'stale-memory':
      return 2;
    case 'stale-link':
      return 3;
    case 'unknown-memory-freshness':
      return 4;
  }
}

function validationReceipts(
  candidate: ContextBriefMemoryRetrievalV1['candidates'][number],
  observed: readonly ContextBriefCitationValidationReceiptV2[] | undefined,
  observedAt: string,
): readonly ContextBriefCitationValidationReceiptV2[] {
  const observedById = new Map((observed ?? []).map(receipt => [receipt.citationId, receipt]));
  const receipts = candidate.codeCitations.map(
    citation =>
      observedById.get(citation.id) ?? {
        candidateCount: 0,
        citationId: citation.id,
        coverage: 'incomplete' as const,
        kind: citation.target.kind,
        observedAt,
        reason: 'repository-unavailable' as const,
        repositoryId: citation.repositoryId,
        sourcePath: citation.path,
        status: 'unknown' as const,
        strategy: 'none' as const,
        validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
      },
  );
  for (let index = 0; index < candidate.citationErrorCount; index += 1) {
    receipts.push({
      candidateCount: 0,
      citationId: `tncc_${sha256HexSync(`${candidate.uri}\u0000malformed\u0000${index}`).slice(0, 40)}`,
      coverage: 'incomplete',
      kind: 'malformed',
      observedAt,
      reason: 'malformed-citation',
      status: 'unknown',
      strategy: 'none',
      validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
    });
  }
  return receipts;
}

function publicCitationReceipts(
  receipts: readonly ContextBriefCitationValidationReceiptV2[],
): readonly ContextBriefCitationReceiptV2[] {
  const auditReceipt = receipts.find(
    receipt =>
      receipt.status === 'relocated' &&
      (publicObservedNodeId(receipt) !== undefined || boundedRelocationHint(receipt.observedPath) !== undefined),
  );
  return receipts.slice(0, CONTEXT_BRIEF_MAXIMUM_PUBLIC_CITATION_RECEIPTS).map(receipt => {
    // One move hint per memory is enough to provide an exact audit follow-up
    // without letting repeated optional metadata evict the memory itself.
    const observedNodeId = receipt === auditReceipt ? publicObservedNodeId(receipt) : undefined;
    const relocationHint =
      receipt === auditReceipt && observedNodeId === undefined
        ? boundedRelocationHint(receipt.observedPath)
        : undefined;
    return {
      citationId: receipt.citationId,
      ...(observedNodeId === undefined ? {} : {observedNodeId}),
      reason: receipt.reason,
      ...(relocationHint === undefined ? {} : {relocationHint}),
      status: receipt.status,
    };
  });
}

function summarizeCitationReceipts(
  receipts: readonly ContextBriefCitationValidationReceiptV2[],
): ContextBriefCitationSummaryV2 | undefined {
  if (receipts.length === 0) return undefined;
  return {
    coverage: receipts.every(isCurrentCompleteReceipt) ? 'current-complete' : 'incomplete',
    exact: receipts.filter(receipt => receipt.status === 'exact').length,
    relocated: receipts.filter(receipt => receipt.status === 'relocated').length,
    stale: receipts.filter(receipt => receipt.status === 'changed' || receipt.status === 'deleted').length,
    unknown: receipts.filter(receipt => receipt.status === 'unknown').length,
    validatorVersion: CONTEXT_BRIEF_CITATION_VALIDATOR_VERSION,
  };
}

function isCurrentCompleteReceipt(receipt: ContextBriefCitationValidationReceiptV2): boolean {
  return receipt.coverage === 'current-complete';
}

function publicObservedNodeId(receipt: ContextBriefCitationValidationReceiptV2): string | undefined {
  if (receipt.status !== 'exact' && receipt.status !== 'relocated') return undefined;
  return receipt.observedNodeId !== undefined &&
    /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u.test(receipt.observedNodeId)
    ? receipt.observedNodeId
    : undefined;
}

function boundedRelocationHint(observedPath: string | undefined): string | undefined {
  if (observedPath === undefined || hasUnsupportedControlCharacter(observedPath)) return undefined;
  const pathTail = observedPath
    .replace(/\\/gu, '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .slice(-2)
    .join('/');
  if (pathTail === '') return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(pathTail).byteLength <= CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES) return pathTail;
  let suffix = '';
  for (const character of [...pathTail].reverse()) {
    const candidate = `${character}${suffix}`;
    if (encoder.encode(`…${candidate}`).byteLength > CONTEXT_BRIEF_CITATION_RELOCATION_HINT_MAXIMUM_BYTES) break;
    suffix = candidate;
  }
  return suffix === '' ? undefined : `…${suffix}`;
}

function hasUnsupportedControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || code === 133 || code === 8_232 || code === 8_233;
  });
}

export function aggregatePreciseStatus(
  receipts: readonly Pick<ContextBriefCitationValidationReceiptV2, 'status'>[],
): ContextBriefMemoryEvidenceV1['preciseStatus'] {
  if (receipts.length === 0) return undefined;
  if (receipts.some(receipt => receipt.status === 'changed')) return 'changed';
  if (receipts.some(receipt => receipt.status === 'deleted')) return 'deleted';
  if (receipts.some(receipt => receipt.status === 'unknown')) return 'unknown';
  return receipts.some(receipt => receipt.status === 'relocated') ? 'relocated' : 'exact';
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
