import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Effect} from 'effect';
import {
  assertIsolatedBuilderPlan,
  codeGraphIsolatedBuilderSpawnPlan,
  codeGraphProgressFromBuildStatus,
  isCodeGraphIsolatedBuilderHost,
  isolatedBuilderFailureMessage,
  isolatedBuilderResultFromCompletedStatus,
  shouldAwaitExistingBuilder,
  statusBelongsToChild,
  type CodeGraphIsolatedBuilderSpawnPlan,
} from '../../src/code_graph/isolated_builder.js';
import type {ObservedCodeGraphBuildStatus} from '../../src/code_graph/build_status.js';
import type {SystemInfoShape} from '../../src/effect/system.js';

function systemInfoStub(overrides: Partial<SystemInfoShape>): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
    currentDirectory: () => '/',
    environment: () => ({}),
    executablePath: '/opt/threadnote/bin/threadnote',
    hardwareInfo: () =>
      Effect.succeed({
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
    processStartIdentity: () => Effect.succeed(undefined),
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
  it('reinvokes CLI graph index with --no-vectors, home, and cwd', () => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(
      systemInfoStub({
        environment: () => ({PATH: '/usr/bin', THREADNOTE_HOME: '/old-home'}),
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
      THREADNOTE_HOME: '/home/.threadnote',
    });
    expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
  });

  it('keeps production plans valid across host shapes (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('/repo', '/tmp/worktree'),
        fc.constantFrom('/home/.threadnote', '/tmp/tn-home'),
        fc.boolean(),
        (cwd, home, bunHost) => {
          const plan = codeGraphIsolatedBuilderSpawnPlan(
            systemInfoStub({
              executablePath: bunHost ? '/usr/local/bin/bun' : '/opt/threadnote/bin/threadnote',
              processArguments: bunHost
                ? ['/usr/local/bin/bun', '/src/standalone.ts', 'mcp-server']
                : ['/opt/threadnote/bin/threadnote', '/$bunfs/root/threadnote', 'mcp-server'],
            }),
            {cwd, threadnoteHome: home},
          );
          expect(() => assertIsolatedBuilderPlan(plan)).not.toThrow();
          const graphAt = plan.arguments.indexOf('graph');
          expect(plan.arguments[graphAt + 1]).toBe('index');
          expect(plan.arguments).toContain('--no-vectors');
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
      input: {counters: {}, phase: 'registering' as const},
      expected: {phase: 'registering'},
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
    const allowedWaiting = new Set(['database-writer', 'repository-lock', 'request-lock', 'snapshot-build']);
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
    expect(statusBelongsToChild(status, 7, 'old-build')).toBe(true);
    expect(
      statusBelongsToChild({...status, buildId: 'old-build'} as ObservedCodeGraphBuildStatus, 8, 'old-build'),
    ).toBe(false);
    expect(
      statusBelongsToChild({...status, buildId: 'new-build'} as ObservedCodeGraphBuildStatus, 8, 'old-build'),
    ).toBe(false);
  });
});

describe('isolated builder exit contracts', () => {
  it('surfaces summaries and rejects missing results', async () => {
    expect(isolatedBuilderFailureMessage(1, 'lock contended', 'ignored')).toBe('lock contended');
    expect(isolatedBuilderFailureMessage(2, undefined, '  boom  ')).toBe(
      'isolated graph index exited with code 2: boom',
    );
    expect(isolatedBuilderFailureMessage(3, undefined, undefined)).toBe('isolated graph index exited with code 3');

    await expect(
      Effect.runPromise(
        isolatedBuilderResultFromCompletedStatus({
          result: {dirty: false, edges: 4, files: 1, snapshotId: 'snap', symbols: 2},
        }),
      ),
    ).resolves.toEqual({edges: 4, symbols: 2});
    await expect(Effect.runPromise(isolatedBuilderResultFromCompletedStatus(undefined))).rejects.toThrow(
      /finished without writing a build result/,
    );
  });
});
