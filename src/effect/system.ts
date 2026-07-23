import {Context, Layer} from 'effect';

export interface SystemInfoShape {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}

export class SystemInfo extends Context.Service<SystemInfo, SystemInfoShape>()('threadnote/effect/SystemInfo') {
  static readonly layer = Layer.sync(SystemInfo, () => {
    const windowsHome =
      process.env.USERPROFILE ??
      (process.env.HOMEDRIVE && process.env.HOMEPATH
        ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
        : process.env.HOME);
    return SystemInfo.of({
      homeDirectory: (process.platform === 'win32' ? windowsHome : (process.env.HOME ?? windowsHome)) ?? process.cwd(),
      platform: process.platform,
    });
  });
}
