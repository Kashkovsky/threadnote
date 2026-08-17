import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, Layer, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, beforeEach, describe, expect} from 'vitest';
import {withCodeGraphBuilderAdmission} from '../../src/code_graph/builder_admission.js';
import {SystemInfo} from '../../src/effect/system.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';

const BUILDER_ADMISSION_TEST_LAYER = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

describe('code graph home builder admission', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp('threadnote-builder-admission-');
  });

  afterEach(async () => {
    await rm(home, {force: true, recursive: true});
  });

  effectIt.effect('admits two builders and gives the next slot to queued current-required work', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const trace = yield* Ref.make<string[]>([]);
        const occupied = yield* Ref.make(0);
        const twoOccupied = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const releaseCurrent = yield* Deferred.make<void>();
        const releaseBackground = yield* Deferred.make<void>();
        const backgroundWaiting = yield* Deferred.make<void>();
        const currentWaiting = yield* Deferred.make<void>();
        const currentStarted = yield* Deferred.make<void>();
        const backgroundStarted = yield* Deferred.make<void>();

        const occupant = (name: string, release: Deferred.Deferred<void>) =>
          withCodeGraphBuilderAdmission(
            {admissionClass: 'background', threadnoteHome: home},
            Effect.gen(function* () {
              yield* Ref.update(trace, values => [...values, name]);
              if ((yield* Ref.updateAndGet(occupied, value => value + 1)) === 2) {
                yield* Deferred.succeed(twoOccupied, undefined);
              }
              yield* Deferred.await(release);
            }),
          );

        const firstFiber = yield* occupant('background-1', releaseFirst).pipe(Effect.forkChild);
        const secondFiber = yield* occupant('background-2', releaseSecond).pipe(Effect.forkChild);
        yield* Deferred.await(twoOccupied);

        const backgroundFiber = yield* withCodeGraphBuilderAdmission(
          {
            admissionClass: 'background',
            onWaiting: Deferred.succeed(backgroundWaiting, undefined).pipe(Effect.asVoid),
            threadnoteHome: home,
          },
          Ref.update(trace, values => [...values, 'background-queued']).pipe(
            Effect.andThen(Deferred.succeed(backgroundStarted, undefined)),
            Effect.andThen(Deferred.await(releaseBackground)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(backgroundWaiting);

        const currentFiber = yield* withCodeGraphBuilderAdmission(
          {
            admissionClass: 'current-required',
            onWaiting: Deferred.succeed(currentWaiting, undefined).pipe(Effect.asVoid),
            threadnoteHome: home,
          },
          Ref.update(trace, values => [...values, 'current']).pipe(
            Effect.andThen(Deferred.succeed(currentStarted, undefined)),
            Effect.andThen(Deferred.await(releaseCurrent)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(currentWaiting);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(currentStarted);
        expect(yield* Deferred.isDone(backgroundStarted)).toBe(false);
        expect(yield* Ref.get(trace)).toEqual(expect.arrayContaining(['background-1', 'background-2', 'current']));

        yield* Deferred.succeed(releaseCurrent, undefined);
        yield* Deferred.await(backgroundStarted);
        yield* Deferred.succeed(releaseBackground, undefined);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Effect.all([firstFiber, secondFiber, currentFiber, backgroundFiber].map(Fiber.join), {
          concurrency: 'unbounded',
          discard: true,
        });
        expect((yield* Ref.get(trace)).at(-1)).toBe('background-queued');
      }).pipe(provideTestLayer(BUILDER_ADMISSION_TEST_LAYER)),
    ),
  );
});
