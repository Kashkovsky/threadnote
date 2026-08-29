import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  graphAdministrationJobSelection,
  graphBuildConcurrencyState,
  graphFocusTarget,
  graphWheelZoomFactor,
  graphWithNodeNeighborhood,
  orderGraphBuildStatuses,
  type GraphBuildStatus,
  type GraphNodeDetail,
  type GraphVisualization,
} from '../../src/manager/graph.js';
import {
  managerGraphDetailWorkingSet,
  representativeManagerGraphEdges,
  type ManagerGraphEdge,
} from '../../src/code_graph/visualization.js';
import {managerGraphCatalogRevision} from '../../src/code_graph/manager_catalog_revision.js';
import type {CodeGraphEdge, CodeGraphSymbol} from '../../src/code_graph/types.js';
import {
  MANAGER_GRAPH_MAX_EDGE_LIMIT,
  MANAGER_GRAPH_MAX_NODE_LIMIT,
  managerGraphVisualizationLimits,
} from '../../src/manager/graph_limits.js';

describe('Manager graph properties', () => {
  it('keeps catalog revisions order-independent and sensitive to lifecycle changes', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            checkoutId: fc.uuid(),
            state: fc.constantFrom('ready' as const, 'unavailable' as const),
            views: fc.uniqueArray(
              fc.record({
                activatedAt: fc.integer({min: 0, max: 2_000_000_000}).map(String),
                repositoryId: fc.uuid(),
                snapshotId: fc.uuid(),
                worktreeId: fc.uuid(),
              }),
              {maxLength: 12, selector: view => view.worktreeId},
            ),
            viewsTruncated: fc.boolean(),
          }),
          {maxLength: 12, selector: database => database.checkoutId},
        ),
        databases => {
          const reordered = [...databases]
            .reverse()
            .map(database => ({...database, views: [...database.views].reverse()}));
          expect(managerGraphCatalogRevision(reordered)).toBe(managerGraphCatalogRevision(databases));

          const changed =
            databases.length === 0
              ? [{checkoutId: 'new', state: 'ready' as const, views: [], viewsTruncated: false}]
              : databases.map((database, index) =>
                  index === 0 ? {...database, viewsTruncated: !database.viewsTruncated} : database,
                );
          expect(managerGraphCatalogRevision(changed)).not.toBe(managerGraphCatalogRevision(databases));
        },
      ),
      {numRuns: 120},
    );
  });

  it('keeps actionable administration jobs deterministic, unique, and bounded', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            buildNumber: fc.integer({min: 0, max: 1_000_000}),
            startedAt: fc.integer({min: 0, max: 2_000_000_000}),
            state: fc.constantFrom('completed' as const, 'failed' as const, 'queued' as const, 'running' as const),
          }),
          {maxLength: 80, selector: item => item.buildNumber},
        ),
        records => {
          const statuses = records.map(record =>
            graphBuildStatus(
              `build-${record.buildNumber}`,
              record.buildNumber.toString(16).padStart(12, '0'),
              record.startedAt,
              record.state,
            ),
          );
          const builds = statuses.filter((_, index) => index % 2 === 0);
          const waiters = statuses.filter((_, index) => index % 2 === 1);
          const forward = graphAdministrationJobSelection(builds, waiters);
          const reverse = graphAdministrationJobSelection([...builds].reverse(), [...waiters].reverse());
          const expectedTotal = statuses.filter(status => status.state !== 'completed').length;

          expect(forward).toEqual(reverse);
          expect(forward.jobs.length).toBeLessThanOrEqual(4);
          expect(forward.jobs.length + forward.hiddenCount).toBe(forward.total);
          expect(forward.total).toBe(expectedTotal);
          expect(new Set(forward.jobs.map(job => job.buildId)).size).toBe(forward.jobs.length);
          expect(forward.jobs.every(job => job.state !== 'completed')).toBe(true);
        },
      ),
      {numRuns: 120},
    );
  });

  it('keeps build banner order invariant across polling order and progress updates', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            buildNumber: fc.integer({min: 0, max: 1_000_000}),
            locationNumber: fc.integer({min: 0, max: 100}),
            progressAt: fc.integer({min: 0, max: 2_000_000_000}),
          }),
          {maxLength: 80, selector: item => item.buildNumber},
        ),
        records => {
          const statuses = records.map(record => ({
            ...graphBuildStatus(
              `build-${record.buildNumber}`,
              record.buildNumber.toString(16).padStart(12, '0'),
              record.progressAt,
              'running',
            ),
            identity: {
              checkoutId: `checkout-${record.buildNumber.toString().padStart(7, '0')}`,
              commit: record.buildNumber.toString(16).padStart(12, '0'),
              repositoryId: 'repository',
              worktreeId: `worktree-${record.buildNumber.toString().padStart(7, '0')}`,
            },
            managerContext: {worktreePath: `/worktrees/${record.locationNumber.toString().padStart(3, '0')}`},
          }));
          const expected = orderGraphBuildStatuses(statuses).map(status => status.buildId);
          const polled = [...statuses].reverse().map((status, index) => ({
            ...status,
            timestamps: {
              ...status.timestamps,
              lastProgressAt: new Date(2_000_000_000 - index).toISOString(),
            },
          }));

          expect(orderGraphBuildStatuses(polled).map(status => status.buildId)).toEqual(expected);
          expect(statuses.map(status => status.buildId)).toEqual(records.map(record => `build-${record.buildNumber}`));
        },
      ),
      {numRuns: 120},
    );
  });

  it('selects the latest observed queued target independently of waiter order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 1, max: 1_000_000}), {minLength: 1, maxLength: 80}),
        startedAtValues => {
          const owner = graphBuildStatus('owner', '000000000000', 0, 'running');
          const waiters = startedAtValues.map(startedAt =>
            graphBuildStatus(
              `waiter-${startedAt.toString().padStart(7, '0')}`,
              startedAt.toString(16).padStart(12, '0'),
              startedAt,
              'queued',
            ),
          );
          const unrelated = {
            ...graphBuildStatus('unrelated', 'ffffffffffff', 2_000_000, 'queued'),
            identity: {
              ...owner.identity,
              checkoutId: 'other-checkout',
              worktreeId: 'other-worktree',
            },
          };
          const expected = Math.max(...startedAtValues)
            .toString(16)
            .padStart(12, '0');
          const forward = graphBuildConcurrencyState(owner, [...waiters, unrelated], []);
          const reverse = graphBuildConcurrencyState(owner, [unrelated, ...waiters].reverse(), []);

          expect(forward).toEqual(reverse);
          expect(forward).toEqual({
            activeTargetCommit: '000000000000',
            latestTargetCommit: expected,
            queuedRequests: waiters.length,
            staleReady: false,
          });
        },
      ),
      {numRuns: 160},
    );
  });

  it('always normalizes arbitrary requested budgets into positive hard bounds', () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({noDefaultInfinity: false, noNaN: false}), {nil: undefined}),
        fc.option(fc.double({noDefaultInfinity: false, noNaN: false}), {nil: undefined}),
        (edgeLimit, nodeLimit) => {
          const limits = managerGraphVisualizationLimits({
            ...(edgeLimit === undefined ? {} : {edgeLimit}),
            ...(nodeLimit === undefined ? {} : {nodeLimit}),
          });
          expect(Number.isSafeInteger(limits.edgeLimit)).toBe(true);
          expect(Number.isSafeInteger(limits.nodeLimit)).toBe(true);
          expect(limits.edgeLimit).toBeGreaterThanOrEqual(1);
          expect(limits.edgeLimit).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_EDGE_LIMIT);
          expect(limits.nodeLimit).toBeGreaterThanOrEqual(1);
          expect(limits.nodeLimit).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_NODE_LIMIT);
        },
      ),
      {numRuns: 200},
    );
  });

  it('keeps arbitrary focus and wheel inputs finite and within reviewed zoom bounds', () => {
    fc.assert(
      fc.property(
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.double({noDefaultInfinity: false, noNaN: false}),
        fc.constantFrom('detail' as const, 'overview' as const),
        (x, y, zoom, nodeX, nodeY, mode) => {
          const target = graphFocusTarget({x, y, zoom}, {x: nodeX, y: nodeY}, mode);
          const minimum = mode === 'detail' ? 2.8 : 1.8;
          expect(Number.isFinite(target.x)).toBe(true);
          expect(Number.isFinite(target.y)).toBe(true);
          expect(Number.isFinite(target.zoom)).toBe(true);
          expect(target.zoom).toBeGreaterThanOrEqual(minimum);
          expect(target.zoom).toBeLessThanOrEqual(minimum * 1.35);

          const factor = graphWheelZoomFactor(zoom);
          expect(Number.isFinite(factor)).toBe(true);
          expect(factor).toBeGreaterThanOrEqual(0.72);
          expect(factor).toBeLessThanOrEqual(1.38);
        },
      ),
      {numRuns: 200},
    );
  });

  it('never duplicates lazy expansion IDs and keeps every edge endpoint present', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            direction: fc.constantFrom('incoming' as const, 'outgoing' as const),
            edgeNumber: fc.integer({min: 0, max: 10_000}),
            relatedNumber: fc.integer({min: 0, max: 100}),
          }),
          {maxLength: 220, selector: item => item.edgeNumber},
        ),
        relationships => {
          const detail = graphNodeDetail(
            relationships.map(item => ({
              confidence: 1,
              direction: item.direction,
              evidencePath: 'src/selected.ts',
              evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
              id: `relationship-${item.edgeNumber}`,
              provenance: 'resolved',
              related: {
                id: `related-${item.relatedNumber}`,
                kind: 'function',
                label: `related-${item.relatedNumber}`,
                path: `src/related-${item.relatedNumber}.ts`,
                projectId: 'cgp_project',
                qualifiedName: `related${item.relatedNumber}`,
              },
              relation: 'calls',
            })),
          );
          const expanded = graphWithNodeNeighborhood(baseGraph(), detail);
          const nodeIds = expanded.nodes.map(node => node.id);
          const edgeIds = expanded.edges.map(edge => edge.id);
          const nodeSet = new Set(nodeIds);
          expect(nodeSet.size).toBe(nodeIds.length);
          expect(new Set(edgeIds).size).toBe(edgeIds.length);
          expect(expanded.edges.every(edge => nodeSet.has(edge.sourceId) && nodeSet.has(edge.targetId))).toBe(true);
          expect(expanded.stats.renderedNodes).toBe(expanded.nodes.length);
          expect(expanded.stats.renderedEdges).toBe(expanded.edges.length);
          expect(expanded.nodes.length).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_NODE_LIMIT);
          expect(expanded.edges.length).toBeLessThanOrEqual(MANAGER_GRAPH_MAX_EDGE_LIMIT);
        },
      ),
      {numRuns: 100},
    );
  });

  it('marks node-budget truncation and preserves the selected unscoped facet on every seed', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 80}), fc.integer({min: 1, max: 24}), (neighborCount, nodeLimit) => {
        const seed = codeGraphSymbol('seed', undefined);
        const neighbors = Array.from({length: neighborCount}, (_, index) =>
          codeGraphSymbol(`neighbor-${index}`, 'cgp_external'),
        );
        const edges = neighbors.map((neighbor, index) => codeGraphEdge(`edge-${index}`, seed.id, neighbor.id));
        const loadedNeighbors = neighbors.slice(0, Math.max(0, nodeLimit - 1));
        const result = managerGraphDetailWorkingSet([seed], loadedNeighbors, edges, 'facet:unscoped', {
          edgeLimit: 100,
          nodeLimit,
        });
        expect(result.nodes.find(node => node.id === seed.id)?.projectId).toBe('facet:unscoped');
        expect(result.nodes.filter(node => node.id !== seed.id).every(node => node.projectId === 'cgp_external')).toBe(
          true,
        );
        expect(result.truncated).toBe(neighborCount > loadedNeighbors.length);
        const visible = new Set(result.nodes.map(node => node.id));
        expect(result.edges.every(edge => visible.has(edge.sourceId) && visible.has(edge.targetId))).toBe(true);
      }),
      {numRuns: 120},
    );
  });

  it('gives every connected retained overview node incident evidence when the budget permits', () => {
    fc.assert(
      fc.property(fc.integer({min: 2, max: 120}), nodeCount => {
        const nodeIds = Array.from({length: nodeCount}, (_, index) => `component-${index}`);
        const candidates: ManagerGraphEdge[] = nodeIds.slice(1).map((nodeId, index) => ({
          confidence: 1,
          count: index + 1,
          id: `edge-${index}`,
          provenance: 'resolved',
          relation: 'imports',
          sourceId: nodeIds[index]!,
          targetId: nodeId,
        }));
        const selected = representativeManagerGraphEdges(candidates, nodeIds, nodeIds.length);
        expect(selected.length).toBeLessThanOrEqual(nodeIds.length);
        expect(
          nodeIds.every(nodeId => selected.some(edge => edge.sourceId === nodeId || edge.targetId === nodeId)),
        ).toBe(true);
      }),
      {numRuns: 100},
    );
  });
});

