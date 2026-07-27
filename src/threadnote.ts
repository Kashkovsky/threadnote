#! /usr/bin/env node

import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import {Console, Effect} from 'effect';
import {Command} from 'effect/unstable/cli';
import {errorMessage} from './utils.js';
import {getThreadnoteVersion} from './version.js';
import {ApplicationLayer} from './effect/runtime.js';
import {ApplicationError} from './effect/errors.js';
import {CliError, normalizeCliArguments, threadnoteCommand} from './effect/cli.js';
import {initializeCliUi} from './cli_ui.js';
import {SystemInfo} from './effect/system.js';

const program = Effect.gen(function* () {
  yield* initializeCliUi();
  const version = yield* getThreadnoteVersion();
  const system = yield* SystemInfo;
  return yield* Command.runWith(threadnoteCommand, {version})(normalizeCliArguments(system.processArguments.slice(2)));
}).pipe(
  Effect.catchDefect(defect =>
    Effect.gen(function* () {
      yield* Console.error(errorMessage(defect));
      const system = yield* SystemInfo;
      yield* Effect.sync(() => system.setExitCode(1));
    }),
  ),
  Effect.tapError(error =>
    CliError.isCliError(error)
      ? Effect.void
      : Console.error(errorMessage(error instanceof ApplicationError ? error.cause : error)),
  ),
  Effect.catch(() => Effect.flatMap(SystemInfo, system => Effect.sync(() => system.setExitCode(1)))),
  Effect.provide(ApplicationLayer),
);

NodeRuntime.runMain(program, {disableErrorReporting: true});
