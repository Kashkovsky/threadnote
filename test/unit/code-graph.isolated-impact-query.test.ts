import {fcProp} from '../helpers/fast-check-property.js';
import {it as effectIt} from '@effect/vitest';
import {succeedUndefined} from '../../src/effect/optional.js';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  decodeImpactQueryRequest,
  impactQueryWorkerStatusObservation,
  impactQueryTransportSelector,
  impactQueryWorkerInspectOptions,
  impactQueryWorkerEnvironment,
  impactQueryWorkerInvocation,
  inspectCodeGraphIsolated,
  inspectCodeGraphImpactIsolated,
  IsolatedCodeGraphImpactQueryTimedOut,
} from '../../src/code_graph/isolated/impact_query.js';
import type {CodeGraphQueryTelemetryObservation} from '../../src/code_graph/query/contract.js';
import type {CodeGraphQueryScope} from '../../src/code_graph/query/scope.js';
import type {CodeGraphQueryResult, RepositoryIdentity} from '../../src/code_graph/types.js';
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

const projectScope: CodeGraphQueryScope = {
  project: {
    graph: {closure: 'dependencies', include: ['shared'], roots: ['apps/web']},
    name: 'web',
    uri: 'threadnote://projects/web',
  },
  scope: {
    admittedPrefixes: ['apps/web', 'shared'],
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
    repositoryId: 'a'.repeat(64),
    scopeKey: 'code-graph-scope:web',
    worktreeId: 'd'.repeat(64),
  },
};

