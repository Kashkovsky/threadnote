import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  effectiveLinuxMemoryBytes,
  linuxCgroupMemoryFiles,
  parseLinuxCgroupMemoryLimitBytes,
} from '../../src/effect/linux_cgroup.js';
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

describe('Linux cgroup effective memory', () => {
  effectIt.prop(
    'resolves every normalized cgroup ancestor exactly once from current group to mount root',
    {
      segments: FC.array(FC.stringMatching(/^[a-z][a-z0-9:_-]{0,12}$/), {maxLength: 8, minLength: 1}),
    },
    ({segments}) => {
      const relative = segments.join('/');
      const files = linuxCgroupMemoryFiles(
        `0::/tenant/${relative}\n`,
        '29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
      );
      const expected = Array.from({length: segments.length + 1}, (_, index) => {
        const ancestor = segments.slice(0, segments.length - index).join('/');
        return {path: `/sys/fs/cgroup/${ancestor ? `${ancestor}/` : ''}memory.max`, version: 2 as const};
      });

      expect(files).toEqual(expected);
      expect(new Set(files.map(file => file.path)).size).toBe(files.length);
      expect(files.every(file => file.path.startsWith('/sys/fs/cgroup/') && !file.path.includes('..'))).toBe(true);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('resolves cgroup v2 current and visible ancestor limits with colon-bearing paths', () => {
    const files = linuxCgroupMemoryFiles(
      '0::/tenant.slice/job:blue/task\n',
      '29 23 0:26 /tenant.slice /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n',
    );

    expect(files).toEqual([
      {path: '/sys/fs/cgroup/job:blue/task/memory.max', version: 2},
      {path: '/sys/fs/cgroup/job:blue/memory.max', version: 2},
      {path: '/sys/fs/cgroup/memory.max', version: 2},
    ]);
  });

  it('maps a cgroup namespace root to a non-root mount and decodes escaped mount paths', () => {
    const files = linuxCgroupMemoryFiles(
      '0::/\n',
      '31 23 0:28 /docker/hidden /sys/fs/cgroup\\040memory rw - cgroup2 cgroup rw\n',
    );

    expect(files).toEqual([{path: '/sys/fs/cgroup memory/memory.max', version: 2}]);
  });

  it('resolves hybrid v1 and v2 memory hierarchies while ignoring unrelated mounts', () => {
    const files = linuxCgroupMemoryFiles(
      ['0::/unified/work', '5:cpu,memory:/legacy/team/work', '7:cpu:/cpu-only/work'].join('\n'),
      [
        '20 18 0:20 /unified /sys/fs/cgroup/unified rw - cgroup2 cgroup rw',
        '21 18 0:21 /legacy/team /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory',
        '22 18 0:22 /cpu-only /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu',
      ].join('\n'),
    );

    expect(files).toEqual([
      {path: '/sys/fs/cgroup/unified/work/memory.max', version: 2},
      {path: '/sys/fs/cgroup/unified/memory.max', version: 2},
      {path: '/sys/fs/cgroup/memory/work/memory.limit_in_bytes', version: 1},
      {path: '/sys/fs/cgroup/memory/memory.limit_in_bytes', version: 1},
    ]);
  });

  it('rejects unsafe or malformed membership paths and deduplicates repeated controllers', () => {
    const mount = '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
    expect(linuxCgroupMemoryFiles('0::/safe/../escape\n', mount)).toEqual([]);
    expect(linuxCgroupMemoryFiles('malformed\n', mount)).toEqual([]);
    expect(linuxCgroupMemoryFiles('0::/safe\n0::/safe\n', mount)).toEqual([
      {path: '/sys/fs/cgroup/safe/memory.max', version: 2},
      {path: '/sys/fs/cgroup/memory.max', version: 2},
    ]);
  });

  it('parses finite limits exactly and treats unlimited sentinels as non-constraining', () => {
    const gib = 1_024 * 1_024 * 1_024;
    expect(parseLinuxCgroupMemoryLimitBytes('8589934592\n')).toBe(8_589_934_592n);
    expect(parseLinuxCgroupMemoryLimitBytes('max')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('-1')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('0')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('8 GiB')).toBeUndefined();
    expect(parseLinuxCgroupMemoryLimitBytes('9223372036854771712')).toBeUndefined();
    expect(effectiveLinuxMemoryBytes(64 * gib, ['max', '9223372036854771712', String(16 * gib), String(8 * gib)])).toBe(
      8 * gib,
    );
    expect(effectiveLinuxMemoryBytes(64 * gib, ['max', '-1', '9223372036854771712'])).toBe(64 * gib);
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
    expect(hardware.effectiveMemoryBytes).toBeGreaterThan(0);
    expect(hardware.effectiveMemoryBytes).toBeLessThanOrEqual(hardware.memoryBytes);
    expect(hardware.operatingSystem.trim().length).toBeGreaterThan(0);
  });
});
