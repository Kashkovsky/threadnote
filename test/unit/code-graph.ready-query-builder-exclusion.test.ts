import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {withReadyQueryBuilderExclusion} from '../../scripts/benchmark-code-graph-ready-query.js';
import {
  codeGraphMaintenanceIntentPath,
  codeGraphMaintenanceLockPath,
  codeGraphRepositoryLockPath,
  codeGraphWorktreeLockPath,
} from '../../src/code_graph/layout.js';
import {withCodeGraphMaintenanceRegistration} from '../../src/code_graph/maintenance_gate.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 20,
  retryIntervalMilliseconds: 5,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 5_000,
} as const;

describe('ready-query builder exclusion', () => {
  effectIt.effect('drains linked-worktree builders and retains every gate through the benchmark body', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ready-query-exclusion-'});
        const checkoutId = 'a'.repeat(64);
        const ownerOneAcquired = yield* Deferred.make<void>();
        const ownerTwoAcquired = yield* Deferred.make<void>();
        const releaseOwnerOne = yield* Deferred.make<void>();
        const releaseOwnerTwo = yield* Deferred.make<void>();
        const bodyEntered = yield* Deferred.make<void>();
        const releaseBody = yield* Deferred.make<void>();
        const contenderEntered = yield* Deferred.make<void>();
        const owner = (worktreeId: string, acquired: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
          withExclusiveFileLock(
            fs,
            codeGraphWorktreeLockPath(path, home, checkoutId, worktreeId),
            {...LOCK_OPTIONS, onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid)},
            Deferred.await(release),
          );
        const ownerOne = yield* Effect.forkScoped(owner('b'.repeat(64), ownerOneAcquired, releaseOwnerOne));
        const ownerTwo = yield* Effect.forkScoped(owner('c'.repeat(64), ownerTwoAcquired, releaseOwnerTwo));
        yield* Deferred.await(ownerOneAcquired);
        yield* Deferred.await(ownerTwoAcquired);

        const benchmark = yield* Effect.forkScoped(
          withReadyQueryBuilderExclusion(
            home,
            checkoutId,
            Deferred.succeed(bodyEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseBody))),
          ),
        );
        yield* Effect.sleep(25);
        expect(Option.isNone(yield* Deferred.poll(bodyEntered))).toBe(true);
        yield* Deferred.succeed(releaseOwnerOne, undefined);
        yield* Fiber.join(ownerOne);
        yield* Effect.sleep(25);
        expect(Option.isNone(yield* Deferred.poll(bodyEntered))).toBe(true);
        yield* Deferred.succeed(releaseOwnerTwo, undefined);
        yield* Fiber.join(ownerTwo);
        yield* Deferred.await(bodyEntered);

        expect(yield* fs.exists(codeGraphMaintenanceIntentPath(path, home))).toBe(true);
        expect(yield* fs.exists(codeGraphRepositoryLockPath(path, home, checkoutId))).toBe(true);
        const contender = yield* Effect.forkScoped(
          withCodeGraphMaintenanceRegistration(
            home,
            Deferred.succeed(contenderEntered, undefined).pipe(Effect.asVoid),
            5_000,
          ),
        );
        yield* Effect.sleep(25);
        expect(Option.isNone(yield* Deferred.poll(contenderEntered))).toBe(true);

        yield* Deferred.succeed(releaseBody, undefined);
        yield* Fiber.join(benchmark);
        yield* Deferred.await(contenderEntered);
        yield* Fiber.join(contender);
        expect(yield* fs.exists(codeGraphMaintenanceIntentPath(path, home))).toBe(false);
        expect(yield* fs.exists(codeGraphRepositoryLockPath(path, home, checkoutId))).toBe(false);
        expect(yield* fs.exists(codeGraphMaintenanceLockPath(path, home))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('releases its maintenance intent and file locks when the benchmark is interrupted', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ready-query-interrupt-'});
        const checkoutId = 'd'.repeat(64);
        const bodyEntered = yield* Deferred.make<void>();
        const benchmark = yield* Effect.forkScoped(
          withReadyQueryBuilderExclusion(
            home,
            checkoutId,
            Deferred.succeed(bodyEntered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(bodyEntered);
        yield* Fiber.interrupt(benchmark);

        expect(yield* fs.exists(codeGraphMaintenanceIntentPath(path, home))).toBe(false);
        expect(yield* fs.exists(codeGraphRepositoryLockPath(path, home, checkoutId))).toBe(false);
        expect(yield* fs.exists(codeGraphMaintenanceLockPath(path, home))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});
