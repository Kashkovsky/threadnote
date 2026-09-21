import {BunFileSystem} from '@effect/platform-bun';
import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Fiber, Layer, Option} from 'effect';
import {TestClock} from 'effect/testing';
import {McpSchema, McpServer} from 'effect/unstable/ai';
import {describe, expect} from 'vitest';
import {CodeGraphAnalysis, analyzeCodeGraph} from '../../src/code_graph/analysis.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {succeedUndefined} from '../../src/effect/optional.js';
import {SystemInfo, type SystemInfoShape} from '../../src/effect/system.js';
import {
  CodeGraphQueryService,
  type CodeGraphSharedReadyAttachInterlock,
  type CodeGraphStatusOptions,
} from '../../src/code_graph/query.js';
import type {CodeGraphQueryScope} from '../../src/code_graph/query/scope.js';
import {codeGraphQueryScopeReceipt} from '../../src/code_graph/query/scope.js';
import {attachCodeGraphStatusObservation} from '../../src/code_graph/query/contract.js';
import type {CodeGraphQueryResult, CodeGraphStatus, RepositoryIdentity} from '../../src/code_graph/types.js';
import {
  CodeGraphWatcher,
  type CodeGraphRefreshStatus,
  type CodeGraphWatchOptions,
} from '../../src/code_graph/watcher.js';
import {EffectMcpServerAdapter, type EffectMcpServer} from '../../src/effect/ai/mcp.js';
import {registerCodeGraphTool} from '../../src/mcp/server/code_graph.js';
import type {CommandResult, RuntimeConfig} from '../../src/types.js';
import {analysisSnapshot, pagedAnalysisStore} from '../helpers/code-graph-analysis.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('registered analyze_code_graph snapshot resolution', () => {
  effectIt.effect('propagates the explicit project selector to graph status', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});
    return Effect.gen(function* () {
      const result = yield* harness.invoke({callerCwd: ready.identity.repoRoot, operation: 'stats', project: 'app-a'});
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(harness.observation.statusOptions[0]).toMatchObject({project: 'app-a'});
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('infers one configured project before selecting an inspect ready snapshot', () => {
    const manifestPath = '/tmp/threadnote-mcp-code-graph-routing-unique.yaml';
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({
      attachResults: [],
      manifestPath,
      refresh: false,
      statuses: [ready],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(manifestPath, graphManifest(['web']));
      const result = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'query',
        query: 'value',
      });

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(harness.observation.statusOptions[0]).toMatchObject({project: 'web'});
    }).pipe(
      Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
      provideTestLayer(harness.layer),
    );
  });

  effectIt.effect('rejects ambiguous configured inspect scope before graph status selection', () => {
    const manifestPath = '/tmp/threadnote-mcp-code-graph-routing-ambiguous.yaml';
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({
      attachResults: [],
      manifestPath,
      refresh: false,
      statuses: [ready],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(manifestPath, graphManifest(['web', 'api']));
      const result = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'query',
        query: 'value',
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('api, web');
      expect(harness.observation.statusOptions).toHaveLength(0);
    }).pipe(
      Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
      provideTestLayer(harness.layer),
    );
  });
  effectIt.effect('rejects missing operation at the adapter boundary for both code-graph tools', () => {
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const analyzeResult = yield* harness.invoke({callerCwd: ready.identity.repoRoot});
      const inspectResult = yield* harness.invokeInspect({callerCwd: ready.identity.repoRoot});

      expect(analyzeResult.isError).toBe(true);
      expect(inspectResult.isError).toBe(true);
      expect(harness.observation.analysisCalls).toBe(0);
      expect(harness.observation.statusOptions).toHaveLength(0);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect(
    'directs explicit configured-project topology requests to scoped analysis or a prepared workset',
    () => {
      const manifestPath = '/tmp/threadnote-mcp-code-graph-topology-explicit.yaml';
      const repositoryRoot = process.cwd();
      const ready = codeGraphStatus({ready: true, stale: false});
      const harness = analyzeHandlerHarness({
        attachResults: [],
        liveGit: true,
        manifestPath,
        refresh: false,
        statuses: [ready],
      });

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(manifestPath, graphManifest(['web'], repositoryRoot));
        const result = yield* harness.invokeInspect({
          callerCwd: repositoryRoot,
          operation: 'topology',
          project: 'web',
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('analyze_code_graph');
        expect(JSON.stringify(result.content)).toContain('project');
        expect(JSON.stringify(result.content)).toContain('workset prepare');
        expect(harness.observation.statusOptions).toHaveLength(0);
      }).pipe(
        Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
        provideTestLayer(harness.layer),
      );
    },
  );

  effectIt.effect('infers configured-project topology guidance and rejects unknown selectors', () => {
    const manifestPath = '/tmp/threadnote-mcp-code-graph-topology-routing.yaml';
    const ready = codeGraphStatus({ready: true, stale: false});
    const harness = analyzeHandlerHarness({attachResults: [], manifestPath, refresh: false, statuses: [ready]});

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(manifestPath, graphManifest(['web']));

      const inferred = yield* harness.invokeInspect({callerCwd: ready.identity.repoRoot, operation: 'topology'});
      expect(inferred.isError).toBe(true);
      expect(JSON.stringify(inferred.content)).toContain('configured project \\"web\\"');
      expect(JSON.stringify(inferred.content)).toContain('analyze_code_graph');

      const unknown = yield* harness.invokeInspect({
        callerCwd: ready.identity.repoRoot,
        operation: 'topology',
        project: 'unknown',
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain('No configured project named');
      expect(JSON.stringify(unknown.content)).not.toContain('configured project \\"unknown\\"');
      expect(harness.observation.statusOptions).toHaveLength(0);
    }).pipe(
      Effect.ensuring(FileSystem.FileSystem.pipe(Effect.flatMap(fs => fs.remove(manifestPath).pipe(Effect.ignore)))),
      provideTestLayer(harness.layer),
    );
  });

  effectIt.effect('allows ready query and exact-node reads to run beyond the former 25-second budget', () => {
    const ready = codeGraphStatus({ready: true, stale: true});
    const harness = analyzeHandlerHarness({
      allowBackgroundRequest: true,
      attachResults: [ready, ready],
      inspectDelayMilliseconds: 30_000,
      refresh: false,
      statuses: [ready, ready],
    });

    return Effect.gen(function* () {
      for (const request of [
        {operation: 'query' as const, query: 'value'},
        {nodeId: `cgs_${'a'.repeat(32)}`, operation: 'node' as const},
      ]) {
        const fiber = yield* harness
          .invokeInspect({callerCwd: ready.identity.repoRoot, ...request})
          .pipe(Effect.forkChild({startImmediately: true}));
        yield* TestClock.adjust('30 seconds');
        const result = yield* Fiber.join(fiber);

        expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
          operation: request.operation,
          type: 'code-graph-inspection',
        });
      }
      expect(harness.observation.isolatedInspectCalls).toBe(2);
      expect(harness.observation.isolatedRequests).toEqual([
        expect.objectContaining({operation: 'query', readySnapshotId: ready.readySnapshot?.id}),
        expect.objectContaining({operation: 'node', readySnapshotId: ready.readySnapshot?.id}),
      ]);
      expect(harness.observation.lifecycleEvents).toEqual([
        'isolated-read-start',
        'isolated-read-complete',
        'watcher-ensure',
        'isolated-read-start',
        'isolated-read-complete',
        'watcher-ensure',
      ]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('forwards the resolved project scope instead of making the isolated worker rediscover it', () => {
    const projectScope = scopedProjectObservation();
    const base = codeGraphStatus({ready: true, stale: false});
    const ready = attachCodeGraphStatusObservation(
      {
        ...base,
        projectCoverage: {
          project: 'web',
          kind: 'project',
          configuredRoots: ['apps/web'],
          rootComponents: 1,
          dependencyComponents: 1,
          completeness: 'complete',
          negativeProof: 'selected-graph-only',
          observedWorktreeCommit: base.identity.headCommit,
          reusedEquivalentSnapshot: false,
          snapshotSourceCommit: base.readySnapshot!.commit,
        },
      },
      {identity: base.identity, projectScope},
    );
    const harness = analyzeHandlerHarness({
      attachResults: [],
      inspectDelayMilliseconds: 1,
      refresh: false,
      statuses: [ready],
    });

    return Effect.gen(function* () {
      const fiber = yield* harness
        .invokeInspect({callerCwd: ready.identity.repoRoot, operation: 'query', project: 'web', query: 'value'})
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* TestClock.adjust(1);
      const result = yield* Fiber.join(fiber);

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
        projectCoverage: {
          completeness: 'complete',
          configuredRoots: ['apps/web'],
          dependencyComponents: 1,
          kind: 'project',
          project: 'web',
          rootComponents: 1,
        },
      });
      expect(harness.observation.isolatedRequests).toEqual([
        expect.objectContaining({
          operation: 'query',
          projectScopeReceipt: codeGraphQueryScopeReceipt(projectScope),
          readySnapshotId: ready.readySnapshot?.id,
        }),
      ]);
    }).pipe(provideTestLayer(harness.layer));
  });

  effectIt.effect('returns a structured timeout without scheduling a hidden stale-ready rebuild', () => {
    const ready = codeGraphStatus({ready: true, stale: true});
    const harness = analyzeHandlerHarness({
      allowBackgroundRequest: true,
      attachResults: [ready],
      inspectDelayMilliseconds: 60_000,
      refresh: false,
      statuses: [ready],
    });

    return Effect.gen(function* () {
      const fiber = yield* harness
        .invokeInspect({callerCwd: ready.identity.repoRoot, operation: 'query', query: 'value'})
        .pipe(Effect.forkChild({startImmediately: true}));
      yield* TestClock.adjust('55 seconds');
      const result = yield* Fiber.join(fiber);

      expect(result.structuredContent, JSON.stringify(result)).toMatchObject({
        operation: 'query',
        readySnapshotAvailable: true,
        state: 'timed-out',
        type: 'code-graph-query-state',
      });
      expect(harness.observation.isolatedInspectCalls).toBe(1);
      expect(harness.observation.lifecycleEvents).toEqual(['isolated-read-start', 'watcher-ensure']);
    }).pipe(provideTestLayer(harness.layer));
  });

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
  readonly allowBackgroundRequest?: boolean;
  readonly attachResults: readonly CodeGraphStatus[];
  readonly inspectDelayMilliseconds?: number;
  readonly liveGit?: boolean;
  readonly manifestPath?: string;
  readonly refresh: boolean;
  readonly statuses: readonly CodeGraphStatus[];
}

function analyzeHandlerHarness(input: AnalyzeHandlerHarnessInput) {
  const statusOptions: Array<CodeGraphStatusOptions | undefined> = [];
  const attachOptions: Array<CodeGraphSharedReadyAttachInterlock | undefined> = [];
  const ensureOptions: CodeGraphWatchOptions[] = [];
  const refreshOptions: CodeGraphWatchOptions[] = [];
  const lifecycleEvents: string[] = [];
  let analysisCalls = 0;
  let isolatedInspectCalls = 0;
  const isolatedRequests: Array<Record<string, unknown>> = [];
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
    inspect: () => Effect.die('Unexpected in-process graph inspection.'),
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
        lifecycleEvents.push('watcher-ensure');
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
    request: () => {
      lifecycleEvents.push('background-refresh-request');
      return input.allowBackgroundRequest
        ? Effect.succeed({
            requestState: 'started',
            refresh: {state: 'active', type: 'code-graph-refresh-continuity', version: 1},
          })
        : Effect.die('Unexpected graph request.');
    },
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
  const command = CommandExecutor.of({
    execute: (executable, arguments_, options) =>
      input.liveGit === true && executable === 'git'
        ? Effect.sync(() => {
            const result = Bun.spawnSync([executable, ...arguments_], {
              cwd: options?.cwd,
              stderr: 'pipe',
              stdout: 'pipe',
            });
            return {
              exitCode: result.exitCode,
              stderr: new TextDecoder().decode(result.stderr),
              stdout: new TextDecoder().decode(result.stdout),
            };
          })
        : Effect.gen(function* () {
            isolatedInspectCalls += 1;
            const status = input.statuses[0];
            if (status === undefined || options?.input === undefined) {
              return yield* Effect.die('Unexpected isolated graph inspection.');
            }
            const request = JSON.parse(new TextDecoder().decode(options.input)) as Record<string, unknown> & {
              readonly operation: CodeGraphQueryResult['operation'];
            };
            lifecycleEvents.push('isolated-read-start');
            isolatedRequests.push(request);
            if (input.inspectDelayMilliseconds !== undefined) yield* Effect.sleep(input.inspectDelayMilliseconds);
            lifecycleEvents.push('isolated-read-complete');
            return commandResult(
              JSON.stringify({ok: true, protocol: 1, result: codeGraphInspectionResult(status, request.operation)}),
            );
          }),
    executeBytes: (executable, arguments_, options) =>
      input.liveGit === true && executable === 'git'
        ? Effect.sync(() => {
            const result = Bun.spawnSync([executable, ...arguments_], {
              cwd: options?.cwd,
              stderr: 'pipe',
              stdout: 'pipe',
            });
            return {
              exitCode: result.exitCode,
              stderr: new TextDecoder().decode(result.stderr),
              stdout: new Uint8Array(result.stdout),
            };
          })
        : Effect.die('Unexpected binary command.'),
    executeStreaming: () => Effect.die('Unexpected streaming command.'),
  });
  const server = new EffectMcpServerAdapter('threadnote-analysis-handler-test', '1.0.0', 'Test server.');
  registerCodeGraphTool(server, runtimeConfig(input.manifestPath));
  type AddedTool = Parameters<EffectMcpServer['addTool']>[0];
  let analyzeHandle: AddedTool['handle'] | undefined;
  let inspectHandle: AddedTool['handle'] | undefined;
  const mcpLayer = Layer.succeed(McpServer.McpServer, {
    addTool: (options: AddedTool) =>
      Effect.sync(() => {
        if (options.tool.name === 'analyze_code_graph') analyzeHandle = options.handle;
        if (options.tool.name === 'inspect_code_graph') inspectHandle = options.handle;
      }),
  } as unknown as EffectMcpServer);
  const applicationLayer = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Layer.succeed(CommandExecutor, command),
    Layer.succeed(CodeGraphAnalysis, analysis),
    Layer.succeed(CodeGraphQueryService, query),
    Layer.succeed(CodeGraphWatcher, watcher),
    Layer.succeed(SystemInfo, systemInfoStub()),
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
    invokeInspect: (arguments_: Record<string, unknown>) =>
      Effect.suspend(() => {
        const handle = inspectHandle;
        if (handle === undefined) return Effect.die('inspect_code_graph was not registered.');
        return handle(arguments_).pipe(Effect.provideService(McpSchema.McpServerClient, mcpServerClient()));
      }),
    layer,
    observation: {
      attachOptions,
      ensureOptions,
      get analysisCalls() {
        return analysisCalls;
      },
      get isolatedInspectCalls() {
        return isolatedInspectCalls;
      },
      isolatedRequests,
      lifecycleEvents,
      refreshOptions,
      statusOptions,
      get watcherStatusCalls() {
        return watcherStatusCalls;
      },
    },
  };
}

function scopedProjectObservation(): CodeGraphQueryScope {
  return {
    project: {
      graph: {closure: 'dependencies', roots: ['apps/web']},
      name: 'web',
      uri: 'threadnote://projects/web',
    },
    scope: {
      admittedPrefixes: ['apps/web', 'packages/shared'],
      closureDigest: 'closure-digest',
      completeness: 'complete',
      controlPaths: ['package.json'],
      definitionDigest: 'definition-digest',
      diagnostics: [],
      includedProjectIds: ['web', 'shared'],
      rootProjectIds: ['web'],
      scopeKey: 'code-graph-scope:web',
    },
    evidence: {
      catalogFingerprint: 'catalog-fingerprint',
      closureDigest: 'closure-digest',
      definitionDigest: 'definition-digest',
      extractorSet: 'extractor-set',
      inventoryFingerprint: 'inventory-fingerprint',
      observedCommit: 'b'.repeat(40),
      policyFingerprint: 'policy-fingerprint',
      repositoryId: analysisSnapshot([], []).repositoryId,
      scopeKey: 'code-graph-scope:web',
      worktreeId: analysisSnapshot([], []).worktreeId,
    },
  };
}

function commandResult(stdout: string): CommandResult {
  return {exitCode: 0, stderr: '', stdout};
}

function systemInfoStub(): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({HOME: '/bootstrap-home', PATH: '/bootstrap-bin'}),
    executablePath: '/opt/bin/bun',
    hardwareInfo: Effect.succeed({
      cpuModel: 'test',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'test',
    }),
    homeDirectory: '/home/test',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/opt/bin/bun', '/src/standalone.ts', 'mcp-server'],
    processId: 1,
    processStartIdentity: () => succeedUndefined,
    readLine: () => () => undefined,
    runtimeVersion: 'test',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/tmp',
    userName: 'test',
  };
}

