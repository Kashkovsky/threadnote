import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Effect, Exit, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  codeGraphAnonymousTelemetryComponent,
  codeGraphAnonymousTelemetryFields,
  emitCodeGraphBackgroundFailure,
  makeCodeGraphAnonymousTelemetryReporter,
} from '../../src/code_graph/anonymous_telemetry.js';
import {CodeGraphStorePermissionError, type CodeGraphProgress} from '../../src/code_graph/types.js';
import {anonymousTelemetryTestLayer} from '../../src/effect/telemetry.js';
import type {SystemInfoShape} from '../../src/effect/system.js';
import {
  anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure,
  anonymousTelemetryDiagnosticFromError,
} from '../../src/telemetry/diagnostic.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph anonymous telemetry', () => {
  it('maps graph phases to the closed anonymous progress vocabulary', () => {
    expect(codeGraphAnonymousTelemetryFields({phase: 'registering'})).toEqual({phase: 'graph.registering'});
    expect(codeGraphAnonymousTelemetryFields({phase: 'waiting', reason: 'database-writer'})).toEqual({
      phase: 'graph.waiting',
      waitingReason: 'database-writer',
    });
    expect(
      codeGraphAnonymousTelemetryFields({
        completed: 3,
        pagesCompleted: 2,
        phase: 'reclaiming',
        rowsDeleted: 100,
        total: 8,
        unit: 'snapshots',
      }),
    ).toEqual({completed: 3, phase: 'graph.reclaiming', total: 8});
    expect(
      codeGraphAnonymousTelemetryFields({
        edges: 100,
        phase: 'resolving',
        resolved: 90,
        subphase: 'complete',
        symbols: 20,
      }),
    ).toEqual({completed: 90, phase: 'graph.resolving', subphase: 'complete', total: 100});
    expect(
      codeGraphAnonymousTelemetryFields({
        activity: {
          elapsedMilliseconds: 400,
          rows: 2_000,
          stage: 'copying-edges',
          stageElapsedMilliseconds: 100,
          state: 'progress',
          transactionMilliseconds: 80,
        },
        phase: 'activating',
        snapshotId: 'private-snapshot-id',
        subphase: 'writing-and-checkpointing',
      }),
    ).toEqual({
      elapsedMilliseconds: 400,
      phase: 'graph.activating',
      stage: 'copying-edges',
      stageElapsedMilliseconds: 100,
      subphase: 'writing-and-checkpointing',
      transactionMilliseconds: 80,
    });
  });

  it('derives only the closed graph component label from process context', () => {
    expect(codeGraphAnonymousTelemetryComponent({})).toBe('cli');
    expect(codeGraphAnonymousTelemetryComponent({THREADNOTE_MCP_BROKER_CHILD: '1'})).toBe('mcp');
    expect(codeGraphAnonymousTelemetryComponent({THREADNOTE_MCP_BROKER_CHILD: '/Users/private'})).toBe('cli');
  });

  it('is noninterfering with path, language, classifier, role, and other per-file metadata', () => {
    fc.assert(
      fc.property(
        fc.record({
          completed: fc.nat({max: 1_000_000}),
          degradedFiles: fc.nat({max: 1_000_000}),
          factsBytesCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          sourceBytesCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          sourceBytesTotal: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          total: fc.nat({max: 1_000_000}),
          workUnitsCompleted: fc.nat({max: Number.MAX_SAFE_INTEGER}),
          workUnitsTotal: fc.nat({max: Number.MAX_SAFE_INTEGER}),
        }),
        fc.record({
          classifier: fc.string(),
          language: fc.string(),
          path: fc.string(),
          role: fc.string(),
        }),
        fc.record({
          classifier: fc.string(),
          language: fc.string(),
          path: fc.string(),
          role: fc.string(),
        }),
        (counters, firstPrivate, secondPrivate) => {
          const first = scanningProgress(counters, firstPrivate);
          const second = scanningProgress(counters, secondPrivate);
          const projected = codeGraphAnonymousTelemetryFields(first);

          expect(projected).toEqual(codeGraphAnonymousTelemetryFields(second));
          expect(Object.keys(projected)).not.toEqual(
            expect.arrayContaining(['classifier', 'degraded', 'language', 'path', 'role', 'sizeBucket']),
          );
        },
      ),
      {numRuns: 64},
    );
  });

  effectIt.effect('emits on phase changes and once per minute with bucketed path-free graph progress', () => {
    const capture = capturingTracer();
    const report = makeCodeGraphAnonymousTelemetryReporter('mcp');
    const scanning = scanningProgress(
      {
        completed: 9,
        degradedFiles: 123,
        factsBytesCompleted: 129,
        sourceBytesCompleted: 65,
        sourceBytesTotal: 513,
        total: 17,
        workUnitsCompleted: 33,
        workUnitsTotal: 257,
      },
      {
        classifier: 'private-classifier',
        language: 'private-language',
        path: '/Users/private/secret-repository.ts',
        role: 'private-role',
      },
    );

    return Effect.gen(function* () {
      yield* report(scanning);
      yield* report(scanning);
      yield* TestClock.adjust('59 seconds');
      yield* report(scanning);
      expect(capture.spans).toHaveLength(1);

      yield* TestClock.adjust('1 second');
      yield* report(scanning);
      yield* report({phase: 'waiting', reason: 'repository-lock'});

      expect(capture.spans).toHaveLength(3);
      const first = Object.fromEntries(capture.spans[0]!.span.attributes);
      expect(first).toMatchObject({
        'threadnote.component': 'mcp',
        'threadnote.event': 'checkpoint',
        'threadnote.graph.degradation_reason': 'rss',
        'threadnote.operation': 'graph-build',
        'threadnote.phase': 'graph.scanning',
        'threadnote.stage': 'extracting',
        'threadnote.work.completed_bucket': '2^3',
        'threadnote.work.degraded_files_bucket': '2^6',
        'threadnote.work.facts_bytes_completed_bucket': '2^7',
        'threadnote.work.source_bytes_completed_bucket': '2^6',
        'threadnote.work.source_bytes_total_bucket': '2^9',
        'threadnote.work.total_bucket': '2^4',
        'threadnote.work.units_completed_bucket': '2^5',
        'threadnote.work.units_total_bucket': '2^8',
      });
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain('/Users/private');
      expect(serialized).not.toContain('private-classifier');
      expect(serialized).not.toContain('private-language');
      expect(serialized).not.toContain('private-role');

      expect(Object.fromEntries(capture.spans[2]!.span.attributes)).toMatchObject({
        'threadnote.phase': 'graph.waiting',
        'threadnote.waiting_reason': 'repository-lock',
      });
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('emits closed terminal events for detached refresh and maintenance failures', () => {
    const capture = capturingTracer();

    return Effect.gen(function* () {
      yield* emitCodeGraphBackgroundFailure(
        'mcp',
        'graph-refresh',
        anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure({
          code: 'busy',
          operation: 'refresh code graph',
          recovery: 'defer',
          retryable: true,
        }),
      );
      yield* emitCodeGraphBackgroundFailure(
        'cli',
        'graph-maintenance',
        anonymousTelemetryDiagnosticFromError(
          new CodeGraphStorePermissionError('private failure at /Users/private/graph.sqlite', {
            operation: 'run routine code graph maintenance',
          }),
        ),
      );

      const attributes = capture.spans.map(captured => Object.fromEntries(captured.span.attributes));
      expect(attributes).toEqual([
        expect.objectContaining({
          'error.type': 'CodeGraphStoreError',
          'threadnote.component': 'mcp',
          'threadnote.event': 'lifecycle',
          'threadnote.failure.code': 'busy',
          'threadnote.failure.domain': 'code-graph-storage',
          'threadnote.failure.operation': 'refresh-code-graph',
          'threadnote.failure.recovery': 'defer',
          'threadnote.failure.retryable': true,
          'threadnote.operation': 'graph-refresh',
          'threadnote.outcome': 'failure',
        }),
        expect.objectContaining({
          'error.type': 'CodeGraphStorePermissionError',
          'threadnote.component': 'cli',
          'threadnote.event': 'lifecycle',
          'threadnote.failure.code': 'permission',
          'threadnote.failure.domain': 'code-graph-storage',
          'threadnote.failure.operation': 'run-routine-code-graph-maintenance',
          'threadnote.failure.recovery': 'fix-permissions',
          'threadnote.failure.retryable': false,
          'threadnote.operation': 'graph-maintenance',
          'threadnote.outcome': 'failure',
        }),
      ]);
      expect(JSON.stringify(attributes)).not.toContain('/Users/private');
      expect(JSON.stringify(attributes)).not.toContain('private failure');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });
});

function scanningProgress(
  counters: {
    readonly completed: number;
    readonly degradedFiles?: number;
    readonly factsBytesCompleted: number;
    readonly sourceBytesCompleted: number;
    readonly sourceBytesTotal: number;
    readonly total: number;
    readonly workUnitsCompleted: number;
    readonly workUnitsTotal: number;
  },
  privateFields: {
    readonly classifier: string;
    readonly language: string;
    readonly path: string;
    readonly role: string;
  },
): Extract<CodeGraphProgress, {readonly phase: 'scanning'}> {
  return {
    accepted: counters.completed,
    activity: {
      batchCompleted: counters.completed,
      batchTotal: counters.total,
      bytes: counters.sourceBytesCompleted,
      classifier: privateFields.classifier,
      degraded: true,
      degradationReason: 'rss',
      factsBytes: counters.factsBytesCompleted,
      language: privateFields.language,
      path: privateFields.path,
      role: privateFields.role,
      sizeBucket: '>1MiB',
      stage: 'extracting',
    },
    completed: counters.completed,
    excluded: 1,
    metrics: {
      ...(counters.degradedFiles === undefined ? {} : {degradedFiles: counters.degradedFiles}),
      factsBytesCompleted: counters.factsBytesCompleted,
      sourceBytesCompleted: counters.sourceBytesCompleted,
      sourceBytesTotal: counters.sourceBytesTotal,
      workUnitsCompleted: counters.workUnitsCompleted,
      workUnitsTotal: counters.workUnitsTotal,
    },
    phase: 'scanning',
    skipped: 2,
    total: counters.total,
    unit: 'files',
  };
}

function capturingTracer(): {
  readonly spans: readonly {readonly span: Tracer.NativeSpan}[];
  readonly tracer: Tracer.Tracer;
} {
  const spans: Array<{readonly span: Tracer.NativeSpan}> = [];
  return {
    spans,
    tracer: Tracer.make({
      span(options) {
        return new (class extends Tracer.NativeSpan {
          override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
            super.end(endTime, exit);
            spans.push({span: this});
          }
        })(options);
      },
    }),
  };
}

function systemInfoStub(): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
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
  };
}
