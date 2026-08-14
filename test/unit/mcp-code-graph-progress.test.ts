import {it as effectIt} from '@effect/vitest';
import {TestError} from '../helpers/test-error.js';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphAnalysisMcpResponse,
  codeGraphAnalysisRefreshResult,
  codeGraphInspectionAllowsStaleReady,
  codeGraphMcpAnalysisBudget,
  codeGraphMcpAnalysisLimits,
  codeGraphMcpResponse,
  codeGraphResultWithRefreshContinuity,
  codeGraphRefreshBlocksReadyInspection,
  codeGraphQueryTimeoutResult,
  codeGraphRetryAfterMilliseconds,
  compactCodeGraphMcpProgress,
  compactCodeGraphMcpResult,
  compactCodeGraphMcpTiming,
  selectCodeGraphReadySnapshotForInspection,
} from '../../src/mcp_server.js';
import {analyzeCodeGraph} from '../../src/code_graph/analysis.js';
import type {CodeGraphProgress, CodeGraphQueryResult} from '../../src/code_graph/types.js';
import type {CodeGraphRefreshStatus} from '../../src/code_graph/watcher.js';
import {analysisEdge, analysisSnapshot, analysisSymbol, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';
import {
  readAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryReportedOutcome,
} from '../../src/telemetry/diagnostic.js';

describe('MCP code graph indexing progress', () => {
  it('allows stale ready evidence for non-strict operations only', () => {
    expect(
      Object.fromEntries(
        (['query', 'node', 'neighbors', 'explain', 'path', 'impact'] as const).map(operation => [
          operation,
          codeGraphInspectionAllowsStaleReady(operation),
        ]),
      ),
    ).toEqual({explain: true, impact: false, neighbors: true, node: true, path: false, query: true});
  });

  it('allows an explicitly safe ready graph to serve while background indexing continues', () => {
    const indexing = indexingStatus(60_000);

    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale: false}, indexing)).toBe(false);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, indexing)).toBe(true);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, indexing, true)).toBe(
      false,
    );
    expect(codeGraphRefreshBlocksReadyInspection({stale: true}, indexing)).toBe(true);
    expect(
      codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale: false}, deferredStatus('busy')),
    ).toBe(false);
    expect(
      codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, deferredStatus('busy')),
    ).toBe(true);
    expect(
      codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, deferredStatus('busy'), true),
    ).toBe(false);
  });

  it('never lets a deferred or active refresh hide a usable ready snapshot', () => {
    const refreshStatuses = [deferredStatus('busy'), indexingStatus(60_000)];
    for (const refresh of refreshStatuses) {
      for (const stale of [false, true]) {
        for (const allowStale of [false, true]) {
          const usable = !stale || allowStale;
          expect(
            codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale}, refresh, allowStale),
          ).toBe(!usable);
        }
      }
    }
  });

  it('does not block inspection after a shared ready snapshot is attached to the worktree', () => {
    const indexing = indexingStatus(60_000);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'cgsn_shared'}, stale: false}, indexing)).toBe(
      false,
    );
  });

  it.prop(
    'keeps the exact ready snapshot selected until a verified promotion changes the observed pointer',
    {
      allowStale: FC.boolean(),
      failureCode: FC.constantFrom(
        'busy' as const,
        'no-space' as const,
        'permission' as const,
        'transient-io' as const,
      ),
      refreshState: FC.constantFrom('deferred' as const, 'indexing' as const),
      stale: FC.boolean(),
      verifiedPromotion: FC.boolean(),
    },
    ({allowStale, failureCode, refreshState, stale, verifiedPromotion}) => {
      const ready = {id: 'R'};
      const candidate = {id: 'candidate'};
      const observed = verifiedPromotion ? candidate : ready;
      const refresh = refreshState === 'deferred' ? deferredStatus(failureCode) : indexingStatus(60_000);
      const selected = selectCodeGraphReadySnapshotForInspection({readySnapshot: observed, stale}, refresh, allowStale);
      const usable = !stale || allowStale;

      expect(selected).toBe(usable ? observed : undefined);
      if (!verifiedPromotion) expect(selected).not.toBe(candidate);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('serves stale non-strict evidence with one bounded path-free recovery warning', () => {
    const result = {...verboseCodeGraphResult(), freshness: 'stale' as const, warnings: []};
    const deferred = {
      ...deferredStatus('no-space'),
      privateNativeDetail: '/Users/private/graph.sqlite',
    } as unknown as CodeGraphRefreshStatus;
    const continued = codeGraphResultWithRefreshContinuity(result, deferred);

    expect(continued.freshness).toBe('stale');
    expect(continued.snapshot).toBe(result.snapshot);
    expect(continued.warnings).toHaveLength(1);
    expect(continued.warnings[0]).toContain('no-space');
    expect(continued.warnings[0]).toContain('Free storage space');
    expect(continued.warnings[0]!.length).toBeLessThanOrEqual(320);
    expect(JSON.stringify(continued)).not.toContain('/Users/private');
    expect(codeGraphResultWithRefreshContinuity(continued, deferred)).toBe(continued);
  });

  it('labels stale ready evidence while indexing continues', () => {
    const result = {...verboseCodeGraphResult(), freshness: 'stale' as const, warnings: []};
    const continued = codeGraphResultWithRefreshContinuity(result, indexingStatus(60_000));

    expect(continued.warnings).toEqual([
      'Serving the existing stale ready snapshot while code graph refresh continues in the background.',
    ]);
    expect(codeGraphResultWithRefreshContinuity(continued, indexingStatus(60_000))).toBe(continued);
  });

  it('keeps path, impact, and whole-graph analysis strict when refresh is deferred', () => {
    const deferred = deferredStatus('permission');
    for (const operation of ['path', 'impact'] as const) {
      expect(codeGraphQueryTimeoutResult(operation, deferred)).toMatchObject({
        structuredContent: {
          failure: {code: 'permission', recovery: 'fix-permissions'},
          operation,
          state: 'deferred',
          version: 4,
        },
      });
    }
    expect(codeGraphAnalysisRefreshResult('stats', deferred)).toMatchObject({
      structuredContent: {
        failure: {code: 'permission', recovery: 'fix-permissions'},
        operation: 'stats',
        state: 'deferred',
        type: 'code-graph-analysis-state',
        version: 2,
      },
    });
    expect(readAnonymousTelemetryReportedOutcome(codeGraphAnalysisRefreshResult('stats', deferred))).toBe('failure');
  });

  it('returns a structured reconnect requirement when a newer runtime upgraded graph storage', () => {
    const runtimeSkew = {
      failure: {
        code: 'incompatible-schema',
        operation: 'refresh code graph',
        recovery: 'reconnect-runtime',
        retryable: false,
      },
      state: 'deferred',
    } as const satisfies CodeGraphRefreshStatus;

    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, runtimeSkew, true)).toBe(
      true,
    );

    const inspection = codeGraphQueryTimeoutResult('query', runtimeSkew);
    expect(inspection.structuredContent).toMatchObject({
      failure: {code: 'incompatible-schema', recovery: 'reconnect-runtime'},
      operation: 'query',
      state: 'reconnect-required',
      type: 'code-graph-index-state',
    });
    expect(JSON.stringify(inspection)).toMatch(/reconnect/i);

    const analysis = codeGraphAnalysisRefreshResult('stats', runtimeSkew);
    expect(analysis.structuredContent).toMatchObject({
      failure: {code: 'incompatible-schema', recovery: 'reconnect-runtime'},
      operation: 'stats',
      state: 'reconnect-required',
      type: 'code-graph-analysis-state',
    });
    expect(JSON.stringify(analysis)).toMatch(/reconnect/i);
    expect(readAnonymousTelemetryReportedOutcome(analysis)).toBe('failure');
    expect(readAnonymousTelemetryDiagnostic(analysis)).toEqual({
      code: 'incompatible-schema',
      domain: 'code-graph-storage',
      errorType: 'CodeGraphStoreError',
      operation: 'refresh code graph',
      recovery: 'reconnect-runtime',
      retryable: false,
    });
  });

  it('derives a bounded adaptive poll interval from the phase estimate', () => {
    expect(codeGraphRetryAfterMilliseconds(undefined)).toBe(5_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(4_000))).toBe(3_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60_000))).toBe(15_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60 * 60_000))).toBe(30_000);
  });

  it('keeps elapsed query, active indexing, and deferred refresh states explicit', () => {
    const timedOut = codeGraphQueryTimeoutResult('query');
    expect(timedOut.isError).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      retryAfterMilliseconds: 5_000,
      state: 'timed-out',
      type: 'code-graph-query-state',
      version: 2,
    });
    expect(readAnonymousTelemetryReportedOutcome(timedOut)).toBe('timed-out');

    const indexing = codeGraphQueryTimeoutResult('query', indexingStatus(60_000));
    expect(indexing.isError).not.toBe(true);
    expect(indexing.structuredContent).toMatchObject({
      retryAfterMilliseconds: 15_000,
      state: 'indexing',
      type: 'code-graph-index-state',
      version: 3,
    });
    expect(readAnonymousTelemetryReportedOutcome(indexing)).toBe('unavailable');

    const deferred = codeGraphQueryTimeoutResult('query', deferredStatus('transient-io'));
    expect(deferred.isError).not.toBe(true);
    expect(deferred.structuredContent).toMatchObject({
      failure: {code: 'transient-io', recovery: 'retry-read-only', retryable: true},
      state: 'deferred',
      type: 'code-graph-index-state',
      version: 4,
    });
    expect(readAnonymousTelemetryReportedOutcome(deferred)).toBe('failure');
    expect(readAnonymousTelemetryDiagnostic(deferred)).toEqual({
      code: 'transient-io',
      domain: 'code-graph-storage',
      errorType: 'CodeGraphStoreError',
      operation: 'refresh code graph',
      recovery: 'retry-read-only',
      retryable: true,
    });
    for (const result of [timedOut, indexing, deferred]) {
      expect(JSON.stringify(result)).not.toContain('anonymous-telemetry');
      expect(Object.getOwnPropertySymbols(result)).not.toEqual([]);
    }
  });

  it('keeps detailed materialization telemetry out of MCP indexing state', () => {
    const progress: CodeGraphProgress = {
      activity: {
        batchCompleted: 17,
        batchTotal: 200,
        cachedFactBytes: 999_999_999,
        elapsedMilliseconds: 12_345,
        rows: {edges: 8_000_000, symbols: 2_000_000, terms: 48_000_000},
        sourceBytes: 123_456_789,
        stage: 'writing-terms',
        transactionMilliseconds: 2_500,
      },
      completed: 2_176,
      metrics: {
        batchesCompleted: 17,
        batchesTotal: 200,
        cachedFactBytesCompleted: 9_999_999,
        cachedFactBytesTotal: 99_999_999,
        rows: {edges: 8_000_000, symbols: 2_000_000, terms: 48_000_000},
        sourceBytesCompleted: 1_000_000,
        sourceBytesTotal: 10_000_000,
        storage: {
          estimatedRequiredBytes: 200_000_000_000,
          temporaryDatabaseBytes: 10_000_000_000,
          temporaryDatabaseHighWaterBytes: 12_000_000_000,
        },
      },
      phase: 'materializing',
      reused: 2_000,
      total: 25_600,
      unit: 'files',
    };
    const compact = compactCodeGraphMcpProgress(progress);
    const serialized = JSON.stringify(compact);

    expect(compact).toEqual({
      activity: {batchCompleted: 17, batchTotal: 200, stage: 'writing-terms'},
      completed: 2_176,
      phase: 'materializing',
      reused: 2_000,
      total: 25_600,
      type: 'code-graph-progress',
      unit: 'files',
      version: 1,
    });
    expect(serialized).not.toContain('storage');
    expect(serialized).not.toContain('cachedFactBytes');
    expect(serialized.length).toBeLessThan(300);
  });

  it('reports the compact reason for a queued graph build', () => {
    expect(compactCodeGraphMcpProgress({phase: 'waiting', reason: 'database-writer'})).toEqual({
      phase: 'waiting',
      reason: 'database-writer',
      type: 'code-graph-progress',
      version: 1,
    });
  });

  it('keeps required stale-storage reclamation progress concise', () => {
    expect(
      compactCodeGraphMcpProgress({
        completed: 0,
        pagesCompleted: 42,
        phase: 'reclaiming',
        rowsDeleted: 210_000,
        total: 1,
        unit: 'snapshots',
      }),
    ).toEqual({
      completed: 0,
      pagesCompleted: 42,
      phase: 'reclaiming',
      rowsDeleted: 210_000,
      total: 1,
      type: 'code-graph-progress',
      unit: 'snapshots',
      version: 1,
    });
  });

  it('bounds MCP graph evidence and omits indexing-only symbol fields', () => {
    const result = verboseCodeGraphResult();
    const compact = compactCodeGraphMcpResult(result);
    const serialized = JSON.stringify(compact);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(24 * 1_024);
    expect(compact.output.truncated).toBe(true);
    expect(compact).toMatchObject({sourceVersion: 1, type: 'code-graph-inspection', version: 1});
    expect(compact.output.returnedNodes).toBeLessThan(result.nodes.length);
    expect(compact.output.returnedEdges).toBeLessThan(result.edges.length);
    expect(serialized).not.toContain('lookupKeys');
    expect(serialized).not.toContain('documentation');
    expect(serialized).not.toContain('contentHash');
    expect(compact.nodes[0]).toMatchObject({id: 'cgs_0000', name: expect.any(String), path: expect.any(String)});
    expect(compact.warnings.at(-1)).toContain('refine the query');

    const response = codeGraphMcpResponse(result);
    expect(response.text).toContain('MCP output was bounded to');
    expect(new TextEncoder().encode(response.text).byteLength).toBeLessThan(20 * 1_024);
  });

  it('keeps MCP timing and whole-graph analysis limits context-sized', () => {
    expect(
      compactCodeGraphMcpTiming({
        buildId: 'internal-build-id',
        elapsedMilliseconds: 123_456,
        estimateConfidence: 'medium',
        estimatedPhaseRemainingMilliseconds: 12_345.1,
        estimateScope: 'phase',
        lastProgressAgeMilliseconds: 12.1,
        phaseElapsedMilliseconds: 55_555.1,
        phaseStartedAtMilliseconds: 1,
        startedAtMilliseconds: 1,
        updatedAtMilliseconds: 2,
      }),
    ).toEqual({
      estimateConfidence: 'medium',
      estimatedPhaseRemainingMilliseconds: 12_346,
      estimateScope: 'phase',
      lastProgressAgeMilliseconds: 13,
      phaseElapsedMilliseconds: 55_556,
      type: 'code-graph-progress-timing',
      version: 1,
    });
    expect(codeGraphMcpAnalysisLimits('full', 5_000)).toMatchObject({
      communities: 12,
      communityMembers: 0,
      components: 12,
      confidenceFindings: 12,
      hubs: 12,
      relationshipGroupMembers: 8,
      relationshipGroups: 12,
      surprisingLinks: 12,
    });
    expect(codeGraphMcpAnalysisLimits('community', 5_000).communityMembers).toBe(5_000);
    expect(codeGraphMcpAnalysisBudget()).toEqual({
      maxDurationMilliseconds: 25_000,
      maxEdges: 500_000,
      maxEdgeVisits: 1_000_000,
      maxNodes: 100_000,
    });
  });

  effectIt.effect('marks a small stats projection complete when all stats evidence fits', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('stats-first', '@acme/stats', 'src/stats.ts');
      const second = analysisSymbol('stats-second', '@acme/stats', 'src/stats.ts');
      const edges = [analysisEdge('stats-edge', first, second, 'contains')];
      const analysis = yield* analyzeCodeGraph(pagedAnalysisStore([first, second], edges), {
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('stats', 24),
        snapshot: analysisSnapshot([first, second], edges),
      });

      const response = codeGraphAnalysisMcpResponse(analysis, 'stats', {
        displayName: 'Fixture/stats',
        repositoryId: 'repository-id',
      });

      expect(response.structuredContent.output.structuredContent).toEqual({
        budgetBytes: 24 * 1_024,
        byteLength: expect.any(Number),
        complete: true,
        omitted: {},
        truncated: false,
        truncatedStrings: 0,
      });
      expect(response.structuredContent.output.text).toMatchObject({complete: true, truncated: false});
      expect(response.structuredContent.result).toMatchObject({
        communities: [],
        components: [],
        confidenceAudit: {findings: [], provenances: []},
        hubs: [],
        memberships: [],
        relationshipGroups: [],
        surprisingLinks: [],
      });
      expect(response.text).toContain('structured projection complete');
    }),
  );

  effectIt.effect('excludes unrelated topology arrays before stats truncation and byte accounting', () =>
    Effect.gen(function* () {
      const first = analysisSymbol('scoped-first', '@acme/scoped', 'src/scoped.ts');
      const second = analysisSymbol('scoped-second', '@acme/scoped', 'src/scoped.ts');
      const symbols = [first, second];
      const edges = [analysisEdge('scoped-edge', first, second, 'contains')];
      const store = pagedAnalysisStore(symbols, edges);
      const snapshot = analysisSnapshot(symbols, edges);
      const [stats, topology] = yield* Effect.all(
        [
          analyzeCodeGraph(store, {
            databasePath: ':memory:',
            limits: codeGraphMcpAnalysisLimits('stats', 24),
            snapshot,
          }),
          analyzeCodeGraph(store, {databasePath: ':memory:', snapshot}),
        ],
        {concurrency: 2},
      );
      const community = topology.communities[0];
      const component = topology.components[0];
      const membership = topology.memberships[0];
      expect(community).toBeDefined();
      expect(component).toBeDefined();
      expect(membership).toBeDefined();
      if (!community || !component || !membership) throw new TestError('Expected topology fixtures.');
      const longRepositoryText = '界'.repeat(800);
      const noisyStats = {
        ...stats,
        communities: Array.from({length: 200}, (_, index) => ({
          ...community,
          label: `irrelevant-community-${index}-${longRepositoryText}`,
        })),
        components: Array.from({length: 200}, (_, index) => ({
          ...component,
          label: `irrelevant-component-${index}-${longRepositoryText}`,
        })),
        memberships: Array.from({length: 200}, (_, index) => ({
          ...membership,
          node: {
            ...membership.node,
            path: `src/irrelevant-${index}-${longRepositoryText}.ts`,
          },
        })),
      };
      const repository = {displayName: 'Fixture/scoped-stats', repositoryId: 'repository-id'};

      const clean = codeGraphAnalysisMcpResponse(stats, 'stats', repository);
      const noisy = codeGraphAnalysisMcpResponse(noisyStats, 'stats', repository);

      expect(noisy).toEqual(clean);
      expect(noisy.structuredContent.output.structuredContent).toMatchObject({
        complete: true,
        omitted: {},
        truncated: false,
        truncatedStrings: 0,
      });
      expect(new TextEncoder().encode(JSON.stringify(noisy.structuredContent)).byteLength).toBeLessThanOrEqual(
        24 * 1_024,
      );
    }),
  );

  effectIt.effect('independently bounds deterministic MCP analysis text and structured projections', () =>
    Effect.gen(function* () {
      const path = `src/${'深'.repeat(600)}.ts`;
      const symbols = Array.from({length: 180}, (_, index) =>
        analysisSymbol(`node-${index.toString().padStart(4, '0')}`, '@acme/large', path, {
          name: `node-${index}-${'🙂'.repeat(300)}`,
          qualifiedName: `Fixture.${'Namespace.'.repeat(100)}node${index}`,
        }),
      );
      const edges = symbols.slice(1).map((symbol, index) => analysisEdge(`edge-${index}`, symbols[index]!, symbol));
      const store = pagedAnalysisStore(symbols, edges);
      const snapshot = analysisSnapshot(symbols, edges);
      const communities = yield* analyzeCodeGraph(store, {
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('communities', 24),
        snapshot,
      });
      const communityId = communities.communities[0]?.id;
      expect(communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
      if (!communityId) throw new TestError('Expected one deterministic fixture community.');
      const analysis = yield* analyzeCodeGraph(store, {
        communityId,
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('community', 5_000),
        snapshot,
      });
      const verbose = {
        ...analysis,
        warnings: Array.from({length: 5_000}, () => ''),
      };
      const first = codeGraphAnalysisMcpResponse(verbose, 'community', {
        displayName: `Fixture/${'界'.repeat(2_000)}`,
        repositoryId: 'repository-id',
      });
      const second = codeGraphAnalysisMcpResponse(verbose, 'community', {
        displayName: `Fixture/${'界'.repeat(2_000)}`,
        repositoryId: 'repository-id',
      });
      const structuredBytes = new TextEncoder().encode(JSON.stringify(first.structuredContent)).byteLength;
      const textBytes = new TextEncoder().encode(first.text).byteLength;

      expect(first).toEqual(second);
      expect(structuredBytes).toBeLessThanOrEqual(24 * 1_024);
      expect(textBytes).toBeLessThanOrEqual(24 * 1_024);
      expect(first.structuredContent).toMatchObject({
        output: {
          analysisCoverage: {topology: analysis.coverage.topology.state},
          structuredContent: {
            budgetBytes: 24 * 1_024,
            byteLength: structuredBytes,
            complete: false,
            omitted: {
              communityMembers: expect.any(Number),
            },
            truncated: true,
            truncatedStrings: expect.any(Number),
          },
          text: {
            budgetBytes: 24 * 1_024,
            byteLength: textBytes,
            complete: false,
            truncated: true,
          },
        },
        sourceVersion: analysis.version,
        type: 'code-graph-analysis',
        version: 1,
      });
      expect(first.text).toContain('MCP text output coverage: truncated');
      expect(first.structuredContent.result.coverage).toEqual(analysis.coverage);
    }),
  );

  effectIt.effect(
    'marks MCP topology unavailable above the retained-node cap without changing the analysis defaults',
    () =>
      Effect.gen(function* () {
        const symbols = [analysisSymbol('one', '@acme/capped', 'src/one.ts')];
        const snapshot = {...analysisSnapshot(symbols, []), symbolCount: codeGraphMcpAnalysisBudget().maxNodes! + 1};
        const result = yield* analyzeCodeGraph(pagedAnalysisStore(symbols, []), {
          budget: codeGraphMcpAnalysisBudget(),
          databasePath: ':memory:',
          limits: codeGraphMcpAnalysisLimits('hubs', 24),
          snapshot,
        });

        expect(result.budget).toMatchObject(codeGraphMcpAnalysisBudget());
        expect(result.coverage.topology.state).toBe('unavailable');
        expect(result.warnings).toContain(
          `Topology was not derived because only 1 of ${snapshot.symbolCount.toLocaleString()} symbols fit the node/time budget.`,
        );
      }),
  );

  it.prop(
    'never exceeds MCP context budgets across result cardinalities',
    {
      displayNameLength: FC.integer({max: 32_000, min: 0}),
      edgeCount: FC.integer({max: 200, min: 0}),
      nodeCount: FC.integer({max: 100, min: 0}),
    },
    ({displayNameLength, edgeCount, nodeCount}) => {
      const verbose = verboseCodeGraphResult();
      const result = {
        ...verbose,
        edges: verbose.edges.slice(0, edgeCount),
        nodes: verbose.nodes.slice(0, nodeCount),
        repository: {...verbose.repository, displayName: 'r'.repeat(displayNameLength)},
      };
      const response = codeGraphMcpResponse(result);
      const compact = response.structuredContent;

      expect(new TextEncoder().encode(JSON.stringify(compact)).byteLength).toBeLessThanOrEqual(24 * 1_024);
      expect(new TextEncoder().encode(response.text).byteLength).toBeLessThan(20 * 1_024);
      expect(compact.repository.displayName.length).toBeLessThanOrEqual(320);
      expect(compact).toMatchObject({sourceVersion: 1, type: 'code-graph-inspection', version: 1});
      expect(compact.output.returnedNodes).toBeLessThanOrEqual(nodeCount);
      expect(compact.output.returnedEdges).toBeLessThanOrEqual(edgeCount);
      expect(compact.output.truncated).toBe(
        compact.output.returnedNodes < nodeCount ||
          compact.output.returnedEdges < edgeCount ||
          verbose.warnings.length > 5,
      );
    },
    {fastCheck: {numRuns: 50}},
  );
});

