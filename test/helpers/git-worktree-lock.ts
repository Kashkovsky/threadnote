import {publicRemoteMemoryError} from '../../src/remote_memory/errors.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {SystemInfo} from '../../src/effect/system.js';
import {makeGitWorktreeLock, type GitWorktreeLock} from '../../src/effect/git_worktree_lock.js';
import {provideTestLayer} from './effect-layer.js';

export const gitLockTestLayer = Layer.merge(SystemInfo.layer, BunServices.layer);

/** Runs the production adapter for tests of the Promise/Git process boundary. */
export const testGitWorktreeLock: GitWorktreeLock = (path, operation) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* makeGitWorktreeLock();
        return yield* Effect.tryPromise({try: () => lock(path, operation), catch: publicRemoteMemoryError});
      }),
    ).pipe(provideTestLayer(gitLockTestLayer)),
  );
