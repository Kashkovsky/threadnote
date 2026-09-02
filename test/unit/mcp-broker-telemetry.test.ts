import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, Tracer} from 'effect';
import {describe, expect} from 'vitest';
import {emitMcpBrokerFailureEvent} from '../../src/effect/mcp_broker_process.js';
import type {SystemInfoShape} from '../../src/effect/system.js';
import {anonymousTelemetryTestLayer} from '../../src/effect/telemetry.js';
import type {McpBrokerFailureEvent} from '../../src/mcp/broker.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

interface CapturedSpan {
  readonly span: Tracer.NativeSpan;
}

describe('MCP broker anonymous telemetry', () => {
  effectIt.effect('maps every closed broker failure to a path-free lifecycle event', () => {
    const capture = capturingTracer();
    const cases = [
      {area: 'child', reason: 'spawn'},
      {area: 'child', reason: 'write'},
      {area: 'child', reason: 'exit'},
      {area: 'promotion', reason: 'timeout'},
      {area: 'promotion', reason: 'protocol'},
    ] as const satisfies readonly McpBrokerFailureEvent[];

    return Effect.gen(function* () {
      yield* Effect.forEach(cases, emitMcpBrokerFailureEvent, {discard: true});

      expect(capture.spans).toHaveLength(cases.length);
      expect(capture.spans.map(spanAttributes)).toEqual(
        cases.map(event =>
          expect.objectContaining({
            'error.type': 'McpBrokerError',
            'threadnote.component': 'mcp',
            'threadnote.event': 'lifecycle',
            'threadnote.operation': `mcp-broker.${event.area}.${event.reason}`,
            'threadnote.outcome': 'failure',
          }),
        ),
      );
      const serialized = JSON.stringify(capture.spans.map(spanAttributes));
      expect(serialized).not.toContain('/Users/private');
      expect(serialized).not.toContain('private-version');
      expect(serialized).not.toContain('98765');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });

  effectIt.effect('cannot fail the broker boundary when private tracing defects', () => {
    const tracer = Tracer.make({
      span() {
        throw new Error('private tracer failure');
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(emitMcpBrokerFailureEvent({area: 'child', reason: 'exit'}));
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer})));
  });

  effectIt.effect('maps an invalid runtime observation to unknown without reflecting its fields', () => {
    const capture = capturingTracer();
    const invalid = {
      area: 'child',
      error: new Error('private raw error'),
      path: '/Users/private/repository',
      processId: 98_765,
      reason: 'private-version',
    } as unknown as McpBrokerFailureEvent;

    return Effect.gen(function* () {
      yield* emitMcpBrokerFailureEvent(invalid);

      const attributes = spanAttributes(capture.spans[0]);
      expect(attributes).toMatchObject({'threadnote.operation': 'mcp-broker.unknown'});
      const serialized = JSON.stringify(attributes);
      expect(serialized).not.toContain('/Users/private');
      expect(serialized).not.toContain('private raw error');
      expect(serialized).not.toContain('private-version');
      expect(serialized).not.toContain('98765');
    }).pipe(provideTestLayer(anonymousTelemetryTestLayer({system: systemInfoStub(), tracer: capture.tracer})));
  });
});

function capturingTracer(): {readonly spans: CapturedSpan[]; readonly tracer: Tracer.Tracer} {
  const spans: CapturedSpan[] = [];
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

function spanAttributes(captured: CapturedSpan): Record<string, unknown> {
  return Object.fromEntries(captured.span.attributes);
}

function systemInfoStub(): SystemInfoShape {
  return {
    architecture: 'arm64',
    availableDiskBytes: () => Effect.succeed(undefined),
    currentDirectory: () => '/Users/private/repository',
    environment: () => ({}),
    executablePath: '/Users/private/bin/threadnote',
    hardwareInfo: Effect.succeed({
      cpuModel: 'private-model',
      effectiveMemoryBytes: 1,
      memoryBytes: 1,
      operatingSystem: 'private-version',
    }),
    homeDirectory: '/Users/private',
    isProcessRunning: () => false,
    memoryUsage: () => ({external: 0, heapUsed: 0, peakRss: 0, rss: 0}),
    pathDelimiter: ':',
    platform: 'darwin',
    processArguments: ['/Users/private/bin/threadnote'],
    processId: 98_765,
    processStartIdentity: () => Effect.succeed(undefined),
    readLine: () => () => undefined,
    runtimeVersion: 'private-version',
    setEnvironmentVariable: () => undefined,
    setExitCode: () => undefined,
    signalProcess: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: '/Users/private/tmp',
    userName: 'private-user',
  };
}
