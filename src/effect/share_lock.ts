import {Clock, Effect, FileSystem, Option, Path} from 'effect';
import type {ShareRuntime} from '../types.js';
import {readExclusiveFileLockOwner, withExclusiveFileLock} from './file_lock.js';
import {SystemInfo} from './system.js';

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

export type SharedRepositoryLockState = 'active' | 'available' | 'unhealthy';

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
    const lockPath = sharedRepositoryLockPath(pathService, agentContextHome);
    const lockOptions =
      options.waitTimeoutMilliseconds === undefined
        ? SHARED_REPOSITORY_LOCK_OPTIONS
        : {...SHARED_REPOSITORY_LOCK_OPTIONS, waitTimeoutMilliseconds: options.waitTimeoutMilliseconds};
    return yield* withExclusiveFileLock(fs, lockPath, lockOptions, Effect.uninterruptible(criticalSection));
  });
}

/**
 * Observes whether automatic reads can safely defer to another live share
 * operation. A healthy live lease is normal under concurrent agents; malformed,
 * stale, dead-owner, and identity-mismatched locks remain visible as unhealthy.
 */
export const observeSharedRepositoryHomeLock = Effect.fn('share.observeRepositoryLock')(function* (
  agentContextHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  const lockPath = sharedRepositoryLockPath(pathService, agentContextHome);
  return yield* Effect.gen(function* () {
    if (!(yield* fs.exists(lockPath))) return 'available' as const;
    const owner = Option.getOrUndefined(yield* readExclusiveFileLockOwner(fs, lockPath));
    if (!owner) return 'unhealthy' as const;
    const info = yield* fs.stat(lockPath);
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    const now = yield* Clock.currentTimeMillis;
    if (
      info.type !== 'File' ||
      modifiedAt === undefined ||
      now - modifiedAt > SHARED_REPOSITORY_LOCK_STALE_MILLISECONDS ||
      !system.isProcessRunning(owner.processId)
    ) {
      return 'unhealthy' as const;
    }
    if (owner.processStartIdentity) {
      const currentIdentity = yield* system.processStartIdentity(owner.processId);
      if (currentIdentity !== undefined && currentIdentity !== owner.processStartIdentity) {
        return 'unhealthy' as const;
      }
    }
    return 'active' as const;
  }).pipe(Effect.catch(() => Effect.succeed('unhealthy' as const)));
});

function sharedRepositoryLockPath(pathService: Path.Path, agentContextHome: string): string {
  return pathService.join(agentContextHome, 'threadnote', 'shared-repository.lock');
}
