import {Context, Deferred, Effect, Exit, Layer, Ref} from 'effect';
import {effectiveLinuxMemoryBytes, linuxCgroupMemoryFiles} from './linux_cgroup.js';
import {withoutTelemetrySessionEnvironment} from '../telemetry/session.js';
import {readWindowsHardwareInfo, readWindowsProcessStartIdentity} from './windows_system.js';

class SystemOperationError extends Error {
  readonly _tag = 'SystemOperationError' as const;
}

function systemOperationError(cause: unknown): SystemOperationError {
  return cause instanceof SystemOperationError
    ? cause
    : new SystemOperationError(cause instanceof Error ? cause.message : String(cause), {cause});
}

export interface PlatformPathShape {
  readonly basename: (path: string) => string;
  readonly dirname: (path: string) => string;
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: readonly string[]) => string;
  readonly normalize: (path: string) => string;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (...paths: readonly string[]) => string;
  readonly sep: string;
}

interface NativeFileSystemPromisesShape {
  readonly lstat: (path: string, options: {readonly bigint: true}) => Promise<RuntimeBigIntStats>;
  readonly open: (path: string, flags: number) => Promise<RuntimeFileHandle>;
  readonly opendir: (
    path: string,
    options: {readonly bufferSize: number; readonly encoding: 'buffer' | 'utf8'},
  ) => Promise<RuntimeDirectoryHandle>;
  readonly stat: (path: string, options: {readonly bigint: true}) => Promise<RuntimeBigIntStats>;
  readonly statfs?: (path: string, options: {readonly bigint: true}) => Promise<unknown>;
}

interface RuntimeFileHandle {
  readonly close: () => Promise<void>;
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{readonly bytesRead: number}>;
  readonly stat: (options: {readonly bigint: true}) => Promise<RuntimeBigIntStats>;
}

interface NativeFileSystemModuleShape {
  readonly constants: {
    readonly O_NOFOLLOW?: number;
    readonly O_NONBLOCK?: number;
    readonly O_RDONLY: number;
  };
  readonly promises: NativeFileSystemPromisesShape;
}

interface NativePathModuleShape {
  readonly posix: PlatformPathShape;
  readonly win32: PlatformPathShape;
}

interface NativeOperatingSystemModuleShape {
  readonly cpus: () => readonly {readonly model: string}[];
  readonly release: () => string;
  readonly totalmem: () => number;
}

