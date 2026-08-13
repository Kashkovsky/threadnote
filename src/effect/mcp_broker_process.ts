import {Cause, Effect, Queue} from 'effect';
import {activeInstalledRelease} from '../installations.js';
import {McpBrokerError, runMcpBroker, type McpBrokerChild} from '../mcp_broker.js';
import type {StandaloneActiveRelease} from '../standalone_process_lease.js';
import {SystemInfo, type SystemInfoShape} from './system.js';
import {triggerAutoUpdateIfEnabled} from '../auto_update.js';

const AUTO_UPDATE_CHECK_INTERVAL_MILLISECONDS = 15 * 60 * 1_000;

interface ActiveReleaseRequest {
  readonly reject: (cause: unknown) => void;
  readonly resolve: (release: StandaloneActiveRelease | undefined) => void;
}

/** Runtime boundary for the stable MCP broker's stdio and child process. */
export const mcpBrokerEffect = Effect.gen(function* () {
  const system = yield* SystemInfo;
  yield* triggerAutoUpdateIfEnabled().pipe(Effect.ignore);
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(AUTO_UPDATE_CHECK_INTERVAL_MILLISECONDS).pipe(
        Effect.andThen(triggerAutoUpdateIfEnabled()),
        Effect.ignore,
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
        input: Bun.stdin.stream() as AsyncIterable<Uint8Array>,
        readActiveRelease: () =>
          new Promise((resolve, reject) => {
            if (!Queue.offerUnsafe(activeReleaseRequests, {reject, resolve})) {
              reject(new McpBrokerError('Threadnote MCP broker active-release reader is unavailable.'));
            }
          }),
        spawn: release => spawnMcpRuntime(release, system),
        writeOutput: writeBrokerOutput,
      }),
    catch: cause =>
      cause instanceof McpBrokerError
        ? cause
        : new McpBrokerError(cause instanceof Error ? cause.message : String(cause)),
  });
});

function spawnMcpRuntime(release: StandaloneActiveRelease, system: SystemInfoShape): McpBrokerChild {
  const separator = release.releaseRoot.endsWith('/') || release.releaseRoot.endsWith('\\') ? '' : '/';
  const executable = `${release.releaseRoot}${separator}${system.platform === 'win32' ? 'threadnote.exe' : 'threadnote'}`;
  const child = Bun.spawn({
    cmd: [executable, 'mcp-server'],
    env: {...system.environment(), THREADNOTE_MCP_BROKER_CHILD: '1'},
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
