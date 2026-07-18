#! /usr/bin/env node

import {NodeRuntime, NodeServices} from '@effect/platform-node';
import {Effect} from 'effect';
import {Command} from 'effect/unstable/cli';
import {errorMessage} from './utils.js';
import {getThreadnoteVersion} from './version.js';
import {ApplicationLayer} from './effect/runtime.js';
import {ApplicationError} from './effect/errors.js';
import {CliError, normalizeCliArguments, threadnoteCommand} from './effect/cli.js';

const program = Command.runWith(threadnoteCommand, {version: getThreadnoteVersion()})(
  normalizeCliArguments(process.argv.slice(2)),
).pipe(
  Effect.provide(ApplicationLayer),
  Effect.provide(NodeServices.layer),
  Effect.tapError(error =>
    CliError.isCliError(error)
      ? Effect.void
      : Effect.sync(() => console.error(errorMessage(error instanceof ApplicationError ? error.cause : error))),
  ),
  Effect.catch(() =>
    Effect.sync(() => {
      process.exitCode = 1;
    }),
  ),
);

NodeRuntime.runMain(program, {disableErrorReporting: true});