export interface RuntimeBigIntStats {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

interface RuntimeDirectoryEntry {
  readonly name: string | Uint8Array;
}

interface RuntimeDirectoryHandle extends AsyncIterable<RuntimeDirectoryEntry | Uint8Array> {
  readonly close: () => Promise<void> | void;
}

export interface RuntimeDirectoryNamePage {
  readonly names: readonly Uint8Array[];
  readonly overflow: boolean;
}

export interface RuntimeTextDirectoryNamePage {
  readonly names: readonly string[];
  readonly overflow: boolean;
}

/** Stream UTF-8 directory names without retaining a corpus-sized listing. */
export async function* runtimeTextDirectoryNames(path: string): AsyncGenerator<string, void, void> {
  const directory = await nativeFileSystemPromises.opendir(path, {
    bufferSize: 32,
    encoding: runtimePlatform === 'win32' ? 'utf8' : 'buffer',
  });
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  try {
    for await (const entry of directory) {
      const name = entry instanceof Uint8Array ? entry : entry.name;
      yield typeof name === 'string' ? name : decoder.decode(name);
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // A fully consumed async directory iterator is already closed.
    }
  }
}

/** Host facts and Bun's Node-compatible structural adapters stay inside SystemInfo's runtime boundary. */
export const runtimeArchitecture = process.arch;
export const runtimePlatform = process.platform;
const nativeOperatingSystemModule = process.getBuiltinModule('os') as NativeOperatingSystemModuleShape;
export const runtimeOperatingSystemRelease = nativeOperatingSystemModule.release();
const nativeFileSystemModule = process.getBuiltinModule('fs') as NativeFileSystemModuleShape;
const nativeFileSystemPromises = nativeFileSystemModule.promises;
const nativePathModule = process.getBuiltinModule('path') as NativePathModuleShape;

export type ProcessResourceUsageRuntime = 'bun' | 'node';

/**
 * Node exposes process.resourceUsage().maxRSS in KiB on every platform. The
 * release-pinned Bun 1.3.14 exposes bytes on Darwin and KiB on its other
 * supported platforms. Revalidate this adapter whenever the pinned Bun
 * version moves.
 */
export function processResourceUsageMaxRssBytes(
  maxRss: number,
  platform: NodeJS.Platform,
  runtime: ProcessResourceUsageRuntime,
): number {
  return runtime === 'bun' && platform === 'darwin' ? maxRss : maxRss * 1_024;
}

export function platformPathFor(platform: NodeJS.Platform): PlatformPathShape {
  return platform === 'win32' ? nativePathModule.win32 : nativePathModule.posix;
}

/** Windows stat modes are synthetic; retain structural checks there and enforce POSIX privacy bits elsewhere. */
export function fileSystemModeIsPrivate(platform: NodeJS.Platform, mode: number): boolean {
  return platform === 'win32' || (mode & 0o077) === 0;
}

/** Exact host facts retained by same-machine benchmark provenance. */
export function runtimeHostHardwareInfo(): {
  readonly cpuModel: string;
  readonly logicalCpuCount: number;
  readonly memoryBytes: number;
} {
  const processors = nativeOperatingSystemModule.cpus();
  return {
    cpuModel: processors[0]?.model ?? 'unknown',
    logicalCpuCount: processors.length,
    memoryBytes: nativeOperatingSystemModule.totalmem(),
  };
}

export function runtimeLstat(path: string): Promise<RuntimeBigIntStats> {
  return nativeFileSystemPromises.lstat(path, {bigint: true});
}

/** Read one regular file without following a stable symbolic-link target and reject path/file races. */
export async function runtimeReadBoundedStableRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes >= Number.MAX_SAFE_INTEGER) {
    throw new SystemOperationError('Invalid read bound.');
  }
  const pathBefore = await nativeFileSystemPromises.lstat(path, {bigint: true});
  if (!stableRegularFile(pathBefore) || pathBefore.size > BigInt(maximumBytes)) {
    throw new SystemOperationError('Target is not a bounded stable regular file.');
  }
  const flags =
    nativeFileSystemModule.constants.O_RDONLY |
    (nativeFileSystemModule.constants.O_NONBLOCK ?? 0) |
    (runtimePlatform === 'win32' ? 0 : (nativeFileSystemModule.constants.O_NOFOLLOW ?? 0));
  const opened = await nativeFileSystemPromises.open(path, flags);
  try {
    const [openedBefore, pathOpened] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    if (!sameStableRegularFile(pathBefore, openedBefore) || !sameStableRegularFile(pathBefore, pathOpened)) {
      throw new SystemOperationError('Target changed while opening.');
    }
    const bytes = new Uint8Array(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await opened.read(bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) {
        throw new SystemOperationError('Target returned an invalid read size.');
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [openedAfter, pathAfter] = await Promise.all([
      opened.stat({bigint: true}),
      nativeFileSystemPromises.lstat(path, {bigint: true}),
    ]);
    if (
      !sameStableRegularFile(pathBefore, openedAfter) ||
      !sameStableRegularFile(pathBefore, pathAfter) ||
      offset > maximumBytes ||
      BigInt(offset) !== pathBefore.size
    ) {
      throw new SystemOperationError('Target changed during bounded read.');
    }
    return bytes.slice(0, offset);
  } finally {
    await opened.close();
  }
}

/** Follows links while retaining exact device/inode identity beyond JavaScript's safe-integer range. */
export function runtimeStat(path: string): Promise<RuntimeBigIntStats> {
  return nativeFileSystemPromises.stat(path, {bigint: true});
}

function stableRegularFile(info: RuntimeBigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.dev !== 0n && info.ino !== 0n;
}

function sameStableRegularFile(left: RuntimeBigIntStats, right: RuntimeBigIntStats): boolean {
  return (
    stableRegularFile(left) &&
    stableRegularFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Raw POSIX directory names stay bytes; enumeration stops immediately after the first over-limit entry. */
export async function runtimeDirectoryNamePage(path: string, entryLimit: number): Promise<RuntimeDirectoryNamePage> {
  if (!Number.isSafeInteger(entryLimit) || entryLimit < 0)
    throw new SystemOperationError('Runtime directory entry limit is invalid.');
  const directory = await nativeFileSystemPromises.opendir(path, {
    bufferSize: 32,
    encoding: runtimePlatform === 'win32' ? 'utf8' : 'buffer',
  });
  const names: Uint8Array[] = [];
  try {
    for await (const entry of directory) {
      const name = entry instanceof Uint8Array ? entry : entry.name;
      if (names.length === entryLimit) return {names, overflow: true};
      names.push(typeof name === 'string' ? new TextEncoder().encode(name) : Uint8Array.from(name));
    }
  } finally {
    try {
      await directory.close();
    } catch {
      // A fully consumed async directory iterator is already closed.
    }
  }
  return {names, overflow: false};
}

/** Effect-native UTF-8 view for bounded application ledgers that reject non-text names. */
export function runtimeTextDirectoryNamePage(
  path: string,
  entryLimit: number,
): Effect.Effect<RuntimeTextDirectoryNamePage, unknown> {
  return Effect.tryPromise({
    try: () => runtimeDirectoryNamePage(path, entryLimit),
    catch: systemOperationError,
  }).pipe(
    Effect.flatMap(page =>
      Effect.try({
        try: () => {
          const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
          return {names: page.names.map(name => decoder.decode(name)), overflow: page.overflow};
        },
        catch: systemOperationError,
      }),
    ),
  );
}

export interface SystemInfoShape {
  readonly architecture: string;
  readonly availableDiskBytes: (path: string) => Effect.Effect<number | undefined, unknown>;
  /** Versioned cross-observer identity; optional for legacy injected SystemInfo adapters. */
  readonly canonicalProcessStartIdentity?: (processId: number) => Effect.Effect<string | undefined>;
  readonly currentDirectory: () => string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly hardwareInfo: Effect.Effect<SystemHardwareInfo, Error>;
  readonly isProcessRunning: (processId: number) => boolean;
  readonly memoryUsage: () => {
    readonly external: number;
    readonly heapUsed: number;
    /** Peak resident bytes when the runtime exposes a compatible process counter. */
    readonly peakRss?: number;
    readonly rss: number;
  };
  readonly processStartIdentity: (processId: number) => Effect.Effect<string | undefined>;
  readonly runtimeVersion: string;
  readonly pathDelimiter: string;
  readonly platform: NodeJS.Platform;
  readonly processId: number;
  readonly processArguments: readonly string[];
  readonly readLine: (prompt: string, onLine: (line: string) => void) => () => void;
  readonly signalProcess: (processId: number, signal: NodeJS.Signals) => void;
  readonly setExitCode: (code: number) => void;
  readonly setEnvironmentVariable: (name: string, value: string) => void;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly tempDirectory: string;
  readonly userId?: number;
  readonly userName: string;
}

export interface SystemHardwareInfo {
  readonly cpuModel: string;
  /** Physical RAM remains the stable benchmark provenance value. */
  readonly memoryBytes: number;
  /** Lower of physical RAM and any visible finite cgroup memory limit. */
  readonly effectiveMemoryBytes: number;
  readonly operatingSystem: string;
}

type ProcessStartIdentityCacheState =
  | {readonly _tag: 'empty'}
  | {readonly _tag: 'pending'; readonly deferred: Deferred.Deferred<ProcessStartIdentityCacheSignal>}
  | {readonly _tag: 'complete'; readonly identity: string | undefined};

type ProcessStartIdentityCacheDecision =
  | {readonly _tag: 'owner'; readonly deferred: Deferred.Deferred<ProcessStartIdentityCacheSignal>}
  | {readonly _tag: 'pending'; readonly deferred: Deferred.Deferred<ProcessStartIdentityCacheSignal>}
  | {readonly _tag: 'complete'; readonly identity: string | undefined};

type ProcessStartIdentityCacheSignal =
  {readonly _tag: 'complete'; readonly identity: string | undefined} | {readonly _tag: 'retry'};

export function makeCachedProcessStartIdentityResolver(
  ownProcessId: number,
  resolve: (processId: number) => Effect.Effect<string | undefined>,
  ownerClaimed?: Effect.Effect<void>,
): Effect.Effect<(processId: number) => Effect.Effect<string | undefined>> {
  return Effect.gen(function* () {
    const state = yield* Ref.make<ProcessStartIdentityCacheState>({_tag: 'empty'});
    const resolveOwnProcessStartIdentity: Effect.Effect<string | undefined> = Effect.suspend(() =>
      Effect.uninterruptibleMask(restore =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ProcessStartIdentityCacheSignal>();
          const decision = yield* Ref.modify(
            state,
            (current): readonly [ProcessStartIdentityCacheDecision, ProcessStartIdentityCacheState] => {
              if (current._tag === 'complete') {
                return [{_tag: 'complete', identity: current.identity} as const, current];
              }
              if (current._tag === 'pending') {
                return [{_tag: 'pending', deferred: current.deferred} as const, current];
              }
              const pending = {_tag: 'pending', deferred: candidate} as const;
              return [{_tag: 'owner', deferred: candidate} as const, pending];
            },
          );
          if (decision._tag === 'complete') return decision.identity;
          if (decision._tag === 'pending') {
            const signal = yield* restore(Deferred.await(decision.deferred));
            return signal._tag === 'complete' ? signal.identity : yield* restore(resolveOwnProcessStartIdentity);
          }
          if (ownerClaimed !== undefined) yield* ownerClaimed;

          // Cache both a defined identity and completed absence, but never cache
          // an interrupted/defective owner. Pending callers receive a neutral
          // retry signal so exactly one becomes the next owner instead of
          // inheriting another fiber's interruption cause.
          return yield* restore(resolve(ownProcessId)).pipe(
            Effect.onExit(exit =>
              Exit.isSuccess(exit)
                ? Ref.set(state, {_tag: 'complete', identity: exit.value}).pipe(
                    Effect.andThen(Deferred.succeed(decision.deferred, {_tag: 'complete', identity: exit.value})),
                    Effect.asVoid,
                  )
                : Ref.set(state, {_tag: 'empty'}).pipe(
                    Effect.andThen(Deferred.succeed(decision.deferred, {_tag: 'retry'})),
                    Effect.asVoid,
                  ),
            ),
          );
        }),
      ),
    );
    return (processId: number) => (processId === ownProcessId ? resolveOwnProcessStartIdentity : resolve(processId));
  });
}

export class SystemInfo extends Context.Service<SystemInfo, SystemInfoShape>()('threadnote/effect/SystemInfo') {
  static readonly layer = Layer.effect(
    SystemInfo,
    Effect.gen(function* () {
      const homeDirectory = resolveHomeDirectory(process.env, runtimePlatform);
      const processStartIdentity = yield* makeCachedProcessStartIdentityResolver(process.pid, processId =>
        readProcessStartIdentity(processId, runtimePlatform, process.env),
      );
      const canonicalProcessStartIdentity = yield* makeCachedProcessStartIdentityResolver(process.pid, processId =>
        readCanonicalProcessStartIdentity(processId, runtimePlatform, process.env),
      );
      return SystemInfo.of({
        architecture: runtimeArchitecture,
        availableDiskBytes: path => availableDiskBytes(path, runtimePlatform, process.env),
        canonicalProcessStartIdentity,
        currentDirectory: () => process.cwd(),
        environment: () => process.env,
        executablePath: process.execPath,
        hardwareInfo: readSystemHardwareInfo(runtimePlatform, process.env),
        homeDirectory,
        isProcessRunning: processId => {
          try {
            process.kill(processId, 0);
            return true;
          } catch (cause: unknown) {
            return !(
              typeof cause === 'object' &&
              cause !== null &&
              'code' in cause &&
              (cause as {readonly code?: unknown}).code === 'ESRCH'
            );
          }
        },
        memoryUsage: () => {
          const usage = process.memoryUsage();
          const runtimePeakRss = process.resourceUsage().maxRSS;
          const runtime: ProcessResourceUsageRuntime = 'bun' in process.versions ? 'bun' : 'node';
          return {
            external: usage.external,
            heapUsed: usage.heapUsed,
            peakRss: processResourceUsageMaxRssBytes(runtimePeakRss, runtimePlatform, runtime),
            rss: usage.rss,
          };
        },
        processStartIdentity,
        runtimeVersion: Bun.version,
        pathDelimiter: runtimePlatform === 'win32' ? ';' : ':',
        platform: runtimePlatform,
        processId: process.pid,
        processArguments: process.argv,
        readLine: (prompt, onLine) => {
          const input = process.stdin;
          let buffered = '';
          let settled = false;
          const cleanup = () => {
            input.off('data', onData);
            input.off('end', onEnd);
            input.pause();
          };
          const finish = (line: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            onLine(line);
          };
          const onData = (chunk: string | Uint8Array) => {
            buffered += String(chunk);
            const newline = buffered.search(/[\r\n]/);
            if (newline >= 0) {
              finish(buffered.slice(0, newline));
            }
          };
          const onEnd = () => finish(buffered);
          process.stdout.write(prompt);
          input.on('data', onData);
          input.once('end', onEnd);
          input.resume();
          return cleanup;
        },
        signalProcess: (processId, signal) => {
          process.kill(processId, signal);
        },
        setExitCode: code => {
          process.exitCode = code;
        },
        setEnvironmentVariable: (name, value) => {
          process.env[name] = value;
        },
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
        tempDirectory:
          process.env.TMPDIR ??
          process.env.TEMP ??
          process.env.TMP ??
          (runtimePlatform === 'win32' ? process.cwd() : '/tmp'),
        userId: process.getuid?.(),
        userName: process.env.USER ?? process.env.USERNAME ?? 'unknown',
      });
    }),
  );
}

const DISK_QUERY_TIMEOUT_MS = 10_000;
const DISK_QUERY_OUTPUT_LIMIT_BYTES = 64 * 1_024;
const KIBIBYTE_BYTES = 1024;
const DARWIN_PROCESS_START_OUTPUT_PATTERN =
  /^ {0,4}((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}) {0,4}\n?$/;
const PROCESS_IDENTITY_QUERY_OUTPUT_LIMIT_BYTES = 4 * 1_024;
const PROCESS_IDENTITY_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_START_OUTPUT_PATTERN = /^(0|[1-9][0-9]{0,19})(?:\r?\n)?$/;
const MAXIMUM_SAFE_BYTE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const NATIVE_STATFS_UNAVAILABLE_CODES = new Set([
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ERR_METHOD_NOT_IMPLEMENTED',
  'ERR_NOT_IMPLEMENTED',
]);

export interface DiskCapacityProbeAdapters {
  readonly fallback: (
    path: string,
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly statfs: (path: string) => Effect.Effect<unknown, unknown>;
}

class NativeStatfsUnavailableError {
  readonly _tag = 'NativeStatfsUnavailableError';
}

function availableDiskBytes(path: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  return probeRuntimeAvailableDiskBytes(
    path,
    platform,
    runtimeArchitecture,
    environment,
    defaultDiskCapacityProbeAdapters,
  );
}

export function probeRuntimeAvailableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  environment: NodeJS.ProcessEnv,
  adapters: DiskCapacityProbeAdapters,
  timeoutMilliseconds = DISK_QUERY_TIMEOUT_MS,
) {
  // Bun 1.3.14's standalone darwin-x64 runtime has produced unusable native
  // statfs observations on the exact Intel release runner. Keep the same
  // bounded, cancellable query contract while using df on that architecture.
  return platform === 'darwin' && architecture === 'x64'
    ? adapters.fallback(path, platform, environment).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMilliseconds,
          orElse: () => Effect.succeed(undefined),
        }),
      )
    : probeAvailableDiskBytes(path, platform, environment, adapters, timeoutMilliseconds);
}

