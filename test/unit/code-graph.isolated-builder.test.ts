import {TestError} from '../helpers/test-error.js';
import {succeedUndefined} from '../../src/effect/optional.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {DateTime, Deferred, Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {
  assertIsolatedBuilderPlan,
  awaitOwnedIsolatedBuilderResult,
  codeGraphIsolatedBuilderSpawnPlan,
  codeGraphProgressFromBuildStatus,
  isCodeGraphIsolatedBuilderHost,
  isolatedBuilderFailureMessage,
  isolatedBuilderRequestMatches,
  isolatedBuilderResultFromCompletedStatus,
  runIsolatedCodeGraphIndex,
  shouldAwaitExistingBuilder,
  statusBelongsToChild,
  type CodeGraphIsolatedBuilderSpawnPlan,
} from '../../src/code_graph/isolated_builder.js';
import type {ObservedCodeGraphBuildStatus} from '../../src/code_graph/build_status.js';
import {CodeGraphRuntimeReconnectRequiredError, type RepositoryIdentity} from '../../src/code_graph/types.js';
import type {SystemInfoShape} from '../../src/effect/system.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {mkdtempSync, rmSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

function systemInfoStub(overrides: Partial<SystemInfoShape>): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => succeedUndefined,
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
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
    processArguments: ['/opt/threadnote/bin/threadnote'],
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
    ...overrides,
  };
}

describe('isolated code-graph builder host detection', () => {
  it('detects installed and development MCP hosts, not CLI graph index children', () => {
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
      }),
    ).toBe(true);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/usr/local/bin/bun',
        processArguments: ['/usr/local/bin/bun', '/src/standalone.ts', 'mcp-server'],
      }),
    ).toBe(true);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote-mcp-server',
        processArguments: ['/opt/threadnote/bin/threadnote-mcp-server'],
      }),
    ).toBe(true);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: [
          '/opt/threadnote/bin/threadnote',
          '/$bunfs/root/threadnote',
          'graph',
          'index',
          '--cwd',
          '/repo',
        ],
      }),
    ).toBe(false);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/usr/local/bin/bun',
        processArguments: ['/usr/local/bin/bun', '/src/standalone.ts', 'graph', 'index', '--cwd', '/repo'],
      }),
    ).toBe(false);
    expect(
      isCodeGraphIsolatedBuilderHost({
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'recall', 'mcp-server'],
      }),
    ).toBe(false);
  });
});

