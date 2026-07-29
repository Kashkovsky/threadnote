import {Deferred, Effect, Ref} from 'effect';
import {describe, expect, it} from 'vitest';
import {makeCodeGraphWatcher, type CodeGraphWatchOptions} from '../../src/code_graph/watcher.js';

const options: CodeGraphWatchOptions = {
  cwd: '/fixture/repository',
  key: 'repository:worktree',
  threadnoteHome: '/fixture/home',
};

describe('CodeGraphWatcher', () => {
  it('deduplicates concurrent session registrations and finalizes the watcher with the session scope', async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const starts = yield* Ref.make(0);
        const stops = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* makeCodeGraphWatcher(() =>
              Effect.acquireRelease(
                Ref.update(starts, count => count + 1).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
                () => Ref.update(stops, count => count + 1),
              ).pipe(Effect.andThen(Effect.never), Effect.scoped),
            );
            yield* Effect.all(
              Array.from({length: 20}, () => watcher.ensure(options)),
              {concurrency: 'unbounded'},
            );
            yield* Deferred.await(started);
            expect(yield* Ref.get(starts)).toBe(1);
            expect(yield* Ref.get(stops)).toBe(0);
          }),
        );
        return {starts: yield* Ref.get(starts), stops: yield* Ref.get(stops)};
      }),
    );

    expect(counts).toEqual({starts: 1, stops: 1});
  });

  it('keeps explicit watch mode distinct from session registration', async () => {
    const initialRefreshes: boolean[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* makeCodeGraphWatcher((_options, initialRefresh) =>
            Effect.sync(() => {
              initialRefreshes.push(initialRefresh);
            }),
          );
          yield* watcher.watch(options);
        }),
      ),
    );

    expect(initialRefreshes).toEqual([true]);
  });

  it('starts a replacement watcher after the previous run terminates', async () => {
    const starts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const count = yield* Ref.make(0);
          const firstStarted = yield* Deferred.make<void>();
          const firstRelease = yield* Deferred.make<void>();
          const firstStopped = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(() =>
            Ref.updateAndGet(count, value => value + 1).pipe(
              Effect.tap(value =>
                value === 1 ? Deferred.succeed(firstStarted, undefined) : Deferred.succeed(secondStarted, undefined),
              ),
              Effect.flatMap(value => (value === 1 ? Deferred.await(firstRelease) : Effect.never)),
              Effect.ensuring(Deferred.succeed(firstStopped, undefined)),
            ),
          );

          yield* watcher.ensure(options);
          yield* Deferred.await(firstStarted);
          yield* Deferred.succeed(firstRelease, undefined);
          yield* Deferred.await(firstStopped);
          yield* Effect.yieldNow;
          yield* watcher.ensure(options);
          yield* Deferred.await(secondStarted);
          return yield* Ref.get(count);
        }),
      ),
    );

    expect(starts).toBe(2);
  });
});