function graphBuildStatus(
  buildId: string,
  commit: string,
  startedAtMilliseconds: number,
  state: 'completed' | 'failed' | 'queued' | 'running',
): GraphBuildStatus {
  const startedAt = new Date(startedAtMilliseconds).toISOString();
  return {
    buildId,
    counters: {},
    identity: {
      checkoutId: 'checkout',
      commit,
      repositoryId: 'repository',
      worktreeId: 'worktree',
    },
    observation: {
      heartbeatAgeMilliseconds: 0,
      liveness: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'active',
    },
    owner: {processId: 42},
    phase: state === 'queued' ? 'waiting' : 'scanning',
    state,
    timestamps: {heartbeatAt: startedAt, lastProgressAt: startedAt, startedAt},
  };
}

function codeGraphSymbol(id: string, resolutionScopeId: string | undefined): CodeGraphSymbol {
  return {
    contentHash: id,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [],
    name: id,
    path: `src/${id}.ts`,
    qualifiedName: id,
    resolutionDomain: 'typescript',
    ...(resolutionScopeId ? {resolutionScopeId} : {}),
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function codeGraphEdge(id: string, sourceId: string, targetId: string): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'src/seed.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation: 'calls',
    sourceId,
    sourceName: sourceId,
    targetId,
    targetName: targetId,
  };
}

