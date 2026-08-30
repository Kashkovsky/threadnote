import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult} from '../code_graph/types.js';
import type {ContextBriefPlanV1} from './types.js';

export interface ContextBriefAnchoredRepositoryGraphRequestV1 {
  readonly depth: 0 | 1;
  readonly direction: 'both' | 'incoming';
  readonly edgeLimit: number;
  readonly nodeId?: string;
  readonly nodeLimit: number;
  readonly phase: 'evidence' | 'path-resolution';
  readonly operation: 'impact' | 'neighbors';
  readonly query?: string;
  readonly seedQueries?: readonly string[];
  readonly seedQueryCount?: 1;
}

interface RankedNode {
  readonly node: CodeGraphQueryNode;
  readonly nodeRank: number;
  readonly priority: number;
  readonly requestRank: number;
}

interface RankedEdge {
  readonly edge: CodeGraphEdge;
  readonly edgeRank: number;
  readonly priority: number;
  readonly requestRank: number;
}

/**
 * Turn exact Context Brief anchors into one-hop graph reads. Task text is intentionally absent:
 * trace walks both directions, while impact walks incoming dependents. This prevents a semantic
 * task match in repository metadata from displacing the source neighborhood the caller selected.
 */
export function contextBriefAnchoredRepositoryGraphRequests(
  plan: ContextBriefPlanV1['graph'],
): readonly ContextBriefAnchoredRepositoryGraphRequestV1[] {
  if (plan.codeRefs.length === 0 || (plan.mode !== 'trace' && plan.mode !== 'impact')) return [];
  return plan.codeRefs.map(ref => {
    const stableId = ref.startsWith('cgs_');
    return plan.mode === 'impact'
      ? {
          depth: 1,
          direction: 'incoming',
          edgeLimit: plan.edgeLimit,
          nodeLimit: plan.nodeLimit,
          operation: 'impact',
          phase: 'evidence',
          query: ref,
          ...(stableId ? {} : {seedQueries: [ref], seedQueryCount: 1 as const}),
        }
      : stableId
        ? {
            depth: 1,
            direction: 'both',
            edgeLimit: plan.edgeLimit,
            nodeId: ref,
            nodeLimit: plan.nodeLimit,
            operation: 'neighbors',
            phase: 'evidence',
          }
        : {
            depth: 0,
            direction: 'incoming',
            edgeLimit: 1,
            nodeLimit: plan.nodeLimit,
            operation: 'impact',
            phase: 'path-resolution',
            query: ref,
            seedQueries: [ref],
            seedQueryCount: 1,
          };
  });
}

/** Convert an exact path-resolution seed into the semantic-free both-direction trace. */
export function contextBriefResolvedPathTraceRequest(
  plan: ContextBriefPlanV1['graph'],
  nodeId: string,
): ContextBriefAnchoredRepositoryGraphRequestV1 {
  return {
    depth: 1,
    direction: 'both',
    edgeLimit: plan.edgeLimit,
    nodeId,
    nodeLimit: plan.nodeLimit,
    operation: 'neighbors',
    phase: 'evidence',
  };
}

/** Prefer the file module as the stable one-hop seed, with a symbol fallback for module-less extractors. */
export function contextBriefResolvedPathTraceSeed(
  result: CodeGraphQueryResult,
  path: string,
): CodeGraphQueryNode | undefined {
  return result.nodes
    .filter(node => node.path === path)
    .sort(
      (left, right) =>
        Number(right.kind === 'module') - Number(left.kind === 'module') ||
        right.score - left.score ||
        compareText(left.id, right.id),
    )[0];
}

/**
 * Merge request-ordered one-hop reads without mixing graph generations. Exact anchors and source
 * modules are protected ahead of metadata properties; direct import/re-export/test contracts are
 * protected ahead of generic containment. Completion timing cannot affect the result order.
 */
export function mergeContextBriefAnchoredRepositoryGraphResults(
  plan: ContextBriefPlanV1['graph'],
  results: readonly CodeGraphQueryResult[],
  warningCount = 0,
): CodeGraphQueryResult {
  const first = results[0];
  if (first === undefined) throw new Error('No anchored Context Brief graph read completed.');
  const nodes = rankAnchoredNodes(plan, results);
  const edges = rankAnchoredEdges(results);
  const warnings = stableUnique([
    ...results.flatMap(result => result.warnings),
    ...(warningCount === 0
      ? []
      : [`${warningCount} anchored graph traversal(s) were unavailable; results are partial.`]),
  ]);
  const freshness = results.some(result => result.freshness === 'stale')
    ? 'stale'
    : results.every(result => result.freshness === 'current')
      ? 'current'
      : 'deferred';
  return {
    edges: edges.slice(0, plan.edgeLimit),
    freshness,
    nodes: nodes.slice(0, plan.nodeLimit),
    operation: plan.mode === 'impact' ? 'impact' : 'query',
    repository: first.repository,
    snapshot: first.snapshot,
    trust: first.trust,
    version: first.version,
    warnings,
  };
}

