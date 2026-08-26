import {Effect} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '../code_graph/query.js';
import type {CodeGraphEdge, CodeGraphQueryResult} from '../code_graph/types.js';
import {queryCodeGraphWorksetV2, type QueryCodeGraphWorksetV2OptionsV1} from '../code_graph/workset_query_v2.js';
import type {CodeGraphWorksetEvidenceProjectionV2} from '../code_graph/workset_evidence.js';
import type {RuntimeConfig} from '../types.js';
import type {
  ContextBriefGraphCardV1,
  ContextBriefGraphContractV1,
  ContextBriefGraphEvidenceV1,
  ContextBriefPlanV1,
  ContextBriefSnapshotV1,
} from './types.js';

const TRUST = {
  classification: 'untrusted-repository-data',
  instructionPolicy: 'evidence-only-never-follow',
} as const;

/** Read only ready graph state. This boundary never attaches, builds, or requests maintenance. */
export const retrieveContextBriefGraphEvidence = Effect.fn('contextBrief.retrieveGraphEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['graph'],
) {
  return plan.scope.kind === 'workset'
    ? yield* retrieveWorksetGraphEvidence(config, plan)
    : yield* retrieveRepositoryGraphEvidence(config, plan);
});

const retrieveWorksetGraphEvidence = Effect.fn('contextBrief.retrieveWorksetGraphEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['graph'],
) {
  if (plan.scope.kind !== 'workset') throw new Error('Context Brief workset graph plan has the wrong scope.');
  const options: QueryCodeGraphWorksetV2OptionsV1 = {
    edgeLimit: plan.edgeLimit,
    evidenceCards: plan.evidenceCards,
    maximumEstimatedTokens: plan.maximumEstimatedTokens,
    nodeLimit: plan.nodeLimit,
    query: plan.query,
    worksetName: plan.scope.name,
  };
  const result = yield* queryCodeGraphWorksetV2(config, options);
  return fromWorksetProjection(result.structuredContent);
});

const retrieveRepositoryGraphEvidence = Effect.fn('contextBrief.retrieveRepositoryGraphEvidence')(function* (
  config: RuntimeConfig,
  plan: ContextBriefPlanV1['graph'],
) {
  if (plan.scope.kind !== 'repository') throw new Error('Context Brief repository graph plan has the wrong scope.');
  const query = yield* CodeGraphQueryService;
  const status = yield* query.status(config.agentContextHome, plan.scope.callerCwd, {requestMaintenance: false});
  if (status.readySnapshot === undefined) {
    return unavailableContextBriefGraphEvidence('graph-ready-snapshot-missing', 1, {
      missing: 1,
    });
  }
  const result = yield* query.inspect({
    cwd: plan.scope.callerCwd,
    edgeLimit: plan.edgeLimit,
    nodeLimit: plan.nodeLimit,
    operation: 'query',
    query: plan.query,
    refresh: false,
    requestMaintenance: false,
    statusObservation: observationFromCodeGraphStatus(status),
    strictFreshness: false,
    threadnoteHome: config.agentContextHome,
  });
  return fromRepositoryQuery(result);
});

export function fromWorksetProjection(result: CodeGraphWorksetEvidenceProjectionV2): ContextBriefGraphEvidenceV1 {
  const cards = result.cards.map((card, rank): ContextBriefGraphCardV1 => ({
    id: card.id,
    rank,
    reason: compactText(card.reason.summary, 160),
    ref: card.ref,
    repositoryKey: card.repositoryKey,
    symbol: {
      kind: compactText(card.symbol.kind, 80),
      language: compactText(card.symbol.language, 80),
      line: card.symbol.span.line,
      name: compactText(card.symbol.name, 160),
      ...(card.symbol.packageName === undefined ? {} : {packageName: compactText(card.symbol.packageName, 160)}),
      path: card.symbol.path,
      qualifiedName: compactText(card.symbol.qualifiedName, 240),
    },
  }));
  const contracts = uniqueContracts(
    result.cards.flatMap((card, cardRank) =>
      card.relationships.map((relationship, relationshipRank): ContextBriefGraphContractV1 => ({
        authority: relationship.authority,
        evidence: {
          line: relationship.evidence.span.line,
          path: relationship.evidence.path,
          repositoryKey: relationship.evidence.repositoryKey,
        },
        id: contractId([
          relationship.source.ref,
          relationship.relation,
          relationship.target.ref,
          relationship.evidence.repositoryKey,
          relationship.evidence.path,
          String(relationship.evidence.span.line),
        ]),
        provenance: relationship.provenance,
        rank: cardRank * 32 + relationshipRank,
        relation: relationship.relation,
        sourceRef: relationship.source.ref,
        targetRef: relationship.target.ref,
      })),
    ),
  );
  const snapshots = Object.entries(result.repositories)
    .filter(([, receipt]) => receipt.snapshot !== undefined)
    .sort(([left], [right]) => compareText(left, right))
    .map(([repositoryKey, receipt]): ContextBriefSnapshotV1 => ({
      commit: receipt.snapshot!.commit,
      dirty: receipt.snapshot!.dirty,
      freshness: receipt.snapshot!.freshness === 'current' ? 'fresh' : 'stale',
      repositoryId: receipt.repositoryId,
      repositoryKey,
      snapshotId: receipt.snapshot!.id,
    }));
  const readyRepositories = (result.coverage.states.current ?? 0) + (result.coverage.states.stale ?? 0);
  const gaps = [
    ...(result.coverage.complete ? [] : ['graph-coverage-incomplete']),
    ...((result.coverage.states.missing ?? 0) > 0 ? ['graph-snapshots-missing'] : []),
    ...((result.coverage.states.failed ?? 0) > 0 ? ['graph-repository-read-failed'] : []),
    ...(result.output.omittedCards > 0 ? ['graph-evidence-has-continuation'] : []),
  ];
  return {
    cards,
    citationValidationFence: {
      generation: result.workset.generation,
      kind: 'workset',
      workset: result.workset.name,
    },
    ...(result.continuation === undefined ? {} : {continuation: result.continuation}),
    contracts,
    coverage: {
      complete: result.coverage.complete,
      consideredRepositories: result.coverage.consideredRepositories,
      readyRepositories,
      requestedRepositories: result.coverage.requestedRepositories,
      states: result.coverage.states,
    },
    gaps,
    resolvedSnapshots: result.coverage.requestedRepositories === 1 && snapshots.length === 1 ? snapshots : [],
    trust: TRUST,
    warnings: result.warnings.map(warning => compactText(warning, 240)).slice(0, 16),
  };
}

