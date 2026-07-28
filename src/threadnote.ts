import {Console, Effect} from 'effect';
import {Command} from 'effect/unstable/cli';
import {errorMessage} from './utils.js';
import {getThreadnoteVersion} from './version.js';
import {ApplicationError} from './effect/errors.js';
import {CliError, normalizeCliArguments, threadnoteCommand} from './effect/cli.js';
import {initializeCliUi} from './cli_ui.js';
import {SystemInfo} from './effect/system.js';

export const cliEffect = (arguments_: readonly string[]) =>
  Effect.gen(function* () {
    yield* initializeCliUi();
    const version = yield* getThreadnoteVersion();
    return yield* Command.runWith(threadnoteCommand, {version})(normalizeCliArguments(arguments_));
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
  );
