import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  codeGraphAnalysisMcpResponse,
  codeGraphMcpAnalysisBudget,
  codeGraphMcpAnalysisLimits,
  codeGraphMcpResponse,
  codeGraphRefreshBlocksReadyInspection,
  codeGraphQueryTimeoutResult,
  codeGraphRetryAfterMilliseconds,
  compactCodeGraphMcpProgress,
  compactCodeGraphMcpResult,
  compactCodeGraphMcpTiming,
} from '../../src/mcp_server.js';
import {analyzeCodeGraph} from '../../src/code_graph/analysis.js';
import type {CodeGraphProgress, CodeGraphQueryResult} from '../../src/code_graph/types.js';
import type {CodeGraphRefreshStatus} from '../../src/code_graph/watcher.js';
import {analysisEdge, analysisSnapshot, analysisSymbol, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';

describe('MCP code graph indexing progress', () => {
  it('allows an explicitly safe ready graph to serve while background indexing continues', () => {
    const indexing = indexingStatus(60_000);

    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'ready'}, stale: false}, indexing)).toBe(false);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, indexing)).toBe(true);
    expect(codeGraphRefreshBlocksReadyInspection({readySnapshot: {id: 'stale'}, stale: true}, indexing, true)).toBe(
      false,
    );
    expect(codeGraphRefreshBlocksReadyInspection({stale: true}, indexing)).toBe(true);
    expect(
      codeGraphRefreshBlocksReadyInspection(
        {readySnapshot: {id: 'ready'}, stale: false},
        {message: 'fixture failed', state: 'failed'},
      ),
    ).toBe(true);
  });

  it('derives a bounded adaptive poll interval from the phase estimate', () => {
    expect(codeGraphRetryAfterMilliseconds(undefined)).toBe(5_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(4_000))).toBe(3_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60_000))).toBe(15_000);
    expect(codeGraphRetryAfterMilliseconds(indexingStatus(60 * 60_000))).toBe(30_000);
  });

  it('keeps elapsed query and active indexing states retryable without hiding a failed build', () => {
    const timedOut = codeGraphQueryTimeoutResult('query');
    expect(timedOut.isError).not.toBe(true);
    expect(timedOut.structuredContent).toMatchObject({
      retryAfterMilliseconds: 5_000,
      state: 'timed-out',
      type: 'code-graph-query-state',
      version: 2,
    });

    const indexing = codeGraphQueryTimeoutResult('query', indexingStatus(60_000));
    expect(indexing.isError).not.toBe(true);
    expect(indexing.structuredContent).toMatchObject({
      retryAfterMilliseconds: 15_000,
      state: 'indexing',
      type: 'code-graph-index-state',
      version: 3,
    });

    const failed = codeGraphQueryTimeoutResult('query', {message: 'fixture index failed', state: 'failed'});
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      message: 'fixture index failed',
      state: 'failed',
      type: 'code-graph-index-state',
      version: 3,
    });
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

  it('marks a small stats projection complete when all stats evidence fits', async () => {
    const first = analysisSymbol('stats-first', '@acme/stats', 'src/stats.ts');
    const second = analysisSymbol('stats-second', '@acme/stats', 'src/stats.ts');
    const edges = [analysisEdge('stats-edge', first, second, 'contains')];
    const analysis = await Effect.runPromise(
      analyzeCodeGraph(pagedAnalysisStore([first, second], edges), {
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('stats', 24),
        snapshot: analysisSnapshot([first, second], edges),
      }),
    );

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
  });

  it('excludes unrelated topology arrays before stats truncation and byte accounting', async () => {
    const first = analysisSymbol('scoped-first', '@acme/scoped', 'src/scoped.ts');
    const second = analysisSymbol('scoped-second', '@acme/scoped', 'src/scoped.ts');
    const symbols = [first, second];
    const edges = [analysisEdge('scoped-edge', first, second, 'contains')];
    const store = pagedAnalysisStore(symbols, edges);
    const snapshot = analysisSnapshot(symbols, edges);
    const [stats, topology] = await Promise.all([
      Effect.runPromise(
        analyzeCodeGraph(store, {
          databasePath: ':memory:',
          limits: codeGraphMcpAnalysisLimits('stats', 24),
          snapshot,
        }),
      ),
      Effect.runPromise(analyzeCodeGraph(store, {databasePath: ':memory:', snapshot})),
    ]);
    const community = topology.communities[0];
    const component = topology.components[0];
    const membership = topology.memberships[0];
    expect(community).toBeDefined();
    expect(component).toBeDefined();
    expect(membership).toBeDefined();
    if (!community || !component || !membership) throw new Error('Expected topology fixtures.');
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
  });

  it('independently bounds deterministic MCP analysis text and structured projections', async () => {
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
    const communities = await Effect.runPromise(
      analyzeCodeGraph(store, {
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('communities', 24),
        snapshot,
      }),
    );
    const communityId = communities.communities[0]?.id;
    expect(communityId).toMatch(/^cgc_[a-f0-9]{32}$/);
    if (!communityId) throw new Error('Expected one deterministic fixture community.');
    const analysis = await Effect.runPromise(
      analyzeCodeGraph(store, {
        communityId,
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('community', 5_000),
        snapshot,
      }),
    );
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
  });

  it('marks MCP topology unavailable above the retained-node cap without changing the analysis defaults', async () => {
    const symbols = [analysisSymbol('one', '@acme/capped', 'src/one.ts')];
    const snapshot = {...analysisSnapshot(symbols, []), symbolCount: codeGraphMcpAnalysisBudget().maxNodes! + 1};
    const result = await Effect.runPromise(
      analyzeCodeGraph(pagedAnalysisStore(symbols, []), {
        budget: codeGraphMcpAnalysisBudget(),
        databasePath: ':memory:',
        limits: codeGraphMcpAnalysisLimits('hubs', 24),
        snapshot,
      }),
    );

    expect(result.budget).toMatchObject(codeGraphMcpAnalysisBudget());
    expect(result.coverage.topology.state).toBe('unavailable');
    expect(result.warnings).toContain(
      `Topology was not derived because only 1 of ${snapshot.symbolCount.toLocaleString()} symbols fit the node/time budget.`,
    );
  });

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
