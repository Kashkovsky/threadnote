import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {
  cacheGraphNodeDetail,
  createGraphQueryRequestGate,
  graphAnalysisRequestIsCurrent,
  graphAnalysisCoverageLabel,
  graphAnalysisTopologyAvailable,
  graphAdministrationTarget,
  graphBuildIsActive,
  graphBuildShouldDisplay,
  graphBuildTarget,
  graphCatalogSearchOptions,
  graphCatalogPageOffsets,
  graphCatalogContinuationHasMore,
  graphCompletedBuildResultIdentity,
  graphDisplayEdges,
  graphFocusLayoutTargets,
  graphFocusTarget,
  graphMaintenanceStatusLabel,
  graphNodeDetailRequestIsCurrent,
  graphNodeSizeValues,
  graphOverviewSizeLabel,
  graphQueryRequestIsCurrent,
  graphRelationshipCountLabel,
  graphRelationshipSampleLabel,
  graphRequestIsCurrent,
  graphRepositoryOptionLabel,
  graphStatusPollDelay,
  graphStatusRequiresCatalogRefresh,
  graphViewRemovalTarget,
  graphWaiterCountForBuild,
  graphWheelZoomFactor,
  graphWithNodeNeighborhood,
  GraphWorkspace,
  managerGraphDebouncedQueryCandidate,
  managerGraphQueryCandidate,
  mergeGraphRepositoryGroups,
  resolveGraphSelection,
  type GraphEdge,
  type GraphAnalysis,
  type GraphRepositoryGroup,
  type GraphQueryVisualization,
} from '../../src/manager_graph.js';