export function probeAvailableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  adapters: DiskCapacityProbeAdapters,
  timeoutMilliseconds = DISK_QUERY_TIMEOUT_MS,
) {
  return adapters.statfs(path).pipe(
    Effect.matchEffect({
      onFailure: cause =>
        isNativeStatfsUnavailable(cause) ? adapters.fallback(path, platform, environment) : Effect.succeed(undefined),
      onSuccess: statistics => Effect.succeed(availableDiskBytesFromStatfs(statistics)),
    }),
    Effect.timeoutOrElse({
      duration: timeoutMilliseconds,
      orElse: () => Effect.succeed(undefined),
    }),
  );
}

export function availableDiskBytesFromStatfs(statistics: unknown): number | undefined {
  if (typeof statistics !== 'object' || statistics === null) return undefined;
  const fields = statistics as {readonly bavail?: unknown; readonly bsize?: unknown};
  const availableBlocks = nonNegativeIntegerBigInt(fields.bavail);
  const blockSize = positiveIntegerBigInt(fields.bsize);
  if (availableBlocks === undefined || blockSize === undefined) return undefined;
  const availableBytes = availableBlocks * blockSize;
  return Number(availableBytes > MAXIMUM_SAFE_BYTE_COUNT ? MAXIMUM_SAFE_BYTE_COUNT : availableBytes);
}

