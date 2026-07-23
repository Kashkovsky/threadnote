import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {Console, Context, Effect, Layer, Schema} from 'effect';
import {command as commandText, info, warning} from '../cli_ui.js';
import {redactSensitiveText} from '../scrubber.js';
import type {CommandResult} from '../types.js';

export interface CommandOptions {
  readonly allowFailure?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface CommandInvocation {
  readonly args: readonly string[];
  readonly executable: string;
  readonly windowsVerbatimArguments: boolean;
}

export interface StreamingCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputChars?: number;
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

export class CommandTerminationFailed extends Schema.TaggedErrorClass<CommandTerminationFailed>()(
  'CommandTerminationFailed',
  {
    ...CommandFields,
    cause: Schema.Defect(),
    pid: Schema.Number,
  },
) {}

export type CommandExecutionError =
  CommandFailed | CommandOutputLimitExceeded | CommandSpawnFailed | CommandTerminationFailed | CommandTimedOut;

export class CommandExecutor extends Context.Service<
  CommandExecutor,
  {
    readonly execute: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, CommandExecutionError>;
    readonly executeStreaming?: (
      executable: string,
      args: readonly string[],
      options?: StreamingCommandOptions,
    ) => Effect.Effect<CommandResult>;
  }
>()('threadnote/effect/CommandExecutor') {
  static readonly layer = Layer.sync(CommandExecutor, () =>
    CommandExecutor.of({execute: executeCommand, executeStreaming: executeStreamingCommand}),
  );
}

export const runCommandEffect = Effect.fn('runCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) {
  const command = yield* CommandExecutor;
  return yield* command.execute(executable, args, options);
});

export const runStreamingCommandEffect = Effect.fn('runStreamingCommandEffect')(function* (
  executable: string,
  args: readonly string[],
  options: StreamingCommandOptions = {},
) {
  const command = yield* CommandExecutor;
  return yield* (command.executeStreaming ?? executeStreamingCommand)(executable, args, options);
});

