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

export function withSharedRepositoryLock<A, E, R>(config: ShareRuntime, criticalSection: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const lockPath = pathService.join(config.agentContextHome, 'threadnote', 'shared-repository.lock');
    return yield* withExclusiveFileLock(
      fs,
      lockPath,
      SHARED_REPOSITORY_LOCK_OPTIONS,
      Effect.uninterruptible(criticalSection),
    );
  });
}