describe('isolated code-graph builder spawn plan', () => {
  it('reuses completed results only for exact request-key equality', () => {
    const status = {request: {key: 'request-a'}} as ObservedCodeGraphBuildStatus;
    expect(isolatedBuilderRequestMatches(status, 'request-a')).toBe(true);
    expect(isolatedBuilderRequestMatches(status, 'request-b')).toBe(false);
    expect(isolatedBuilderRequestMatches(status, undefined)).toBe(false);
  });

  it('checks runtime compatibility before observing or spawning a child', async () => {
    const identity: RepositoryIdentity = {
      caseMode: 'sensitive',
      checkoutId: 'a'.repeat(64),
      displayName: 'fixture/repository',
      gitCommonDirectory: '/fixture/repository/.git',
      headCommit: 'b'.repeat(40),
      objectFormat: 'sha1',
      repoRoot: '/fixture/repository',
      repositoryId: 'c'.repeat(64),
      worktreeId: 'd'.repeat(64),
    };
    const failure = CodeGraphRuntimeReconnectRequiredError.of();
    let spawnCalls = 0;

    await expect(
      runEffect(
        runIsolatedCodeGraphIndex({
          assertRuntimeSchemaCompatible: databasePath => {
            expect(databasePath).toContain(identity.checkoutId);
            return Effect.fail(failure);
          },
          cwd: identity.repoRoot,
          resolveIdentity: () => Effect.succeed(identity),
          spawn: () => {
            spawnCalls += 1;
            throw TestError.make({message: 'spawn must not run'});
          },
          threadnoteHome: '/fixture/home',
        }),
      ),
    ).rejects.toBe(failure);
    expect(spawnCalls).toBe(0);
  });

  it('reinvokes CLI graph index with --no-vectors, home, and cwd', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(
      systemInfoStub({
        environment: () => ({
          PATH: '/usr/bin',
          THREADNOTE_HOME: '/old-home',
          THREADNOTE_TELEMETRY_SESSION_ID: 'tns_000102030405060708090a0b0c0d0e0f',
          THREADNOTE_TELEMETRY_CONSENT_GENERATION: 'tng_000102030405060708090a0b0c0d0e0f',
        }),
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
      }),
      {cwd: '/repo/worktree', threadnoteHome: '/home/.threadnote'},
    );
    expect(plan.executable).toBe('/opt/threadnote/bin/threadnote');
    expect(plan.arguments).toEqual([
      '--home',
      '/home/.threadnote',
      'graph',
      'index',
      '--no-vectors',
      '--cwd',
      '/repo/worktree',
    ]);
    expect(plan.environment).toEqual({
      PATH: '/usr/bin',
      THREADNOTE_CODE_GRAPH_BUILDER_ADMISSION_CLASS: 'current-required',
      THREADNOTE_HOME: '/home/.threadnote',
      THREADNOTE_TELEMETRY_CHILD: 'graph-builder',
      THREADNOTE_TELEMETRY_CONSENT_GENERATION: 'tng_000102030405060708090a0b0c0d0e0f',
      THREADNOTE_TELEMETRY_SESSION_ID: 'tns_000102030405060708090a0b0c0d0e0f',
    });
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('forwards a Manager full rebuild without disabling vectors', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(systemInfoStub({}), {
      cwd: '/repo/worktree',
      full: true,
      noVectors: false,
      threadnoteHome: '/home/.threadnote',
    });

    expect(plan.arguments).toEqual([
      '--home',
      '/home/.threadnote',
      'graph',
      'index',
      '--full',
      '--cwd',
      '/repo/worktree',
    ]);
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('keeps production plans valid across host shapes (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('/repo', '/tmp/worktree'),
        fc.constantFrom('/home/.threadnote', '/tmp/tn-home'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (cwd, home, bunHost, full, noVectors) => {
          const plan = codeGraphIsolatedBuilderSpawnPlan(
            systemInfoStub({
              executablePath: bunHost ? '/usr/local/bin/bun' : '/opt/threadnote/bin/threadnote',
              processArguments: bunHost
                ? ['/usr/local/bin/bun', '/src/standalone.ts', 'mcp-server']
                : ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
            }),
            {cwd, full, noVectors, threadnoteHome: home},
          );
          expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
          const graphAt = plan.arguments.indexOf('graph');
          expect(plan.arguments[graphAt + 1]).toBe('index');
          expect(plan.arguments.includes('--full')).toBe(full);
          expect(plan.arguments.includes('--no-vectors')).toBe(noVectors);
          expect(plan.arguments[plan.arguments.indexOf('--cwd') + 1]).toBe(cwd);
          expect(plan.arguments[plan.arguments.indexOf('--home') + 1]).toBe(home);
        },
      ),
      {numRuns: 40},
    );
  });

  it('rejects MCP launcher, mcp-server prefix, and missing graph index', () => {
    const base: CodeGraphIsolatedBuilderSpawnPlan = {
      arguments: ['--home', '/home', 'graph', 'index', '--cwd', '/repo'],
      environment: {},
      executable: '/opt/threadnote/bin/threadnote',
    };
    expect(() => assertIsolatedBuilderPlan({...base, executable: '/opt/threadnote/bin/threadnote-mcp-server'})).toThrow(
      /must not spawn the MCP launcher/,
    );
    expect(() =>
      assertIsolatedBuilderPlan({...base, arguments: ['mcp-server', 'graph', 'index', '--cwd', '/repo']}),
    ).toThrow(/must not spawn an MCP server/);
    expect(() => assertIsolatedBuilderPlan({...base, arguments: ['--home', '/home', '--cwd', '/repo']})).toThrow(
      /must invoke `graph index`/,
    );
  });
});

