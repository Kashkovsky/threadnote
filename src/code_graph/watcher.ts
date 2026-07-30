import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Semaphore,
  Stream,
  SynchronizedRef,
} from 'effect';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from './indexer.js';
import type {CodeGraphProgress} from './types.js';

export interface CodeGraphWatchOptions {
  readonly cwd: string;
  readonly key: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly onRefreshed?: (symbols: number, edges: number) => Effect.Effect<void>;
  readonly threadnoteHome: string;
}

export type CodeGraphRefreshStatus =
  | {
      readonly progress?: CodeGraphProgress;
      readonly state: 'indexing';
    }
  | {
      readonly edges: number;
      readonly state: 'ready';
      readonly symbols: number;
    }
  | {
      readonly message: string;
      readonly state: 'failed';
    };

export interface CodeGraphWatcherShape {
  readonly ensure: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly refresh: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly status: (key: string) => Effect.Effect<Option.Option<CodeGraphRefreshStatus>>;
  readonly watch: (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;
}

export interface CodeGraphWatcherLifecycleOptions {
  readonly idleTimeoutMilliseconds?: number;
  readonly maximumWatchers?: number;
  readonly sweepIntervalMilliseconds?: number;
}

export type CodeGraphWatchRun = (
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
  requestRefresh: () => Effect.Effect<void>,
) => Effect.Effect<void, unknown>;

export type CodeGraphRefreshRun = (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;

interface ActiveRefresh {
  readonly completion: Deferred.Deferred<void, Error>;
  readonly latestOptions: CodeGraphWatchOptions;
  readonly pending: boolean;
}

interface ActiveWatch {
  readonly cancel: Effect.Effect<void>;
  readonly generation: object;
  readonly lastUsedAt: number;
}

interface RefreshDecision {
  readonly completion: Deferred.Deferred<void, Error>;
  readonly start: boolean;
}

interface WatchStartDecision {
  readonly evicted: readonly [string, ActiveWatch][];
  readonly start: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 30 * 60_000;
const DEFAULT_MAXIMUM_WATCHERS = 32;
const DEFAULT_SWEEP_INTERVAL_MILLISECONDS = 60_000;

export class CodeGraphWatcher extends Context.Service<CodeGraphWatcher, CodeGraphWatcherShape>()(
  'threadnote/codeGraph/CodeGraphWatcher',
) {
  static readonly layer = Layer.effect(
    CodeGraphWatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const indexer = yield* CodeGraphIndexer;
      const run = (
        options: CodeGraphWatchOptions,
        initialRefresh: boolean,
        requestRefresh: () => Effect.Effect<void>,
      ) => watchRepository(fs, path, options, initialRefresh, requestRefresh);
      const refresh = (options: CodeGraphWatchOptions) => indexRepository(indexer, options).pipe(Effect.asVoid);
      return yield* makeCodeGraphWatcher(run, refresh);
    }),
  );
}

export const makeCodeGraphWatcher = Effect.fn('codeGraph.makeWatcher')(function* (
  run: CodeGraphWatchRun,
  refreshRun: CodeGraphRefreshRun,
  lifecycleOptions: CodeGraphWatcherLifecycleOptions = {},
) {
  const scope = yield* Effect.scope;
  const idleTimeoutMilliseconds = positiveInteger(
    lifecycleOptions.idleTimeoutMilliseconds,
    DEFAULT_IDLE_TIMEOUT_MILLISECONDS,
  );
  const maximumWatchers = positiveInteger(lifecycleOptions.maximumWatchers, DEFAULT_MAXIMUM_WATCHERS);
  const sweepIntervalMilliseconds = positiveInteger(
    lifecycleOptions.sweepIntervalMilliseconds,
    DEFAULT_SWEEP_INTERVAL_MILLISECONDS,
  );
  const activeWatches = yield* SynchronizedRef.make(new Map<string, ActiveWatch>());
  const activeRefreshes = yield* SynchronizedRef.make(new Map<string, ActiveRefresh>());
  const refreshStatuses = yield* SynchronizedRef.make(new Map<string, CodeGraphRefreshStatus>());
  const refreshSemaphore = yield* Semaphore.make(1);
  const sweepStarted = yield* Ref.make(false);
  const setStatus = (key: string, status: CodeGraphRefreshStatus) =>
    SynchronizedRef.update(refreshStatuses, current => new Map(current).set(key, status));
  const removeStatuses = (keys: readonly string[]) =>
    keys.length === 0
      ? Effect.void
      : SynchronizedRef.update(refreshStatuses, current => {
          const next = new Map(current);
          for (const key of keys) next.delete(key);
          return next;
        });
  const trackedRefreshOptions = (options: CodeGraphWatchOptions): CodeGraphWatchOptions => ({
    ...options,
    onProgress: progress =>
      setStatus(options.key, {progress, state: 'indexing'}).pipe(
        Effect.andThen(options.onProgress?.(progress) ?? Effect.void),
      ),
    onRefreshed: (symbols, edges) =>
      setStatus(options.key, {edges, state: 'ready', symbols}).pipe(
        Effect.andThen(options.onRefreshed?.(symbols, edges) ?? Effect.void),
      ),
  });
  const removeWatch = (key: string, generation: object) =>
    SynchronizedRef.modify(activeWatches, current => {
      if (current.get(key)?.generation !== generation) return [false, current] as const;
      const next = new Map(current);
      next.delete(key);
      return [true, next] as const;
    }).pipe(Effect.flatMap(removed => (removed ? removeStatuses([key]) : Effect.void)));
  const touchWatch = (key: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* SynchronizedRef.update(activeWatches, current => {
        const existing = current.get(key);
        if (!existing) return current;
        const next = new Map(current);
        next.set(key, {...existing, lastUsedAt: now});
        return next;
      });
    });
  const runRefreshLoop = (
    key: string,
    completion: Deferred.Deferred<void, Error>,
    initialOptions: CodeGraphWatchOptions,
  ) =>
    Effect.gen(function* () {
      let options = initialOptions;
      let lastFailure: Error | undefined;
      for (;;) {
        yield* setStatus(key, {state: 'indexing'});
        lastFailure = undefined;
        yield* refreshSemaphore.withPermit(refreshRun(trackedRefreshOptions(options))).pipe(
          Effect.catchCause(cause => {
            lastFailure = new Error(String(cause));
            return setStatus(key, {message: lastFailure.message, state: 'failed'}).pipe(
              Effect.andThen(
                Effect.logWarning(`Code graph background refresh failed for ${options.cwd}: ${lastFailure.message}`),
              ),
            );
          }),
        );
        const nextOptions = yield* SynchronizedRef.modify(activeRefreshes, current => {
          const active = current.get(key);
          if (!active || active.completion !== completion) return [undefined, current] as const;
          const next = new Map(current);
          if (active.pending) {
            next.set(key, {...active, pending: false});
            return [active.latestOptions, next] as const;
          }
          next.delete(key);
          return [undefined, next] as const;
        });
        if (!nextOptions) break;
        options = nextOptions;
      }
      if (lastFailure) {
        yield* Deferred.fail(completion, lastFailure);
      } else {
        yield* Deferred.succeed(completion, undefined);
      }
      if (!(yield* SynchronizedRef.get(activeWatches)).has(key)) yield* removeStatuses([key]);
    });
  const scheduleRefresh = (options: CodeGraphWatchOptions, queueTrailing: boolean) =>
    Effect.gen(function* () {
      const candidate = yield* Deferred.make<void, Error>();
      const decision = yield* SynchronizedRef.modify(activeRefreshes, current => {
        const active = current.get(options.key);
        if (active) {
          const decision: RefreshDecision = {completion: active.completion, start: false};
          if (!queueTrailing) return [decision, current] as const;
          const next = new Map(current);
          next.set(options.key, {...active, latestOptions: options, pending: true});
          return [decision, next] as const;
        }
        const next = new Map(current);
        next.set(options.key, {
          completion: candidate,
          latestOptions: options,
          pending: false,
        });
        const decision: RefreshDecision = {completion: candidate, start: true};
        return [decision, next] as const;
      });
      if (decision.start) {
        yield* runRefreshLoop(options.key, decision.completion, options).pipe(Effect.forkIn(scope));
      }
      return decision.completion;
    });
  const requestBackgroundRefresh = (options: CodeGraphWatchOptions, queueTrailing: boolean) =>
    scheduleRefresh(options, queueTrailing).pipe(Effect.asVoid);
  const requestRefreshAndWait = (options: CodeGraphWatchOptions) =>
    scheduleRefresh(options, false).pipe(Effect.flatMap(Deferred.await));
  const cancelWatches = (entries: readonly [string, ActiveWatch][]) =>
    Effect.gen(function* () {
      yield* removeStatuses(entries.map(([key]) => key));
      yield* Effect.forEach(entries, ([, entry]) => entry.cancel, {concurrency: 1, discard: true});
    });
  const startSessionWatch = (options: CodeGraphWatchOptions) =>
    Effect.gen(function* () {
      yield* ensureIdleSweep;
      const now = yield* Clock.currentTimeMillis;
      const generation = {};
      const reservation: ActiveWatch = {cancel: Effect.void, generation, lastUsedAt: now};
      const decision = yield* SynchronizedRef.modify(activeWatches, current => {
        const existing = current.get(options.key);
        if (existing) {
          const next = new Map(current);
          next.set(options.key, {...existing, lastUsedAt: now});
          const decision: WatchStartDecision = {evicted: [], start: false};
          return [decision, next] as const;
        }
        const next = new Map(current);
        const evicted: [string, ActiveWatch][] = [];
        while (next.size >= maximumWatchers) {
          const oldest = oldestWatch(next);
          if (!oldest) break;
          next.delete(oldest[0]);
          evicted.push(oldest);
        }
        next.set(options.key, reservation);
        const decision: WatchStartDecision = {evicted, start: true};
        return [decision, next] as const;
      });
      yield* cancelWatches(decision.evicted);
      if (!decision.start) return;
      const fiber = yield* run(options, false, () => requestBackgroundRefresh(options, true)).pipe(
        Effect.ensuring(removeWatch(options.key, generation)),
        Effect.forkIn(scope),
      );
      const installed = yield* SynchronizedRef.modify(activeWatches, current => {
        const active = current.get(options.key);
        if (active?.generation !== generation) return [false, current] as const;
        const next = new Map(current);
        next.set(options.key, {
          ...active,
          cancel: Fiber.interrupt(fiber).pipe(Effect.asVoid),
        });
        return [true, next] as const;
      });
      if (!installed) yield* Fiber.interrupt(fiber);
    });
  const sweepIdleWatches = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const refreshing = yield* SynchronizedRef.get(activeRefreshes);
    const expired = yield* SynchronizedRef.modify(activeWatches, current => {
      const next = new Map(current);
      const removed: [string, ActiveWatch][] = [];
      for (const entry of current) {
        if (!refreshing.has(entry[0]) && now - entry[1].lastUsedAt >= idleTimeoutMilliseconds) {
          next.delete(entry[0]);
          removed.push(entry);
        }
      }
      return [removed, next] as const;
    });
    yield* cancelWatches(expired);
  });
  const ensureIdleSweep = Ref.getAndSet(sweepStarted, true).pipe(
    Effect.flatMap(started =>
      started
        ? Effect.void
        : Effect.sleep(sweepIntervalMilliseconds).pipe(
            Effect.andThen(sweepIdleWatches),
            Effect.forever,
            Effect.forkIn(scope),
            Effect.asVoid,
          ),
    ),
  );

  return CodeGraphWatcher.of({
    ensure: startSessionWatch,
    refresh: options =>
      Effect.gen(function* () {
        yield* touchWatch(options.key);
        yield* requestBackgroundRefresh(options, false);
      }),
    status: key =>
      touchWatch(key).pipe(
        Effect.andThen(SynchronizedRef.get(refreshStatuses)),
        Effect.map(current => Option.fromUndefinedOr(current.get(key))),
      ),
    watch: options =>
      requestRefreshAndWait(options).pipe(
        Effect.andThen(run(options, true, () => requestBackgroundRefresh(options, true))),
        Effect.ensuring(removeStatuses([options.key])),
      ),
  });
});

