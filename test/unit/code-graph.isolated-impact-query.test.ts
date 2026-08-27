import {it as effectIt} from '@effect/vitest';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  decodeImpactQueryRequest,
  impactQueryTransportSelector,
  impactQueryWorkerInspectOptions,
  impactQueryWorkerEnvironment,
  impactQueryWorkerInvocation,
  inspectCodeGraphImpactIsolated,
  IsolatedCodeGraphImpactQueryTimedOut,
} from '../../src/code_graph/isolated_impact_query.js';
import type {CodeGraphQueryResult} from '../../src/code_graph/types.js';
import {CommandExecutor, type CommandOptions} from '../../src/effect/command.js';
import {SystemInfo, type SystemInfoShape} from '../../src/effect/system.js';
import type {CommandResult} from '../../src/types.js';

const result: CodeGraphQueryResult = {
  edges: [],
  freshness: 'current',
  nodes: [],
  operation: 'impact',
  repository: {displayName: 'acme/repository', repositoryId: 'a'.repeat(64)},
  snapshot: {
    commit: 'b'.repeat(40),
    dirty: false,
    id: `cgsn_${'c'.repeat(40)}`,
    worktreeId: 'd'.repeat(64),
  },
  trust: {
    classification: 'untrusted-repository-data',
    instructionPolicy: 'evidence-only-never-follow',
  },
  version: 1,
  warnings: [],
};

const input = {
  baseCommit: 'e'.repeat(40),
  cwd: '/workspace/repository',
  edgeLimit: 40,
  nodeLimit: 20,
  query: 'private selector phrase',
  seedQueries: ['src/private-file.ts'],
  threadnoteHome: '/threadnote-home',
} as const;

