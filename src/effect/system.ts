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
    const windowsHome =
      process.env.USERPROFILE ??
      (process.env.HOMEDRIVE && process.env.HOMEPATH
        ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
        : process.env.HOME);
    return SystemInfo.of({
      currentDirectory: () => process.cwd(),
      environment: () => process.env,
      executablePath: process.execPath,
      homeDirectory: (process.platform === 'win32' ? windowsHome : (process.env.HOME ?? windowsHome)) ?? process.cwd(),
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