function nativeStatfs(path: string) {
  if (typeof nativeFileSystemPromises.statfs !== 'function') {
    return Effect.fail(new NativeStatfsUnavailableError());
  }
  return Effect.tryPromise({
    try: () => nativeFileSystemPromises.statfs!(path, {bigint: true}),
    catch: systemOperationError,
  });
}

/** @internal Exported for a real-process cancellation regression. */
export function legacyAvailableDiskBytes(
  path: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  posixDiskCommand = '/bin/df',
) {
  const command =
    platform === 'win32'
      ? [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$root=[IO.Path]::GetPathRoot($env:THREADNOTE_DISK_PATH); ' +
            'if (-not $root) { exit 2 }; ' +
            '[Console]::Out.Write((Get-PSDrive -Name $root.Substring(0,1)).Free)',
        ]
      : [posixDiskCommand, '-Pk', path];
  const sanitizedEnvironment = withoutTelemetrySessionEnvironment(environment);
  const childEnvironment =
    platform === 'win32' ? {...sanitizedEnvironment, THREADNOTE_DISK_PATH: path} : sanitizedEnvironment;
  return Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: command,
          env: childEnvironment,
          killSignal: 'SIGKILL',
          maxBuffer: DISK_QUERY_OUTPUT_LIMIT_BYTES,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      catch: systemOperationError,
    }),
    child =>
      Effect.tryPromise({
        try: async () => {
          const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
          if (exitCode !== 0) return undefined;
          const text = output.trim();
          return platform === 'win32' ? parseWindowsAvailableDiskBytes(text) : parsePosixAvailableDiskBytes(text);
        },
        catch: systemOperationError,
      }),
    child =>
      Effect.sync(() => {
        if (child.exitCode !== null) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may exit while its finalizer runs.
        }
      }),
  );
}

