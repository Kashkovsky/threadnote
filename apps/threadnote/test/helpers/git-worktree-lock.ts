import {TestSystemInfoLayer} from './system-layer.js';
import {publicRemoteMemoryError} from '@threadnote/remote-memory/errors';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';

import {makeGitWorktreeLock, type GitWorktreeLock} from '@threadnote/threadnote/effect/git_worktree_lock';
import {provideTestLayer} from './effect-layer.js';

export const gitLockTestLayer = Layer.merge(TestSystemInfoLayer, BunServices.layer);

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
