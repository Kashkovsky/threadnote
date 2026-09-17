import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, Ref} from 'effect';
import {describe, expect} from 'vitest';
import {
  EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
  makeCodeGraphBuildResourceCoordinator,
} from '../../src/code_graph/build_resources.js';

describe('code graph build resource coordinator', () => {
  effectIt.effect('returns preparation and prepared-spool resources on interruption', () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<Array<string | undefined>>([]);
      const resources = yield* makeCodeGraphBuildResourceCoordinator(resource =>
        Ref.update(observed, values => [...values, resource]),
      );
      const entered = yield* Deferred.make<void>();
      const fiber = yield* Effect.acquireUseRelease(
        resources.acquirePreparedSpool(1024),
        () =>
          Effect.acquireUseRelease(
            resources.acquirePreparation,
            () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            () => resources.releasePreparation,
          ),
        () => resources.releasePreparedSpool(1024),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(yield* resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(yield* Ref.get(observed)).toEqual([
        'prepared-spool-budget',
        'home-preparation-slot',
        'prepared-spool-budget',
        undefined,
      ]);
    }),
  );

  effectIt.effect('fails fast before waiting for a writer while preparation is held', () =>
    Effect.gen(function* () {
      const resources = yield* makeCodeGraphBuildResourceCoordinator(() => Effect.void);
      yield* resources.acquirePreparation;
      const exit = yield* Effect.exit(resources.assertWriterMayWait);
      expect(exit._tag).toBe('Failure');
      yield* resources.releasePreparation;
      yield* resources.assertWriterMayWait;
    }),
  );

  effectIt.effect('exposes the bounded legacy admission remainder while permitting its writer phase', () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<Array<string | undefined>>([]);
      const resources = yield* makeCodeGraphBuildResourceCoordinator(resource =>
        Ref.update(observed, values => [...values, resource]),
      );
      yield* resources.acquireLegacyBuilder;
      yield* resources.assertWriterMayWait;
      yield* resources.acquireWriter;
      yield* resources.releaseWriter;
      yield* resources.releaseLegacyBuilder;
      expect(yield* resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      expect(yield* Ref.get(observed)).toEqual([
        'home-builder-slot',
        'checkout-writer',
        'home-builder-slot',
        undefined,
      ]);
    }),
  );
});