const defaultDiskCapacityProbeAdapters: DiskCapacityProbeAdapters = {
  fallback: legacyAvailableDiskBytes,
  statfs: nativeStatfs,
};

function isNativeStatfsUnavailable(cause: unknown): boolean {
  const underlying = cause instanceof SystemOperationError ? cause.cause : cause;
  if (underlying instanceof NativeStatfsUnavailableError) return true;
  if (typeof underlying !== 'object' || underlying === null || !('code' in underlying)) return false;
  const code = (underlying as {readonly code?: unknown}).code;
  return typeof code === 'string' && NATIVE_STATFS_UNAVAILABLE_CODES.has(code);
}

function nonNegativeIntegerBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

function positiveIntegerBigInt(value: unknown): bigint | undefined {
  const integer = nonNegativeIntegerBigInt(value);
  return integer !== undefined && integer > 0n ? integer : undefined;
}

export function parsePosixAvailableDiskBytes(output: string): number | undefined {
  const lastLine = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!lastLine) return undefined;
  const fields = lastLine.trim().split(/\s+/);
  const availableKibibytes = Number(fields.at(-3));
  return Number.isSafeInteger(availableKibibytes) && availableKibibytes >= 0
    ? availableKibibytes * KIBIBYTE_BYTES
    : undefined;
}

