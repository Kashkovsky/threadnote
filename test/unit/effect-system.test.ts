import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  parsePosixAvailableDiskBytes,
  parseLinuxProcessStartIdentity,
  parseProcessStartIdentityOutput,
  parseWindowsAvailableDiskBytes,
  resolveHomeDirectory,
  SystemInfo,
} from '../../src/effect/system.js';

describe('SystemInfo home directory resolution', () => {
  it('ignores empty Windows home variables', () => {
    expect(
      resolveHomeDirectory(
        {
          HOME: '',
          HOMEDRIVE: 'C:',
          HOMEPATH: '\\Users\\threadnote',
          USERPROFILE: '   ',
        },
        'win32',
      ),
    ).toBe('C:\\Users\\threadnote');
  });

  it('uses a non-empty POSIX HOME before compatibility variables', () => {
    expect(resolveHomeDirectory({HOME: '/home/threadnote', USERPROFILE: '/fallback'}, 'linux')).toBe(
      '/home/threadnote',
    );
  });

  it('fails explicitly when no home directory is available', () => {
    expect(() => resolveHomeDirectory({HOME: '', USERPROFILE: ''}, 'linux')).toThrow(
      'Could not determine the current user home directory',
    );
  });
});

describe('SystemInfo disk capacity parsing', () => {
  it('parses POSIX df output in 1024-byte blocks', () => {
    expect(
      parsePosixAvailableDiskBytes(
        'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 100000 12000 88000 12% /tmp\n',
      ),
    ).toBe(88_000 * 1024);
  });

  it('parses Windows free bytes and rejects invalid output', () => {
    expect(parseWindowsAvailableDiskBytes('987654321\r\n')).toBe(987_654_321);
    expect(parseWindowsAvailableDiskBytes('not-a-size')).toBeUndefined();
  });
});

describe('SystemInfo process identity', () => {
  it('parses Linux stat fields after a command name containing spaces and parentheses', () => {
    const fieldsThroughProcessStart = ['S', ...Array.from({length: 18}, (_, index) => String(index + 1)), '987654'];
    expect(parseLinuxProcessStartIdentity(`123 (threadnote) worker) ${fieldsThroughProcessStart.join(' ')}\n`)).toBe(
      'linux:987654',
    );
    expect(parseLinuxProcessStartIdentity('malformed stat')).toBeUndefined();
    expect(
      parseLinuxProcessStartIdentity(
        `123 (threadnote) ${['S', ...Array.from({length: 18}, () => '0'), 'not-a-tick'].join(' ')}`,
      ),
    ).toBeUndefined();
  });

  it('normalizes macOS and Windows process-start command output', () => {
    expect(parseProcessStartIdentityOutput('darwin', ' Tue Jul 28 18:57:16 2026\n')).toBe(
      'darwin:Tue Jul 28 18:57:16 2026',
    );
    expect(parseProcessStartIdentityOutput('win32', '638893834360000000\r\n')).toBe('win32:638893834360000000');
    expect(parseProcessStartIdentityOutput('linux', '123')).toBeUndefined();
    expect(parseProcessStartIdentityOutput('darwin', '   ')).toBeUndefined();
  });

  it('reports a stable identity for the current process on the host adapter', async () => {
    const identities = await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        return [
          yield* system.processStartIdentity(system.processId),
          yield* system.processStartIdentity(system.processId),
        ] as const;
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(identities[0]).toBeTruthy();
    expect(identities[1]).toBe(identities[0]);
  });
});

describe('SystemInfo benchmark metadata', () => {
  it('reports real CPU, memory, and operating-system values', async () => {
    const hardware = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SystemInfo).hardwareInfo();
      }).pipe(Effect.provide(ApplicationLayer)),
    );

    expect(hardware.cpuModel.trim().length).toBeGreaterThan(0);
    expect(hardware.memoryBytes).toBeGreaterThan(0);
    expect(hardware.operatingSystem.trim().length).toBeGreaterThan(0);
  });
});
