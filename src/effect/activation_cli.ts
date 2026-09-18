import {Console, Effect, Schema} from 'effect';
import {Command} from 'effect/unstable/cli';
import {boolean, requiredString} from './cli_flags.js';

export interface ActivationCliRequest {
  readonly activationId?: string;
  readonly apply: boolean;
  readonly command: 'start' | 'continue' | 'status' | 'undo';
}

export class ActivationCliError extends Schema.TaggedError<ActivationCliError>()('ActivationCliError', {
  message: Schema.String,
}) {}

export type ActivationCliRunner<R = never> = (
  request: ActivationCliRequest,
) => Effect.Effect<void, ActivationCliError, R>;

const apply = boolean('apply', 'Apply only the next explicitly permitted activation work');
const approved = boolean('approved', 'Apply the previewed undo plan');

/** Small registration shell. Product adapters own raw input observation and print bounded next-action identifiers. */
export function makeActivationCommand<R>(run: ActivationCliRunner<R>) {
  const start = Command.make('start', {apply}, ({apply}) => run({apply, command: 'start'}));
  const continue_ = Command.make(
    'continue',
    {activationId: requiredString('activation-id', 'Exact activation ID returned by activate start'), apply},
    ({activationId, apply}) => run({activationId, apply, command: 'continue'}),
  );
  const status = Command.make(
    'status',
    {activationId: requiredString('activation-id', 'Exact activation ID returned by activate start')},
    ({activationId}) => run({activationId, apply: false, command: 'status'}),
  );
  const undo = Command.make(
    'undo',
    {activationId: requiredString('activation-id', 'Exact activation ID returned by activate start'), approved},
    ({activationId, approved}) => run({activationId, apply: approved, command: 'undo'}),
  );
  return Command.make('activate').pipe(
    Command.withDescription('Preview and resume a two-surface guided activation'),
    Command.withSubcommands([start, continue_, status, undo]),
  );
}

/** Temporary production adapter until catalog/import/proof adapters are wired; it deliberately performs no hidden work. */
export const runUnavailableActivationCli = (_request: ActivationCliRequest) =>
  Console.error(
    'Guided activation requires the installed catalog/import/proof adapters. No activation state or external changes were made.',
  ).pipe(Effect.andThen(ActivationCliError.make({message: 'Activation capability unavailable.'})));
