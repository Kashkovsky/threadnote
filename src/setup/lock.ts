import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../effect/file/lock.js';

const SETUP_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 50,
  staleAfterMilliseconds: 60_000,
  waitTimeoutMilliseconds: 60_000,
} as const;

export function withSetupMutationLock<A, E, R>(agentContextHome: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = `${path.resolve(agentContextHome)}.setup-mutation.lock`;
    return yield* withExclusiveFileLock(fs, lockPath, SETUP_LOCK_OPTIONS, effect);
  });
}
