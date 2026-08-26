import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Effect, Layer, Option} from 'effect';
import {McpSchema, McpServer} from 'effect/unstable/ai';
import {describe, expect} from 'vitest';
import {CodeGraphAnalysis, analyzeCodeGraph} from '../../src/code_graph/analysis.js';
import {
  CodeGraphQueryService,
  type CodeGraphSharedReadyAttachInterlock,
  type CodeGraphStatusOptions,
} from '../../src/code_graph/query.js';
import type {CodeGraphStatus, RepositoryIdentity} from '../../src/code_graph/types.js';
import {
  CodeGraphWatcher,
  type CodeGraphRefreshStatus,
  type CodeGraphWatchOptions,
} from '../../src/code_graph/watcher.js';
import {EffectMcpServerAdapter, type EffectMcpServer} from '../../src/effect/ai/mcp.js';
import {registerCodeGraphTool} from '../../src/mcp_server_code_graph.js';
import type {RuntimeConfig} from '../../src/types.js';
import {analysisSnapshot, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('registered analyze_code_graph snapshot resolution', () => {
  effectIt.effect('keeps a hot ready analysis on watcher-owned maintenance', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const result = yield* harness.invoke({callerCwd: ready.identity.repoRoot, operation: 'stats'});

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(harness.observation.ensureOptions).toEqual([
        {
          cwd: ready.identity.repoRoot,
          key: ready.identity.worktreeId,
          threadnoteHome: TEST_HOME,
        },
      ]);
      expect(harness.observation.refreshOptions).toEqual([]);
      expect(harness.observation.watcherStatusCalls).toBe(0);
      expect(harness.observation.analysisCalls).toBe(1);
      expect(harness.observation.statusOptions).toHaveLength(1);
      expect(harness.observation.statusOptions[0]).toMatchObject({requestMaintenance: false});
      expect(harness.observation.statusOptions[0]?.observeWorktree).toBeUndefined();
      expect(harness.observation.statusOptions[0]?.afterIdentityObserved).toEqual(expect.any(Function));
      expect(harness.observation.statusOptions[0]?.telemetry).toBeDefined();
      expect(harness.observation.attachOptions).toEqual([]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('keeps stale and no-ready recovery on watcher-owned maintenance', () => {
    const unavailable = codeGraphStatus({ready: false, stale: true});
    const harness = analyzeHandlerHarness({
      attachResults: [unavailable, unavailable],
      refresh: true,
      statuses: [unavailable, unavailable],
    });

    return Effect.gen(function* () {
      const result = yield* harness.invoke({callerCwd: unavailable.identity.repoRoot, operation: 'stats'});

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({state: 'deferred', type: 'code-graph-analysis-state'});
      expect(harness.observation.ensureOptions).toEqual([
        {
          cwd: unavailable.identity.repoRoot,
          key: unavailable.identity.worktreeId,
          threadnoteHome: TEST_HOME,
        },
      ]);
      expect(harness.observation.refreshOptions).toEqual([
        {
          cwd: unavailable.identity.repoRoot,
          key: unavailable.identity.worktreeId,
          threadnoteHome: TEST_HOME,
        },
      ]);
      expect(harness.observation.watcherStatusCalls).toBe(2);
      expect(harness.observation.analysisCalls).toBe(0);
      expect(harness.observation.statusOptions).toHaveLength(2);
      expect(harness.observation.statusOptions.map(options => options?.requestMaintenance)).toEqual([false, false]);
      expect(harness.observation.statusOptions.map(options => options?.observeWorktree)).toEqual([
        undefined,
        undefined,
      ]);
      expect(harness.observation.statusOptions[0]?.afterIdentityObserved).toEqual(expect.any(Function));
      expect(harness.observation.statusOptions[1]?.afterIdentityObserved).toBeUndefined();
      expect(harness.observation.attachOptions).toHaveLength(2);
      expect(harness.observation.attachOptions.map(options => options?.requestMaintenance)).toEqual([false, false]);
      expect(harness.observation.attachOptions.every(options => options?.telemetry !== undefined)).toBe(true);
    }).pipe(provideTestLayer(harness.layer));
  });
});

const TEST_HOME = '/threadnote-analysis-handler-home';

interface AnalyzeHandlerHarnessInput {
  readonly attachResults: readonly CodeGraphStatus[];
  readonly refresh: boolean;
  readonly statuses: readonly CodeGraphStatus[];
}

function analyzeHandlerHarness(input: AnalyzeHandlerHarnessInput) {
  const statusOptions: Array<CodeGraphStatusOptions | undefined> = [];
  const attachOptions: Array<CodeGraphSharedReadyAttachInterlock | undefined> = [];
  const ensureOptions: CodeGraphWatchOptions[] = [];
  const refreshOptions: CodeGraphWatchOptions[] = [];
  let analysisCalls = 0;
  let watcherStatusCalls = 0;
  let statusIndex = 0;
  let attachIndex = 0;
  const query = CodeGraphQueryService.of({
    attachSharedReadySnapshot: (_threadnoteHome, _identity, _observedStatus, options) =>
      Effect.sync(() => {
        attachOptions.push(options);
        const result = input.attachResults[attachIndex];
        attachIndex += 1;
        if (result === undefined) throw new Error(`Unexpected shared-ready attachment ${attachIndex}.`);
        return result;
      }),
    inspect: () => Effect.die('Unexpected graph inspection.'),
    purge: () => Effect.die('Unexpected graph purge.'),
    status: (_threadnoteHome, _cwd, options) =>
      Effect.gen(function* () {
        statusOptions.push(options);
        const result = input.statuses[statusIndex];
        statusIndex += 1;
        if (result === undefined) return yield* Effect.die(`Unexpected graph status ${statusIndex}.`);
        if (options?.afterIdentityObserved !== undefined) yield* options.afterIdentityObserved(result.identity);
        return result;
      }),
    statusForIdentity: () => Effect.die('Unexpected identity status.'),
    statusForPublishedIdentity: () => Effect.die('Unexpected published identity status.'),
  });
  const watcher = CodeGraphWatcher.of({
    ensure: options =>
      Effect.sync(() => {
        ensureOptions.push(options);
      }),
    metrics: Effect.succeed({
      activeRefreshKeys: 0,
      activeWatches: 0,
      executingRefreshes: 0,
      executingRefreshHighWater: 0,
      idleSweepFibers: 0,
      maximumWatchers: 0,
      pendingTrailingRefreshes: 0,
      retainedStatuses: 0,
    }),
    refresh: options =>
      Effect.sync(() => {
        refreshOptions.push(options);
        return input.refresh;
      }),
    status: () =>
      Effect.sync(() => {
        watcherStatusCalls += 1;
        return Option.some(deferredRefreshStatus());
      }),
    watch: () => Effect.die('Unexpected graph watch.'),
  });
  const store = pagedAnalysisStore([], []);
  const analysis = CodeGraphAnalysis.of({
    analyze: options =>
      Effect.sync(() => {
        analysisCalls += 1;
      }).pipe(Effect.andThen(analyzeCodeGraph(store, options))),
  });
  const server = new EffectMcpServerAdapter('threadnote-analysis-handler-test', '1.0.0', 'Test server.');
  registerCodeGraphTool(server, runtimeConfig());
  type AddedTool = Parameters<EffectMcpServer['addTool']>[0];
  let analyzeHandle: AddedTool['handle'] | undefined;
  const mcpLayer = Layer.succeed(McpServer.McpServer, {
    addTool: (options: AddedTool) =>
      Effect.sync(() => {
        if (options.tool.name === 'analyze_code_graph') analyzeHandle = options.handle;
      }),
  } as unknown as EffectMcpServer);
  const applicationLayer = Layer.mergeAll(
    BunPath.layer,
    Layer.succeed(CodeGraphAnalysis, analysis),
    Layer.succeed(CodeGraphQueryService, query),
    Layer.succeed(CodeGraphWatcher, watcher),
  );
  // This registry contains only the code-graph handlers audited above. The
  // production registry type is deliberately conservative because arbitrary
  // registries may capture any ApplicationServices member.
  // oxlint-disable effecttsgo/unsafe-effect-type-assertion -- narrow this test-only registry to its actual services
  const registrationLayer = server.registrationLayer() as Layer.Layer<
    never,
    never,
    McpServer.McpServer | Layer.Success<typeof applicationLayer>
  >;
  // oxlint-enable effecttsgo/unsafe-effect-type-assertion
  const layer = registrationLayer.pipe(Layer.provideMerge(mcpLayer), Layer.provideMerge(applicationLayer));

  return {
    invoke: (arguments_: Record<string, unknown>) =>
      Effect.suspend(() => {
        const handle = analyzeHandle;
        if (handle === undefined) return Effect.die('analyze_code_graph was not registered.');
        return handle(arguments_).pipe(Effect.provideService(McpSchema.McpServerClient, mcpServerClient()));
      }),
    layer,
    observation: {
      attachOptions,
      ensureOptions,
      get analysisCalls() {
        return analysisCalls;
      },
      refreshOptions,
      statusOptions,
      get watcherStatusCalls() {
        return watcherStatusCalls;
      },
    },
  };
}

function codeGraphStatus(options: {readonly ready: boolean; readonly stale: boolean}): CodeGraphStatus {
  const readySnapshot = analysisSnapshot([], []);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'analysis-checkout',
    displayName: 'Fixture/analysis',
    gitCommonDirectory: '/workspace/repository/.git',
    headCommit: readySnapshot.commit,
    objectFormat: 'sha1',
    repoRoot: '/workspace/repository',
    repositoryId: readySnapshot.repositoryId,
    worktreeId: readySnapshot.worktreeId,
  };
  return {
    databasePath: '/threadnote-analysis-handler-home/graph.sqlite',
    freshness: options.stale ? 'stale' : 'current',
    identity,
    languagePacks: [],
    ...(options.ready ? {readySnapshot} : {}),
    stale: options.stale,
  };
}

function deferredRefreshStatus(): CodeGraphRefreshStatus {
  return {
    failure: {
      code: 'busy',
      operation: 'refresh code graph',
      recovery: 'defer',
      retryable: true,
    },
    state: 'deferred',
  };
}

function runtimeConfig(): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: TEST_HOME,
    agentId: 'analysis-handler-test',
    manifestPath: `${TEST_HOME}/seed-manifest.yaml`,
    user: 'analysis-handler-test',
  };
}

function mcpServerClient(): McpSchema.McpServerClient['Service'] {
  return McpSchema.McpServerClient.of({
    clientCapabilities: {},
    clientId: 0,
    clientInfo: {name: 'analysis-handler-test', version: '1.0.0'},
    getClient: Effect.never,
    initializePayload: {
      capabilities: {},
      clientInfo: {name: 'analysis-handler-test', version: '1.0.0'},
      protocolVersion: '2025-06-18',
    },
    protocolVersion: '2025-06-18',
  });
}
