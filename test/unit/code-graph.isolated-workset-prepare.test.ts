import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV,
  codeGraphIsolatedWorksetPrepareSpawnPlan,
  decodeIsolatedWorksetPrepareProgress,
  decodeIsolatedWorksetPrepareResult,
} from '../../src/code_graph/workset_catalog/isolated_prepare.js';
import type {SystemInfoShape} from '../../src/effect/system.js';
import {Effect} from 'effect';

function systemInfoStub(overrides: Partial<SystemInfoShape> = {}): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
    currentDirectory: () => '/',
    environment: () => ({
      PATH: '/usr/bin',
      THREADNOTE_TELEMETRY_CONSENT_GENERATION: 'tng_000102030405060708090a0b0c0d0e0f',
      THREADNOTE_TELEMETRY_SESSION_ID: 'tns_000102030405060708090a0b0c0d0e0f',
    }),
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

const progress = {
  activity: {completed: 5, phase: 'scanning', total: 10, unit: 'files'},
  attempt: 1,
  completed: 0,
  elapsedMilliseconds: 2_500,
  maxAttempts: 2,
  message: 'Workset indexing · api · scanning 5/10 files.',
  phase: 'indexing',
  project: 'api',
  total: 2,
  type: 'code-graph-workset-progress',
  version: 1,
  workset: 'platform',
} as const;

const result = {
  coverage: {complete: true, excluded: 0, failed: 0, missing: 0, ready: 1, requested: 1},
  manifestDigest: 'a'.repeat(64),
  members: [
    {
      project: 'api',
      projectionDigest: 'b'.repeat(64),
      repositoryId: 'c'.repeat(64),
      snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
      state: 'ready',
      symbolCount: 42,
    },
  ],
  published: {
    digest: 'e'.repeat(64),
    id: 'cgwg_fixture',
    manifestDigest: 'a'.repeat(64),
    memberCount: 1,
    state: 'ready',
    worksetName: 'platform',
  },
  state: 'ready',
  type: 'code-graph-workset-prepare',
  version: 1,
  workset: 'platform',
} as const;

describe('isolated Manager workset preparation', () => {
  it('spawns the exact runtime with JSON progress and isolated member builders', () => {
    const plan = codeGraphIsolatedWorksetPrepareSpawnPlan(systemInfoStub(), {
      concurrency: 2,
      manifestPath: '/home/.threadnote/seed-manifest.yaml',
      threadnoteHome: '/home/.threadnote',
      workset: 'platform',
    });

    expect(plan).toMatchObject({
      arguments: [
        '--home',
        '/home/.threadnote',
        '--manifest',
        '/home/.threadnote/seed-manifest.yaml',
        'workset',
        'prepare',
        '--json',
        '--concurrency',
        '2',
        'platform',
      ],
      executable: '/opt/threadnote/bin/threadnote',
    });
    expect(plan.environment).toMatchObject({
      [CODE_GRAPH_MANAGER_WORKSET_ORCHESTRATOR_ENV]: '1',
      THREADNOTE_HOME: '/home/.threadnote',
      THREADNOTE_MANIFEST: '/home/.threadnote/seed-manifest.yaml',
      THREADNOTE_TELEMETRY_CHILD: 'graph-builder',
    });
  });

  it('preserves bounded concurrency and targets across installed and development runtimes (property)', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 8}), fc.boolean(), (concurrency, development) => {
        const plan = codeGraphIsolatedWorksetPrepareSpawnPlan(
          systemInfoStub(
            development
              ? {
                  executablePath: '/usr/local/bin/bun',
                  processArguments: ['/usr/local/bin/bun', '/src/standalone.ts', 'manage'],
                }
              : {},
          ),
          {
            concurrency,
            manifestPath: '/fixture/manifest.yaml',
            threadnoteHome: '/fixture/home',
            workset: 'platform',
          },
        );

        expect(plan.arguments[plan.arguments.indexOf('--concurrency') + 1]).toBe(String(concurrency));
        expect(plan.arguments.at(-1)).toBe('platform');
        expect(plan.arguments.filter(argument => argument === 'workset')).toHaveLength(1);
        expect(plan.arguments.includes('/src/standalone.ts')).toBe(development);
      }),
      {numRuns: 40},
    );
  });

  it('decodes existing CLI progress into a bounded path-free Manager projection', () => {
    const decoded = decodeIsolatedWorksetPrepareProgress(
      JSON.stringify({...progress, privatePath: '/private/repository'}),
    );

    expect(decoded).toEqual(progress);
    expect(JSON.stringify(decoded)).not.toContain('/private/repository');
    expect(decodeIsolatedWorksetPrepareProgress(JSON.stringify({...progress, completed: -1}))).toBeUndefined();
    expect(decodeIsolatedWorksetPrepareProgress('not-json')).toBeUndefined();
  });

  it('decodes the final publication receipt and rejects malformed authority', () => {
    const decoded = decodeIsolatedWorksetPrepareResult(JSON.stringify({...result, privatePath: '/private/repository'}));

    expect(decoded).toEqual(result);
    expect(JSON.stringify(decoded)).not.toContain('/private/repository');
    expect(
      decodeIsolatedWorksetPrepareResult(JSON.stringify({...result, manifestDigest: 'not-a-digest'})),
    ).toBeUndefined();
    expect(decodeIsolatedWorksetPrepareResult(JSON.stringify({...result, state: 'staging'}))).toBeUndefined();
  });
});
