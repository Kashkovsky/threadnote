import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect} from 'effect';
import {LOCAL_MODEL_WORKER_ARGUMENT, nativeLocalModelWorkerServer} from './effect/ai/isolated-local-model-runtime.js';
import {ApplicationLayer} from './effect/runtime.js';
import {SystemInfo} from './effect/system.js';
import {withStandaloneProcessLease} from './installations.js';
import {mcpServerEffect} from './mcp_server.js';
import {cliEffect} from './threadnote.js';

const executableName = process.execPath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
const arguments_ = process.argv.slice(2);
const isLocalModelWorker = arguments_[0] === LOCAL_MODEL_WORKER_ARGUMENT;
const isMcpServer = executableName?.startsWith('threadnote-mcp-server') === true || arguments_[0] === 'mcp-server';
const mainProgram = isMcpServer ? Effect.scoped(mcpServerEffect) : cliEffect(arguments_);
const program = isLocalModelWorker
  ? Effect.scoped(nativeLocalModelWorkerServer).pipe(
      Effect.provide(SystemInfo.layer),
      Effect.provide(BunServices.layer),
    )
  : withStandaloneProcessLease(mainProgram).pipe(Effect.provide(ApplicationLayer));

BunRuntime.runMain(program, {
  disableErrorReporting: isLocalModelWorker || !isMcpServer,
});