const identity: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId: 'checkout-id',
  displayName: 'acme/repository',
  gitCommonDirectory: '/workspace/repository/.git',
  headCommit: 'b'.repeat(40),
  objectFormat: 'sha1',
  repoRoot: '/workspace/repository',
  repositoryId: 'a'.repeat(64),
  worktreeId: 'd'.repeat(64),
};

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
    expect(
      impactQueryWorkerInvocation(
        systemInfoStub({
          executablePath: '/opt/bin/bun',
          processArguments: ['/opt/bin/bun'],
        }),
      ),
    ).toEqual({
      arguments: [
        Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url)),
        '--threadnote-code-graph-impact-query-worker',
      ],
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

  effectIt.effect('round-trips ordinary query reads through the isolated worker', () =>
    Effect.gen(function* () {
      let encodedRequest: Uint8Array | undefined;
      const queryResult = {...result, operation: 'query' as const};
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            encodedRequest = options?.input;
            return commandResult(JSON.stringify({ok: true, protocol: 1, result: queryResult}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });

      const actual = yield* inspectCodeGraphIsolated({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'query',
        projectScope,
        query: input.query,
        readySnapshotId: result.snapshot.id,
        threadnoteHome: input.threadnoteHome,
      }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      expect(actual).toEqual(queryResult);
      expect(decodeImpactQueryRequest(new TextDecoder().decode(encodedRequest))).toMatchObject({
        operation: 'query',
        projectScope,
        query: input.query,
        readySnapshotId: result.snapshot.id,
      });
    }),
  );

  it('reuses the parent ready snapshot and resolved project scope in the worker', () => {
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'query',
        projectScope,
        protocol: 1,
        query: input.query,
        readySnapshotId: result.snapshot.id,
        threadnoteHome: input.threadnoteHome,
      }),
    );

    expect(request).toBeDefined();
    expect(impactQueryWorkerStatusObservation(request!, identity)).toEqual({
      borrowedSnapshotId: result.snapshot.id,
      identity,
      projectScope,
    });
  });

  effectIt.effect('accepts every canonical borrowed ready-snapshot identity', () =>
    Effect.gen(function* () {
      const observedSnapshotIds: string[] = [];
      const command = CommandExecutor.of({
        execute: (_executable, _arguments, options) =>
          Effect.sync(() => {
            const request = decodeImpactQueryRequest(new TextDecoder().decode(options?.input));
            observedSnapshotIds.push(request?.borrowedSnapshotId ?? 'missing');
            return commandResult(JSON.stringify({ok: true, protocol: 1, result: {...result, operation: 'query'}}));
          }),
        executeStreaming: () => Effect.die('unused'),
      });
      const snapshotIds = [
        `cgsn_${'a'.repeat(40)}`,
        `cgsn_${'b'.repeat(40)}-direct`,
        `cgsn_${'c'.repeat(40)}-full-${'d'.repeat(16)}`,
      ];

      for (const borrowedSnapshotId of snapshotIds) {
        yield* inspectCodeGraphIsolated({
          borrowedSnapshotId,
          cwd: input.cwd,
          edgeLimit: input.edgeLimit,
          nodeLimit: input.nodeLimit,
          operation: 'query',
          query: input.query,
          threadnoteHome: input.threadnoteHome,
        }).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));
      }

      expect(observedSnapshotIds).toEqual(snapshotIds);
    }),
  );

  effectIt.effect('replays bounded worker query-stage telemetry in the parent process', () =>
    Effect.gen(function* () {
      const observed: CodeGraphQueryTelemetryObservation[] = [];
      const command = CommandExecutor.of({
        execute: () =>
          Effect.succeed(
            commandResult(
              JSON.stringify({
                ok: true,
                protocol: 1,
                result: {...result, operation: 'query'},
                telemetry: [
                  {
                    disposition: 'fallback',
                    durationMilliseconds: 17,
                    outcome: 'success',
                    phase: 'graph.query.execute',
                    stage: 'query-worktree-observation',
                  },
                  {
                    disposition: 'skipped',
                    durationMilliseconds: 0,
                    outcome: 'success',
                    phase: 'graph.query.execute',
                    stage: 'query-strict-reobservation',
                  },
                ],
              }),
            ),
          ),
        executeStreaming: () => Effect.die('unused'),
      });
      const onTelemetryObservation = (observation: CodeGraphQueryTelemetryObservation) =>
        Effect.sync(() => {
          observed.push(observation);
        });

      yield* inspectCodeGraphIsolated(
        {
          cwd: input.cwd,
          edgeLimit: input.edgeLimit,
          nodeLimit: input.nodeLimit,
          operation: 'query',
          query: input.query,
          threadnoteHome: input.threadnoteHome,
        },
        {onTelemetryObservation},
      ).pipe(Effect.provideService(CommandExecutor, command), Effect.provideService(SystemInfo, systemInfoStub({})));

      expect(observed).toEqual([
        {
          disposition: 'fallback',
          durationMilliseconds: 17,
          outcome: 'success',
          phase: 'graph.query.execute',
          stage: 'query-worktree-observation',
        },
        {
          disposition: 'skipped',
          durationMilliseconds: 0,
          outcome: 'success',
          phase: 'graph.query.execute',
          stage: 'query-strict-reobservation',
        },
      ]);
    }),
  );

  effectIt.effect('rejects a worker response for a different inspection operation', () =>
    Effect.gen(function* () {
      const command = CommandExecutor.of({
        execute: () => Effect.succeed(commandResult(JSON.stringify({ok: true, protocol: 1, result}))),
        executeStreaming: () => Effect.die('unused'),
      });

      const failure = yield* inspectCodeGraphIsolated({
        cwd: input.cwd,
        edgeLimit: input.edgeLimit,
        nodeLimit: input.nodeLimit,
        operation: 'query',
        query: input.query,
        threadnoteHome: input.threadnoteHome,
      }).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.provideService(SystemInfo, systemInfoStub({})),
        Effect.flip,
      );

      expect(failure._tag).toBe('IsolatedCodeGraphImpactQueryError');
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

  fcProp(
    effectIt,
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
    ({baseCommit, query, seeds}) => {
      fc.pre(query !== '' || seeds.length > 0);
      const request = {
        baseCommit,
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation: 'impact' as const,
        protocol: 1,
        query,
        seedQueries: seeds,
        seedQueryCount: seeds.length,
        threadnoteHome: '/threadnote-home',
      };
      expect(decodeImpactQueryRequest(JSON.stringify(request))).toEqual(request);
    },
    {fastCheck: {numRuns: 80}},
  );

  fcProp(
    effectIt,
    'round-trips every local inspection operation without changing its selector contract (property)',
    {
      operation: fc.constantFrom('query', 'node', 'neighbors', 'explain', 'path', 'impact'),
      prefixes: fc.array(
        fc.string({maxLength: 40, minLength: 1}).filter(value => !value.includes('\0')),
        {maxLength: 8},
      ),
      snapshotHash: gitObjectId(40),
      selector: fc.string({maxLength: 80, minLength: 1}).filter(value => !value.includes('\0')),
    },
    ({operation, prefixes, selector, snapshotHash}) => {
      const operationFields =
        operation === 'query' || operation === 'impact'
          ? {query: selector}
          : operation === 'node' || operation === 'neighbors'
            ? {nodeId: selector, query: ''}
            : operation === 'path'
              ? {from: selector, query: '', to: `${selector}-target`}
              : {query: '', symbol: selector};
      const request = {
        cwd: '/workspace/repository',
        edgeLimit: 40,
        nodeLimit: 20,
        operation,
        projectScope: {
          ...projectScope,
          scope: {...projectScope.scope!, admittedPrefixes: prefixes},
        },
        protocol: 1,
        readySnapshotId: `cgsn_${snapshotHash}`,
        threadnoteHome: '/threadnote-home',
        ...operationFields,
      };
      const decoded = decodeImpactQueryRequest(JSON.stringify(request));
      expect(decoded).toEqual(request);
      expect(impactQueryWorkerInspectOptions(decoded!, '/threadnote-home')).toMatchObject({
        operation,
        strictFreshness: operation === 'path' || operation === 'impact',
      });
    },
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
        operation: 'impact',
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

  it('reconstructs operation-specific ready-only inspect options', () => {
    const request = decodeImpactQueryRequest(
      JSON.stringify({
        cwd: input.cwd,
        direction: 'incoming',
        edgeLimit: input.edgeLimit,
        nodeId: `cgs_${'a'.repeat(32)}`,
        nodeLimit: input.nodeLimit,
        operation: 'neighbors',
        protocol: 1,
        query: '',
        threadnoteHome: input.threadnoteHome,
      }),
    );
    expect(request).toBeDefined();
    expect(impactQueryWorkerInspectOptions(request!, input.threadnoteHome)).toMatchObject({
      direction: 'incoming',
      nodeId: `cgs_${'a'.repeat(32)}`,
      operation: 'neighbors',
      refresh: false,
      requestMaintenance: false,
      strictFreshness: false,
    });
  });

  it('rejects NUL-bearing, over-count, and non-SHA protocol fields', () => {
    const request = {
      cwd: '/workspace/repository',
      edgeLimit: 40,
      nodeLimit: 20,
      operation: 'impact',
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
    ...overrides,
  };
}
