import {Console, Context, Effect, Layer, Schema, Sink, Stdio, Stream} from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import {ChildProcessSpawner} from 'effect/unstable/process/ChildProcessSpawner';
import {command as commandText, info, warning} from '../cli_ui.js';
import {redactSensitiveText} from '../scrubber.js';
import type {CommandResult} from '../types.js';
import {SystemInfo, type SystemInfoShape} from './system.js';

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

export type CommandExecutionError = CommandFailed | CommandOutputLimitExceeded | CommandSpawnFailed | CommandTimedOut;

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
  static readonly layer = Layer.effect(
    CommandExecutor,
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      const system = yield* SystemInfo;
      return CommandExecutor.of({
        execute: (executable, args, options) =>
          executeCommand(executable, args, options, system).pipe(
            Effect.provideService(ChildProcessSpawner, childProcessSpawner),
          ),
        executeStreaming: (executable, args, options) =>
          executeStreamingCommand(executable, args, options, system).pipe(
            Effect.provideService(ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Stdio.Stdio, stdio),
          ),
      });
    }),
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
  if (command.executeStreaming) {
    return yield* command.executeStreaming(executable, args, options);
  }
  const system = yield* SystemInfo;
  return yield* executeStreamingCommand(executable, args, options, system);
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

const executeCommand = Effect.fn('CommandExecutor.execute')(function* (
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
  system: SystemInfoShape,
) {
  const environment = system.environment();
  const maxOutputBytes = options.maxOutputBytes ?? commandMaxOutputBytes(environment);
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs(environment);
  const command = formatShellCommand(executable, args);
  const safeArgs = redactCommandArgs(args);
  const safeExecutable = redactSensitiveText(executable);
  const spawnFailed = (cause: unknown) => commandSpawnFailure(command, safeExecutable, safeArgs, cause);
  const outputExceeded = new CommandOutputLimitExceeded({
    args: safeArgs,
    executable: safeExecutable,
    maxOutputBytes,
    message: `${command} exceeded output limit of ${maxOutputBytes} bytes`,
  });
  const run = Effect.scoped(
    Effect.gen(function* () {
      const invocation = yield* Effect.try({
        try: () =>
          resolveCommandInvocation(
            executable,
            args,
            system.platform,
            environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
          ),
        catch: spawnFailed,
      });
      const handle = yield* ChildProcess.make(invocation.executable, [...invocation.args], {
        cwd: options.cwd,
        env: commandEnvironment(executable, options.env, environment),
        forceKillAfter: 1000,
        stdin: 'ignore',
      }).pipe(Effect.mapError(spawnFailed));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectCommandOutput(handle.stdout, maxOutputBytes, outputExceeded).pipe(
            Effect.mapError(cause => (cause instanceof CommandOutputLimitExceeded ? cause : spawnFailed(cause))),
          ),
          collectCommandOutput(handle.stderr, maxOutputBytes, outputExceeded).pipe(
            Effect.mapError(cause => (cause instanceof CommandOutputLimitExceeded ? cause : spawnFailed(cause))),
          ),
          handle.exitCode.pipe(Effect.map(Number), Effect.mapError(spawnFailed)),
        ],
        {concurrency: 'unbounded'},
      );
      const result = {exitCode, stderr, stdout};
      if (exitCode === 0) {
        return result;
      }
      return yield* new CommandFailed({
        args: safeArgs,
        executable: safeExecutable,
        exitCode,
        message: redactSensitiveText(`${command} failed: ${stderr || stdout}`),
        stderr: redactSensitiveText(stderr),
        stdout: redactSensitiveText(stdout),
      });
    }),
  );
  const timedOut = new CommandTimedOut({
    args: safeArgs,
    executable: safeExecutable,
    message: `${command} timed out after ${timeoutMs}ms`,
    timeoutMs,
  });
  const bounded =
    timeoutMs <= 0
      ? run
      : run.pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(timedOut),
          }),
        );
  return yield* options.allowFailure === true
    ? bounded.pipe(Effect.catch(error => Effect.succeed(commandErrorResult(error))))
    : bounded;
});

