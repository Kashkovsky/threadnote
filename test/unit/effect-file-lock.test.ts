import {Effect, FileSystem} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FileLockTimeout, withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {join, mkdir, mkdtemp, rm, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

const TEST_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 5,
  retryIntervalMilliseconds: 2,
  staleAfterMilliseconds: 20,
  waitTimeoutMilliseconds: 500,
} as const;

describe('Effect file lock', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-file-lock-');
    lockPath = join(directory, 'locks', 'test.lock');
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it('refreshes a live lease and keeps concurrent critical sections serialized', async () => {
    const trace: string[] = [];
    await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = withExclusiveFileLock(
          fs,
          lockPath,
          TEST_LOCK_OPTIONS,
          Effect.gen(function* () {
            yield* Effect.sync(() => trace.push('first:start'));
            yield* Effect.sleep(75);
            yield* Effect.sync(() => trace.push('first:end'));
          }),
        );
        const second = Effect.sleep(30).pipe(
          Effect.andThen(
            withExclusiveFileLock(
              fs,
              lockPath,
              TEST_LOCK_OPTIONS,
              Effect.sync(() => trace.push('second:start', 'second:end')),
            ),
          ),
        );
        yield* Effect.all([first, second], {concurrency: 2});
      }),
    );

    expect(trace).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('reports lock contention with a typed timeout', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, `${process.pid}:live-owner\n`, {mode: 0o600});

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(
            fs,
            lockPath,
            {...TEST_LOCK_OPTIONS, waitTimeoutMilliseconds: 10},
            Effect.void,
          );
        }),
      ),
    ).rejects.toBeInstanceOf(FileLockTimeout);
  });

  it('recovers a stale lock only when its recorded owner is not alive', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired'));
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('recovers a fresh lock immediately when its recorded owner is no longer alive', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired'));
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('recovers a stale lock even when an old recovery guard was orphaned', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    await writeFile(`${lockPath}.recovery`, '2147483647:orphaned-recovery\n', {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(`${lockPath}.recovery`, old, old);

    await expect(
      run(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* withExclusiveFileLock(fs, lockPath, TEST_LOCK_OPTIONS, Effect.succeed('acquired'));
        }),
      ),
    ).resolves.toBe('acquired');
  });

  it('waits behind a live recovery lease before taking over a stale lock', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    await writeFile(`${lockPath}.recovery`, `${process.pid}:live-recovery\n`, {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(`${lockPath}.recovery`, old, old);
    let recoveryLeaseReleased = false;
    const release = setTimeout(() => {
      recoveryLeaseReleased = true;
      void rm(`${lockPath}.recovery`, {force: true});
    }, 40);

    try {
      await expect(
        run(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* withExclusiveFileLock(
              fs,
              lockPath,
              TEST_LOCK_OPTIONS,
              Effect.sync(() => recoveryLeaseReleased),
            );
          }),
        ),
      ).resolves.toBe(true);
    } finally {
      clearTimeout(release);
    }
  });

  it('serializes simultaneous contenders during stale-lock takeover', async () => {
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:dead-owner\n', {mode: 0o600});
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    let active = 0;
    let maximumActive = 0;
    const contender = (name: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* withExclusiveFileLock(
          fs,
          lockPath,
          TEST_LOCK_OPTIONS,
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
            });
            yield* Effect.sleep(30);
            yield* Effect.sync(() => {
              active -= 1;
            });
            return name;
          }),
        );
      });

    await expect(run(Effect.all([contender('first'), contender('second')], {concurrency: 2}))).resolves.toEqual([
      'first',
      'second',
    ]);
    expect(maximumActive).toBe(1);
  });
});