describe('codeGraphProgressFromBuildStatus', () => {
  const cases = [
    {
      description: 'registering',
      input: {
        counters: {},
        phase: 'registering' as const,
        registration: {
          activity: {elapsedMilliseconds: 250, generations: 2, keys: 400, stage: 'loading-cache' as const},
        },
      },
      expected: {
        activity: {elapsedMilliseconds: 250, generations: 2, keys: 400, stage: 'loading-cache'},
        phase: 'registering',
      },
    },
    {
      description: 'scanning counters',
      input: {
        counters: {accepted: 2, completed: 5, excluded: 1, skipped: 0, total: 10},
        phase: 'scanning' as const,
      },
      expected: {
        accepted: 2,
        completed: 5,
        excluded: 1,
        phase: 'scanning',
        skipped: 0,
        total: 10,
        unit: 'files',
      },
    },
    {
      description: 'materializing counters',
      input: {counters: {completed: 3, reused: 1, total: 9}, phase: 'materializing' as const},
      expected: {completed: 3, phase: 'materializing', reused: 1, total: 9, unit: 'files'},
    },
    {
      description: 'disk-capacity waiting',
      input: {counters: {}, phase: 'waiting' as const, subphase: 'disk-capacity'},
      expected: {phase: 'waiting', reason: 'disk-capacity'},
    },
  ] as const;

  for (const testCase of cases) {
    it(`maps ${testCase.description}`, () => {
      expect(codeGraphProgressFromBuildStatus(testCase.input)).toEqual(testCase.expected);
    });
  }

  it('keeps phase variants valid and filters unsupported waiting reasons (property)', () => {
    const phases = [
      'registering',
      'waiting',
      'reclaiming',
      'scanning',
      'materializing',
      'resolving',
      'activating',
      'embedding',
    ] as const;
    const allowedWaiting = new Set([
      'database-writer',
      'disk-capacity',
      'home-builder-cap',
      'repository-lock',
      'request-lock',
      'snapshot-build',
    ]);
    fc.assert(
      fc.property(
        fc.constantFrom(...phases),
        fc.nat({max: 100}),
        fc.option(fc.string({maxLength: 24}), {nil: undefined}),
        (phase, n, subphase) => {
          const progress = codeGraphProgressFromBuildStatus({
            counters: {
              accepted: n,
              completed: n,
              edges: n,
              embedded: n,
              excluded: n,
              pagesCompleted: n,
              resolved: n,
              reused: n,
              rowsDeleted: n,
              skipped: n,
              symbols: n,
              total: n + 1,
            },
            phase,
            subphase: phase === 'resolving' ? 'complete' : subphase,
          });
          expect(progress.phase).toBe(phase);
          if (progress.phase === 'waiting') {
            if (progress.reason !== undefined) expect(allowedWaiting.has(progress.reason)).toBe(true);
          }
          if (progress.phase === 'scanning' || progress.phase === 'materializing') {
            expect(progress.unit).toBe('files');
            expect(progress.total).toBe(n + 1);
          }
          if (progress.phase === 'embedding') expect(progress.unit).toBe('symbols');
          if (progress.phase === 'reclaiming') expect(progress.unit).toBe('snapshots');
        },
      ),
      {numRuns: 80},
    );
  });
});

describe('shouldAwaitExistingBuilder and statusBelongsToChild', () => {
  it('elects exactly one owner for every cross-host observe-then-spawn permutation', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({max: 10_000, min: 2}), {maxLength: 20, minLength: 1}), callers => {
        let status: ObservedCodeGraphBuildStatus | undefined;
        let owners = 0;
        const waiters: number[] = [];
        for (const processId of callers) {
          if (shouldAwaitExistingBuilder(status, processId)) {
            waiters.push(processId);
            continue;
          }
          owners += 1;
          status = {
            observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
            owner: {processId, runtime: 'bun', runtimeVersion: '1'},
          } as ObservedCodeGraphBuildStatus;
        }

        expect(owners).toBe(1);
        const completedSnapshotId = 'owner-snapshot';
        expect(waiters.map(() => completedSnapshotId)).toEqual(callers.slice(1).map(() => completedSnapshotId));
      }),
      {numRuns: 100},
    );
  });

  it('awaits active and stalled foreign builders only', () => {
    const livenessValues = ['abandoned', 'active', 'completed', 'failed', 'stalled'] as const;
    fc.assert(
      fc.property(fc.constantFrom(...livenessValues), fc.integer({min: 1, max: 1000}), (liveness, ownerPid) => {
        const status = {
          observation: {heartbeatAgeMilliseconds: 0, liveness},
          owner: {processId: ownerPid, runtime: 'bun' as const, runtimeVersion: '1'},
        } as ObservedCodeGraphBuildStatus;
        expect(shouldAwaitExistingBuilder(status, 99)).toBe(
          (liveness === 'active' || liveness === 'stalled') && ownerPid !== 99,
        );
      }),
      {numRuns: 40},
    );
  });

  it('matches child ownership by pid and rejects the prior build id', () => {
    const status = {
      buildId: 'old-build',
      owner: {processId: 7, runtime: 'bun' as const, runtimeVersion: '1'},
    } as ObservedCodeGraphBuildStatus;
    expect(statusBelongsToChild(status, 7, 'old-build')).toBe(false);
    expect(statusBelongsToChild({...status, buildId: 'new-build'}, 7, 'old-build')).toBe(true);
    expect(statusBelongsToChild({...status, buildId: 'old-build'}, 8, 'old-build')).toBe(false);
    expect(statusBelongsToChild({...status, buildId: 'new-build'}, 8, 'old-build')).toBe(false);
    expect(statusBelongsToChild({...status, buildId: 'other-build'}, 7, 'old-build', 'new-build')).toBe(false);
  });
});