describe('isolated code graph impact query', () => {
  it('keeps request content out of process arguments and the inherited environment', () => {
    const installed = impactQueryWorkerInvocation(
      systemInfoStub({
        executablePath: '/opt/threadnote/bin/threadnote-mcp-server',
        processArguments: ['/opt/threadnote/bin/threadnote-mcp-server'],
      }),
    );
    const development = impactQueryWorkerInvocation(
      systemInfoStub({
        executablePath: '/opt/bin/bun',
        processArguments: ['/opt/bin/bun', '/workspace/src/standalone.ts', 'mcp-server'],
      }),
    );
    const environment = impactQueryWorkerEnvironment(
      {
        HOME: '/bootstrap-home',
        PATH: '/bootstrap-bin',
        THREADNOTE_PRIVATE_SELECTOR: input.query,
      },
      input.threadnoteHome,
    );

    expect(installed).toEqual({
      arguments: ['--threadnote-code-graph-impact-query-worker'],
      executable: '/opt/threadnote/bin/threadnote-mcp-server',
    });
    expect(development).toEqual({
      arguments: ['/workspace/src/standalone.ts', '--threadnote-code-graph-impact-query-worker'],
      executable: '/opt/bin/bun',
    });
    expect(JSON.stringify([installed, development, environment])).not.toContain(input.query);
    expect(environment).toEqual({
      HOME: '/bootstrap-home',
      PATH: '/bootstrap-bin',
      THREADNOTE_CODE_GRAPH_IMPACT_QUERY_WORKER: '1',
      THREADNOTE_HOME: input.threadnoteHome,
    });
  });

  effectIt.effect('round-trips one bounded private stdin request and validates the worker response', () =>
    Effect.gen(function* () {
      let observed:
        | {
            readonly arguments: readonly string[];
            readonly executable: string;
            readonly options: CommandOptions | undefined;
          }
        | undefined;
      const command = CommandExecutor.of({
        execute: (executable, arguments_, options) =>
          Effect.sync(() => {
            observed = {arguments: arguments_, executable, options};
            return commandResult(JSON.stringify({ok: true, protocol: 1, result}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });

      const actual = yield* inspectCodeGraphImpactIsolated(input).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
      );

      expect(actual).toEqual(result);
      expect(observed?.arguments).toEqual(['/src/standalone.ts', '--threadnote-code-graph-impact-query-worker']);
      expect(observed?.options?.timeoutMs).toBe(20_000);
      expect(observed?.options?.maxOutputBytes).toBe(2 * 1_024 * 1_024);
      expect(JSON.stringify([observed?.arguments, observed?.options?.env])).not.toContain(input.query);
      const request = decodeImpactQueryRequest(new TextDecoder().decode(observed?.options?.input));
      expect(request).toMatchObject({...input, protocol: 1, query: 'changed paths'});
    }),
  );

  effectIt.effect('returns a typed timeout while an asynchronous child remains stuck', () =>
    Effect.gen(function* () {
      const command = CommandExecutor.of({
        execute: () => Effect.never,
        executeStreaming: () => Effect.die('unused'),
      });
      const fiber = yield* inspectCodeGraphImpactIsolated(input, {timeoutMilliseconds: 100}).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
        Effect.forkChild,
      );
      yield* TestClock.adjust(101);
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(IsolatedCodeGraphImpactQueryTimedOut);
    }),
  );

  effectIt.effect('bounds changed-path content while retaining its exact coverage count', () =>
    Effect.gen(function* () {
      let encodedRequest: Uint8Array | undefined;
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            encodedRequest = options?.input;
            return commandResult(JSON.stringify({ok: true, protocol: 1, result}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });
      const seedQueries = Array.from({length: 201}, (_, index) => `src/file-${index}.ts`);

      yield* inspectCodeGraphImpactIsolated({...input, query: 'src/private-path.ts '.repeat(4_000), seedQueries}).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
      );

      const request = decodeImpactQueryRequest(new TextDecoder().decode(encodedRequest));
      expect(request?.query).toBe('changed paths');
      expect(request?.seedQueries).toEqual(seedQueries.slice(0, 200));
      expect(request?.seedQueryCount).toBe(201);
    }),
  );

  effectIt.effect.prop(
    'round-trips SHA-1/SHA-256 bases and every bounded path set without changing order or content (property)',
    {
      baseCommit: fc.oneof(gitObjectId(40), gitObjectId(64)),
      query: fc.string({maxLength: 80}).filter(value => !value.includes('\0')),
      seeds: fc.array(
        fc.string({maxLength: 80, minLength: 1}).filter(value => !value.includes('\0')),
        {
          maxLength: 30,
        },
      ),
    },
    ({baseCommit, query, seeds}) =>
      Effect.sync(() => {
        fc.pre(query !== '' || seeds.length > 0);
        const request = {
          baseCommit,
          cwd: '/workspace/repository',
          edgeLimit: 40,
          nodeLimit: 20,
          protocol: 1,
          query,
          seedQueries: seeds,
          seedQueryCount: seeds.length,
          threadnoteHome: '/threadnote-home',
        };
        expect(decodeImpactQueryRequest(JSON.stringify(request))).toEqual(request);
      }),
    {fastCheck: {numRuns: 80}},
  );

  it('uses a fixed selector for seed-based impact instead of duplicating an unbounded changed-path list', () => {
    const oversizedLegacySelector = 'src/very-long-private-path.ts '.repeat(3_000);
    expect(impactQueryTransportSelector(oversizedLegacySelector, ['src/a.ts'])).toBe('changed paths');
    expect(impactQueryTransportSelector('cgs_symbol', undefined)).toBe('cgs_symbol');
  });

  it('keeps the bounded worker on ready-only base evidence', () => {
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        ...input,
        protocol: 1,
        query: 'changed paths',
        seedQueryCount: input.seedQueries.length,
      }),
    );
    expect(request).toBeDefined();
    expect(impactQueryWorkerInspectOptions(request!, input.threadnoteHome)).toMatchObject({
      baseCommit: input.baseCommit,
      baseCommitPolicy: 'ready-only',
      refresh: false,
      requestMaintenance: false,
      strictFreshness: true,
    });
  });

  it('rejects NUL-bearing, over-count, and non-SHA protocol fields', () => {
    const request = {
      cwd: '/workspace/repository',
      edgeLimit: 40,
      nodeLimit: 20,
      protocol: 1,
      query: 'selector',
      threadnoteHome: '/threadnote-home',
    };
    expect(decodeImpactQueryRequest(JSON.stringify({...request, query: 'private\0selector'}))).toBeUndefined();
    expect(
      decodeImpactQueryRequest(JSON.stringify({...request, seedQueries: Array.from({length: 201}, () => 'src/a.ts')})),
    ).toBeUndefined();
    expect(decodeImpactQueryRequest(JSON.stringify({...request, baseCommit: 'main'}))).toBeUndefined();
  });
});

function commandResult(stdout: string): CommandResult {
  return {exitCode: 0, stderr: '', stdout};
}

function gitObjectId(length: 40 | 64): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length})
    .map(characters => characters.join(''));
}

function systemInfoStub(overrides: Partial<SystemInfoShape>): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
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