const executeStreamingCommand = Effect.fn('CommandExecutor.executeStreaming')(function* (
  executable: string,
  args: readonly string[],
  options: StreamingCommandOptions = {},
  system: SystemInfoShape,
) {
  const maxOutputChars = options.maxOutputChars ?? 64_000;
  const command = formatShellCommand(executable, args);
  const safeArgs = redactCommandArgs(args);
  const safeExecutable = redactSensitiveText(executable);
  const spawnFailed = (cause: unknown) => commandSpawnFailure(command, safeExecutable, safeArgs, cause);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const invocation = yield* Effect.try({
        try: () =>
          resolveCommandInvocation(
            executable,
            args,
            system.platform,
            system.environment().ComSpec ?? system.environment().COMSPEC ?? 'cmd.exe',
          ),
        catch: spawnFailed,
      });
      const handle = yield* ChildProcess.make(invocation.executable, [...invocation.args], {
        env: options.env,
        forceKillAfter: 1000,
        stdin: 'inherit',
      }).pipe(Effect.mapError(spawnFailed));
      const stdio = yield* Stdio.Stdio;
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamingOutput(handle.stdout, stdio.stdout({endOnDone: false}), maxOutputChars),
          collectStreamingOutput(handle.stderr, stdio.stderr({endOnDone: false}), maxOutputChars),
          handle.exitCode.pipe(Effect.map(Number)),
        ],
        {concurrency: 'unbounded'},
      );
      return {exitCode, stderr, stdout};
    }),
  ).pipe(
    Effect.catch(cause => {
      const message = causeMessage(cause);
      return Effect.succeed({exitCode: 1, stderr: `${message}\n`, stdout: ''});
    }),
  );
});

function collectCommandOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  maxOutputBytes: number,
  outputExceeded: CommandOutputLimitExceeded,
) {
  const encoder = new TextEncoder();
  return stream.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => '',
      (current, chunk) => {
        const next = `${current}${chunk}`;
        return encoder.encode(next).byteLength <= maxOutputBytes ? Effect.succeed(next) : Effect.fail(outputExceeded);
      },
    ),
  );
}

function collectStreamingOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  sink: Sink.Sink<void, string | Uint8Array, never, unknown>,
  maxOutputChars: number,
) {
  return stream.pipe(
    Stream.decodeText,
    Stream.runFoldEffect(
      () => '',
      (current, chunk) =>
        Stream.run(Stream.make(chunk), sink).pipe(Effect.as(appendOutputTail(current, chunk, maxOutputChars))),
    ),
  );
}

function appendOutputTail(current: string, chunk: string, maxOutputChars: number): string {
  const next = `${current}${chunk}`;
  return next.length <= maxOutputChars ? next : next.slice(next.length - maxOutputChars);
}

function commandSpawnFailure(
  command: string,
  safeExecutable: string,
  safeArgs: readonly string[],
  cause: unknown,
): CommandSpawnFailed {
  const message = causeMessage(cause);
  return new CommandSpawnFailed({
    args: safeArgs,
    cause: new Error(redactSensitiveText(message)),
    executable: safeExecutable,
    message: redactSensitiveText(`${command} failed to start: ${message}`),
  });
}

function commandErrorResult(error: CommandExecutionError): CommandResult {
  switch (error._tag) {
    case 'CommandFailed':
      return {exitCode: error.exitCode, stderr: error.stderr, stdout: error.stdout};
    case 'CommandOutputLimitExceeded':
    case 'CommandTimedOut':
      return {exitCode: 124, stderr: error.message, stdout: ''};
    case 'CommandSpawnFailed':
      return {exitCode: 127, stderr: error.message, stdout: ''};
  }
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : typeof cause === 'object' && cause !== null && 'message' in cause
      ? String(cause.message)
      : String(cause);
}

const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;

export function resolveCommandInvocation(
  executable: string,
  args: readonly string[],
  currentPlatform: NodeJS.Platform,
  comspec = 'cmd.exe',
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

export const windowsTaskkillExecutable = Effect.fn('CommandExecutor.windowsTaskkillExecutable')(function* () {
  const environment = (yield* SystemInfo).environment();
  return `${(environment.SystemRoot ?? 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\taskkill.exe`;
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

export function withoutGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = {...env};
  for (const key of GIT_ENVIRONMENT_KEYS) {
    delete next[key];
  }
  return next;
}

function commandEnvironment(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  systemEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  return isGitExecutable(executable) ? withoutGitEnvironment(env ?? systemEnvironment) : env;
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

export function commandTimeoutMs(environment: Readonly<Record<string, string | undefined>>): number {
  return positiveIntegerFromEnv(environment, 'THREADNOTE_COMMAND_TIMEOUT_MS') ?? 10 * 60 * 1000;
}

export function commandMaxOutputBytes(environment: Readonly<Record<string, string | undefined>>): number {
  return positiveIntegerFromEnv(environment, 'THREADNOTE_COMMAND_MAX_OUTPUT_BYTES') ?? 5 * 1024 * 1024;
}

function positiveIntegerFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const value = environment[name];
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
