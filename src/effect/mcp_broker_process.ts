import {Cause, Crypto, Effect, Queue} from 'effect';
import {activeInstalledRelease} from '../installations.js';
import {McpBrokerError, runMcpBroker, type McpBrokerChild, type McpBrokerFailureEvent} from '../mcp_broker.js';
import {getRuntimeConfig} from '../runtime.js';
import type {StandaloneActiveRelease} from '../standalone_process_lease.js';
import {resolveTelemetryConfiguration} from '../telemetry/config.js';
import {resolveAgentSession, withAgentSessionEnvironment} from '../telemetry/session.js';
import {SystemInfo, type SystemInfoShape} from './system.js';
import {emitAnonymousTelemetryEvent, withAnonymousTelemetry} from './telemetry.js';

interface ActiveReleaseRequest {
  readonly reject: (cause: unknown) => void;
  readonly resolve: (release: StandaloneActiveRelease | undefined) => void;
}

/** Runtime boundary for the stable MCP broker's stdio and child process. */
const mcpBrokerProgram = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const configuration = yield* getRuntimeConfig();
  const telemetryConfiguration = yield* resolveTelemetryConfiguration(configuration);
  const agentSession = resolveAgentSession({
    configuration: telemetryConfiguration,
    environment: system.environment(),
    randomBytes: yield* crypto.randomBytes(16),
  });
  const brokerFailureEvents = yield* Queue.dropping<McpBrokerFailureEvent>(64);
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(brokerFailureEvents).pipe(
        Effect.flatMap(emitMcpBrokerFailureEvent),
        Effect.catchCause(() => Effect.void),
      ),
    ),
  );
  const activeReleaseRequests = yield* Queue.unbounded<ActiveReleaseRequest>();
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(activeReleaseRequests).pipe(
        Effect.flatMap(request =>
          activeInstalledRelease().pipe(
            Effect.matchCauseEffect({
              onFailure: cause => Effect.sync(() => request.reject(new McpBrokerError(Cause.pretty(cause)))),
              onSuccess: release => Effect.sync(() => request.resolve(release)),
            }),
          ),
        ),
      ),
    ),
  );
  yield* Effect.tryPromise({
    try: () =>
      runMcpBroker({
        agentSessionId: agentSession.id,
        input: Bun.stdin.stream() as AsyncIterable<Uint8Array>,
        onFailure: event => {
          Queue.offerUnsafe(brokerFailureEvents, event);
        },
        readActiveRelease: () =>
          new Promise((resolve, reject) => {
            if (!Queue.offerUnsafe(activeReleaseRequests, {reject, resolve})) {
              reject(new McpBrokerError('Threadnote MCP broker active-release reader is unavailable.'));
            }
          }),
        spawn: (release, childAgentSessionId) =>
          spawnMcpRuntime(release, system, {
            consentGeneration: agentSession.consentGeneration,
            id: childAgentSessionId,
          }),
        writeOutput: writeBrokerOutput,
      }),
    catch: cause =>
      cause instanceof McpBrokerError
        ? cause
        : new McpBrokerError(cause instanceof Error ? cause.message : String(cause)),
  });
});

export const mcpBrokerEffect = withAnonymousTelemetry({component: 'mcp', operation: 'mcp-broker'}, mcpBrokerProgram);

/** @internal Emits one closed, privacy-safe broker recovery observation. */
export function emitMcpBrokerFailureEvent(event: McpBrokerFailureEvent): Effect.Effect<void> {
  return emitAnonymousTelemetryEvent({
    component: 'mcp',
    errorType: 'McpBrokerError',
    event: 'lifecycle',
    operation: mcpBrokerFailureOperation(event),
    outcome: 'failure',
  });
}

function mcpBrokerFailureOperation(event: McpBrokerFailureEvent): string {
  switch (`${event.area}:${event.reason}`) {
    case 'child:exit':
      return 'mcp-broker.child.exit';
    case 'child:spawn':
      return 'mcp-broker.child.spawn';
    case 'child:write':
      return 'mcp-broker.child.write';
    case 'promotion:protocol':
      return 'mcp-broker.promotion.protocol';
    case 'promotion:timeout':
      return 'mcp-broker.promotion.timeout';
    default:
      return 'mcp-broker.unknown';
  }
}

function spawnMcpRuntime(
  release: StandaloneActiveRelease,
  system: SystemInfoShape,
  agentSession: {readonly consentGeneration?: string; readonly id: string},
): McpBrokerChild {
  const separator = release.releaseRoot.endsWith('/') || release.releaseRoot.endsWith('\\') ? '' : '/';
  const executable = `${release.releaseRoot}${separator}${system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'}`;
  const child = Bun.spawn({
    cmd: [executable, 'mcp-server'],
    env: {
      ...withAgentSessionEnvironment(system.environment(), agentSession, 'mcp-server'),
      THREADNOTE_MCP_BROKER_CHILD: '1',
    },
    stdin: 'pipe',
    stderr: 'inherit',
    stdout: 'pipe',
  });
  return {
    exited: child.exited,
    input: child.stdin,
    kill: signal => child.kill(signal),
    output: child.stdout as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
    processId: child.pid,
  };
}

function writeBrokerOutput(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, error => (error ? reject(error) : resolve()));
  });
}