export const maybeRunEffect = Effect.fn('maybeRunEffect')(function* (
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  options: Pick<CommandOptions, 'allowFailure' | 'cwd' | 'timeoutMs'> = {},
) {
  const cwdSuffix = options.cwd ? ` (cwd: ${options.cwd})` : '';
  const label = dryRun ? warning('Would run') : info('Running');
  yield* Console.log(`${label}: ${commandText(formatShellCommand(executable, args))}${cwdSuffix}`);
  if (dryRun) {
    return undefined;
  }
  const result = yield* runCommandEffect(executable, args, options);
  if (result.stdout.trim()) {
    yield* Console.log(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    yield* Console.error(result.stderr.trim());
  }
  return result;
});

const executeCommand = Effect.fn('CommandExecutor.execute')((
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
) => {
  const maxOutputBytes = options.maxOutputBytes ?? commandMaxOutputBytes();
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs();
  const command = formatShellCommand(executable, args);
  const safeArgs = redactCommandArgs(args);
  const safeExecutable = redactSensitiveText(executable);
  const invocation = resolveCommandInvocation(executable, args);
  const run = Effect.callback<CommandResult, CommandExecutionError>(resume => {
    let child: ChildProcess | undefined;
    let finished = false;
    const complete = (result: CommandResult, error?: CommandExecutionError): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (error && options.allowFailure !== true) {
        resume(Effect.fail(error));
      } else {
        resume(Effect.succeed(result));
      }
    };

    try {
      child = execFile(
        invocation.executable,
        [...invocation.args],
        {
          cwd: options.cwd,
          encoding: 'utf8',
          env: commandEnvironment(executable, options.env),
          maxBuffer: maxOutputBytes,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        },
        (cause, stdout, stderr) => {
          if (!cause) {
            complete({exitCode: 0, stderr, stdout});
            return;
          }
          const error = cause as Error & {readonly code?: number | string};
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            const outputError = new CommandOutputLimitExceeded({
              args: safeArgs,
              executable: safeExecutable,
              maxOutputBytes,
              message: `${command} exceeded output limit of ${maxOutputBytes} bytes`,
            });
            complete({exitCode: 124, stderr: outputError.message, stdout}, outputError);
            return;
          }
          if (typeof error.code !== 'number') {
            const spawnError = new CommandSpawnFailed({
              args: safeArgs,
              cause: redactedError(error),
              executable: safeExecutable,
              message: redactSensitiveText(`${command} failed to start: ${error.message}`),
            });
            complete({exitCode: 127, stderr: error.message, stdout}, spawnError);
            return;
          }
          const failed = new CommandFailed({
            args: safeArgs,
            executable: safeExecutable,
            exitCode: error.code,
            message: redactSensitiveText(`${command} failed: ${stderr || stdout}`),
            stderr: redactSensitiveText(stderr),
            stdout: redactSensitiveText(stdout),
          });
          complete({exitCode: error.code, stderr, stdout}, failed);
        },
      );
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const spawnError = new CommandSpawnFailed({
        args: safeArgs,
        cause: redactedError(error),
        executable: safeExecutable,
        message: redactSensitiveText(`${command} failed to start: ${error.message}`),
      });
      complete({exitCode: 127, stderr: error.message, stdout: ''}, spawnError);
    }

    return child && !finished
      ? terminationCleanupEffect(child, invocation, false).pipe(
          Effect.andThen(Effect.sleep(1000)),
          Effect.andThen(
            Effect.suspend(() =>
              child && child.exitCode === null ? terminationCleanupEffect(child, invocation, true) : Effect.void,
            ),
          ),
        )
      : Effect.void;
  });
  if (timeoutMs <= 0) {
    return run;
  }
  const timedOut = new CommandTimedOut({
    args: safeArgs,
    executable: safeExecutable,
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

const executeStreamingCommand = Effect.fn('CommandExecutor.executeStreaming')((
  executable: string,
  args: readonly string[],
  options: StreamingCommandOptions = {},
) => {
  const invocation = resolveCommandInvocation(executable, args);
  const maxOutputChars = options.maxOutputChars ?? 64_000;
  return Effect.callback<CommandResult>(resume => {
    let child: ChildProcess | undefined;
    let finished = false;
    let stderr = '';
    let stdout = '';
    const appendTail = (current: string, chunk: string): string => {
      const next = `${current}${chunk}`;
      return next.length <= maxOutputChars ? next : next.slice(next.length - maxOutputChars);
    };
    const complete = (result: CommandResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      resume(Effect.succeed(result));
    };
    try {
      child = spawn(invocation.executable, invocation.args, {
        env: options.env,
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      child.stdout?.on('data', chunk => {
        const text = String(chunk);
        process.stdout.write(text);
        stdout = appendTail(stdout, text);
      });
      child.stderr?.on('data', chunk => {
        const text = String(chunk);
        process.stderr.write(text);
        stderr = appendTail(stderr, text);
      });
      child.on('error', cause => {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`${message}\n`);
        complete({exitCode: 1, stderr: appendTail(stderr, message), stdout});
      });
      child.on('close', code => complete({exitCode: code ?? 1, stderr, stdout}));
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      complete({exitCode: 1, stderr: appendTail(stderr, message), stdout});
    }
    return child && !finished ? terminationCleanupEffect(child, invocation, true) : Effect.void;
  });
});

const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;

export function resolveCommandInvocation(
  executable: string,
  args: readonly string[],
  currentPlatform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): CommandInvocation {
  if (currentPlatform !== 'win32' || !/\.(?:bat|cmd)$/i.test(executable)) {
    return {args, executable, windowsVerbatimArguments: false};
  }
  for (const value of [executable, ...args]) {
    if (value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error('Windows batch commands do not accept NUL, CR, or LF characters.');
    }
  }
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const command = escapeWindowsCommand(executable);
  const escapedArgs = args.map(arg => escapeWindowsArgument(arg, doubleEscape));
  return {
    args: ['/d', '/s', '/c', `"${[command, ...escapedArgs].join(' ')}"`],
    executable: comspec,
    windowsVerbatimArguments: true,
  };
}

function escapeWindowsCommand(value: string): string {
  return value.replace(WINDOWS_COMMAND_META, '^$1');
}

function escapeWindowsArgument(value: string, doubleEscape: boolean): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`.replace(WINDOWS_COMMAND_META, '^$1');
  return doubleEscape ? escaped.replace(WINDOWS_COMMAND_META, '^$1') : escaped;
}

export function isGitExecutable(executable: string): boolean {
  const name = executable.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return /^(?:git)(?:\.(?:bat|cmd|com|exe))?$/i.test(name);
}

export function windowsTaskkillExecutable(): string {
  return `${(process.env.SystemRoot ?? 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\taskkill.exe`;
}

export function terminateCommandProcessEffect(
  child: ChildProcess,
  _invocation: CommandInvocation,
  force: boolean,
): Effect.Effect<void, CommandTerminationFailed> {
  return Effect.callback<void, CommandTerminationFailed>(resume => {
    beginCommandProcessTermination(child, force, cause => {
      if (cause && child.exitCode === null) {
        resume(
          Effect.fail(
            new CommandTerminationFailed({
              args: [],
              cause: redactedError(cause),
              executable: windowsTaskkillExecutable(),
              message: redactSensitiveText(
                `Could not terminate process tree ${child.pid ?? 'unknown'}: ${cause.message}`,
              ),
              pid: child.pid ?? -1,
            }),
          ),
        );
        return;
      }
      resume(Effect.void);
    });
  });
}

function terminationCleanupEffect(child: ChildProcess, invocation: CommandInvocation, force: boolean) {
  return terminateCommandProcessEffect(child, invocation, force).pipe(
    Effect.catch(error =>
      Effect.sync(() => {
        process.stderr.write(`Warning: ${error.message}\n`);
      }),
    ),
  );
}

export function terminateCommandProcess(
  child: ChildProcess,
  _invocation: CommandInvocation,
  force: boolean,
): Promise<void> {
  return new Promise((resolveTermination, rejectTermination) => {
    beginCommandProcessTermination(child, force, cause => {
      if (cause && child.exitCode === null) {
        rejectTermination(cause);
      } else {
        resolveTermination();
      }
    });
  });
}

function beginCommandProcessTermination(child: ChildProcess, force: boolean, complete: (cause?: Error) => void): void {
  if (child.exitCode !== null) {
    complete();
    return;
  }
  if (process.platform === 'win32' && child.pid !== undefined) {
    execFile(windowsTaskkillExecutable(), ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true}, cause => {
      const error = cause instanceof Error ? cause : undefined;
      if (error && child.exitCode === null) {
        child.kill('SIGKILL');
      }
      complete(error);
    });
    return;
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } finally {
    complete();
  }
}

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
  return isGitExecutable(executable) ? withoutGitEnvironment(env ?? process.env) : env;
}

export function formatShellCommand(executable: string, args: readonly string[]): string {
  return redactSensitiveText([executable, ...args].map(shellQuote).join(' '));
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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

function redactCommandArgs(args: readonly string[]): readonly string[] {
  const combined = args.join(' ');
  if (redactSensitiveText(combined) !== combined) {
    return ['[REDACTED]'];
  }
  return args.map(redactSensitiveText);
}

function redactedError(error: Error): Error {
  return new Error(redactSensitiveText(error.message));
}
