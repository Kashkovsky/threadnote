import {Context, Effect, Layer} from 'effect';
import {effectiveLinuxMemoryBytes, linuxCgroupMemoryFiles} from './linux_cgroup.js';
import {readWindowsHardwareInfo, readWindowsProcessStartIdentity} from './windows_system.js';

export interface SystemInfoShape {
  readonly architecture: string;
  readonly availableDiskBytes: (path: string) => Effect.Effect<number | undefined, unknown>;
  readonly currentDirectory: () => string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly hardwareInfo: () => Effect.Effect<SystemHardwareInfo, Error>;
  readonly isProcessRunning: (processId: number) => boolean;
  readonly memoryUsage: () => {
    readonly external: number;
    readonly heapUsed: number;
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

export class SystemInfo extends Context.Service<SystemInfo, SystemInfoShape>()('threadnote/effect/SystemInfo') {
  static readonly layer = Layer.sync(SystemInfo, () => {
    const homeDirectory = resolveHomeDirectory(process.env, process.platform);
    let ownProcessStartIdentity: string | undefined;
    let ownProcessStartIdentityLoaded = false;
    const processStartIdentity = (processId: number) =>
      processId === process.pid && ownProcessStartIdentityLoaded
        ? Effect.succeed(ownProcessStartIdentity)
        : readProcessStartIdentity(processId, process.platform, process.env).pipe(
            Effect.tap(identity =>
              processId === process.pid
                ? Effect.sync(() => {
                    ownProcessStartIdentity = identity;
                    ownProcessStartIdentityLoaded = identity !== undefined;
                  })
                : Effect.void,
            ),
          );
    return SystemInfo.of({
      architecture: process.arch,
      availableDiskBytes: path => availableDiskBytes(path, process.platform, process.env),
      currentDirectory: () => process.cwd(),
      environment: () => process.env,
      executablePath: process.execPath,
      hardwareInfo: () => readSystemHardwareInfo(process.platform, process.env),
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
        return {
          external: usage.external,
          heapUsed: usage.heapUsed,
          rss: usage.rss,
        };
      },
      processStartIdentity,
      runtimeVersion: Bun.version,
      pathDelimiter: process.platform === 'win32' ? ';' : ':',
      platform: process.platform,
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
        (process.platform === 'win32' ? process.cwd() : '/tmp'),
      userId: process.getuid?.(),
      userName: process.env.USER ?? process.env.USERNAME ?? 'unknown',
    });
  });
}

const DISK_QUERY_TIMEOUT_MS = 10_000;
const KIBIBYTE_BYTES = 1024;
const PROCESS_IDENTITY_QUERY_TIMEOUT_MS = 5_000;

function availableDiskBytes(path: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  return Effect.try({
    try: () => {
      const result =
        platform === 'win32'
          ? Bun.spawnSync({
              cmd: [
                'powershell.exe',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '$root=[IO.Path]::GetPathRoot($env:THREADNOTE_DISK_PATH); ' +
                  'if (-not $root) { exit 2 }; ' +
                  '[Console]::Out.Write((Get-PSDrive -Name $root.Substring(0,1)).Free)',
              ],
              env: {...environment, THREADNOTE_DISK_PATH: path},
              stderr: 'pipe',
              stdout: 'pipe',
              timeout: DISK_QUERY_TIMEOUT_MS,
            })
          : Bun.spawnSync({
              cmd: ['df', '-Pk', path],
              env: environment,
              stderr: 'pipe',
              stdout: 'pipe',
              timeout: DISK_QUERY_TIMEOUT_MS,
            });
      if (result.exitCode !== 0) return undefined;
      const output = result.stdout.toString().trim();
      return platform === 'win32' ? parseWindowsAvailableDiskBytes(output) : parsePosixAvailableDiskBytes(output);
    },
    catch: () => undefined,
  });
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
          throw new Error('Linux hardware metadata is incomplete.');
        }
        const memoryBytes = memoryKibibytes * KIBIBYTE_BYTES;
        const effectiveMemoryBytes = await readLinuxEffectiveMemoryBytes(memoryBytes);
        const operatingSystem = spawnText(['uname', '-sr'], environment);
        return {cpuModel, effectiveMemoryBytes, memoryBytes, operatingSystem};
      },
      catch: cause => new Error('Could not read Linux hardware metadata.', {cause}),
    });
  }
  if (platform === 'darwin') {
    return Effect.try({
      try: () => {
        const cpuModel = spawnText(['sysctl', '-n', 'machdep.cpu.brand_string'], environment);
        const memoryBytes = Number(spawnText(['sysctl', '-n', 'hw.memsize'], environment));
        const version = spawnText(['sw_vers', '-productVersion'], environment);
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
          throw new Error('macOS memory metadata is invalid.');
        }
        return {cpuModel, effectiveMemoryBytes: memoryBytes, memoryBytes, operatingSystem: `macOS ${version}`};
      },
      catch: cause => new Error('Could not read macOS hardware metadata.', {cause}),
    });
  }
  if (platform === 'win32') {
    return readWindowsHardwareInfo(environment);
  }
  return Effect.fail(new Error(`Hardware metadata is not supported on ${platform}.`));
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
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: DISK_QUERY_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} exited with ${result.exitCode}: ${result.stderr.toString().trim()}`);
  }
  const output = result.stdout.toString().trim();
  if (!output) throw new Error(`${command[0]} returned no hardware metadata.`);
  return output;
}

function readProcessStartIdentity(
  processId: number,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
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
  return Effect.sync(() => {
    try {
      const command = platform === 'darwin' ? ['ps', '-o', 'lstart=', '-p', String(processId)] : undefined;
      if (!command) return undefined;
      const result = Bun.spawnSync({
        cmd: command,
        env: environment,
        stderr: 'pipe',
        stdout: 'pipe',
        timeout: PROCESS_IDENTITY_QUERY_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return undefined;
      return parseProcessStartIdentityOutput(platform, result.stdout.toString());
    } catch {
      return undefined;
    }
  });
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

export function resolveHomeDirectory(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = nonEmptyEnvironmentValue(environment.HOME);
  const userProfile = nonEmptyEnvironmentValue(environment.USERPROFILE);
  const homeDrive = nonEmptyEnvironmentValue(environment.HOMEDRIVE);
  const homePath = nonEmptyEnvironmentValue(environment.HOMEPATH);
  const windowsHome = userProfile ?? (homeDrive && homePath ? `${homeDrive}${homePath}` : undefined);
  const resolved = platform === 'win32' ? (windowsHome ?? home) : (home ?? windowsHome);
  if (!resolved) {
    throw new Error('Could not determine the current user home directory from the environment.');
  }
  return resolved;
}

function nonEmptyEnvironmentValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
