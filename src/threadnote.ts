import {Console, Effect} from 'effect';
import {Command} from 'effect/unstable/cli';
import {errorMessage} from './utils.js';
import {getThreadnoteVersion} from './version.js';
import {ApplicationError} from './effect/errors.js';
import {CliError, inspectCliInvocation, normalizeCliArguments, threadnoteCommand} from './effect/cli.js';
import {initializeCliUi} from './cli_ui.js';
import {SystemInfo} from './effect/system.js';
import {withProductionLogging} from './effect/production_log.js';
import {expandPath} from './utils.js';

export const cliEffect = (arguments_: readonly string[]) => {
  const program = Effect.gen(function* () {
    yield* initializeCliUi();
    const version = yield* getThreadnoteVersion();
    return yield* Command.runWith(threadnoteCommand, {version})(normalizeCliArguments(arguments_));
  });
  const loggedProgram = cliProductionLogContext(arguments_).pipe(
    Effect.matchEffect({
      onFailure: () => program,
      onSuccess: context =>
        context === undefined
          ? program
          : withProductionLogging(context.home, {component: 'cli', operation: context.operation}, program),
    }),
  );
  return loggedProgram.pipe(
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
};

const cliProductionLogContext = Effect.fn('threadnote.cliProductionLogContext')(function* (
  arguments_: readonly string[],
) {
  const invocation = inspectCliInvocation(arguments_);
  if (!invocation.writeProductionLog || invocation.operation === undefined) {
    return undefined;
  }
  const system = yield* SystemInfo;
  const home = yield* expandPath(invocation.homeOverride ?? system.environment().THREADNOTE_HOME ?? '~/.threadnote');
  return {home, operation: invocation.operation};
});
