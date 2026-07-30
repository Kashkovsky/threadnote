import {describe, expect, it} from 'vitest';
import {
  graphDisplayEdges,
  graphFocusLayoutTargets,
  graphFocusTarget,
  graphNodeSizeValues,
  graphWithNodeNeighborhood,
  type GraphEdge,
} from '../../src/manager_graph.js';

describe('manager graph focus', () => {
  it('centers a searched detail node and zooms into its labels', () => {
    expect(graphFocusTarget({x: 0, y: 0, zoom: 0.6}, {x: 125, y: -48}, 'detail')).toEqual({
      x: 125,
      y: -48,
      zoom: 2.8,
    });
  });

  it('keeps a closer user zoom while centering the selected node', () => {
    expect(graphFocusTarget({x: 20, y: 30, zoom: 4.5}, {x: -90, y: 12}, 'overview')).toEqual({
      x: -90,
      y: 12,
      zoom: 4.5,
    });
  });

  it('isolates incoming and outgoing selection neighborhoods after relation filtering', () => {
    const edges: readonly GraphEdge[] = [
      edge('incoming-call', 'source', 'selected', 'calls'),
      edge('outgoing-call', 'selected', 'target', 'calls'),
      edge('outgoing-import', 'selected', 'module', 'imports'),
      edge('unrelated', 'other', 'another', 'calls'),
    ];

    expect(graphDisplayEdges(edges, 'selected', 'incoming', 'all').map(item => item.id)).toEqual(['incoming-call']);
    expect(graphDisplayEdges(edges, 'selected', 'outgoing', 'calls').map(item => item.id)).toEqual(['outgoing-call']);
    expect(graphDisplayEdges(edges, 'selected', 'neighbors', 'all').map(item => item.id)).toEqual([
      'incoming-call',
      'outgoing-call',
      'outgoing-import',
    ]);
    expect(graphDisplayEdges(edges, undefined, 'neighbors', 'imports').map(item => item.id)).toEqual([
      'outgoing-import',
    ]);
  });

  it('sizes nodes by distinct neighbors instead of duplicate relationship edges', () => {
    const edges: readonly GraphEdge[] = [
      edge('a-b-call', 'a', 'b', 'calls'),
      edge('a-b-import', 'a', 'b', 'imports'),
      edge('c-a-call', 'c', 'a', 'calls'),
      edge('a-d-call', 'a', 'd', 'calls'),
    ];

    expect(Object.fromEntries(graphNodeSizeValues(edges, 'connections'))).toEqual({
      a: 3,
      b: 1,
      c: 1,
      d: 1,
    });
    expect(Object.fromEntries(graphNodeSizeValues(edges, 'incoming'))).toEqual({
      a: 1,
      b: 1,
      d: 1,
    });
    expect(Object.fromEntries(graphNodeSizeValues(edges, 'outgoing'))).toEqual({
      a: 2,
      c: 1,
    });
  });

  it('keeps the selected node anchored while separating highlighted node labels', () => {
    const nodes = [
      {id: 'selected', label: 'RuntimeConfig', radius: 12, x: 0, y: 0},
      ...Array.from({length: 12}, (_, index) => ({
        id: `neighbor-${index}`,
        label: `src/feature/long-neighbor-${index}.ts`,
        radius: 7,
        x: 2,
        y: 2,
      })),
    ];
    const edges = nodes
      .slice(1)
      .flatMap((node, index) => [
        edge(`edge-${index}`, 'selected', node.id, 'calls'),
        edge(`duplicate-${index}`, 'selected', node.id, 'imports'),
      ]);
    const labelSizes = new Map(nodes.map(node => [node.id, {height: node.id === 'selected' ? 24 : 15, width: 170}]));

    const targets = graphFocusLayoutTargets(nodes, 'selected', edges, labelSizes, 2.8);

    expect(targets.get('selected')).toEqual({x: 0, y: 0});
    expect(targets.size).toBe(nodes.length);
    const targetLabels = nodes.map(node => {
      const position = targets.get(node.id)!;
      const size = labelSizes.get(node.id)!;
      return {
        bottom: position.y + size.height / 2 / 2.8,
        id: node.id,
        left: position.x + (node.radius + 4) / 2.8,
        right: position.x + (node.radius + 4 + size.width) / 2.8,
        top: position.y - size.height / 2 / 2.8,
      };
    });
    for (const [index, left] of targetLabels.entries()) {
      for (const right of targetLabels.slice(index + 1)) {
        const overlaps =
          Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
          Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
        expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false);
      }
    }
  });

  it('does not move nodes when there is no selected focus', () => {
    expect(
      graphFocusLayoutTargets(
        [
          {id: 'a', label: 'a', radius: 6, x: 0, y: 0},
          {id: 'b', label: 'b', radius: 6, x: 1, y: 1},
        ],
        undefined,
        [edge('a-b', 'a', 'b', 'calls')],
      ).size,
    ).toBe(0);
  });

  it('pulls distant highlighted neighbors into a compact local orbit', () => {
    const nodes = [
      {id: 'selected', label: 'selected', radius: 10, x: 0, y: 0},
      ...Array.from({length: 12}, (_, index) => ({
        id: `neighbor-${index}`,
        label: `neighbor-${index}`,
        radius: 6,
        x: 1_000 + index * 100,
        y: -1_000 - index * 100,
      })),
    ];
    const targets = graphFocusLayoutTargets(
      nodes,
      'selected',
      nodes.slice(1).map((node, index) => edge(`edge-${index}`, 'selected', node.id, 'calls')),
    );

    expect(
      Math.max(
        ...nodes
          .slice(1)
          .map(node => targets.get(node.id)!)
          .map(position => Math.hypot(position.x, position.y)),
      ),
    ).toBeLessThan(100);
  });

  it('pushes a visible unhighlighted label away from the anchored selection', () => {
    const nodes = [
      {id: 'selected', label: 'RuntimeConfig', radius: 12, x: 0, y: 0},
      {id: 'neighbor', label: 'src/runtime.ts', radius: 7, x: 100, y: 100},
      {id: 'obstacle', label: 'src/threadnote.ts', radius: 7, x: 0, y: 0},
    ];
    const labelSizes = new Map([
      ['selected', {height: 24, width: 104}],
      ['neighbor', {height: 15, width: 90}],
      ['obstacle', {height: 15, width: 96}],
    ]);

    const targets = graphFocusLayoutTargets(
      nodes,
      'selected',
      [edge('selected-neighbor', 'selected', 'neighbor', 'calls')],
      labelSizes,
      2.8,
    );

    expect(targets.get('selected')).toEqual({x: 0, y: 0});
    expect(targets.get('obstacle')).not.toEqual({x: 0, y: 0});
  });

  it('adds a replaceable direct neighborhood from lazy node details', () => {
    const graph = {
      edges: [edge('selected-existing', 'selected', 'existing', 'calls')],
      mode: 'detail' as const,
      nodes: [
        graphNode('selected', 'withExclusiveFileLock'),
        graphNode('existing', 'CodeGraphQueryService'),
        graphNode('unrelated', 'unrelated'),
      ],
      projectId: 'package:threadnote',
      repository: {
        displayName: 'threadnote',
        id: 'repository',
        projects: [],
        repositoryId: 'repository-id',
        snapshot: {
          commit: 'commit',
          dirty: true,
          edgeCount: 10_000,
          fileCount: 100,
          id: 'snapshot',
          symbolCount: 12_000,
        },
      },
      stats: {
        renderedEdges: 1,
        renderedNodes: 3,
        totalEdges: 10_000,
        totalNodes: 12_000,
      },
      warnings: ['bounded working set'],
    };
    const detail = nodeDetail('selected', 'withExclusiveFileLock', [
      relationship('selected-existing', 'outgoing', 'existing', 'CodeGraphQueryService'),
      relationship('incoming-missing', 'incoming', 'missing-in', 'appendProductionLogs'),
      relationship('outgoing-missing', 'outgoing', 'missing-out', 'ensureCommit'),
    ]);

    const expanded = graphWithNodeNeighborhood(graph, detail);

    expect(expanded.nodes.map(node => node.id)).toEqual([
      'selected',
      'existing',
      'unrelated',
      'missing-in',
      'missing-out',
    ]);
    expect(expanded.edges.map(item => [item.id, item.sourceId, item.targetId])).toEqual([
      ['selected-existing', 'selected', 'existing'],
      ['incoming-missing', 'missing-in', 'selected'],
      ['outgoing-missing', 'selected', 'missing-out'],
    ]);
    expect(expanded.nodes.find(node => node.id === 'selected')?.degree).toBe(3);
    expect(expanded.stats).toMatchObject({renderedEdges: 3, renderedNodes: 5});
    expect(expanded.warnings.at(-1)).toBe('Loaded 2 direct neighbors for withExclusiveFileLock.');
    expect(graph.nodes).toHaveLength(3);
  });
});

