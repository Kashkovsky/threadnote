import {execFile, type ChildProcess} from 'node:child_process';
import {basename} from 'node:path';
import {Context, Effect, Layer, Schema} from 'effect';
import type {CommandResult} from '../types.js';

export interface CommandOptions {
  readonly allowFailure?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

const CommandFields = {
  args: Schema.Array(Schema.String),
  executable: Schema.String,
  message: Schema.String,
};

export class CommandFailed extends Schema.TaggedErrorClass<CommandFailed>()('CommandFailed', {
  ...CommandFields,
  exitCode: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
}) {}

export class CommandTimedOut extends Schema.TaggedErrorClass<CommandTimedOut>()('CommandTimedOut', {
  ...CommandFields,
  timeoutMs: Schema.Number,
}) {}

export class CommandOutputLimitExceeded extends Schema.TaggedErrorClass<CommandOutputLimitExceeded>()(
  'CommandOutputLimitExceeded',
  {
    ...CommandFields,
    maxOutputBytes: Schema.Number,
  },
) {}

export class CommandSpawnFailed extends Schema.TaggedErrorClass<CommandSpawnFailed>()('CommandSpawnFailed', {
  ...CommandFields,
  cause: Schema.Defect(),
}) {}

export type CommandExecutionError = CommandFailed | CommandOutputLimitExceeded | CommandSpawnFailed | CommandTimedOut;

export class CommandExecutor extends Context.Service<
  CommandExecutor,
  {
    readonly execute: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, CommandExecutionError>;
  }
>()('threadnote/effect/CommandExecutor') {
  static readonly layer = Layer.sync(CommandExecutor, () => CommandExecutor.of({execute: executeCommand}));
}

export const runCommandEffect = Effect.fn('runCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  const command = yield* CommandExecutor;
  return yield* command.execute(executable, args, options);
});

const executeCommand = Effect.fn('CommandExecutor.execute')((
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) => {
  const maxOutputBytes = options.maxOutputBytes ?? commandMaxOutputBytes();
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs();
  const command = formatCommand(executable, args);
  const run = Effect.callback<CommandResult, CommandExecutionError>(resume => {
    let child: ChildProcess | undefined;
    let finished = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (killEscalationTimer) {
        clearTimeout(killEscalationTimer);
      }
    };
    const terminate = (): void => {
      if (!child || child.exitCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      killEscalationTimer = setTimeout(() => {
        if (!finished && child && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 1000);
      killEscalationTimer.unref?.();
    };
    const complete = (result: CommandResult, error?: CommandExecutionError): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimers();
      if (error && options.allowFailure !== true) {
        resume(Effect.fail(error));
      } else {
        resume(Effect.succeed(result));
      }
    };

    try {
      child = execFile(
        executable,
        [...args],
        {
          cwd: options.cwd,
          encoding: 'utf8',
          env: commandEnvironment(executable, options.env),
          maxBuffer: maxOutputBytes,
        },
        (cause, stdout, stderr) => {
          if (!cause) {
            complete({exitCode: 0, stderr, stdout});
            return;
          }
          const error = cause as Error & {readonly code?: number | string};
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            const outputError = new CommandOutputLimitExceeded({
              args: [...args],
              executable,
              maxOutputBytes,
              message: `${formatCommand(executable, args)} exceeded output limit of ${maxOutputBytes} bytes`,
            });
            complete({exitCode: 124, stderr: outputError.message, stdout}, outputError);
            return;
          }
          if (typeof error.code !== 'number') {
            const spawnError = new CommandSpawnFailed({
              args: [...args],
              cause,
              executable,
              message: `${formatCommand(executable, args)} failed to start: ${error.message}`,
            });
            complete({exitCode: 127, stderr: error.message, stdout}, spawnError);
            return;
          }
          const failed = new CommandFailed({
            args: [...args],
            executable,
            exitCode: error.code,
            message: `${formatCommand(executable, args)} failed: ${stderr || stdout}`,
            stderr,
            stdout,
          });
          complete({exitCode: error.code, stderr, stdout}, failed);
        },
      );
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const spawnError = new CommandSpawnFailed({
        args: [...args],
        cause,
        executable,
        message: `${formatCommand(executable, args)} failed to start: ${error.message}`,
      });
      complete({exitCode: 127, stderr: error.message, stdout: ''}, spawnError);
    }

    return Effect.sync(() => {
      if (!finished) {
        clearTimers();
        terminate();
      }
    });
  });
  if (timeoutMs <= 0) {
    return run;
  }
  const timedOut = new CommandTimedOut({
    args: [...args],
    executable,
    message: `${command} timed out after ${timeoutMs}ms`,
    timeoutMs,
  });
  return run.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        options.allowFailure === true
          ? Effect.succeed({exitCode: 124, stderr: timedOut.message, stdout: ''})
          : Effect.fail(timedOut),
    }),
  );
});

const GIT_ENVIRONMENT_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
] as const;

export function withoutGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = {...env};
  for (const key of GIT_ENVIRONMENT_KEYS) {
    delete next[key];
  }
  return next;
}

function commandEnvironment(executable: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  return basename(executable) === 'git' ? withoutGitEnvironment(env ?? process.env) : env;
}

export function commandTimeoutMs(): number {
  return positiveIntegerFromEnv('THREADNOTE_COMMAND_TIMEOUT_MS') ?? 10 * 60 * 1000;
}

export function commandMaxOutputBytes(): number {
  return positiveIntegerFromEnv('THREADNOTE_COMMAND_MAX_OUTPUT_BYTES') ?? 5 * 1024 * 1024;
}

function positiveIntegerFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].join(' ');
}
