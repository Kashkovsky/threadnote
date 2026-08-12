import {dlopen} from 'bun:ffi';
import {Effect} from 'effect';

class WindowsSystemError extends Error {
  readonly _tag = 'WindowsSystemError' as const;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const DOTNET_TICKS_AT_WINDOWS_FILE_TIME_EPOCH = 504_911_232_000_000_000n;
const MEMORY_STATUS_BYTES = 64;
const MEMORY_STATUS_TOTAL_PHYSICAL_OFFSET = 8;
const WINDOWS_VERSION_INFO_BYTES = 276;
const WINDOWS_VERSION_MAJOR_OFFSET = 4;
const WINDOWS_VERSION_MINOR_OFFSET = 8;
const WINDOWS_VERSION_BUILD_OFFSET = 12;

export interface WindowsHardwareInfo {
  readonly cpuModel: string;
  readonly effectiveMemoryBytes: number;
  readonly memoryBytes: number;
  readonly operatingSystem: string;
}

export function readWindowsHardwareInfo(environment: NodeJS.ProcessEnv) {
  return Effect.try({
    try: () => {
      const kernel = dlopen('kernel32.dll', {
        GlobalMemoryStatusEx: {
          args: ['buffer'],
          returns: 'i32',
        },
      });
      const native = dlopen('ntdll.dll', {
        RtlGetVersion: {
          args: ['buffer'],
          returns: 'i32',
        },
      });
      try {
        const memoryStatus = new Uint8Array(MEMORY_STATUS_BYTES);
        const memoryView = new DataView(memoryStatus.buffer);
        memoryView.setUint32(0, MEMORY_STATUS_BYTES, true);
        if (kernel.symbols.GlobalMemoryStatusEx(memoryStatus) === 0) {
          throw new WindowsSystemError('GlobalMemoryStatusEx failed.');
        }

        const versionInfo = new Uint8Array(WINDOWS_VERSION_INFO_BYTES);
        const versionView = new DataView(versionInfo.buffer);
        versionView.setUint32(0, WINDOWS_VERSION_INFO_BYTES, true);
        if (native.symbols.RtlGetVersion(versionInfo) !== 0) {
          throw new WindowsSystemError('RtlGetVersion failed.');
        }

        const memoryBytes = Number(memoryView.getBigUint64(MEMORY_STATUS_TOTAL_PHYSICAL_OFFSET, true));
        const cpuModel =
          environment.PROCESSOR_IDENTIFIER?.trim() || environment.PROCESSOR_ARCHITECTURE?.trim() || 'Windows processor';
        const operatingSystem = `Windows ${versionView.getUint32(WINDOWS_VERSION_MAJOR_OFFSET, true)}.${versionView.getUint32(
          WINDOWS_VERSION_MINOR_OFFSET,
          true,
        )}.${versionView.getUint32(WINDOWS_VERSION_BUILD_OFFSET, true)}`;
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
          throw new WindowsSystemError('Windows memory metadata is invalid.');
        }
        return {
          cpuModel,
          effectiveMemoryBytes: memoryBytes,
          memoryBytes,
          operatingSystem,
        } satisfies WindowsHardwareInfo;
      } finally {
        native.close();
        kernel.close();
      }
    },
    catch: cause => new WindowsSystemError('Could not read native Windows hardware metadata.', {cause}),
  });
}

export function readWindowsProcessStartIdentity(processId: number): Effect.Effect<string | undefined> {
  return Effect.sync(() => {
    try {
      const kernel = dlopen('kernel32.dll', {
        CloseHandle: {
          args: ['ptr'],
          returns: 'i32',
        },
        GetProcessTimes: {
          args: ['ptr', 'buffer', 'buffer', 'buffer', 'buffer'],
          returns: 'i32',
        },
        OpenProcess: {
          args: ['u32', 'i32', 'u32'],
          returns: 'ptr',
        },
      });
      try {
        const handle = kernel.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, processId);
        if (handle === null) return undefined;
        try {
          const creationTime = new BigUint64Array(1);
          const exitTime = new BigUint64Array(1);
          const kernelTime = new BigUint64Array(1);
          const userTime = new BigUint64Array(1);
          if (kernel.symbols.GetProcessTimes(handle, creationTime, exitTime, kernelTime, userTime) === 0) {
            return undefined;
          }
          return `win32:${creationTime[0] + DOTNET_TICKS_AT_WINDOWS_FILE_TIME_EPOCH}`;
        } finally {
          kernel.symbols.CloseHandle(handle);
        }
      } finally {
        kernel.close();
      }
    } catch {
      return undefined;
    }
  });
}