function codeGraphStatus(options: {readonly ready: boolean; readonly stale: boolean}): CodeGraphStatus {
  const readySnapshot = {...analysisSnapshot([], []), id: `cgsn_${'c'.repeat(40)}`};
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

function codeGraphInspectionResult(
  status: CodeGraphStatus,
  operation: CodeGraphQueryResult['operation'],
): CodeGraphQueryResult {
  const snapshot = status.readySnapshot!;
  return {
    edges: [],
    freshness: status.stale ? 'stale' : 'current',
    nodes: [],
    operation,
    repository: {displayName: status.identity.displayName, repositoryId: status.identity.repositoryId},
    snapshot: {
      commit: snapshot.commit,
      dirty: snapshot.dirty,
      id: snapshot.id,
      worktreeId: status.identity.worktreeId,
    },
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
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

function runtimeConfig(manifestPath = `${TEST_HOME}/seed-manifest.yaml`): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: TEST_HOME,
    agentId: 'analysis-handler-test',
    manifestPath,
    user: 'analysis-handler-test',
  };
}

function graphManifest(projects: readonly string[], projectPath = '/workspace/repository'): string {
  return [
    'version: 1',
    'projects:',
    ...projects.flatMap(name => [
      `  - name: ${name}`,
      `    path: ${projectPath}`,
      '    seed: []',
      `    uri: threadnote://resources/repos/${name}`,
      '    graph:',
      '      closure: dependencies',
      '      roots: [src]',
    ]),
    '',
  ].join('\n');
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
