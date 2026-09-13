import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {graphSharingLayout} from './layout.js';

const LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;

/** Serializes canonical pointer promotion with admission and quarantine checks. */
export function withCoordinatorStateLock<A, E, R>(
  options: {readonly threadnoteHome: string},
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = graphSharingLayout(path, options.threadnoteHome);
    return yield* withExclusiveFileLock(fs, layout.coordinatorStateLockPath, LOCK_OPTIONS, effect);
  });
}