function baseGraph(): GraphVisualization {
  return {
    edges: [],
    mode: 'detail',
    nodes: [
      {
        degree: 0,
        id: 'selected',
        kind: 'function',
        label: 'selected',
        path: 'src/selected.ts',
        projectId: 'cgp_project',
        type: 'symbol',
      },
    ],
    paging: {edgeLimit: 640, hasMore: false, nodeLimit: 240},
    projectId: 'cgp_project',
    repository: {
      accounting: {
        attributedSymbols: 1,
        componentSymbols: 1,
        fallbackSymbols: 0,
        omittedSymbols: 0,
        totalSymbols: 1,
      },
      displayName: 'fixture',
      id: 'checkout.worktree',
      metrics: 'complete',
      snapshot: {
        commit: 'abcdef01',
        dirty: false,
        edgeCount: 0,
        fileCount: 1,
        id: 'snapshot',
        symbolCount: 1,
      },
    },
    scope: {id: 'cgp_project', label: 'project'},
    stats: {renderedEdges: 0, renderedNodes: 1, totalEdges: 0, totalNodes: 1},
    warnings: [],
  };
}

function graphNodeDetail(relationships: GraphNodeDetail['relationships']): GraphNodeDetail {
  return {
    node: {
      exported: true,
      id: 'selected',
      kind: 'function',
      label: 'selected',
      language: 'typescript',
      path: 'src/selected.ts',
      projectId: 'cgp_project',
      qualifiedName: 'selected',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    },
    relationships,
    snapshotId: 'snapshot',
    stats: {incoming: 0, outgoing: 0, provenances: [], relations: [], truncated: false},
  };
}
