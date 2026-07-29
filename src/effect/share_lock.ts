import {Effect, FileSystem, Path} from 'effect';
import type {ShareRuntime} from '../types.js';
import {withExclusiveFileLock} from './file_lock.js';

const SHARED_REPOSITORY_LOCK_STALE_MILLISECONDS = 10 * 60 * 1_000;
const SHARED_REPOSITORY_LOCK_RETRY_MILLISECONDS = 25;
const SHARED_REPOSITORY_LOCK_WAIT_TIMEOUT_MILLISECONDS = 30_000;
const SHARED_REPOSITORY_LOCK_OPTIONS = {
  retryIntervalMilliseconds: SHARED_REPOSITORY_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: SHARED_REPOSITORY_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: SHARED_REPOSITORY_LOCK_WAIT_TIMEOUT_MILLISECONDS,
} as const;

interface SharedRepositoryLockOptions {
  readonly waitTimeoutMilliseconds?: number;
}

export function withSharedRepositoryLock<A, E, R>(
  config: ShareRuntime,
  criticalSection: Effect.Effect<A, E, R>,
  options: SharedRepositoryLockOptions = {},
) {
  return withSharedRepositoryHomeLock(config.agentContextHome, criticalSection, options);
}

export function withSharedRepositoryHomeLock<A, E, R>(
  agentContextHome: string,
  criticalSection: Effect.Effect<A, E, R>,
  options: SharedRepositoryLockOptions = {},
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const lockPath = pathService.join(agentContextHome, 'threadnote', 'shared-repository.lock');
    const lockOptions =
      options.waitTimeoutMilliseconds === undefined
        ? SHARED_REPOSITORY_LOCK_OPTIONS
        : {...SHARED_REPOSITORY_LOCK_OPTIONS, waitTimeoutMilliseconds: options.waitTimeoutMilliseconds};
    return yield* withExclusiveFileLock(fs, lockPath, lockOptions, Effect.uninterruptible(criticalSection));
  });
}