describe('isolated builder exit contracts', () => {
  effectIt.effect('surfaces summaries and rejects missing results', () =>
    Effect.gen(function* () {
      expect(isolatedBuilderFailureMessage(1, 'lock contended', 'ignored')).toBe('lock contended');
      expect(isolatedBuilderFailureMessage(2, undefined, '  boom  ')).toBe(
        'isolated graph index exited with code 2: boom',
      );
      expect(isolatedBuilderFailureMessage(3, undefined, undefined)).toBe('isolated graph index exited with code 3');

      expect(
        yield* isolatedBuilderResultFromCompletedStatus({
          result: {dirty: false, edges: 4, files: 1, snapshotId: 'snap', symbols: 2},
        }),
      ).toEqual({dirty: false, edges: 4, files: 1, snapshotId: 'snap', symbols: 2});
      expect(String(yield* Effect.flip(isolatedBuilderResultFromCompletedStatus(undefined)))).toMatch(
        /finished without writing a build result/,
      );
    }),
  );

  effectIt.effect('waits for the exact owned result during a bounded post-exit grace', () =>
    Effect.gen(function* () {
      const ownedPending = {
        buildId: 'owned-build',
        owner: {processId: 7, runtime: 'bun' as const, runtimeVersion: '1'},
      } as ObservedCodeGraphBuildStatus;
      const ownedCompleted = {
        ...ownedPending,
        result: {dirty: false, edges: 41, files: 3, snapshotId: 'snapshot', symbols: 29},
      } as ObservedCodeGraphBuildStatus;
      const statuses = [undefined, ownedPending, ownedCompleted] as const;
      let reads = 0;
      const result = yield* awaitOwnedIsolatedBuilderResult(
        Effect.sync(() => statuses[Math.min(reads++, statuses.length - 1)]),
        7,
        'prior-build',
        undefined,
        {pollMilliseconds: 100, timeoutMilliseconds: 500},
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(200);

      expect(yield* Fiber.join(result)).toEqual({
        dirty: false,
        edges: 41,
        files: 3,
        snapshotId: 'snapshot',
        symbols: 29,
      });
      expect(reads).toBe(3);
    }),
  );

  effectIt.effect('fails at the grace deadline when only unrelated results are visible', () =>
    Effect.gen(function* () {
      let reads = 0;
      const unrelated = {
        buildId: 'other-build',
        owner: {processId: 8, runtime: 'bun' as const, runtimeVersion: '1'},
        result: {dirty: false, edges: 999, files: 1, snapshotId: 'other', symbols: 999},
      } as ObservedCodeGraphBuildStatus;
      const outcome = yield* awaitOwnedIsolatedBuilderResult(
        Effect.sync(() => {
          reads += 1;
          return unrelated;
        }),
        7,
        'prior-build',
        'owned-build',
        {pollMilliseconds: 100, timeoutMilliseconds: 300},
      ).pipe(
        Effect.match({
          onFailure: error => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => 'unexpected success',
        }),
        Effect.forkChild,
      );

      yield* TestClock.adjust(300);

      expect(yield* Fiber.join(outcome)).toMatch(/finished without writing a build result/);
      expect(reads).toBe(4);
    }),
  );

  effectIt.effect('remains interruptible while awaiting the result sidecar', () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* awaitOwnedIsolatedBuilderResult(
        Effect.sync(() => {
          reads += 1;
          return undefined;
        }),
        7,
        'prior-build',
        'owned-build',
        {pollMilliseconds: 100, timeoutMilliseconds: 2_000},
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(100);
      expect(reads).toBe(2);
      yield* Fiber.interrupt(result);
      yield* TestClock.adjust(2_000);
      expect(reads).toBe(2);
    }),
  );

  effectIt.effect.prop(
    'never accepts a foreign, prior, or different-build result while polling (property)',
    {
      sequence: fc.array(fc.constantFrom('absent', 'foreign', 'prior', 'different-build', 'owned-pending'), {
        maxLength: 12,
      }),
    },
    ({sequence}) =>
      Effect.gen(function* () {
        const statusFor = (kind: (typeof sequence)[number]): ObservedCodeGraphBuildStatus | undefined => {
          if (kind === 'absent') return undefined;
          const buildId =
            kind === 'prior' ? 'prior-build' : kind === 'different-build' ? 'different-build' : 'owned-build';
          const processId = kind === 'foreign' ? 8 : 7;
          return {
            buildId,
            owner: {processId, runtime: 'bun' as const, runtimeVersion: '1'},
            ...(kind === 'owned-pending'
              ? {}
              : {result: {dirty: false, edges: 999, files: 1, snapshotId: kind, symbols: 999}}),
          } as ObservedCodeGraphBuildStatus;
        };
        const ownedCompleted = {
          buildId: 'owned-build',
          owner: {processId: 7, runtime: 'bun' as const, runtimeVersion: '1'},
          result: {dirty: false, edges: 41, files: 3, snapshotId: 'owned', symbols: 29},
        } as ObservedCodeGraphBuildStatus;
        const statuses = [...sequence.map(statusFor), ownedCompleted];
        let reads = 0;

        expect(
          yield* awaitOwnedIsolatedBuilderResult(
            Effect.sync(() => statuses[Math.min(reads++, statuses.length - 1)]),
            7,
            'prior-build',
            'owned-build',
            {pollMilliseconds: 0, timeoutMilliseconds: 10_000},
          ),
        ).toEqual({dirty: false, edges: 41, files: 3, snapshotId: 'owned', symbols: 29});
        expect(reads).toBe(statuses.length);
      }),
    {fastCheck: {numRuns: 60}},
  );
});