function oldestWatch(watches: ReadonlyMap<string, ActiveWatch>): [string, ActiveWatch] | undefined {
  let oldest: [string, ActiveWatch] | undefined;
  for (const entry of watches) {
    if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
  }
  return oldest;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}

const indexRepository = (indexer: CodeGraphIndexerShape, options: CodeGraphWatchOptions) =>
  indexer
    .index({
      cwd: options.cwd,
      onProgress: options.onProgress,
      threadnoteHome: options.threadnoteHome,
    })
    .pipe(
      Effect.tap(
        summary => options.onRefreshed?.(summary.snapshot.symbolCount, summary.snapshot.edgeCount) ?? Effect.void,
      ),
    );

const watchRepository = Effect.fn('codeGraph.watchRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: CodeGraphWatchOptions,
  _initialRefresh: boolean,
  requestRefresh: () => Effect.Effect<void>,
) {
  const changes = fs.watch(options.cwd).pipe(
    Stream.filter(event => relevantWatchPath(path, options.cwd, event.path)),
    Stream.debounce('750 millis'),
    Stream.map(() => undefined),
    Stream.catchCause(cause =>
      Stream.fromEffect(Effect.logWarning(`Code graph filesystem watch failed for ${options.cwd}: ${String(cause)}`)),
    ),
  );
  const reconciliation = Stream.fromSchedule(Schedule.spaced('5 minutes')).pipe(Stream.map(() => undefined));
  yield* Stream.merge(changes, reconciliation).pipe(Stream.runForEach(requestRefresh));
});

function relevantWatchPath(path: Path.Path, cwd: string, eventPath: string): boolean {
  const absolute = path.isAbsolute(eventPath) ? eventPath : path.join(cwd, eventPath);
  const relative = path.relative(cwd, absolute);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(path.sep);
  return !segments.some(
    segment => segment.startsWith('.') && segment !== '.gitignore' && segment !== '.threadnoteignore',
  );
}