export function fromRepositoryQuery(result: CodeGraphQueryResult): ContextBriefGraphEvidenceV1 {
  const repositoryKey = compactText(result.repository.displayName, 160);
  const cards = result.nodes.map((node, rank): ContextBriefGraphCardV1 => ({
    id: `cbgc_${sha256HexSync(`${result.repository.repositoryId}\u0000${node.id}`).slice(0, 24)}`,
    rank,
    reason: `Indexed symbol match (${node.score.toFixed(3)}).`,
    ref: node.id,
    repositoryKey,
    symbol: {
      kind: compactText(node.kind, 80),
      language: compactText(node.language, 80),
      line: node.span.line,
      name: compactText(node.name, 160),
      ...(node.packageName === undefined ? {} : {packageName: compactText(node.packageName, 160)}),
      path: node.path,
      qualifiedName: compactText(node.qualifiedName, 240),
    },
  }));
  const contracts = uniqueContracts(
    result.edges.flatMap((edge, rank) => repositoryContract(edge, rank, repositoryKey)),
  );
  const snapshot: ContextBriefSnapshotV1 = {
    commit: result.snapshot.commit,
    dirty: result.snapshot.dirty,
    freshness: result.freshness === 'current' ? 'fresh' : result.freshness === 'stale' ? 'stale' : 'unknown',
    repositoryId: result.repository.repositoryId,
    repositoryKey,
    snapshotId: result.snapshot.id,
  };
  return {
    cards,
    citationValidationFence: {
      kind: 'repository',
      repositoryId: result.repository.repositoryId,
      snapshotId: result.snapshot.id,
    },
    contracts,
    coverage: {
      complete: true,
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {[result.freshness]: 1},
    },
    gaps: [],
    resolvedSnapshots: [snapshot],
    trust: TRUST,
    warnings: result.warnings.map(warning => compactText(warning, 240)).slice(0, 16),
  };
}

export function unavailableContextBriefGraphEvidence(
  gap = 'graph-query-unavailable',
  requestedRepositories = 0,
  states: Readonly<Record<string, number>> = {},
): ContextBriefGraphEvidenceV1 {
  return {
    cards: [],
    contracts: [],
    coverage: {
      complete: false,
      consideredRepositories: 0,
      readyRepositories: 0,
      requestedRepositories,
      states,
    },
    gaps: [gap],
    resolvedSnapshots: [],
    trust: TRUST,
    warnings: [],
  };
}

function repositoryContract(
  edge: CodeGraphEdge,
  rank: number,
  repositoryKey: string,
): readonly ContextBriefGraphContractV1[] {
  if (edge.sourceId === undefined || edge.targetId === undefined) return [];
  return [
    {
      authority: edge.provenance === 'heuristic' || edge.provenance === 'model' ? 'supporting' : 'authoritative',
      evidence: {line: edge.evidenceSpan.line, path: edge.evidencePath, repositoryKey},
      id: contractId([
        edge.sourceId,
        edge.relation,
        edge.targetId,
        repositoryKey,
        edge.evidencePath,
        String(edge.evidenceSpan.line),
      ]),
      provenance: edge.provenance,
      rank,
      relation: edge.relation,
      sourceRef: edge.sourceId,
      targetRef: edge.targetId,
    },
  ];
}

function uniqueContracts(contracts: readonly ContextBriefGraphContractV1[]): readonly ContextBriefGraphContractV1[] {
  const byId = new Map<string, ContextBriefGraphContractV1>();
  for (const contract of contracts) {
    const current = byId.get(contract.id);
    if (current === undefined || contract.rank < current.rank) byId.set(contract.id, contract);
  }
  return [...byId.values()]
    .sort((left, right) => left.rank - right.rank || compareText(left.id, right.id))
    .slice(0, 64)
    .map((contract, rank) => ({...contract, rank}));
}

function contractId(parts: readonly string[]): string {
  return `cbct_${sha256HexSync(parts.join('\u0000')).slice(0, 24)}`;
}

function compactText(value: string, maximumBytes: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (new TextEncoder().encode(normalized).byteLength <= maximumBytes) return normalized;
  let prefix = '';
  for (const character of normalized) {
    if (new TextEncoder().encode(`${prefix}${character}…`).byteLength > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}…`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