/** Fail closed when a path trace fell through to an unrelated semantic match. */
export function contextBriefAnchoredRepositoryGraphResultMatches(
  request: ContextBriefAnchoredRepositoryGraphRequestV1,
  result: CodeGraphQueryResult,
): boolean {
  if (result.operation !== request.operation) return false;
  if (request.operation === 'neighbors') return result.nodes.some(node => node.id === request.nodeId);
  const exactStableId = request.query !== undefined && /^cgs_[a-f0-9]{32}$/u.test(request.query);
  const exactPathSeed =
    request.query !== undefined &&
    request.seedQueryCount === 1 &&
    request.seedQueries?.length === 1 &&
    request.seedQueries[0] === request.query;
  if (!exactStableId && !exactPathSeed) return false;
  if (request.phase === 'path-resolution') return result.nodes.some(node => node.path === request.query);
  return result.nodes.length > 0;
}

function rankAnchoredNodes(
  plan: ContextBriefPlanV1['graph'],
  results: readonly CodeGraphQueryResult[],
): readonly CodeGraphQueryNode[] {
  const anchorIds = new Set(plan.codeRefs.filter(ref => ref.startsWith('cgs_')));
  const anchorPaths = new Set(plan.codeRefs.filter(ref => !ref.startsWith('cgs_')));
  const relationshipPriorities = strongestRelationshipPriorityByNodeId(results);
  const byId = new Map<string, RankedNode>();
  for (const [requestRank, result] of results.entries()) {
    for (const [nodeRank, node] of result.nodes.entries()) {
      const ranked = {
        node,
        nodeRank,
        priority: anchoredNodePriority(plan.mode, node, anchorIds, anchorPaths, relationshipPriorities.get(node.id)),
        requestRank,
      } satisfies RankedNode;
      const current = byId.get(node.id);
      if (current === undefined || compareRankedNode(ranked, current) < 0) byId.set(node.id, ranked);
    }
  }
  return [...byId.values()].sort(compareRankedNode).map(item => item.node);
}

function anchoredNodePriority(
  mode: ContextBriefPlanV1['mode'],
  node: CodeGraphQueryNode,
  anchorIds: ReadonlySet<string>,
  anchorPaths: ReadonlySet<string>,
  relationshipPriority: number | undefined,
): number {
  const exact = anchorIds.has(node.id) || anchorPaths.has(node.path);
  const module = node.kind === 'module';
  const directSourceRelationship = relationshipPriority === 0;
  const supportingRelationship = relationshipPriority !== undefined && relationshipPriority < 3;
  if (mode === 'trace') {
    if (exact && (module || anchorIds.has(node.id))) return 0;
    if (directSourceRelationship) return 1;
    if (exact) return 2;
    if (module) return 3;
    if (supportingRelationship) return 4;
    return 5;
  }
  if ((directSourceRelationship || module) && !exact) return 0;
  if (directSourceRelationship || (exact && module)) return 1;
  if (exact) return 2;
  if (supportingRelationship) return 3;
  return 4;
}

/**
 * Cards and contracts share one relevance signal. A non-module source consumer reached through an
 * import, re-export, export, or test edge must not tie with an arbitrary metadata property merely
 * because both happened to be hydrated as ordinary nodes. Structural metadata remains available
 * after the direct source neighborhood instead of being filtered out.
 */
function strongestRelationshipPriorityByNodeId(results: readonly CodeGraphQueryResult[]): ReadonlyMap<string, number> {
  const priorities = new Map<string, number>();
  for (const edge of results.flatMap(result => result.edges)) {
    const priority = anchoredEdgePriority(edge);
    for (const nodeId of [edge.sourceId, edge.targetId]) {
      if (nodeId === undefined) continue;
      const current = priorities.get(nodeId);
      if (current === undefined || priority < current) priorities.set(nodeId, priority);
    }
  }
  return priorities;
}

function rankAnchoredEdges(results: readonly CodeGraphQueryResult[]): readonly CodeGraphEdge[] {
  const byId = new Map<string, RankedEdge>();
  for (const [requestRank, result] of results.entries()) {
    for (const [edgeRank, edge] of result.edges.entries()) {
      const ranked = {edge, edgeRank, priority: anchoredEdgePriority(edge), requestRank} satisfies RankedEdge;
      const current = byId.get(edge.id);
      if (current === undefined || compareRankedEdge(ranked, current) < 0) byId.set(edge.id, ranked);
    }
  }
  return [...byId.values()].sort(compareRankedEdge).map(item => item.edge);
}

function anchoredEdgePriority(edge: CodeGraphEdge): number {
  switch (edge.relation) {
    case 'exports':
    case 'imports':
    case 'reexports':
    case 'tests':
      return 0;
    case 'depends_on':
    case 'references':
      return 1;
    case 'calls':
    case 'configures':
    case 'constructs':
    case 'extends':
    case 'implements':
    case 'overrides':
    case 'reads_or_writes':
      return 2;
    case 'contains':
    case 'declares':
    case 'documents':
    case 'semantic_association':
      return 3;
  }
}

function compareRankedNode(left: RankedNode, right: RankedNode): number {
  return (
    left.priority - right.priority ||
    left.nodeRank - right.nodeRank ||
    left.requestRank - right.requestRank ||
    compareText(left.node.id, right.node.id)
  );
}

function compareRankedEdge(left: RankedEdge, right: RankedEdge): number {
  return (
    left.priority - right.priority ||
    left.edgeRank - right.edgeRank ||
    left.requestRank - right.requestRank ||
    compareText(left.edge.id, right.edge.id)
  );
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
