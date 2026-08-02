import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  graphFocusTarget,
  graphWheelZoomFactor,
  graphWithNodeNeighborhood,
  type GraphNodeDetail,
  type GraphVisualization,
} from '../../src/manager_graph.js';
import {
  MANAGER_GRAPH_MAX_EDGE_LIMIT,
  MANAGER_GRAPH_MAX_NODE_LIMIT,
  managerGraphVisualizationLimits,
} from '../../src/manager_graph_limits.js';

describe('Manager graph properties', () => {
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
        },
      ),
      {numRuns: 100},
    );
  });
});

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
    stats: {incoming: 0, outgoing: 0, provenances: [], relations: [], truncated: false},
  };
}
