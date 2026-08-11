import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, Logger, Ref, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphWatcherSnapshotStale,
  makeCodeGraphWatcher,
  prewarmCandidatesFromRefOutput,
  type CodeGraphWatchOptions,
  watchRepository,
} from '../../src/code_graph/watcher.js';
import {
  CodeGraphRuntimeReconnectRequiredError,
  CodeGraphStoreBusyError,
  CodeGraphStoreNoSpaceError,
  CodeGraphStorePermissionError,
  CodeGraphStoreTransientIoError,
} from '../../src/code_graph/types.js';

const options: CodeGraphWatchOptions = {
  cwd: '/fixture/repository',
  key: 'repository:worktree',
  threadnoteHome: '/fixture/home',
};

describe('CodeGraphWatcher', () => {
  it('admits at most two unique non-current ref tips for prewarming', () => {
    const objectId = fc
      .array(fc.integer({max: 15, min: 0}), {maxLength: 40, minLength: 40})
      .map(values => values.map(value => value.toString(16)).join(''));
    fc.assert(
      fc.property(
        fc.array(objectId, {maxLength: 20}),
        objectId,
        fc.integer({max: 20, min: -5}),
        (ids, current, limit) => {
          const candidates = prewarmCandidatesFromRefOutput(
            [...ids, current, 'not-an-object-id', ...ids].join('\n'),
            current,
            limit,
          );
          expect(candidates.length).toBeLessThanOrEqual(2);
          expect(new Set(candidates).size).toBe(candidates.length);
          expect(candidates).not.toContain(current);
          expect(candidates.every(value => /^[0-9a-f]{40}$/u.test(value))).toBe(true);
        },
      ),
      {numRuns: 250},
    );
  });

  effectIt.effect('deduplicates concurrent session registrations and finalizes the watcher with the session scope', () => Effect.gen(function* () {
    const counts = yield* (Effect.gen(function* () {
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
      }));

    expect(counts).toEqual({starts: 1, stops: 1});
  }));

  effectIt.effect('keeps explicit watch mode distinct from session registration', () => Effect.gen(function* () {
    const initialRefreshes: boolean[] = [];
    yield* (Effect.scoped(
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
      ));

    expect(initialRefreshes).toEqual([true]);
  }));

  effectIt.effect('starts a replacement watcher after the previous run terminates', () => Effect.gen(function* () {
    const starts = yield* (Effect.scoped(
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
      ));

    expect(starts).toBe(2);
  }));

  effectIt.effect('starts a replacement watcher after the previous run fails', () => Effect.gen(function* () {
    const starts = yield* (Effect.scoped(
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
                Effect.flatMap(value =>
                  value === 1
                    ? Deferred.await(firstRelease).pipe(
                        Effect.andThen(Effect.fail(new TestError('transient watcher failure'))),
                      )
                    : Effect.never,
                ),
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
      ));

    expect(starts).toBe(2);
  }));

  effectIt.effect('deduplicates background refreshes and exposes progress until the graph is ready', () => Effect.gen(function* () {
    const result = yield* (Effect.scoped(
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
                    completed: 132,
                    excluded: 12,
                    phase: 'scanning',
                    skipped: 4,
                    total: 256,
                    unit: 'files',
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
      ));

    expect(result.starts).toBe(1);
    expect(result.indexing).toMatchObject({
      _tag: 'Some',
      value: {
        progress: {
          accepted: 128,
          completed: 132,
          excluded: 12,
          phase: 'scanning',
          skipped: 4,
          total: 256,
          unit: 'files',
        },
        state: 'indexing',
        timing: {
          buildId: expect.any(String),
          elapsedMilliseconds: expect.any(Number),
          lastProgressAgeMilliseconds: expect.any(Number),
        },
      },
    });
    expect(result.ready).toMatchObject({
      _tag: 'Some',
      value: {edges: 400, state: 'ready', symbols: 200},
    });
  }));

  effectIt.effect('returns promptly under held-writer load and publishes one typed deferred failure', () => Effect.gen(function* () {
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    const result = yield* (Effect.scoped(
        Effect.gen(function* () {
          const starts = yield* Ref.make(0);
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () =>
              Ref.update(starts, count => count + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.fail(
                    new CodeGraphStoreBusyError('private writer detail /Users/private/graph.sqlite', {
                      operation: 'load /Users/private/graph.sqlite',
                    }),
                  ),
                ),
              ),
          );

          yield* watcher.ensure(options);
          const requests = yield* Effect.all(
            Array.from({length: 128}, () => watcher.refresh(options)),
            {concurrency: 'unbounded'},
          );
          yield* Deferred.await(started);
          const whileHeld = yield* watcher.status(options.key);
          yield* Deferred.succeed(release, undefined);
          let settled = yield* watcher.status(options.key);
          for (
            let attempt = 0;
            attempt < 16 && settled._tag === 'Some' && settled.value.state === 'indexing';
            attempt += 1
          ) {
            yield* Effect.yieldNow;
            settled = yield* watcher.status(options.key);
          }
          return {requests, settled, starts: yield* Ref.get(starts), whileHeld};
        }),
      ).pipe(provideTestLayer(Logger.layer([logger]))));

    expect(result.starts).toBe(1);
    expect(result.requests.filter(Boolean)).toHaveLength(1);
    expect(result.whileHeld).toMatchObject({_tag: 'Some', value: {state: 'indexing'}});
    expect(result.settled).toMatchObject({
      _tag: 'Some',
      value: {
        failure: {code: 'busy', operation: 'refresh code graph', recovery: 'defer', retryable: true},
        state: 'deferred',
      },
    });
    const serialized = JSON.stringify(result.settled);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('private writer detail');
    expect(logs).toContain('Code graph background refresh deferred (busy; recovery: defer).');
    expect(logs.join('\n')).not.toContain('/fixture/repository');
    expect(logs.join('\n')).not.toContain('/Users/private');
    expect(logs.join('\n')).not.toContain('private writer detail');
  }));

  effectIt.effect('normalizes operational refresh failures without retaining native details', () => Effect.gen(function* () {
    const privateMarker = '/Volumes/private/native-graph.sqlite';
    const failures = [
      new CodeGraphStoreBusyError(`busy ${privateMarker}`),
      new CodeGraphStoreNoSpaceError(`full ${privateMarker}`),
      new CodeGraphStorePermissionError(`permission ${privateMarker}`),
      new CodeGraphRuntimeReconnectRequiredError(),
      new CodeGraphStoreTransientIoError(`io ${privateMarker}`),
    ];

    for (const failure of failures) {
      const status = yield* (Effect.scoped(
          Effect.gen(function* () {
            const watcher = yield* makeCodeGraphWatcher(
              () => Effect.never,
              () => Effect.fail(failure),
            );
            const failureOptions = {...options, key: `${options.key}:${failure.code}`};
            yield* watcher.ensure(failureOptions);
            yield* watcher.refresh(failureOptions);
            let current = yield* watcher.status(failureOptions.key);
            for (let attempt = 0; attempt < 16; attempt += 1) {
              if (current._tag === 'Some' && current.value.state !== 'indexing') break;
              yield* Effect.yieldNow;
              current = yield* watcher.status(failureOptions.key);
            }
            return current;
          }),
        ));

      expect(status).toMatchObject({
        _tag: 'Some',
        value: {failure: {code: failure.code, operation: 'refresh code graph'}, state: 'deferred'},
      });
      if (failure instanceof CodeGraphRuntimeReconnectRequiredError) {
        expect(status).toMatchObject({
          _tag: 'Some',
          value: {failure: {recovery: 'reconnect-runtime', retryable: false}, state: 'deferred'},
        });
      }
      expect(JSON.stringify(status)).not.toContain(privateMarker);
    }
  }));

  effectIt.effect('turns a refresh defect into one bounded unknown status instead of stranding indexing', () => Effect.gen(function* () {
    const privateMarker = '/Users/private/defect.sqlite';
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    const status = yield* (Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () => Effect.die(new TestError(`native defect ${privateMarker}`)),
          );
          yield* watcher.ensure(options);
          yield* watcher.refresh(options);
          let current = yield* watcher.status(options.key);
          for (let attempt = 0; attempt < 16; attempt += 1) {
            if (current._tag === 'Some' && current.value.state !== 'indexing') break;
            yield* Effect.yieldNow;
            current = yield* watcher.status(options.key);
          }
          return current;
        }),
      ).pipe(provideTestLayer(Logger.layer([logger]))));

    expect(status).toMatchObject({
      _tag: 'Some',
      value: {
        failure: {code: 'unknown', operation: 'refresh code graph', recovery: 'diagnose', retryable: false},
        state: 'deferred',
      },
    });
    expect(logs).toContain('Code graph background refresh deferred (unknown; recovery: diagnose).');
    expect(`${JSON.stringify(status)}\n${logs.join('\n')}`).not.toContain(privateMarker);
  }));

  effectIt.effect('propagates refresh scope interruption without converting it into a deferred failure', () => Effect.gen(function* () {
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    yield* (Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          );
          yield* watcher.ensure(options);
          yield* watcher.refresh(options);
          yield* Deferred.await(started);
          expect(yield* watcher.status(options.key)).toMatchObject({_tag: 'Some', value: {state: 'indexing'}});
        }),
      ).pipe(provideTestLayer(Logger.layer([logger]))));

    expect(logs.some(message => message.includes('background refresh deferred'))).toBe(false);
  }));

  effectIt.effect('keeps periodic reconciliation alive after a filesystem watch defect', () => {
    const privateMarker = '/Users/private/watch-root';
    const logs: string[] = [];
    const logger = Logger.make<unknown, void>(options => {
      logs.push(String(options.message));
    });
    return Effect.gen(function* () {
      const refreshes = yield* Ref.make(0);
      const fiber = yield* watchRepository(
        {watch: () => Stream.die(new TestError(`watch defect ${privateMarker}`))} as never,
        {} as never,
        options,
        false,
        () => Ref.update(refreshes, count => count + 1),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const beforeReconciliation = yield* Ref.get(refreshes);
      yield* TestClock.adjust('5 minutes');
      yield* Effect.yieldNow;

      expect(yield* Ref.get(refreshes)).toBeGreaterThan(beforeReconciliation);
      expect(logs).toContain('Code graph filesystem watch stopped; periodic reconciliation remains active.');
      expect(logs.join('\n')).not.toContain(privateMarker);
      yield* Fiber.interrupt(fiber);
    }).pipe(provideTestLayer(Logger.layer([logger])), Effect.scoped);
  });

  effectIt.effect('requests initial maintenance and orders change maintenance before refresh', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      const fiber = yield* watchRepository(
        {watch: () => Stream.make({path: 'source.ts'})} as never,
        {
          isAbsolute: (value: string) => value.startsWith('/'),
          join: (...values: string[]) => values.join('/'),
          relative: () => 'source.ts',
          sep: '/',
        } as never,
        options,
        false,
        () => Ref.update(events, current => [...current, 'refresh']),
        {
          periodicRefreshRequired: Effect.succeed(false),
          requestAfterChange: Ref.update(events, current => [...current, 'change-maintenance']).pipe(
            Effect.andThen(Effect.fail(new TestError('maintenance scheduling defect'))),
          ),
          requestInitial: Ref.update(events, current => [...current, 'initial-maintenance']),
        },
      ).pipe(Effect.forkScoped);

      yield* TestClock.adjust('751 millis');
      yield* Effect.yieldNow;

      expect(yield* Ref.get(events)).toEqual(['initial-maintenance', 'change-maintenance', 'refresh']);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('refreshes on periodic positive staleness and preserves on current or unknown evidence', () =>
    Effect.gen(function* () {
      for (const testCase of [
        {expectedRefreshes: 0, probe: Effect.succeed(false)},
        {expectedRefreshes: 1, probe: Effect.succeed(true)},
        {expectedRefreshes: 0, probe: Effect.fail(new TestError('unknown freshness'))},
      ] as const) {
        const refreshes = yield* Ref.make(0);
        const maintenanceRequests = yield* Ref.make(0);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* watchRepository(
              {watch: () => Stream.never} as never,
              {} as never,
              options,
              false,
              () => Ref.update(refreshes, count => count + 1),
              {
                periodicRefreshRequired: Ref.update(maintenanceRequests, count => count + 1).pipe(
                  Effect.andThen(testCase.probe),
                ),
                requestAfterChange: Effect.void,
                requestInitial: Effect.void,
              },
            ).pipe(Effect.forkScoped);
            yield* TestClock.adjust('5 minutes');
            yield* Effect.yieldNow;

            expect(yield* Ref.get(maintenanceRequests)).toBe(1);
            expect(yield* Ref.get(refreshes)).toBe(testCase.expectedRefreshes);
            yield* Fiber.interrupt(fiber);
          }),
        );
      }
    }),
  );

  effectIt.effect('classifies unchanged and changed watcher evidence without full refresh work', () =>
    Effect.sync(() => {
      const cleanSnapshot = {commit: 'a', dirty: false};
      expect(codeGraphWatcherSnapshotStale(cleanSnapshot, {headCommit: 'a'}, {dirty: false})).toBe(false);
      expect(codeGraphWatcherSnapshotStale(cleanSnapshot, {headCommit: 'b'}, {dirty: false})).toBe(true);
      expect(
        codeGraphWatcherSnapshotStale(
          {commit: 'a', dirty: true, overlayFingerprint: 'old'},
          {headCommit: 'a'},
          {dirty: true, fingerprint: 'new'},
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect('serializes explicit and watch-triggered refreshes while coalescing a trailing run', () =>
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
                completed: ordinal,
                excluded: 0,
                phase: 'scanning',
                skipped: 0,
                total: 2,
                unit: 'files',
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
          [...Array.from({length: 50}, () => trigger!()), ...Array.from({length: 50}, () => watcher.refresh(options))],
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
    ).pipe(
      Effect.tap(result =>
        Effect.sync(() => {
          expect(result.beforeRelease).toEqual({maximum: 1, starts: 1});
          expect(result.duringTrailing).toEqual({maximum: 1, starts: 2});
          expect(result.finalMaximum).toBe(1);
          expect(result.finalStarts).toBe(2);
          expect(result.status).toMatchObject({
            _tag: 'Some',
            value: {edges: 400, state: 'ready', symbols: 200},
          });
        }),
      ),
    ),
  );

  effectIt.effect('atomically collapses intermediate changes and resolves the latest target in the trailing run', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const targets: string[] = [];
        let currentTarget = 'commit-a';
        let trigger: (() => Effect.Effect<void>) | undefined;
        const firstStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondCompleted = yield* Deferred.make<void>();
        const watcher = yield* makeCodeGraphWatcher(
          (_options, _initialRefresh, requestRefresh) =>
            Effect.sync(() => {
              trigger = requestRefresh;
            }).pipe(Effect.andThen(Effect.never)),
          () =>
            Effect.gen(function* () {
              targets.push(currentTarget);
              if (targets.length === 1) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(firstRelease);
              } else {
                yield* Deferred.succeed(secondCompleted, undefined);
              }
            }),
        );

        yield* watcher.ensure(options);
        while (trigger === undefined) yield* Effect.yieldNow;
        yield* watcher.refresh(options);
        yield* Deferred.await(firstStarted);
        currentTarget = 'commit-b';
        yield* trigger!();
        currentTarget = 'commit-c';
        yield* Effect.all(
          Array.from({length: 64}, () => trigger!()),
          {
            concurrency: 'unbounded',
            discard: true,
          },
        );
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(secondCompleted);
        return targets;
      }),
    ).pipe(Effect.tap(observed => Effect.sync(() => expect(observed).toEqual(['commit-a', 'commit-c'])))),
  );

  effectIt.effect('serializes refreshes across repository keys to bound process memory', () => Effect.gen(function* () {
    const result = yield* (Effect.scoped(
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
      ));

    expect(result.beforeRelease).toEqual({maximum: 1, starts: 1});
    expect(result.finalMaximum).toBe(1);
    expect(result.finalStarts).toBe(8);
  }));

  effectIt.effect('reports exact path-free queue and execution metrics under coalescing load', () =>
    Effect.gen(function* () {
      const watchTriggers = new Map<string, () => Effect.Effect<void>>();
      const watchesStarted = yield* Ref.make(0);
      const allWatchesStarted = yield* Deferred.make<void>();
      const refreshStarts = yield* Ref.make(0);
      const refreshCompletions = yield* Ref.make(0);
      const firstRefreshStarted = yield* Deferred.make<void>();
      const allRefreshesCompleted = yield* Deferred.make<void>();
      const releaseRefreshes = yield* Deferred.make<void>();
      const firstOptions = {...options, key: 'repository:worktree:first'};
      const secondOptions = {...options, key: 'repository:worktree:second'};
      const watcher = yield* makeCodeGraphWatcher(
        (watchOptions, _initialRefresh, requestRefresh) =>
          Effect.gen(function* () {
            watchTriggers.set(watchOptions.key, requestRefresh);
            const started = yield* Ref.updateAndGet(watchesStarted, count => count + 1);
            if (started === 2) yield* Deferred.succeed(allWatchesStarted, undefined);
            return yield* Effect.never;
          }),
        refreshOptions =>
          Effect.gen(function* () {
            const started = yield* Ref.updateAndGet(refreshStarts, count => count + 1);
            if (started === 1) yield* Deferred.succeed(firstRefreshStarted, undefined);
            yield* Deferred.await(releaseRefreshes);
            yield* refreshOptions.onRefreshed?.(started * 100, started * 200) ?? Effect.void;
            const completed = yield* Ref.updateAndGet(refreshCompletions, count => count + 1);
            if (completed === 4) yield* Deferred.succeed(allRefreshesCompleted, undefined);
          }),
        {maximumWatchers: 4},
      );

      expect(yield* watcher.metrics).toEqual({
        activeRefreshKeys: 0,
        activeWatches: 0,
        executingRefreshes: 0,
        executingRefreshHighWater: 0,
        idleSweepFibers: 0,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 0,
        retainedStatuses: 0,
      });

      yield* watcher.ensure(firstOptions);
      yield* watcher.ensure(secondOptions);
      yield* Deferred.await(allWatchesStarted);
      expect(yield* watcher.metrics).toEqual({
        activeRefreshKeys: 0,
        activeWatches: 2,
        executingRefreshes: 0,
        executingRefreshHighWater: 0,
        idleSweepFibers: 1,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 0,
        retainedStatuses: 0,
      });

      yield* watcher.refresh(firstOptions);
      yield* Deferred.await(firstRefreshStarted);
      yield* watcher.refresh(secondOptions);
      yield* Effect.all(
        Array.from({length: 256}, (_, index) => {
          const selected = index % 2 === 0 ? firstOptions : secondOptions;
          return index % 4 < 2 ? watchTriggers.get(selected.key)!() : watcher.refresh(selected).pipe(Effect.asVoid);
        }),
        {concurrency: 'unbounded', discard: true},
      );

      let whileHeld = yield* watcher.metrics;
      for (let attempt = 0; attempt < 16 && whileHeld.retainedStatuses < 2; attempt += 1) {
        yield* Effect.yieldNow;
        whileHeld = yield* watcher.metrics;
      }
      expect(whileHeld).toEqual({
        activeRefreshKeys: 2,
        activeWatches: 2,
        executingRefreshes: 1,
        executingRefreshHighWater: 1,
        idleSweepFibers: 1,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 2,
        retainedStatuses: 2,
      });
      expect(JSON.stringify(whileHeld)).not.toContain('/fixture');
      expect(JSON.stringify(whileHeld)).not.toContain('repository:worktree');

      yield* Deferred.succeed(releaseRefreshes, undefined);
      yield* Deferred.await(allRefreshesCompleted);
      let drained = yield* watcher.metrics;
      for (let attempt = 0; attempt < 16 && drained.activeRefreshKeys > 0; attempt += 1) {
        yield* Effect.yieldNow;
        drained = yield* watcher.metrics;
      }
      expect(yield* Ref.get(refreshStarts)).toBe(4);
      expect(drained).toEqual({
        activeRefreshKeys: 0,
        activeWatches: 2,
        executingRefreshes: 0,
        executingRefreshHighWater: 1,
        idleSweepFibers: 1,
        maximumWatchers: 4,
        pendingTrailingRefreshes: 0,
        retainedStatuses: 2,
      });
    }).pipe(Effect.scoped),
  );

  effectIt.effect('balances execution metrics across refresh failure and scope interruption', () =>
    Effect.gen(function* () {
      const failedWatcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        () => Effect.fail(new TestError('expected refresh failure')),
      );
      yield* failedWatcher.refresh({...options, key: 'failure'});
      let afterFailure = yield* failedWatcher.metrics;
      for (let attempt = 0; attempt < 16 && afterFailure.activeRefreshKeys > 0; attempt += 1) {
        yield* Effect.yieldNow;
        afterFailure = yield* failedWatcher.metrics;
      }
      expect(afterFailure.executingRefreshes).toBe(0);
      expect(afterFailure.executingRefreshHighWater).toBe(1);
      expect(afterFailure.executingRefreshes).toBeGreaterThanOrEqual(0);

      const interruptedWatcher = yield* Effect.scoped(
        Effect.gen(function* () {
          const executingStarted = yield* Deferred.make<void>();
          const watcher = yield* makeCodeGraphWatcher(
            () => Effect.never,
            refreshOptions =>
              Deferred.succeed(executingStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.andThen(refreshOptions.onRefreshed?.(1, 2) ?? Effect.void),
              ),
          );
          yield* watcher.refresh({...options, key: 'executing'});
          yield* Deferred.await(executingStarted);
          yield* watcher.refresh({...options, key: 'waiting'});
          let whileExecuting = yield* watcher.metrics;
          for (let attempt = 0; attempt < 16 && whileExecuting.activeRefreshKeys < 2; attempt += 1) {
            yield* Effect.yieldNow;
            whileExecuting = yield* watcher.metrics;
          }
          expect(whileExecuting.executingRefreshes).toBe(1);
          expect(whileExecuting.executingRefreshHighWater).toBe(1);
          expect(whileExecuting.executingRefreshes).toBeGreaterThanOrEqual(0);
          return watcher;
        }),
      );
      const afterInterruption = yield* interruptedWatcher.metrics;
      expect(afterInterruption.executingRefreshes).toBe(0);
      expect(afterInterruption.executingRefreshHighWater).toBe(1);
      expect(afterInterruption.executingRefreshes).toBeGreaterThanOrEqual(0);
    }).pipe(Effect.scoped),
  );

  effectIt.effect('estimates measured phase work and identifies newly started refreshes', () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<CodeGraphWatchOptions>();
      const release = yield* Deferred.make<void>();
      const watcher = yield* makeCodeGraphWatcher(
        () => Effect.never,
        refreshOptions =>
          Deferred.succeed(captured, refreshOptions).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(refreshOptions.onRefreshed?.(10, 20) ?? Effect.void),
          ),
      );

      const firstStarted = yield* watcher.refresh(options);
      const secondStarted = yield* watcher.refresh(options);
      const progress = yield* Deferred.await(captured);
      const scanning = (completed: number) =>
        progress.onProgress?.({
          accepted: completed,
          completed,
          excluded: 20,
          phase: 'scanning',
          skipped: 0,
          total: 100,
          unit: 'files',
        }) ?? Effect.void;

      yield* scanning(0);
      yield* TestClock.adjust(1_000);
      yield* scanning(10);
      const insufficient = yield* watcher.status(options.key);
      for (let completed = 20; completed <= 80; completed += 10) {
        yield* TestClock.adjust(1_000);
        yield* scanning(completed);
      }
      const estimated = yield* watcher.status(options.key);
      yield* TestClock.adjust(500);
      const aged = yield* watcher.status(options.key);
      yield* TestClock.adjust(2_500);
      const expired = yield* watcher.status(options.key);
      yield* progress.onProgress?.({
        completed: 0,
        phase: 'materializing',
        reused: 80,
        total: 100,
        unit: 'files',
      }) ?? Effect.void;
      const reset = yield* watcher.status(options.key);
      yield* Deferred.succeed(release, undefined);

      expect(firstStarted).toBe(true);
      expect(secondStarted).toBe(false);
      expect(insufficient).toMatchObject({
        _tag: 'Some',
        value: {state: 'indexing'},
      });
      if (insufficient._tag === 'Some' && insufficient.value.state === 'indexing') {
        expect(insufficient.value.timing).not.toHaveProperty('estimatedPhaseRemainingMilliseconds');
      }
      expect(estimated).toMatchObject({
        _tag: 'Some',
        value: {
          state: 'indexing',
          timing: {
            estimateConfidence: 'medium',
            estimatedPhaseRemainingMilliseconds: 2_000,
            estimateScope: 'phase',
          },
        },
      });
      expect(aged).toMatchObject({
        _tag: 'Some',
        value: {
          state: 'indexing',
          timing: {
            elapsedMilliseconds: 8_500,
            lastProgressAgeMilliseconds: 500,
            phaseElapsedMilliseconds: 8_500,
          },
        },
      });
      if (expired._tag === 'Some' && expired.value.state === 'indexing') {
        expect(expired.value.timing).not.toHaveProperty('estimatedPhaseRemainingMilliseconds');
      }
      expect(reset).toMatchObject({
        _tag: 'Some',
        value: {
          progress: {phase: 'materializing'},
          state: 'indexing',
          timing: {
            phaseElapsedMilliseconds: 0,
          },
        },
      });
      if (reset._tag === 'Some' && reset.value.state === 'indexing') {
        expect(reset.value.timing).not.toHaveProperty('estimatedPhaseRemainingMilliseconds');
      }
    }).pipe(Effect.scoped),
  );

  effectIt.effect('caps retained session watchers and evicts the least recently used registrations', () => Effect.gen(function* () {
    const counts = yield* (Effect.gen(function* () {
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
      }));

    expect(counts.inside).toEqual({running: 4, starts: 20, stops: 16});
    expect(counts).toMatchObject({starts: 20, stops: 20});
  }));

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
