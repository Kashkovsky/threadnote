import {Effect, FileSystem, Path} from 'effect';
import {sha256Hex} from './digest.js';
import {withExclusiveFileLock} from './file_lock.js';

const MEMORY_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const MEMORY_LOCK_RETRY_MILLISECONDS = 25;
const MEMORY_LOCK_WAIT_TIMEOUT_MILLISECONDS = 30_000;
const MEMORY_LOCK_OPTIONS = {
  retryIntervalMilliseconds: MEMORY_LOCK_RETRY_MILLISECONDS,
  staleAfterMilliseconds: MEMORY_LOCK_STALE_MILLISECONDS,
  waitTimeoutMilliseconds: MEMORY_LOCK_WAIT_TIMEOUT_MILLISECONDS,
} as const;

/**
 * Serializes writes by their storage URI. Sorting the lock paths keeps
 * cross-URI replacements deadlock-free when two writers touch the same pair.
 */
export function withMemoryUriLocks<A, E, R>(
  fs: FileSystem.FileSystem,
  agentContextHome: string,
  uris: readonly (string | undefined)[],
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const uniqueUris = [...new Set(uris.filter((uri): uri is string => uri !== undefined))];
    const lockPaths = yield* Effect.forEach(uniqueUris, uri =>
      sha256Hex(uri).pipe(
        Effect.map(digest => pathService.join(agentContextHome, 'threadnote', 'memory-locks', `${digest}.lock`)),
      ),
    );
    return yield* lockPaths
      .sort()
      .reduceRight<Effect.Effect<A, E | unknown, R>>(
        (protectedEffect, lockPath) =>
          withExclusiveFileLock(fs, lockPath, MEMORY_LOCK_OPTIONS, protectedEffect) as Effect.Effect<A, E | unknown, R>,
        effect,
      );
  });
}