export function parseWindowsAvailableDiskBytes(output: string): number | undefined {
  const bytes = Number(output.trim());
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function readSystemHardwareInfo(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  if (platform === 'linux') {
    return Effect.tryPromise({
      try: async () => {
        const [cpuInfo, memoryInfo] = await Promise.all([
          Bun.file('/proc/cpuinfo').text(),
          Bun.file('/proc/meminfo').text(),
        ]);
        const cpuModel = /^(?:model name|Hardware)\s*:\s*(.+)$/m.exec(cpuInfo)?.[1]?.trim();
        const memoryKibibytes = Number(/^MemTotal:\s+(\d+)\s+kB$/m.exec(memoryInfo)?.[1]);
        if (!cpuModel || !Number.isSafeInteger(memoryKibibytes) || memoryKibibytes <= 0) {
          throw new SystemOperationError('Linux hardware metadata is incomplete.');
        }
        const memoryBytes = memoryKibibytes * KIBIBYTE_BYTES;
        const effectiveMemoryBytes = await readLinuxEffectiveMemoryBytes(memoryBytes);
        const operatingSystem = spawnText(['uname', '-sr'], environment);
        return {cpuModel, effectiveMemoryBytes, memoryBytes, operatingSystem};
      },
      catch: cause => new SystemOperationError('Could not read Linux hardware metadata.', {cause}),
    });
  }
  if (platform === 'darwin') {
    return Effect.try({
      try: () => {
        const cpuModel = spawnText(['sysctl', '-n', 'machdep.cpu.brand_string'], environment);
        const memoryBytes = Number(spawnText(['sysctl', '-n', 'hw.memsize'], environment));
        const version = spawnText(['sw_vers', '-productVersion'], environment);
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
          throw new SystemOperationError('macOS memory metadata is invalid.');
        }
        return {cpuModel, effectiveMemoryBytes: memoryBytes, memoryBytes, operatingSystem: `macOS ${version}`};
      },
      catch: cause => new SystemOperationError('Could not read macOS hardware metadata.', {cause}),
    });
  }
  if (platform === 'win32') {
    return readWindowsHardwareInfo(environment);
  }
  return Effect.fail(new SystemOperationError(`Hardware metadata is not supported on ${platform}.`));
}