describe('manager graph focus', () => {
  it('carries the complete selected graph identity into administration actions', () => {
    expect(
      graphAdministrationTarget('checkout', {
        repository: {repositoryId: 'repository'},
        worktreeId: 'worktree',
      }),
    ).toEqual({checkoutId: 'checkout', repositoryId: 'repository', worktreeId: 'worktree'});
    expect(
      graphViewRemovalTarget('a'.repeat(64), {
        snapshot: {id: `cgsn_${'c'.repeat(40)}-direct`},
        worktreeId: 'b'.repeat(64),
      }),
    ).toEqual({
      checkoutId: 'a'.repeat(64),
      expectedSnapshotId: `cgsn_${'c'.repeat(40)}-direct`,
      worktreeId: 'b'.repeat(64),
    });
  });

  it('renders per-view preview and confirmed removal controls without requiring a local folder', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const checkoutId = 'a'.repeat(64);
    const worktreeId = 'b'.repeat(64);
    const snapshotId = `cgsn_${'c'.repeat(40)}-direct`;
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        administration: {
          databases: [
            {
              builds: [],
              checkoutId,
              health: {integrity: 'ok', readySnapshots: 1},
              healthState: 'checked',
              issues: [],
              storage: {state: 'available', totalBytes: 0},
              views: [
                {
                  localAssociation: {available: false, state: 'legacy-unknown'},
                  managementAvailable: false,
                  metrics: 'complete',
                  model: 'workspace',
                  projectCount: 0,
                  projectsTruncated: false,
                  repository: {displayName: 'acme/platform', repositoryId: 'd'.repeat(64)},
                  snapshot: {edgeCount: 0, fileCount: 0, id: snapshotId, symbolCount: 0},
                  viewWorktreeId: worktreeId,
                  workspaceCount: 0,
                  workspacesTruncated: false,
                },
              ],
              waiters: [],
            },
          ],
          generatedAt: '2026-08-08T12:00:00.000Z',
          mode: {analyze: false, deep: false},
          obsoleteStores: {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0},
          summary: {databaseCount: 1, readySnapshotCount: 1},
          type: 'code-graph-diagnostics',
          version: 2,
        } as never,
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onAdministrationAction: () => undefined,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Preview remove');
    expect(markup).toContain('Remove view');
    expect(markup).toContain('Index, reindex, and compact require a verified local worktree path.');
  });

  it('renders the graph workspace before its first catalog response', () => {
    const neverResolves = () => new Promise<never>(() => undefined);

    expect(() =>
      renderToStaticMarkup(
        createElement(GraphWorkspace, {
          loadAnalysis: neverResolves,
          loadCatalogPage: neverResolves,
          loadGraph: neverResolves,
          loadNodeDetail: neverResolves,
          loadQuery: neverResolves,
          loadViewsPage: neverResolves,
          onRefresh: () => undefined,
        }),
      ),
    ).not.toThrow();
  });

  it('renders selected snapshot purge progress alongside graph build progress', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {
          builds: [],
          diagnostics: [],
          maintenance: {
            checkoutId: 'a'.repeat(64),
            completed: 3,
            operation: 'selected-snapshot-purge',
            phase: 'verifying-graph',
            snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
            startedAt: '2026-08-09T12:00:00.000Z',
            total: 5,
            updatedAt: '2026-08-09T12:00:01.000Z',
          },
          repositories: [],
          waiterCount: 0,
          waiters: [],
        },
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Selected snapshot purge');
    expect(markup).toContain('rechecking graph safety evidence');
    expect(markup).toContain('3 / 5 safety phases');
    expect(markup).toContain('aria-label="60% complete"');
  });

  it('renders a retry state when the initial catalog request fails', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalogError: 'Graph catalog is temporarily busy.',
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('Indexed repositories unavailable');
    expect(markup).toContain('Graph catalog is temporarily busy.');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain('Loading indexed repositories');
  });

  it('renders stale live owners with a home-abbreviated repository path and status facts', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const baseRepository = repositoryGroup('repository', ['view-a'], 'view-a');
    const repository = {
      ...baseRepository,
      displayName: 'example/repository',
      views: baseRepository.views.map(view => ({
        ...view,
        localAssociation: {
          available: true,
          displayPath: '~/jobs/repository-task-17',
          path: '/tmp/jobs/repository-task-17',
          state: 'verified' as const,
        },
      })),
    };
    const build = {
      ...graphBuildStatus('running'),
      coordination: {lockVerified: true, progressSilent: true, role: 'owner' as const},
      managerContext: {worktreePath: '/tmp/jobs/repository-task-17'},
    };
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [build], diagnostics: [], repositories: [repository], waiterCount: 0, waiters: []},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('example/repository');
    expect(markup).toContain('~/jobs/repository-task-17');
    expect(markup).not.toContain('/tmp/jobs/repository-task-17');
    expect(markup).toContain('Indexing status is stale');
    expect(markup).toContain('Manager cannot determine whether its current operation is advancing.');
    expect(markup).not.toContain('Phase ETA paused');
    expect(markup).not.toContain('progress is silent');
  });

  it('streams path-free extraction dimensions and slow-file telemetry for active builds', () => {
    const neverResolves = () => new Promise<never>(() => undefined);
    const build = {
      ...graphBuildStatus('running'),
      activity: {
        batchCompleted: 7,
        batchTotal: 12,
        bytes: 70 * 1_024,
        classifier: 'typescript',
        factsBytes: 18 * 1_024,
        language: 'typescript',
        parseMilliseconds: 1_250,
        relations: 21,
        role: 'source',
        sizeBucket: '64-256KiB' as const,
        stage: 'extracting' as const,
        symbols: 9,
      },
      counters: {completed: 7, total: 12, unit: 'files'},
      extraction: {
        completedFiles: 7,
        slowFiles: 2,
        topSlowFiles: [],
      },
    };
    const markup = renderToStaticMarkup(
      createElement(GraphWorkspace, {
        catalog: {builds: [build], diagnostics: [], repositories: [], waiterCount: 0, waiters: []},
        loadAnalysis: neverResolves,
        loadCatalogPage: neverResolves,
        loadGraph: neverResolves,
        loadNodeDetail: neverResolves,
        loadQuery: neverResolves,
        loadViewsPage: neverResolves,
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain('64-256KiB source bucket');
    expect(markup).toContain('source/typescript');
    expect(markup).toContain('18.0 KiB emitted facts');
    expect(markup).toContain('9 symbols');
    expect(markup).toContain('21 relations');
    expect(markup).toContain('Extraction telemetry: 7 files completed');
    expect(markup).toContain('2 at or above 1.00s');
  });

  it('uses catalog fallbacks before either a view or continuation exists', () => {
    expect(graphCatalogContinuationHasMore(undefined, undefined, 'projectHasMore', false)).toBe(false);
    expect(graphCatalogContinuationHasMore(undefined, undefined, 'workspaceHasMore', true)).toBe(true);
    expect(
      graphCatalogContinuationHasMore(
        {
          projectHasMore: true,
          projectOffset: 10,
          viewHasMore: true,
          viewId: 'view-a',
          viewOffset: 4,
          workspaceHasMore: false,
          workspaceOffset: 3,
        },
        'view-b',
        'projectHasMore',
        false,
      ),
    ).toBe(false);
  });

  it('polls active graph builds within the two-second Manager freshness contract', () => {
    expect(graphStatusPollDelay([])).toBe(15_000);
    expect(graphStatusPollDelay([graphBuildStatus('running')])).toBe(1_000);
    expect(graphStatusPollDelay([graphBuildStatus('queued')])).toBe(1_000);
    expect(graphStatusPollDelay([graphBuildStatus('completed')])).toBe(15_000);
    const maintenance = {
      checkoutId: 'a'.repeat(64),
      completed: 3,
      operation: 'selected-snapshot-purge' as const,
      phase: 'verifying-graph' as const,
      snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
      total: 5,
    };
    expect(graphStatusPollDelay([], maintenance)).toBe(1_000);
    expect(graphMaintenanceStatusLabel(maintenance)).toBe('Selected snapshot purge · rechecking graph safety evidence');
    const abandoned = {
      ...graphBuildStatus('running'),
      observation: {heartbeatAgeMilliseconds: 60_000, liveness: 'abandoned' as const},
    };
    expect(graphBuildIsActive(abandoned)).toBe(false);
    expect(graphBuildShouldDisplay(abandoned)).toBe(false);
    expect(graphStatusPollDelay([abandoned])).toBe(15_000);
    const staleOwner = {
      ...graphBuildStatus('running'),
      coordination: {lockVerified: true, progressSilent: true, role: 'owner' as const},
    };
    expect(graphBuildIsActive(staleOwner)).toBe(true);
    expect(graphBuildShouldDisplay(staleOwner)).toBe(true);
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
    const visibleBuild = {
      ...graphBuildStatus('completed'),
      identity: {
        ...graphBuildStatus('completed').identity,
        checkoutId: 'known-snapshot',
        worktreeId: 'known-snapshot',
      },
      result: {snapshotId: 'snapshot-known-snapshot'},
    };
    expect(graphStatusRequiresCatalogRefresh(catalog, [visibleBuild])).toBe(false);
    expect(
      graphStatusRequiresCatalogRefresh(catalog, [
        {...graphBuildStatus('completed'), result: {snapshotId: 'snapshot-known-snapshot'}},
      ]),
    ).toBe(true);
    const truncatedCatalog = {
      ...catalog,
      repositories: [{...catalog.repositories[0]!, viewsTruncated: true}],
    };
    const hiddenBuild = {...graphBuildStatus('completed'), result: {snapshotId: 'hidden-snapshot'}};
    expect(graphStatusRequiresCatalogRefresh(truncatedCatalog, [hiddenBuild])).toBe(true);
    expect(
      graphStatusRequiresCatalogRefresh(
        truncatedCatalog,
        [hiddenBuild],
        new Set([graphCompletedBuildResultIdentity(hiddenBuild)!]),
      ),
    ).toBe(false);
    expect(
      graphStatusRequiresCatalogRefresh(
        {
          ...truncatedCatalog,
          repositories: [
            {
              ...truncatedCatalog.repositories[0]!,
              views: [
                {
                  ...truncatedCatalog.repositories[0]!.views[0]!,
                  checkoutId: 'checkout',
                  worktreeId: 'worktree',
                },
              ],
            },
          ],
        },
        [{...graphBuildStatus('completed'), result: {snapshotId: 'promoted-snapshot'}}],
      ),
    ).toBe(true);

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

  it('labels build banners with their global repository and home-abbreviated worktree path', () => {
    const baseRepository = repositoryGroup('repo-a', ['view-a'], 'view-a');
    const repository = {
      ...baseRepository,
      views: baseRepository.views.map(view => ({
        ...view,
        localAssociation: {
          available: true,
          displayPath: '~/jobs/repo-a-task-17',
          path: '/tmp/jobs/repo-a-task-17',
          state: 'verified' as const,
        },
      })),
    };
    const build = {
      ...graphBuildStatus('running'),
      identity: {
        ...graphBuildStatus('running').identity,
        checkoutId: 'view-a',
        displayName: 'example/repo-a',
        repositoryId: 'repo-a',
        worktreeId: 'view-a',
      },
      managerContext: {worktreePath: '/tmp/jobs/repo-a-task-17'},
    };
    expect(graphBuildTarget(build, [repository])).toEqual({
      repositoryLabel: 'repo-a',
      worktreeLabel: '~/jobs/repo-a-task-17',
    });
    expect(graphBuildTarget({...build, managerContext: undefined}, [baseRepository])).toEqual({
      repositoryLabel: 'repo-a',
      worktreeLabel: 'view-a',
    });
    const {managerContext: _managerContext, ...buildWithoutContext} = build;
    expect(
      graphBuildTarget({...buildWithoutContext, identity: {...build.identity, repositoryId: 'missing'}}, []),
    ).toEqual({
      repositoryLabel: 'example/repo-a · repository missing',
      worktreeLabel: 'Checkout view-a · worktree view-a',
    });
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

  it('normalizes explicit queries while debouncing only useful typed graph-query text', () => {
    expect(managerGraphQueryCandidate('  hydration manager  ')).toBe('hydration manager');
    expect(managerGraphQueryCandidate('ab')).toBe('ab');
    expect(managerGraphQueryCandidate('   ')).toBeUndefined();
    expect(managerGraphDebouncedQueryCandidate('ab')).toBeUndefined();
    expect(managerGraphDebouncedQueryCandidate(' api ')).toBe('api');
    expect(managerGraphQueryCandidate('x'.repeat(513))).toBeUndefined();
  });

  it('rejects cancelled or stale code-query responses across rapid input and snapshot changes', () => {
    const result = queryVisualization('hydrate document');
    const controller = new AbortController();
    expect(
      graphQueryRequestIsCurrent(
        false,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        result,
        'snapshot',
        'hydrate document',
      ),
    ).toBe(true);
    controller.abort();
    expect(
      graphQueryRequestIsCurrent(
        controller.signal.aborted,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        result,
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
    expect(
      graphQueryRequestIsCurrent(
        false,
        13,
        12,
        'repository:snapshot:next query:240:640',
        'repository:snapshot:hydrate document:240:640',
        result,
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
    expect(
      graphQueryRequestIsCurrent(
        false,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        {...result, repository: {...result.repository, snapshot: {...result.repository.snapshot, id: 'promoted'}}},
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
    expect(
      graphQueryRequestIsCurrent(
        false,
        12,
        12,
        'repository:snapshot:hydrate document:240:640',
        'repository:snapshot:hydrate document:240:640',
        {...result, query: {...result.query, text: 'next query'}},
        'snapshot',
        'hydrate document',
      ),
    ).toBe(false);
  });

  it('aborts superseded query requests and rejects completed late responses through the workspace gate', async () => {
    const cancellationGate = createGraphQueryRequestGate();
    let cancelledSignal: AbortSignal | undefined;
    const cancelled = cancellationGate.request(
      {expectedQuery: 'first query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:first query'},
      signal => {
        cancelledSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Superseded', 'AbortError')), {once: true});
        });
      },
    );
    const acceptedAfterCancellation = cancellationGate.request(
      {expectedQuery: 'second query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:second query'},
      () => Promise.resolve(queryVisualization('second query')),
    );
    expect(cancelledSignal?.aborted).toBe(true);
    await expect(cancelled.result).resolves.toEqual({state: 'cancelled'});
    await expect(acceptedAfterCancellation.result).resolves.toMatchObject({state: 'accepted'});

    const staleResponseGate = createGraphQueryRequestGate();
    let lateSignal: AbortSignal | undefined;
    let resolveLate: ((graph: GraphQueryVisualization) => void) | undefined;
    const late = staleResponseGate.request(
      {expectedQuery: 'late query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:late query'},
      signal => {
        lateSignal = signal;
        return new Promise(resolve => {
          resolveLate = resolve;
        });
      },
    );
    const acceptedAfterLateResponse = staleResponseGate.request(
      {expectedQuery: 'current query', expectedSnapshotId: 'snapshot', scope: 'repository:snapshot:current query'},
      () => Promise.resolve(queryVisualization('current query')),
    );
    expect(lateSignal?.aborted).toBe(true);
    resolveLate?.(queryVisualization('late query'));
    await expect(late.result).resolves.toMatchObject({state: 'stale'});
    await expect(acceptedAfterLateResponse.result).resolves.toMatchObject({state: 'accepted'});
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

  it('labels overview sizing from the metric that is actually present', () => {
    const base = queryVisualization('overview');
    const overview = {
      ...base,
      mode: 'overview' as const,
      nodes: [{...graphNode('component', 'Component'), symbolCount: 42, type: 'project' as const}],
    };
    expect(graphOverviewSizeLabel(overview)).toBe('Component symbols');
    expect(
      graphOverviewSizeLabel({
        ...overview,
        nodes: overview.nodes.map(({symbolCount: _symbolCount, ...node}) => node),
        repository: {...overview.repository, metrics: 'deferred'},
      }),
    ).toBe('Visible relationship degree');
  });

  it('marks sampled high-degree relationship counts as lower bounds with the sample size', () => {
    const detail = {
      ...nodeDetail('god-node', 'Coordinator', []),
      stats: {
        incoming: 1_500,
        outgoing: 500,
        provenances: [{count: 2_000, provenance: 'resolved'}],
        relations: [{count: 2_000, incoming: 1_500, outgoing: 500, relation: 'calls'}],
        sampledEdges: 2_000,
        summaryTruncated: true,
        truncated: true,
      },
    };
    expect(graphRelationshipCountLabel(detail.stats.incoming, detail.stats.summaryTruncated)).toBe('≥1,500');
    expect(graphRelationshipSampleLabel(detail)).toBe('Counts are lower bounds from a 2,000-edge sample.');
    expect(graphRelationshipCountLabel(12, false)).toBe('12');
  });

  it('merges continuation pages without dropping loaded views or component options', () => {
    const initial = repositoryGroup('repo', ['view-00'], 'view-00');
    const continued = repositoryGroup('repo', ['view-01'], 'view-01');
    const project = {
      id: 'cgp_late_target',
      label: '//apps/late:target',
      model: 'component' as const,
      provenance: 'declared',
    };
    const continuation = {
      ...continued,
      views: [{...continued.views[0]!, projects: [project], projectsTruncated: false}],
    };
    const merged = mergeGraphRepositoryGroups([{...initial, viewsTruncated: true}], [continuation]);
    expect(merged[0]?.views.map(view => view.id)).toEqual(['view-00', 'view-01']);
    expect(merged[0]?.views.find(view => view.id === 'view-01')?.projects).toContainEqual(project);
    expect(merged[0]?.viewsTruncated).toBe(true);

    const refreshed = repositoryGroup('repo', ['view-00'], 'view-00');
    const stalePage = {
      ...refreshed,
      views: [
        {
          ...refreshed.views[0]!,
          projects: [project],
          snapshot: {...refreshed.views[0]!.snapshot, id: 'stale-snapshot'},
        },
      ],
    };
    expect(mergeGraphRepositoryGroups([refreshed], [stalePage])[0]?.views[0]?.projects).toEqual([]);

    const promotedPage = {
      ...refreshed,
      views: [
        {
          ...refreshed.views[0]!,
          activatedAt: '2026-08-02T12:00:00.000Z',
          projects: [project],
          snapshot: {
            ...refreshed.views[0]!.snapshot,
            completedAt: '2026-08-02T11:59:00.000Z',
            id: 'promoted-snapshot',
          },
        },
      ],
    };
    const previousPage = {
      ...refreshed,
      views: [
        {
          ...refreshed.views[0]!,
          activatedAt: '2026-08-01T12:00:00.000Z',
          snapshot: {...refreshed.views[0]!.snapshot, completedAt: '2026-08-01T11:59:00.000Z'},
        },
      ],
    };
    expect(mergeGraphRepositoryGroups([previousPage], [promotedPage])[0]?.views[0]?.snapshot.id).toBe(
      'promoted-snapshot',
    );
    expect(mergeGraphRepositoryGroups([promotedPage], [previousPage])[0]?.views[0]?.snapshot.id).toBe(
      'promoted-snapshot',
    );
  });

  it('keeps unfiltered catalog cursors independent from merged search hits', () => {
    const initial = repositoryGroup('repo', ['view-00', 'view-01'], 'view-00');
    const baseRepository = {
      ...initial.views[0]!,
      checkoutId: 'checkout',
      projects: [
        {id: 'cgp_first', label: '//apps:first'},
        {id: 'cgp_second', label: '//apps:second'},
      ],
      workspaces: [
        {buildSystem: 'bazel', id: 'workspace-1', name: 'one', root: 'apps/one'},
        {buildSystem: 'bazel', id: 'workspace-2', name: 'two', root: 'apps/two'},
      ],
    };
    const baseRepositoryGroup = {
      ...initial,
      views: [baseRepository, {...initial.views[1]!, checkoutId: 'checkout'}],
    };
    const searchResult = {
      ...baseRepository,
      projects: [{id: 'cgp_out_of_prefix', label: '//z:last'}],
      workspaces: [{buildSystem: 'bazel', id: 'workspace-z', name: 'last', root: 'z'}],
    };
    const merged = mergeGraphRepositoryGroups(
      [baseRepositoryGroup],
      [{...baseRepositoryGroup, views: [searchResult]}],
    )[0]!;
    expect(merged.views[0]?.projects).toHaveLength(3);
    expect(merged.views[0]?.workspaces).toHaveLength(3);
    expect(
      graphCatalogPageOffsets({
        baseRepository,
        baseRepositoryGroup,
        checkoutId: 'checkout',
        viewId: baseRepository.id,
      }),
    ).toEqual({projectOffset: 2, viewOffset: 2, workspaceOffset: 2});
    expect(
      graphCatalogPageOffsets({
        baseRepository,
        baseRepositoryGroup,
        checkoutId: 'checkout',
        continuation: {projectOffset: 64, viewId: baseRepository.id, viewOffset: 32, workspaceOffset: 48},
        viewId: baseRepository.id,
      }),
    ).toEqual({projectOffset: 64, viewOffset: 32, workspaceOffset: 48});
  });

  it('turns catalog search responses into visible actionable component and view options', () => {
    const group = repositoryGroup('repo', ['view-current', 'view-match'], 'view-current');
    const currentView = {
      ...group.views[0]!,
      projects: [
        {
          buildSystem: 'bazel',
          id: 'cgp_checkout',
          kind: 'target',
          label: '//apps/checkout:library',
          workspaceId: 'cgw_mobile',
        },
      ],
      workspaces: [{buildSystem: 'bazel', id: 'cgw_mobile', name: 'mobile workspace', root: 'apps/mobile'}],
    };
    const matchingView = {
      ...group.views[1]!,
      label: 'feature/mobile-auth',
      localAssociation: {
        available: true,
        displayPath: '~/src/mobile-auth',
        path: '/home/tester/src/mobile-auth',
        state: 'verified' as const,
      },
    };

    const result = graphCatalogSearchOptions(currentView, [{...group, views: [matchingView]}]);

    expect(result.projects).toEqual([
      expect.objectContaining({
        description: expect.stringContaining('mobile workspace'),
        id: 'cgp_checkout',
        label: '//apps/checkout:library',
        viewId: 'view-current',
      }),
    ]);
    expect(result.views).toEqual([
      expect.objectContaining({
        description: expect.stringContaining('folder ~/src/mobile-auth'),
        id: 'view-match',
        label: 'feature/mobile-auth',
        repositoryId: 'repo',
      }),
    ]);
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

function queryVisualization(query: string): GraphQueryVisualization {
  return {
    edges: [],
    mode: 'detail',
    nodes: [],
    paging: {edgeLimit: 640, hasMore: false, nodeLimit: 240},
    projectId: 'query',
    query: {matchedNodes: 0, state: 'ready', text: query, warnings: []},
    repository: {
      accounting: {
        attributedSymbols: 0,
        componentSymbols: 0,
        fallbackSymbols: 0,
        omittedSymbols: 0,
        totalSymbols: 0,
      },
      displayName: 'threadnote',
      id: 'repository',
      metrics: 'complete',
      snapshot: {
        commit: 'commit',
        dirty: false,
        edgeCount: 0,
        fileCount: 0,
        id: 'snapshot',
        symbolCount: 0,
      },
    },
    scope: {id: 'query', label: query},
    stats: {renderedEdges: 0, renderedNodes: 0, totalEdges: 0, totalNodes: 0},
    warnings: [],
  };
}

function repositoryGroup(id: string, viewIds: readonly string[], defaultViewId: string): GraphRepositoryGroup {
  return {
    defaultViewId,
    displayName: id,
    id,
    repositoryId: id,
    viewsTruncated: false,
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
      localAssociation: {available: false, state: 'legacy-unknown'},
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
