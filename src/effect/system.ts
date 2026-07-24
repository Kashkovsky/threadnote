import {Context, Layer} from 'effect';

export interface SystemInfoShape {
  readonly currentDirectory: () => string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly isProcessRunning: (processId: number) => boolean;
  readonly pathDelimiter: string;
  readonly platform: NodeJS.Platform;
  readonly processId: number;
  readonly processArguments: readonly string[];
  readonly setExitCode: (code: number) => void;
  readonly setEnvironmentVariable: (name: string, value: string) => void;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly tempDirectory: string;
  readonly userId?: number;
  readonly userName: string;
}

export class SystemInfo extends Context.Service<SystemInfo, SystemInfoShape>()('threadnote/effect/SystemInfo') {
  static readonly layer = Layer.sync(SystemInfo, () => {
    const homeDirectory = resolveHomeDirectory(process.env, process.platform);
    return SystemInfo.of({
      currentDirectory: () => process.cwd(),
      environment: () => process.env,
      executablePath: process.execPath,
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
      pathDelimiter: process.platform === 'win32' ? ';' : ':',
      platform: process.platform,
      processId: process.pid,
      processArguments: process.argv,
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