async function readLinuxEffectiveMemoryBytes(physicalMemoryBytes: number): Promise<number> {
  const [processCgroup, processMountInfo] = await Promise.all([
    readOptionalBunFile('/proc/self/cgroup'),
    readOptionalBunFile('/proc/self/mountinfo'),
  ]);
  if (processCgroup === undefined || processMountInfo === undefined) return physicalMemoryBytes;
  const files = linuxCgroupMemoryFiles(processCgroup, processMountInfo);
  const limits = await Promise.all(files.map(file => readOptionalBunFile(file.path)));
  return effectiveLinuxMemoryBytes(physicalMemoryBytes, limits);
}

async function readOptionalBunFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

function spawnText(command: readonly string[], environment: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync({
    cmd: [...command],
    env: withoutTelemetrySessionEnvironment(environment),
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: DISK_QUERY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new SystemOperationError(`${command[0]} exited with ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  const output = result.stdout.toString().trim();
  if (!output) throw new SystemOperationError(`${command[0]} returned no hardware metadata.`);
  return output;
}

/** @internal Exported for real-process deadline and cancellation regressions. */
export function readProcessStartIdentity(
  processId: number,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  timeoutMilliseconds = PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
  darwinProcessCommand = '/bin/ps',
): Effect.Effect<string | undefined> {
  if (!Number.isSafeInteger(processId) || processId <= 0) return Effect.succeed(undefined);
  if (platform === 'linux') {
    return Effect.tryPromise({
      try: () => Bun.file(`/proc/${processId}/stat`).text(),
      catch: () => undefined,
    }).pipe(
      Effect.map(parseLinuxProcessStartIdentity),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  }
  if (platform === 'win32') {
    return readWindowsProcessStartIdentity(processId);
  }
  if (platform !== 'darwin') return Effect.succeed(undefined);
  return readDarwinProcessStartIdentity(processId, environment, timeoutMilliseconds, darwinProcessCommand, output =>
    parseProcessStartIdentityOutput('darwin', output),
  );
}

/** @internal Exported for the canonical channel's real-process regressions. */
export function readCanonicalProcessStartIdentity(
  processId: number,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  timeoutMilliseconds = PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
  darwinProcessCommand = '/bin/ps',
): Effect.Effect<string | undefined> {
  if (platform !== 'darwin') {
    return readProcessStartIdentity(processId, platform, environment, timeoutMilliseconds, darwinProcessCommand);
  }
  if (!Number.isSafeInteger(processId) || processId <= 0) return Effect.succeed(undefined);
  return readDarwinProcessStartIdentity(
    processId,
    {...environment, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'},
    timeoutMilliseconds,
    darwinProcessCommand,
    output => parseCanonicalProcessStartIdentityOutput('darwin', output),
  );
}

function readDarwinProcessStartIdentity(
  processId: number,
  environment: NodeJS.ProcessEnv,
  timeoutMilliseconds: number,
  command: string,
  parseOutput: (output: string) => string | undefined,
): Effect.Effect<string | undefined> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [command, '-o', 'lstart=', '-p', String(processId)],
          env: withoutTelemetrySessionEnvironment(environment),
          killSignal: 'SIGKILL',
          maxBuffer: PROCESS_IDENTITY_QUERY_OUTPUT_LIMIT_BYTES,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      catch: systemOperationError,
    }),
    child =>
      Effect.tryPromise({
        try: async () => {
          const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
          return exitCode === 0 ? parseOutput(output) : undefined;
        },
        catch: systemOperationError,
      }),
    child =>
      Effect.sync(() => {
        if (child.exitCode !== null) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may exit while its finalizer runs.
        }
      }),
  ).pipe(
    Effect.timeoutOrElse({duration: timeoutMilliseconds, orElse: () => Effect.succeed(undefined)}),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

export function parseLinuxProcessStartIdentity(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return undefined;
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startClockTick = fieldsAfterCommand[19];
  return startClockTick && /^[0-9]+$/.test(startClockTick) ? `linux:${startClockTick}` : undefined;
}

export function parseProcessStartIdentityOutput(platform: NodeJS.Platform, output: string): string | undefined {
  if (platform !== 'darwin' && platform !== 'win32') return undefined;
  const identity = output.trim();
  return identity ? `${platform}:${identity}` : undefined;
}

export function parseCanonicalProcessStartIdentityOutput(
  platform: NodeJS.Platform,
  output: string,
): string | undefined {
  if (platform === 'darwin') {
    const identity = DARWIN_PROCESS_START_OUTPUT_PATTERN.exec(output)?.[1];
    return identity ? `darwin-v2:${identity}` : undefined;
  }
  if (platform === 'win32') {
    const identity = WINDOWS_PROCESS_START_OUTPUT_PATTERN.exec(output)?.[1];
    return identity ? `win32:${identity}` : undefined;
  }
  return undefined;
}

export function resolveHomeDirectory(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = nonEmptyEnvironmentValue(environment.HOME);
  const userProfile = nonEmptyEnvironmentValue(environment.USERPROFILE);
  const homeDrive = nonEmptyEnvironmentValue(environment.HOMEDRIVE);
  const homePath = nonEmptyEnvironmentValue(environment.HOMEPATH);
  const windowsHome = userProfile ?? (homeDrive && homePath ? `${homeDrive}${homePath}` : undefined);
  const resolved = platform === 'win32' ? (windowsHome ?? home) : (home ?? windowsHome);
  if (!resolved) {
    throw new SystemOperationError('Could not determine the current user home directory from the environment.');
  }
  return resolved;
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
