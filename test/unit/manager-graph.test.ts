import {describe, expect, it} from 'vitest';
import {
  cacheGraphNodeDetail,
  graphAnalysisRequestIsCurrent,
  graphAnalysisCoverageLabel,
  graphAnalysisTopologyAvailable,
  graphDisplayEdges,
  graphFocusLayoutTargets,
  graphFocusTarget,
  graphNodeDetailRequestIsCurrent,
  graphNodeSizeValues,
  graphRequestIsCurrent,
  graphRepositoryOptionLabel,
  graphStatusPollDelay,
  graphStatusRequiresCatalogRefresh,
  graphWaiterCountForBuild,
  graphWheelZoomFactor,
  graphWithNodeNeighborhood,
  resolveGraphSelection,
  type GraphEdge,
  type GraphAnalysis,
  type GraphRepositoryGroup,
} from '../../src/manager_graph.js';

describe('manager graph focus', () => {
  it('polls active graph builds within the two-second Manager freshness contract', () => {
    expect(graphStatusPollDelay([])).toBe(15_000);
    expect(graphStatusPollDelay([graphBuildStatus('running')])).toBe(1_000);
    expect(graphStatusPollDelay([graphBuildStatus('queued')])).toBe(1_000);
    expect(graphStatusPollDelay([graphBuildStatus('completed')])).toBe(15_000);
  });

  it('refreshes a terminal snapshot missing from the catalog and scopes waiters to their build', () => {
    const catalog = {
      builds: [],
      diagnostics: [],
      repositories: [repositoryGroup('repository', ['known-snapshot'], 'known-snapshot')],
      waiterCount: 0,
      waiters: [],
    };
    expect(
      graphStatusRequiresCatalogRefresh(catalog, [
        {...graphBuildStatus('completed'), result: {snapshotId: 'new-snapshot'}},
      ]),
    ).toBe(true);
    expect(
      graphStatusRequiresCatalogRefresh(catalog, [
        {...graphBuildStatus('completed'), result: {snapshotId: 'snapshot-known-snapshot'}},
      ]),
    ).toBe(false);

    const owner = {...graphBuildStatus('running'), request: {key: 'request-a'}};
    const matching = {...graphBuildStatus('queued'), buildId: 'waiter-a', request: {key: 'request-a'}};
    const otherCheckout = {
      ...graphBuildStatus('queued'),
      buildId: 'waiter-b',
      identity: {...graphBuildStatus('queued').identity, checkoutId: 'other-checkout'},
      request: {key: 'request-a'},
    };
    const otherRequest = {...graphBuildStatus('queued'), buildId: 'waiter-c', request: {key: 'request-b'}};
    expect(graphWaiterCountForBuild(owner, [matching, otherCheckout, otherRequest])).toBe(1);
    expect(graphWaiterCountForBuild(graphBuildStatus('running'), [matching])).toBe(0);
  });

  it('keeps a selected indexed view across refresh and falls back deterministically after removal', () => {
    const groups: readonly GraphRepositoryGroup[] = [repositoryGroup('repo-a', ['view-new', 'view-old'], 'view-new')];
    expect(resolveGraphSelection(groups, 'repo-a', 'view-old')).toEqual({
      repositoryId: 'repo-a',
      viewId: 'view-old',
    });
    expect(resolveGraphSelection([repositoryGroup('repo-a', ['view-new'], 'view-new')], 'repo-a', 'view-old')).toEqual({
      repositoryId: 'repo-a',
      viewId: 'view-new',
    });
    expect(resolveGraphSelection([repositoryGroup('repo-b', ['view-b'], 'view-b')], 'repo-a', 'view-old')).toEqual({
      repositoryId: 'repo-b',
      viewId: 'view-b',
    });
  });

  it('disambiguates distinct logical repositories that share a display name', () => {
    const first = {...repositoryGroup('11111111-logical', ['view-a'], 'view-a'), displayName: 'mobile-native'};
    const second = {...repositoryGroup('22222222-logical', ['view-b'], 'view-b'), displayName: 'mobile-native'};
    expect(graphRepositoryOptionLabel(first, [first, second])).toBe('mobile-native · 11111111');
    expect(graphRepositoryOptionLabel(second, [first, second])).toBe('mobile-native · 22222222');
  });

  it('rejects an analysis response after its repository, snapshot, or request generation changes', () => {
    expect(graphAnalysisRequestIsCurrent(4, 4, 'repo-a:snapshot-1', 'repo-a:snapshot-1')).toBe(true);
    expect(graphAnalysisRequestIsCurrent(5, 4, 'repo-a:snapshot-1', 'repo-a:snapshot-1')).toBe(false);
    expect(graphAnalysisRequestIsCurrent(4, 4, 'repo-b:snapshot-1', 'repo-a:snapshot-1')).toBe(false);
    expect(graphAnalysisRequestIsCurrent(4, 4, 'repo-a:snapshot-2', 'repo-a:snapshot-1')).toBe(false);
  });

  it('rejects stale graph responses after a scope or request generation change', () => {
    expect(graphRequestIsCurrent(7, 7, 'repo:snapshot:component:240', 'repo:snapshot:component:240')).toBe(true);
    expect(graphRequestIsCurrent(8, 7, 'repo:snapshot:component:240', 'repo:snapshot:component:240')).toBe(false);
    expect(graphRequestIsCurrent(7, 7, 'repo:snapshot:other:240', 'repo:snapshot:component:240')).toBe(false);
  });

  it('rejects a late node detail after rapid selection, cancellation, or snapshot promotion', () => {
    const selected = nodeDetail('selected', 'selected', []);
    expect(graphNodeDetailRequestIsCurrent(false, selected, 'snapshot', 'selected')).toBe(true);
    expect(graphNodeDetailRequestIsCurrent(true, selected, 'snapshot', 'selected')).toBe(false);
    expect(graphNodeDetailRequestIsCurrent(false, selected, 'snapshot', 'next-selection')).toBe(false);
    expect(
      graphNodeDetailRequestIsCurrent(false, {...selected, snapshotId: 'previous-snapshot'}, 'snapshot', 'selected'),
    ).toBe(false);
  });

  it('does not present unavailable topology as zero communities, components, or hubs', () => {
    const unavailable = graphAnalysis('unavailable', false);
    expect(graphAnalysisTopologyAvailable(unavailable)).toBe(false);
    expect(graphAnalysisCoverageLabel(unavailable)).toBe('Topology unavailable');
    const partial = graphAnalysis('partial', false);
    expect(graphAnalysisTopologyAvailable(partial)).toBe(true);
    expect(graphAnalysisCoverageLabel(partial)).toBe('Topology partial');
    expect(graphAnalysisCoverageLabel(graphAnalysis('complete', true))).toBe('Complete');
  });

  it('centers a searched detail node and zooms into its labels', () => {
    expect(graphFocusTarget({x: 0, y: 0, zoom: 0.6}, {x: 125, y: -48}, 'detail')).toEqual({
      x: 125,
      y: -48,
      zoom: 2.8,
    });
  });

  it('caps an excessive user zoom while centering the selected node', () => {
    expect(graphFocusTarget({x: 20, y: 30, zoom: 4.5}, {x: -90, y: 12}, 'overview')).toEqual({
      x: -90,
      y: 12,
      zoom: 2.43,
    });
  });

  it('bounds a single wheel event before applying the global camera clamp', () => {
    expect(graphWheelZoomFactor(-1_000_000)).toBe(1.38);
    expect(graphWheelZoomFactor(1_000_000)).toBe(0.72);
    expect(graphWheelZoomFactor(0)).toBe(1);
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
      paging: {edgeLimit: 640, hasMore: false, nodeLimit: 240},
      projectId: 'package:threadnote',
      repository: {
        accounting: {
          attributedSymbols: 12_000,
          componentSymbols: 12_000,
          fallbackSymbols: 0,
          omittedSymbols: 0,
          totalSymbols: 12_000,
        },
        checkoutId: 'repository',
        displayName: 'threadnote',
        id: 'repository',
        label: 'repository',
        metrics: 'complete' as const,
        model: 'workspace' as const,
        projects: [],
        snapshot: {
          commit: 'commit',
          dirty: true,
          edgeCount: 10_000,
          fileCount: 100,
          id: 'snapshot',
          symbolCount: 12_000,
        },
        worktreeId: 'worktree',
        workspaces: [],
      },
      scope: {id: 'package:threadnote', label: 'threadnote'},
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

  it('bounds the node-detail cache and evicts the least recently refreshed entry', () => {
    const cache = new Map<string, ReturnType<typeof nodeDetail>>();
    for (let index = 0; index < 130; index += 1) {
      cacheGraphNodeDetail(cache, `node-${index}`, nodeDetail(`node-${index}`, `node-${index}`, []), 128);
    }
    expect(cache.size).toBe(128);
    expect(cache.has('node-0')).toBe(false);
    expect(cache.has('node-1')).toBe(false);
    cacheGraphNodeDetail(cache, 'node-2', cache.get('node-2')!, 128);
    cacheGraphNodeDetail(cache, 'node-130', nodeDetail('node-130', 'node-130', []), 128);
    expect(cache.has('node-2')).toBe(true);
    expect(cache.has('node-3')).toBe(false);
  });
});

function graphAnalysis(state: GraphAnalysis['coverage']['topology']['state'], complete: boolean): GraphAnalysis {
  return {
    communities: [],
    coverage: {complete, topology: {complete: state === 'complete', state}},
    hubs: [],
    statistics: {
      analyzedEdgeCount: 0,
      analyzedNodeCount: 0,
      communityCount: 0,
      connectedComponentCount: 0,
      maximumDegree: 0,
    },
    surprisingLinks: [],
    warnings: [],
  };
}

function repositoryGroup(id: string, viewIds: readonly string[], defaultViewId: string): GraphRepositoryGroup {
  return {
    defaultViewId,
    displayName: id,
    id,
    repositoryId: id,
    views: viewIds.map(viewId => ({
      accounting: {
        attributedSymbols: 0,
        componentSymbols: 0,
        fallbackSymbols: 0,
        omittedSymbols: 0,
        totalSymbols: 0,
      },
      checkoutId: viewId,
      displayName: id,
      id: viewId,
      label: viewId,
      metrics: 'complete',
      model: 'workspace',
      projectCount: 0,
      projects: [],
      projectsTruncated: false,
      snapshot: {
        commit: 'abcdef01',
        dirty: false,
        edgeCount: 0,
        fileCount: 0,
        id: `snapshot-${viewId}`,
        symbolCount: 0,
      },
      worktreeId: viewId,
      workspaceCount: 0,
      workspaces: [],
      workspacesTruncated: false,
    })),
  };
}

function graphBuildStatus(state: 'completed' | 'failed' | 'queued' | 'running') {
  const timestamp = '2026-07-31T12:00:00.000Z';
  return {
    buildId: `build-${state}`,
    counters: {},
    identity: {
      checkoutId: 'checkout',
      commit: 'abcdef01',
      repositoryId: 'repository',
      worktreeId: 'worktree',
    },
    observation: {
      heartbeatAgeMilliseconds: 0,
      liveness: state === 'completed' ? ('completed' as const) : ('active' as const),
    },
    owner: {processId: 42},
    phase: state === 'queued' ? 'waiting' : 'scanning',
    state,
    timestamps: {heartbeatAt: timestamp, lastProgressAt: timestamp, startedAt: timestamp},
  };
}

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
    snapshotId: 'snapshot',
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