function indexingStatus(estimatedPhaseRemainingMilliseconds: number): CodeGraphRefreshStatus {
  return {
    state: 'indexing',
    timing: {
      buildId: 'test-build',
      elapsedMilliseconds: 2_000,
      estimateConfidence: 'medium',
      estimatedPhaseRemainingMilliseconds,
      estimateScope: 'phase',
      lastProgressAgeMilliseconds: 0,
      phaseElapsedMilliseconds: 2_000,
      phaseStartedAtMilliseconds: 0,
      startedAtMilliseconds: 0,
      updatedAtMilliseconds: 2_000,
    },
  };
}

function deferredStatus(code: 'busy' | 'no-space' | 'permission' | 'transient-io'): CodeGraphRefreshStatus {
  const metadata = {
    busy: {recovery: 'defer' as const, retryable: true},
    'no-space': {recovery: 'free-space' as const, retryable: false},
    permission: {recovery: 'fix-permissions' as const, retryable: false},
    'transient-io': {recovery: 'retry-read-only' as const, retryable: true},
  }[code];
  return {
    failure: {code, operation: 'refresh code graph', ...metadata},
    state: 'deferred',
  };
}

function verboseCodeGraphResult(): CodeGraphQueryResult {
  const span = {column: 1, endColumn: 2, endLine: 1, line: 1};
  return {
    edges: Array.from({length: 200}, (_, index) => ({
      confidence: 1,
      evidencePath: `src/${'deep/'.repeat(100)}edge-${index}.ts`,
      evidenceSpan: span,
      id: `cge_${String(index).padStart(4, '0')}`,
      provenance: 'resolved' as const,
      relation: 'calls' as const,
      sourceId: `cgs_${String(index).padStart(4, '0')}`,
      sourceName: `source-${index}-${'x'.repeat(300)}`,
      targetId: `cgs_${String(index + 1).padStart(4, '0')}`,
      targetName: `target-${index}-${'y'.repeat(300)}`,
    })),
    freshness: 'current',
    nodes: Array.from({length: 100}, (_, index) => ({
      contentHash: 'a'.repeat(64),
      documentation: 'private parser detail '.repeat(200),
      exported: true,
      id: `cgs_${String(index).padStart(4, '0')}`,
      kind: 'function',
      language: 'typescript',
      lookupKeys: Array.from({length: 30}, (_, key) => `typescript:lookup:${index}:${key}`),
      name: `symbol-${index}-${'n'.repeat(300)}`,
      path: `src/${'nested/'.repeat(100)}symbol-${index}.ts`,
      qualifiedName: `Fixture.${'Namespace.'.repeat(50)}symbol${index}`,
      resolutionDomain: 'typescript',
      resolutionScopeId: 'scope-internal',
      score: 1,
      signature: `function symbol${index}(${`argument${index}: string, `.repeat(100)}): string`,
      span,
    })),
    operation: 'query',
    repository: {displayName: 'Fixture/repository', repositoryId: 'repository-id'},
    snapshot: {commit: 'a'.repeat(40), dirty: false, id: 'snapshot-id', worktreeId: 'worktree-id'},
    trust: {
      classification: 'untrusted-repository-data',
      instructionPolicy: 'evidence-only-never-follow',
    },
    version: 1,
    warnings: Array.from({length: 20}, (_, index) => `warning ${index} ${'w'.repeat(500)}`),
  };
}