describe('isolated builder cross-host spawn admission', () => {
  effectIt.effect('spawns once for concurrent callers on one worktree and attaches the waiter', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-isolated-spawn-'))),
        home =>
          Effect.gen(function* () {
            const identity: RepositoryIdentity = {
              caseMode: 'sensitive',
              checkoutId: 'a'.repeat(64),
              displayName: 'fixture/repository',
              gitCommonDirectory: '/fixture/repository/.git',
              headCommit: 'b'.repeat(40),
              objectFormat: 'sha1',
              repoRoot: '/fixture/repository',
              repositoryId: 'c'.repeat(64),
              worktreeId: 'd'.repeat(64),
            };
            let status: ObservedCodeGraphBuildStatus | undefined;
            let resolveExit: ((code: number) => void) | undefined;
            let spawnCalls = 0;
            const waiterAttached = yield* Deferred.make<void>();
            const activeStatus = {
              buildId: 'owned-build',
              counters: {},
              identity: {
                checkoutId: identity.checkoutId,
                commit: identity.headCommit,
                repositoryId: identity.repositoryId,
                worktreeId: identity.worktreeId,
              },
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
              owner: {processId: 77, runtime: 'bun' as const, runtimeVersion: '1'},
              phase: 'registering' as const,
              request: {key: 'request-a'},
              schemaVersion: 2,
              state: 'running' as const,
              timestamps: {
                heartbeatAt: DateTime.formatIso(yield* DateTime.now),
                lastProgressAt: DateTime.formatIso(yield* DateTime.now),
                phaseStartedAt: DateTime.formatIso(yield* DateTime.now),
                startedAt: DateTime.formatIso(yield* DateTime.now),
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            } as unknown as ObservedCodeGraphBuildStatus;
            const options = {
              assertRuntimeSchemaCompatible: () => Effect.void,
              cwd: identity.repoRoot,
              readStatus: Effect.sync(() => status),
              resolveIdentity: () => Effect.succeed(identity),
              requestKey: 'request-a',
              spawn: () => {
                spawnCalls += 1;
                status = activeStatus;
                return {
                  exited: new Promise<number>(resolve => {
                    resolveExit = resolve;
                  }),
                  kill: () => undefined,
                  processId: 77,
                };
              },
              threadnoteHome: home,
            };

            const owner = yield* runIsolatedCodeGraphIndex(options).pipe(Effect.forkChild);
            while (spawnCalls < 1 || resolveExit === undefined) yield* Effect.yieldNow;
            const waiter = yield* runIsolatedCodeGraphIndex({
              ...options,
              onProgress: progress =>
                progress.phase === 'registering'
                  ? Deferred.succeed(waiterAttached, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            }).pipe(Effect.forkChild);
            yield* Deferred.await(waiterAttached);
            status = {
              ...activeStatus,
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'completed'},
              result: {dirty: false, edges: 11, files: 2, snapshotId: 'snapshot', symbols: 7},
              state: 'completed',
            };
            resolveExit(0);

            expect(yield* Effect.all([Fiber.join(owner), Fiber.join(waiter)], {concurrency: 'unbounded'})).toEqual([
              {
                dirty: false,
                edges: 11,
                files: 2,
                requestKey: 'request-a',
                snapshotId: 'snapshot',
                symbols: 7,
              },
              {
                dirty: false,
                edges: 11,
                files: 2,
                requestKey: 'request-a',
                snapshotId: 'snapshot',
                symbols: 7,
              },
            ]);
            expect(spawnCalls).toBe(1);
          }),
        home => Effect.sync(() => rmSync(home, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('serializes differing request targets and never reuses the first result as fresh', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-isolated-targets-'))),
        home =>
          Effect.gen(function* () {
            const identity: RepositoryIdentity = {
              caseMode: 'sensitive',
              checkoutId: 'a'.repeat(64),
              displayName: 'fixture/repository',
              gitCommonDirectory: '/fixture/repository/.git',
              headCommit: 'b'.repeat(40),
              objectFormat: 'sha1',
              repoRoot: '/fixture/repository',
              repositoryId: 'c'.repeat(64),
              worktreeId: 'd'.repeat(64),
            };
            let status: ObservedCodeGraphBuildStatus | undefined;
            const exits: Array<(code: number) => void> = [];
            let spawnCalls = 0;
            const runningStatus = (ordinal: number) =>
              ({
                buildId: `owned-build-${ordinal}`,
                counters: {},
                identity: {
                  checkoutId: identity.checkoutId,
                  commit: identity.headCommit,
                  repositoryId: identity.repositoryId,
                  worktreeId: identity.worktreeId,
                },
                observation: {heartbeatAgeMilliseconds: 0, liveness: 'active'},
                owner: {processId: 77 + ordinal, runtime: 'bun' as const, runtimeVersion: '1'},
                phase: 'registering' as const,
                request: {key: ordinal === 0 ? 'request-a' : 'request-b'},
                schemaVersion: 2,
                state: 'running' as const,
                timestamps: {
                  heartbeatAt: new Date().toISOString(),
                  lastProgressAt: new Date().toISOString(),
                  phaseStartedAt: new Date().toISOString(),
                  startedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              }) as unknown as ObservedCodeGraphBuildStatus;
            const common = {
              assertRuntimeSchemaCompatible: () => Effect.void,
              cwd: identity.repoRoot,
              readStatus: Effect.sync(() => status),
              resolveIdentity: () => Effect.succeed(identity),
              spawn: () => {
                const ordinal = spawnCalls++;
                status = runningStatus(ordinal);
                return {
                  exited: new Promise<number>(resolve => exits.push(resolve)),
                  kill: () => undefined,
                  processId: 77 + ordinal,
                };
              },
              threadnoteHome: home,
            };

            const owner = yield* runIsolatedCodeGraphIndex({...common, requestKey: 'request-a'}).pipe(Effect.forkChild);
            while (spawnCalls < 1 || exits[0] === undefined) yield* Effect.yieldNow;
            const waiter = yield* runIsolatedCodeGraphIndex({...common, requestKey: 'request-b'}).pipe(
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            status = {
              ...runningStatus(0),
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'completed'},
              result: {dirty: false, edges: 11, files: 2, snapshotId: 'snapshot-a', symbols: 7},
              state: 'completed',
            };
            exits[0](0);

            expect(yield* Fiber.join(owner)).toEqual({
              dirty: false,
              edges: 11,
              files: 2,
              requestKey: 'request-a',
              snapshotId: 'snapshot-a',
              symbols: 7,
            });
            while (spawnCalls < 2 || exits[1] === undefined) yield* Effect.yieldNow;
            status = {
              ...runningStatus(1),
              observation: {heartbeatAgeMilliseconds: 0, liveness: 'completed'},
              result: {dirty: true, edges: 13, files: 1, snapshotId: 'snapshot-b', symbols: 9},
              state: 'completed',
            };
            exits[1](0);

            expect(yield* Fiber.join(waiter)).toEqual({
              dirty: true,
              edges: 13,
              files: 1,
              requestKey: 'request-b',
              snapshotId: 'snapshot-b',
              symbols: 9,
            });
            expect(spawnCalls).toBe(2);
          }),
        home => Effect.sync(() => rmSync(home, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});
