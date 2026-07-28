import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect} from 'effect';
import {ApplicationLayer} from './effect/runtime.js';
import {withStandaloneProcessLease} from './installations.js';
import {mcpServerEffect} from './mcp_server.js';
import {cliEffect} from './threadnote.js';

const executableName = process.execPath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
const arguments_ = process.argv.slice(2);
const isMcpServer = executableName?.startsWith('threadnote-mcp-server') === true || arguments_[0] === 'mcp-server';
const program = isMcpServer ? Effect.scoped(mcpServerEffect) : cliEffect(arguments_);

BunRuntime.runMain(withStandaloneProcessLease(program).pipe(Effect.provide(ApplicationLayer)), {
  disableErrorReporting: !isMcpServer,
});
