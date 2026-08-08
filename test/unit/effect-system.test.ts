import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'effect/testing/FastCheck';
import {describe, expect, it, vi} from 'vitest';
import {
  effectiveLinuxMemoryBytes,
  linuxCgroupMemoryFiles,
  parseLinuxCgroupMemoryLimitBytes,
} from '../../src/effect/linux_cgroup.js';
import {
  availableDiskBytesFromStatfs,
  parsePosixAvailableDiskBytes,
  parseLinuxProcessStartIdentity,
  parseProcessStartIdentityOutput,
  parseWindowsAvailableDiskBytes,
  probeAvailableDiskBytes,
  resolveHomeDirectory,
  makeCachedProcessStartIdentityResolver,
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

  effectIt.effect.prop(
    'converts native statfs values to a conservative safe integer monotonically',
    {
      availableBlocks: FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
      blockSize: FC.integer({max: 1_048_576, min: 1}),
      fewerAvailableBlocks: FC.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
    },
    ({availableBlocks, blockSize, fewerAvailableBlocks}) =>
      Effect.sync(() => {
        const lowerBlocks = Math.min(availableBlocks, fewerAvailableBlocks);
        const higherBlocks = Math.max(availableBlocks, fewerAvailableBlocks);
        const exactBytes = BigInt(higherBlocks) * BigInt(blockSize);
        const expected = Number(
          exactBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : exactBytes,
        );
        const lower = availableDiskBytesFromStatfs({bavail: BigInt(lowerBlocks), bsize: BigInt(blockSize)});
        const higher = availableDiskBytesFromStatfs({bavail: BigInt(higherBlocks), bsize: BigInt(blockSize)});
        if (lower === undefined || higher === undefined) {
          throw new Error('Valid native statfs values must produce a safe capacity.');
        }

        expect(higher).toBe(expected);
        expect(lower).toBeLessThanOrEqual(higher);
        expect(Number.isSafeInteger(lower)).toBe(true);
        expect(Number.isSafeInteger(higher)).toBe(true);
      }),
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('uses native asynchronous statistics on supported POSIX platforms without falling back', () =>
    Effect.gen(function* () {
      for (const platform of ['darwin', 'linux'] as const) {
        let fallbackInvocations = 0;
        let nativeInvocations = 0;
        const available = yield* probeAvailableDiskBytes(
          '/private/native-statfs-fixture',
          platform,
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 1;
              }),
            statfs: () =>
              Effect.sync(() => {
                nativeInvocations += 1;
                return {bavail: 256n, bsize: 4096n};
              }),
          },
        );

        expect(available).toBe(1_048_576);
        expect(nativeInvocations).toBe(1);
        expect(fallbackInvocations).toBe(0);
      }
    }),
  );

  effectIt.effect('falls back only for structured native-statfs unavailability', () =>
    Effect.gen(function* () {
      const unavailableCodes = ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'ERR_NOT_IMPLEMENTED', 'ERR_METHOD_NOT_IMPLEMENTED'];
      let fallbackInvocations = 0;
      for (const code of unavailableCodes) {
        const available = yield* probeAvailableDiskBytes(
          '/private/unavailable-statfs-fixture',
          'linux',
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 42;
              }),
            statfs: () => Effect.fail(Object.assign(new Error('Native statfs unavailable.'), {code})),
          },
        );
        expect(available).toBe(42);
      }

      for (const code of ['EACCES', 'EIO', 'ENOENT']) {
        const available = yield* probeAvailableDiskBytes(
          '/private/ordinary-statfs-failure',
          'linux',
          {},
          {
            fallback: () =>
              Effect.sync(() => {
                fallbackInvocations += 1;
                return 99;
              }),
            statfs: () => Effect.fail(Object.assign(new Error(`/private/ordinary-statfs-failure: ${code}`), {code})),
          },
        );
        expect(available).toBeUndefined();
      }

      expect(fallbackInvocations).toBe(unavailableCodes.length);
    }),
  );

  effectIt.effect('bounds a stalled native probe without launching the fallback', () =>
    Effect.gen(function* () {
      let fallbackInvocations = 0;
      let nativeInvocations = 0;
      const fiber = yield* probeAvailableDiskBytes(
        '/private/stalled-statfs-fixture',
        'linux',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
              return 99;
            }),
          statfs: () =>
            Effect.sync(() => {
              nativeInvocations += 1;
            }).pipe(Effect.andThen(Effect.never)),
        },
        25,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(25);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(nativeInvocations).toBe(1);
      expect(fallbackInvocations).toBe(0);
    }),
  );

  effectIt.effect('shares one total deadline between unavailable native detection and fallback work', () =>
    Effect.gen(function* () {
      let fallbackInterruptions = 0;
      let fallbackInvocations = 0;
      let nativeInvocations = 0;
      const fiber = yield* probeAvailableDiskBytes(
        '/private/total-statfs-deadline-fixture',
        'linux',
        {},
        {
          fallback: () =>
            Effect.sync(() => {
              fallbackInvocations += 1;
            }).pipe(
              Effect.andThen(Effect.sleep(60)),
              Effect.as(99),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  fallbackInterruptions += 1;
                }),
              ),
            ),
          statfs: () =>
            Effect.sync(() => {
              nativeInvocations += 1;
            }).pipe(
              Effect.andThen(Effect.sleep(60)),
              Effect.andThen(Effect.fail(Object.assign(new Error('Native statfs unavailable.'), {code: 'ENOSYS'}))),
            ),
        },
        100,
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* TestClock.adjust(60);
      yield* Effect.yieldNow;
      expect(nativeInvocations).toBe(1);
      expect(fallbackInvocations).toBe(1);

      yield* TestClock.adjust(40);

      expect(yield* Fiber.join(fiber)).toBeUndefined();
      expect(fallbackInterruptions).toBe(1);
    }),
  );

  effectIt.effect('launches no subprocesses across a bounded supported-host probe load', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(Bun, 'spawnSync')),
      spawnSyncSpy =>
        Effect.gen(function* () {
          if (process.platform !== 'darwin' && process.platform !== 'linux') return;
          const system = yield* SystemInfo;
          const capacities = yield* Effect.all(
            Array.from({length: 128}, () => system.availableDiskBytes(process.cwd())),
            {concurrency: 16},
          );

          expect(capacities).toHaveLength(128);
          expect(capacities.every(value => value !== undefined && Number.isSafeInteger(value) && value >= 0)).toBe(
            true,
          );
          expect(spawnSyncSpy).not.toHaveBeenCalled();
        }).pipe(Effect.provide(SystemInfo.layer)),
      spawnSyncSpy => Effect.sync(() => spawnSyncSpy.mockRestore()),
    ),
  );
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

  effectIt.effect('shares and caches an exact five-second unavailable own-process probe', () =>
    Effect.gen(function* () {
      let probeCount = 0;
      const resolve = yield* makeCachedProcessStartIdentityResolver(42, () =>
        Effect.sync(() => {
          probeCount += 1;
        }).pipe(Effect.andThen(Effect.sleep(5_000)), Effect.as(undefined)),
      );
      const fiber = yield* Effect.all(
        Array.from({length: 32}, () => resolve(42)),
        {
          concurrency: 'unbounded',
        },
      ).pipe(Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;

      expect(probeCount).toBe(1);
      yield* TestClock.adjust(4_999);
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toEqual(Array.from({length: 32}, () => undefined));
      expect(probeCount).toBe(1);
      expect(yield* resolve(42)).toBeUndefined();
      expect(probeCount).toBe(1);
    }),
  );

  effectIt.effect('re-elects one owner after interruption so pending callers converge on the retry', () =>
    Effect.gen(function* () {
      const firstProbeStarted = yield* Deferred.make<void>();
      let probeCount = 0;
      const resolve = yield* makeCachedProcessStartIdentityResolver(42, () =>
        Effect.suspend(() => {
          probeCount += 1;
          return probeCount === 1
            ? Deferred.succeed(firstProbeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed('fixture-process-start');
        }),
      );
      const firstOwner = yield* resolve(42).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(firstProbeStarted);
      const waiters = yield* Effect.forEach(Array.from({length: 31}), () =>
        resolve(42).pipe(Effect.forkChild({startImmediately: true})),
      );

      yield* Fiber.interrupt(firstOwner);

      expect(yield* Effect.forEach(waiters, Fiber.join)).toEqual(
        Array.from({length: 31}, () => 'fixture-process-start'),
      );
      expect(yield* resolve(42)).toBe('fixture-process-start');
      expect(probeCount).toBe(2);
    }),
  );

  effectIt.effect('cannot strand pending callers when interrupted immediately after ownership acquisition', () =>
    Effect.gen(function* () {
      const firstOwnerClaimed = yield* Deferred.make<void>();
      const releaseFirstOwner = yield* Deferred.make<void>();
      let ownerClaimCount = 0;
      let probeCount = 0;
      const resolve = yield* makeCachedProcessStartIdentityResolver(
        42,
        () =>
          Effect.sync(() => {
            probeCount += 1;
            return 'fixture-process-start';
          }),
        Effect.suspend(() => {
          ownerClaimCount += 1;
          return ownerClaimCount === 1
            ? Deferred.succeed(firstOwnerClaimed, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstOwner)),
                Effect.asVoid,
              )
            : Effect.void;
        }),
      );
      const firstOwner = yield* resolve(42).pipe(Effect.forkChild({startImmediately: true}));
      yield* Deferred.await(firstOwnerClaimed);
      const waiters = yield* Effect.forEach(Array.from({length: 31}), () =>
        resolve(42).pipe(Effect.forkChild({startImmediately: true})),
      );
      const interruption = yield* Fiber.interrupt(firstOwner).pipe(Effect.forkChild({startImmediately: true}));
      yield* Effect.yieldNow;

      yield* Deferred.succeed(releaseFirstOwner, undefined);
      yield* Fiber.join(interruption);

      expect(yield* Effect.forEach(waiters, Fiber.join)).toEqual(
        Array.from({length: 31}, () => 'fixture-process-start'),
      );
      expect(yield* resolve(42)).toBe('fixture-process-start');
      expect(ownerClaimCount).toBe(2);
      expect(probeCount).toBe(1);
    }),
  );

  effectIt.effect('reports a stable identity for the current process on the host adapter', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const identities = [
        yield* system.processStartIdentity(system.processId),
        yield* system.processStartIdentity(system.processId),
      ] as const;

      expect(identities[0]).toBeTruthy();
      expect(identities[1]).toBe(identities[0]);
    }).pipe(Effect.provide(SystemInfo.layer)),
  );
});

describe('SystemInfo benchmark metadata', () => {
  effectIt.effect('reports real CPU, memory, and operating-system values', () =>
    Effect.gen(function* () {
      const hardware = yield* (yield* SystemInfo).hardwareInfo();

      expect(hardware.cpuModel.trim().length).toBeGreaterThan(0);
      expect(hardware.memoryBytes).toBeGreaterThan(0);
      expect(hardware.effectiveMemoryBytes).toBeGreaterThan(0);
      expect(hardware.effectiveMemoryBytes).toBeLessThanOrEqual(hardware.memoryBytes);
      expect(hardware.operatingSystem.trim().length).toBeGreaterThan(0);
    }).pipe(Effect.provide(SystemInfo.layer)),
  );
});
