import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Ref} from 'effect';
import {TestClock} from 'effect/testing';
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
            const watcher = yield* makeCodeGraphWatcher(
              () =>
                Effect.acquireRelease(
                  Ref.update(starts, count => count + 1).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
                  () => Ref.update(stops, count => count + 1),
                ).pipe(Effect.andThen(Effect.never), Effect.scoped),
              () => Effect.void,
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
          const watcher = yield* makeCodeGraphWatcher(
            (_options, initialRefresh) =>
              Effect.sync(() => {
                initialRefreshes.push(initialRefresh);
              }),
            () => Effect.void,
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
          const watcher = yield* makeCodeGraphWatcher(
            () =>
              Ref.updateAndGet(count, value => value + 1).pipe(
                Effect.tap(value =>
                  value === 1 ? Deferred.succeed(firstStarted, undefined) : Deferred.succeed(secondStarted, undefined),
                ),
                Effect.flatMap(value => (value === 1 ? Deferred.await(firstRelease) : Effect.never)),
                Effect.ensuring(Deferred.succeed(firstStopped, undefined)),
              ),
            () => Effect.void,
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

  it('deduplicates background refreshes and exposes progress until the graph is ready', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            refreshOptions =>
              Ref.update(starts, count => count + 1).pipe(
                Effect.andThen(
                  refreshOptions.onProgress?.({
                    accepted: 128,
                    phase: 'scanning',
                    skipped: 4,
                    visited: 132,
                  }) ?? Effect.void,
                ),
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(refreshOptions.onRefreshed?.(200, 400) ?? Effect.void),
                Effect.ensuring(Deferred.succeed(completed, undefined)),
              ),
          );

          yield* Effect.all(
            Array.from({length: 20}, () => watcher.refresh(options)),
            {concurrency: 'unbounded'},
          );
          yield* Deferred.await(started);
          const indexing = yield* watcher.status(options.key);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
          const ready = yield* watcher.status(options.key);
          return {indexing, ready, starts: yield* Ref.get(starts)};
        }),
      ),
    );

    expect(result.starts).toBe(1);
    expect(result.indexing).toMatchObject({
      _tag: 'Some',
      value: {
        progress: {accepted: 128, phase: 'scanning', skipped: 4, visited: 132},
        state: 'indexing',
      },
    });
    expect(result.ready).toMatchObject({
      _tag: 'Some',
      value: {edges: 400, state: 'ready', symbols: 200},
    });
  });

  it('serializes explicit and watch-triggered refreshes while coalescing a trailing run', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const concurrent = yield* Ref.make(0);
          const maximumConcurrent = yield* Ref.make(0);
          const watchStarted = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<void>();
          const secondStarted = yield* Deferred.make<void>();
          const firstRelease = yield* Deferred.make<void>();
          const secondRelease = yield* Deferred.make<void>();
          const secondCompleted = yield* Deferred.make<void>();
          let trigger: (() => Effect.Effect<void>) | undefined;
          const watcher = yield* makeCodeGraphWatcher(
            (_options, _initialRefresh, requestRefresh) =>
              Effect.sync(() => {
                trigger = requestRefresh;
              }).pipe(Effect.andThen(Deferred.succeed(watchStarted, undefined)), Effect.andThen(Effect.never)),
            refreshOptions =>
              Effect.gen(function* () {
                const ordinal = yield* Ref.updateAndGet(starts, count => count + 1);
                const active = yield* Ref.updateAndGet(concurrent, count => count + 1);
                yield* Ref.update(maximumConcurrent, current => Math.max(current, active));
                yield* refreshOptions.onProgress?.({
                  accepted: ordinal,
                  phase: 'scanning',
                  skipped: 0,
                  visited: ordinal,
                }) ?? Effect.void;
                yield* Deferred.succeed(ordinal === 1 ? firstStarted : secondStarted, undefined);
                yield* Deferred.await(ordinal === 1 ? firstRelease : secondRelease);
                yield* refreshOptions.onRefreshed?.(ordinal * 100, ordinal * 200) ?? Effect.void;
                if (ordinal === 2) yield* Deferred.succeed(secondCompleted, undefined);
              }).pipe(Effect.ensuring(Ref.update(concurrent, count => count - 1))),
          );

          yield* watcher.ensure(options);
          yield* Deferred.await(watchStarted);
          yield* watcher.refresh(options);
          yield* Deferred.await(firstStarted);
          yield* Effect.all(
            [
              ...Array.from({length: 50}, () => trigger!()),
              ...Array.from({length: 50}, () => watcher.refresh(options)),
            ],
            {concurrency: 'unbounded'},
          );
          const beforeRelease = {
            maximum: yield* Ref.get(maximumConcurrent),
            starts: yield* Ref.get(starts),
          };
          yield* Deferred.succeed(firstRelease, undefined);
          yield* Deferred.await(secondStarted);
          const duringTrailing = {
            maximum: yield* Ref.get(maximumConcurrent),
            starts: yield* Ref.get(starts),
          };
          yield* Effect.all(
            Array.from({length: 50}, () => watcher.refresh(options)),
            {
              concurrency: 'unbounded',
            },
          );
          yield* Deferred.succeed(secondRelease, undefined);
          yield* Deferred.await(secondCompleted);
          yield* Effect.yieldNow;
          return {
            beforeRelease,
            duringTrailing,
            finalMaximum: yield* Ref.get(maximumConcurrent),
            finalStarts: yield* Ref.get(starts),
            status: yield* watcher.status(options.key),
          };
        }),
      ),
    );

    expect(result.beforeRelease).toEqual({maximum: 1, starts: 1});
    expect(result.duringTrailing).toEqual({maximum: 1, starts: 2});
    expect(result.finalMaximum).toBe(1);
    expect(result.finalStarts).toBe(2);
    expect(result.status).toMatchObject({
      _tag: 'Some',
      value: {edges: 400, state: 'ready', symbols: 200},
    });
  });

  it('serializes refreshes across repository keys to bound process memory', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const concurrent = yield* Ref.make(0);
          const maximumConcurrent = yield* Ref.make(0);
          const firstStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const repositoryCount = 8;
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () =>
              Effect.gen(function* () {
                const ordinal = yield* Ref.updateAndGet(starts, count => count + 1);
                const active = yield* Ref.updateAndGet(concurrent, count => count + 1);
                yield* Ref.update(maximumConcurrent, current => Math.max(current, active));
                if (ordinal === 1) yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(release);
                if (ordinal === repositoryCount) yield* Deferred.succeed(completed, undefined);
              }).pipe(Effect.ensuring(Ref.update(concurrent, count => count - 1))),
          );

          yield* Effect.all(
            Array.from({length: repositoryCount}, (_, index) =>
              watcher.refresh({...options, key: `repository:worktree:${index}`}),
            ),
            {concurrency: 'unbounded'},
          );
          yield* Deferred.await(firstStarted);
          yield* Effect.yieldNow;
          const beforeRelease = {
            maximum: yield* Ref.get(maximumConcurrent),
            starts: yield* Ref.get(starts),
          };
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
          return {
            beforeRelease,
            finalMaximum: yield* Ref.get(maximumConcurrent),
            finalStarts: yield* Ref.get(starts),
          };
        }),
      ),
    );

    expect(result.beforeRelease).toEqual({maximum: 1, starts: 1});
    expect(result.finalMaximum).toBe(1);
    expect(result.finalStarts).toBe(8);
  });

  it('caps retained session watchers and evicts the least recently used registrations', async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const starts = yield* Ref.make(0);
        const stops = yield* Ref.make(0);
        const inside = yield* Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* makeCodeGraphWatcher(
              () =>
                Effect.acquireRelease(
                  Ref.update(starts, count => count + 1),
                  () => Ref.update(stops, count => count + 1),
                ).pipe(Effect.andThen(Effect.never), Effect.scoped),
              () => Effect.void,
              {maximumWatchers: 4},
            );
            for (let index = 0; index < 20; index += 1) {
              yield* watcher.ensure({...options, key: `repository:worktree:${index}`});
              yield* Effect.yieldNow;
            }
            return {
              running: (yield* Ref.get(starts)) - (yield* Ref.get(stops)),
              starts: yield* Ref.get(starts),
              stops: yield* Ref.get(stops),
            };
          }),
        );
        return {
          inside,
          starts: yield* Ref.get(starts),
          stops: yield* Ref.get(stops),
        };
      }),
    );

    expect(counts.inside).toEqual({running: 4, starts: 20, stops: 16});
    expect(counts).toMatchObject({starts: 20, stops: 20});
  });

  effectIt.effect('does not schedule the idle sweep before a session watcher exists', () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const watcher = yield* makeCodeGraphWatcher(
        () => Ref.update(starts, count => count + 1).pipe(Effect.andThen(Effect.never)),
        () => Effect.void,
      );

      // Runtime consumers can set a deterministic wall-clock timestamp before
      // ever using code graph watch. An eager recurring sweep would force the
      // TestClock to replay every minute since the epoch.
      yield* TestClock.setTime(2_000_000_000_000);
      yield* watcher.ensure(options);
      yield* Effect.yieldNow;

      expect(yield* Ref.get(starts)).toBe(1);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('evicts idle watchers and restarts them on later use', () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const stops = yield* Ref.make(0);
      const watcher = yield* makeCodeGraphWatcher(
        () =>
          Effect.acquireRelease(
            Ref.update(starts, count => count + 1),
            () => Ref.update(stops, count => count + 1),
          ).pipe(Effect.andThen(Effect.never), Effect.scoped),
        () => Effect.void,
        {
          idleTimeoutMilliseconds: 1_000,
          maximumWatchers: 4,
          sweepIntervalMilliseconds: 100,
        },
      );

      yield* watcher.ensure(options);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(900);
      yield* watcher.status(options.key);
      yield* TestClock.adjust(900);
      expect(yield* Ref.get(stops)).toBe(0);
      yield* TestClock.adjust(200);
      expect(yield* Ref.get(stops)).toBe(1);
      yield* watcher.ensure(options);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(starts)).toBe(2);
    }).pipe(Effect.scoped),
  );
});
