import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect} from 'effect';
import {LOCAL_MODEL_WORKER_ARGUMENT, nativeLocalModelWorkerServer} from './effect/ai/isolated-local-model-runtime.js';
import {ApplicationLayer} from './effect/runtime.js';
import {SystemInfo} from './effect/system.js';
import {inspectCliInvocation} from './effect/cli.js';
import {withStandaloneProcessLease} from './installations.js';
import {mcpServerEffect} from './mcp_server.js';
import {
  threadnoteHomeForProcess,
  withThreadnoteProcessRegistration,
  type ThreadnoteProcessRole,
} from './process_diagnostics.js';
import {cliEffect} from './threadnote.js';

const executableName = process.execPath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
const arguments_ = process.argv.slice(2);
const isLocalModelWorker = arguments_[0] === LOCAL_MODEL_WORKER_ARGUMENT;
const isMcpServer = executableName?.startsWith('threadnote-mcp-server') === true || arguments_[0] === 'mcp-server';
const cliOperation = isLocalModelWorker || isMcpServer ? undefined : inspectCliInvocation(arguments_).operation;
const processRole: ThreadnoteProcessRole = isLocalModelWorker
  ? 'local-model-worker'
  : isMcpServer
    ? 'mcp'
    : cliOperation === 'manage'
      ? 'manager'
      : 'cli';
const processOperation = isLocalModelWorker
  ? 'model-stdio'
  : isMcpServer
    ? 'mcp-server'
    : cliOperation === 'manage'
      ? 'manager-ui'
      : cliOperation;
const mainProgram = isMcpServer ? Effect.scoped(mcpServerEffect) : cliEffect(arguments_);
const processHome = threadnoteHomeForProcess(arguments_, process.env).pipe(
  Effect.tap(home =>
    Effect.sync(() => {
      // Normalize CLI-only --home into the environment inherited by the
      // crash-isolated model worker and by the direct MCP entrypoint. Runtime
      // diagnostics and model storage must remain in the same Threadnote home.
      process.env.THREADNOTE_HOME = home;
    }),
  ),
);
// The worker owns a separate PID-scoped release lease. If its parent is killed,
// the release must remain pinned until the worker observes closed stdin and exits.
const program = isLocalModelWorker
  ? processHome.pipe(
      Effect.flatMap(processHome =>
        withStandaloneProcessLease(
          withThreadnoteProcessRegistration(
            processHome,
            processRole,
            Effect.scoped(nativeLocalModelWorkerServer),
            processOperation,
          ),
        ),
      ),
      Effect.provide(SystemInfo.layer),
      Effect.provide(BunServices.layer),
    )
  : processHome.pipe(
      Effect.flatMap(processHome =>
        withStandaloneProcessLease(
          withThreadnoteProcessRegistration(processHome, processRole, mainProgram, processOperation),
        ),
      ),
      Effect.provide(ApplicationLayer),
    );

BunRuntime.runMain(program, {
  disableErrorReporting: isLocalModelWorker || !isMcpServer,
});
