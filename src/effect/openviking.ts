import {Effect, Schema} from 'effect';
import {runCommandEffect} from './command.js';
import {retrySchedule} from './time.js';

export class OpenVikingResourceBusy extends Schema.TaggedErrorClass<OpenVikingResourceBusy>()(
  'OpenVikingResourceBusy',
  {
    message: Schema.String,
    stderr: Schema.String,
    stdout: Schema.String,
  },
) {}

export class OpenVikingRemoveFailed extends Schema.TaggedErrorClass<OpenVikingRemoveFailed>()(
  'OpenVikingRemoveFailed',
  {
    command: Schema.String,
    message: Schema.String,
    stderr: Schema.String,
    stdout: Schema.String,
  },
) {}

export interface RemoveOpenVikingResourceOptions {
  readonly delaysMs?: readonly number[];
  readonly isBusy: (stderr: string, stdout: string) => boolean;
  readonly onAttempt?: (attempt: number) => void;
}

export function removeOpenVikingResourceEffect(
  executable: string,
  args: readonly string[],
  options: RemoveOpenVikingResourceOptions,
) {
  const delaysMs = options.delaysMs ?? [1000, 2000, 3000];
  let attempt = 0;
  const remove = Effect.suspend(() =>
    Effect.gen(function* () {
      options.onAttempt?.(attempt);
      attempt += 1;
      const result = yield* runCommandEffect(executable, args, {allowFailure: true});
      if (result.exitCode === 0) {
        return result;
      }
      if (options.isBusy(result.stderr, result.stdout)) {
        return yield* new OpenVikingResourceBusy({
          message: 'OpenViking resource is busy.',
          stderr: result.stderr,
          stdout: result.stdout,
        });
      }
      const command = [executable, ...args].join(' ');
      return yield* new OpenVikingRemoveFailed({
        command,
        message: `${command} failed: ${result.stderr || result.stdout}`,
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }),
  );

  return remove.pipe(
    Effect.retry({
      schedule: retrySchedule(delaysMs),
      while: error => error instanceof OpenVikingResourceBusy,
    }),
    Effect.catchTag('OpenVikingResourceBusy', () => Effect.succeed(undefined)),
  );
}