function edge(id: string, sourceId: string, targetId: string, relation: string): GraphEdge {
  return {
    confidence: 1,
    count: 1,
    id,
    provenance: 'resolved',
    relation,
    sourceId,
    targetId,
  };
}

function graphNode(id: string, label: string) {
  return {
    degree: 1,
    id,
    kind: 'function',
    label,
    path: `src/${label}.ts`,
    projectId: 'package:threadnote',
    type: 'symbol' as const,
  };
}

function nodeDetail(id: string, label: string, relationships: ReturnType<typeof relationship>[]) {
  return {
    node: {
      exported: true,
      id,
      kind: 'function',
      label,
      language: 'typescript',
      path: `src/${label}.ts`,
      projectId: 'package:threadnote',
      qualifiedName: label,
      span: {column: 1, endColumn: 10, endLine: 1, line: 1},
    },
    relationships,
    stats: {
      incoming: relationships.filter(item => item.direction === 'incoming').length,
      outgoing: relationships.filter(item => item.direction === 'outgoing').length,
      provenances: [{count: relationships.length, provenance: 'resolved'}],
      relations: [
        {
          count: relationships.length,
          incoming: relationships.filter(item => item.direction === 'incoming').length,
          outgoing: relationships.filter(item => item.direction === 'outgoing').length,
          relation: 'calls',
        },
      ],
      truncated: false,
    },
  };
}

function relationship(id: string, direction: 'incoming' | 'outgoing', relatedId: string, label: string) {
  return {
    confidence: 1,
    direction,
    evidencePath: `src/${label}.ts`,
    evidenceSpan: {column: 1, endColumn: 10, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    related: {
      id: relatedId,
      kind: 'function',
      label,
      path: `src/${label}.ts`,
      projectId: 'package:threadnote',
      qualifiedName: label,
    },
    relation: 'calls',
  } as const;
}
