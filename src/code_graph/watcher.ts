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
import {CommandExecutor} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import type {CodeGraphProgress} from './types.js';
import {currentCodeGraphBuildStatus, type ObservedCodeGraphBuildStatus} from './build_status.js';
import {codeGraphLayout} from './layout.js';
import {resolveRepositoryIdentity} from './repository.js';

export interface CodeGraphWatchOptions {
  readonly cwd: string;
  readonly key: string;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly onRefreshed?: (symbols: number, edges: number) => Effect.Effect<void>;
  readonly threadnoteHome: string;
}

export interface CodeGraphProgressTiming {
  readonly buildId: string;
  readonly elapsedMilliseconds: number;
  readonly estimateConfidence?: 'high' | 'low' | 'medium';
  readonly estimateScope?: 'phase';
  readonly estimatedPhaseRemainingMilliseconds?: number;
  readonly lastProgressAgeMilliseconds: number;
  readonly phaseElapsedMilliseconds: number;
  readonly phaseStartedAtMilliseconds: number;
  readonly startedAtMilliseconds: number;
  readonly updatedAtMilliseconds: number;
}

export type CodeGraphRefreshStatus =
  | {
      readonly progress?: CodeGraphProgress;
      readonly state: 'indexing';
      readonly timing: CodeGraphProgressTiming;
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
  readonly refresh: (options: CodeGraphWatchOptions) => Effect.Effect<boolean>;
  readonly status: (
    key: string,
    target?: Pick<CodeGraphWatchOptions, 'cwd' | 'threadnoteHome'>,
  ) => Effect.Effect<Option.Option<CodeGraphRefreshStatus>, unknown>;
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

interface ProgressTracker {
  buildId: string;
  estimatedPhaseRemainingMilliseconds?: number;
  estimateConfidence?: CodeGraphProgressTiming['estimateConfidence'];
  lastCompleted?: number;
  lastMeasurementBasis?: 'cached-fact-bytes' | 'files' | 'final-fact-bytes' | 'source-bytes';
  lastSampleAtMilliseconds?: number;
  phase?: CodeGraphProgress['phase'];
  phaseStartedAtMilliseconds: number;
  sampleCount: number;
  rateSamples: number[];
  smoothedUnitsPerMillisecond?: number;
  startedAtMilliseconds: number;
  updatedAtMilliseconds: number;
}

const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 30 * 60_000;
const DEFAULT_MAXIMUM_WATCHERS = 32;
const DEFAULT_SWEEP_INTERVAL_MILLISECONDS = 60_000;
const PROGRESS_ESTIMATE_MINIMUM_SAMPLES = 4;
const PROGRESS_RATE_SAMPLE_WINDOW = 24;

export class CodeGraphWatcher extends Context.Service<CodeGraphWatcher, CodeGraphWatcherShape>()(
  'threadnote/codeGraph/CodeGraphWatcher',
) {
  static readonly layer = Layer.effect(
    CodeGraphWatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const commandExecutor = yield* CommandExecutor;
      const systemInfo = yield* SystemInfo;
      const indexer = yield* CodeGraphIndexer;
      const run = (
        options: CodeGraphWatchOptions,
        initialRefresh: boolean,
        requestRefresh: () => Effect.Effect<void>,
      ) => watchRepository(fs, path, options, initialRefresh, requestRefresh);
      const refresh = (options: CodeGraphWatchOptions) => indexRepository(indexer, options).pipe(Effect.asVoid);
      const watcher = yield* makeCodeGraphWatcher(run, refresh);
      return CodeGraphWatcher.of({
        ...watcher,
        status: (key, target) =>
          watcher.status(key).pipe(
            Effect.flatMap(current => {
              if (Option.isSome(current) || !target) return Effect.succeed(current);
              return Effect.gen(function* () {
                const identity = yield* resolveRepositoryIdentity(target.cwd);
                const layout = codeGraphLayout(path, target.threadnoteHome, identity.checkoutId, identity.worktreeId);
                const persisted = yield* currentCodeGraphBuildStatus(layout, identity.worktreeId);
                return persisted ? Option.some(persistedRefreshStatus(persisted)) : Option.none();
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(SystemInfo, systemInfo),
              );
            }),
          ),
      });
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
  const refreshSequence = yield* Ref.make(0);
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
  const trackedRefreshOptions = (options: CodeGraphWatchOptions, tracker: ProgressTracker): CodeGraphWatchOptions => ({
    ...options,
    onProgress: progress =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        observeProgress(tracker, progress, now);
        yield* setStatus(options.key, {
          progress,
          state: 'indexing',
          timing: progressTiming(tracker, now),
        });
        yield* options.onProgress?.(progress) ?? Effect.void;
      }),
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
        const startedAtMilliseconds = yield* Clock.currentTimeMillis;
        const sequence = yield* Ref.updateAndGet(refreshSequence, value => value + 1);
        const tracker = makeProgressTracker(startedAtMilliseconds, sequence);
        yield* setStatus(key, {
          state: 'indexing',
          timing: progressTiming(tracker, startedAtMilliseconds),
        });
        lastFailure = undefined;
        yield* refreshSemaphore.withPermit(refreshRun(trackedRefreshOptions(options, tracker))).pipe(
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
      return decision;
    });
  const requestBackgroundRefresh = (options: CodeGraphWatchOptions, queueTrailing: boolean) =>
    scheduleRefresh(options, queueTrailing).pipe(Effect.map(decision => decision.start));
  const requestRefreshAndWait = (options: CodeGraphWatchOptions) =>
    scheduleRefresh(options, false).pipe(Effect.flatMap(decision => Deferred.await(decision.completion)));
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
      const fiber = yield* run(options, false, () => requestBackgroundRefresh(options, true).pipe(Effect.asVoid)).pipe(
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
        return yield* requestBackgroundRefresh(options, false);
      }),
    status: key =>
      Effect.gen(function* () {
        yield* touchWatch(key);
        const current = (yield* SynchronizedRef.get(refreshStatuses)).get(key);
        if (!current) return Option.none();
        const now = yield* Clock.currentTimeMillis;
        return Option.some(refreshStatusAt(current, now));
      }),
    watch: options =>
      requestRefreshAndWait(options).pipe(
        Effect.andThen(run(options, true, () => requestBackgroundRefresh(options, true).pipe(Effect.asVoid))),
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

function makeProgressTracker(startedAtMilliseconds: number, sequence: number): ProgressTracker {
  return {
    buildId: `${startedAtMilliseconds.toString(36)}-${sequence.toString(36)}`,
    phaseStartedAtMilliseconds: startedAtMilliseconds,
    rateSamples: [],
    sampleCount: 0,
    startedAtMilliseconds,
    updatedAtMilliseconds: startedAtMilliseconds,
  };
}

function observeProgress(tracker: ProgressTracker, progress: CodeGraphProgress, now: number): void {
  const work = measuredProgress(progress);
  if (tracker.phase !== progress.phase || tracker.lastMeasurementBasis !== work?.basis) {
    tracker.phase = progress.phase;
    tracker.lastMeasurementBasis = work?.basis;
    tracker.phaseStartedAtMilliseconds = now;
    tracker.lastCompleted = work?.completed;
    tracker.lastSampleAtMilliseconds = work ? now : undefined;
    tracker.sampleCount = 0;
    tracker.rateSamples = [];
    tracker.smoothedUnitsPerMillisecond = undefined;
    tracker.estimatedPhaseRemainingMilliseconds = undefined;
    tracker.estimateConfidence = undefined;
  } else if (work) {
    const previousCompleted = tracker.lastCompleted;
    const previousSampleAt = tracker.lastSampleAtMilliseconds;
    if (
      previousCompleted !== undefined &&
      previousSampleAt !== undefined &&
      work.completed > previousCompleted &&
      now > previousSampleAt
    ) {
      const observedRate = (work.completed - previousCompleted) / (now - previousSampleAt);
      tracker.rateSamples = [...tracker.rateSamples, observedRate].slice(-PROGRESS_RATE_SAMPLE_WINDOW);
      tracker.smoothedUnitsPerMillisecond = medianProgressRate(tracker.rateSamples);
      tracker.sampleCount += 1;
    }
    if (work.completed !== previousCompleted) {
      tracker.lastCompleted = work.completed;
      tracker.lastSampleAtMilliseconds = now;
    }
    const remaining = Math.max(0, work.total - work.completed);
    const rate = tracker.smoothedUnitsPerMillisecond;
    if (
      remaining > 0 &&
      rate !== undefined &&
      rate > 0 &&
      Number.isFinite(rate) &&
      tracker.sampleCount >= PROGRESS_ESTIMATE_MINIMUM_SAMPLES
    ) {
      tracker.estimatedPhaseRemainingMilliseconds = roundUpToSecond(remaining / rate);
      tracker.estimateConfidence = estimateConfidence(tracker.sampleCount, work.completed, work.total);
    } else {
      tracker.estimatedPhaseRemainingMilliseconds = undefined;
      tracker.estimateConfidence = undefined;
    }
  }
  tracker.updatedAtMilliseconds = now;
}

function measuredProgress(progress: CodeGraphProgress):
  | {
      readonly basis: 'cached-fact-bytes' | 'files' | 'final-fact-bytes' | 'source-bytes';
      readonly completed: number;
      readonly total: number;
    }
  | undefined {
  switch (progress.phase) {
    case 'scanning':
    case 'embedding':
      return {basis: 'files', completed: progress.completed, total: progress.total};
    case 'materializing': {
      const metrics = progress.metrics;
      if (
        metrics?.factsBytesCompleted !== undefined &&
        metrics.factsBytesTotal !== undefined &&
        metrics.factsBytesTotal > 0
      ) {
        return {
          basis: 'final-fact-bytes',
          completed: Math.min(metrics.factsBytesCompleted, metrics.factsBytesTotal),
          total: metrics.factsBytesTotal,
        };
      }
      if (
        metrics?.cachedFactBytesCompleted !== undefined &&
        metrics.cachedFactBytesTotal !== undefined &&
        metrics.cachedFactBytesTotal > 0
      ) {
        return {
          basis: 'cached-fact-bytes',
          completed: Math.min(metrics.cachedFactBytesCompleted, metrics.cachedFactBytesTotal),
          total: metrics.cachedFactBytesTotal,
        };
      }
      if (metrics && metrics.sourceBytesTotal > 0) {
        return {
          basis: 'source-bytes',
          completed: Math.min(metrics.sourceBytesCompleted, metrics.sourceBytesTotal),
          total: metrics.sourceBytesTotal,
        };
      }
      return {basis: 'files', completed: progress.completed, total: progress.total};
    }
    default:
      return undefined;
  }
}

function medianProgressRate(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle];
}

function estimateConfidence(
  sampleCount: number,
  completed: number,
  total: number,
): CodeGraphProgressTiming['estimateConfidence'] {
  const fraction = total === 0 ? 1 : completed / total;
  if (sampleCount >= 6 && fraction >= 0.4) return 'high';
  if (sampleCount >= 3 && fraction >= 0.1) return 'medium';
  return 'low';
}

function roundUpToSecond(milliseconds: number): number {
  return Math.ceil(Math.max(0, milliseconds) / 1_000) * 1_000;
}

function progressTiming(tracker: ProgressTracker, now: number): CodeGraphProgressTiming {
  return {
    buildId: tracker.buildId,
    elapsedMilliseconds: Math.max(0, now - tracker.startedAtMilliseconds),
    ...(tracker.estimateConfidence ? {estimateConfidence: tracker.estimateConfidence} : {}),
    ...(tracker.estimatedPhaseRemainingMilliseconds === undefined
      ? {}
      : {
          estimatedPhaseRemainingMilliseconds: tracker.estimatedPhaseRemainingMilliseconds,
          estimateScope: 'phase' as const,
        }),
    lastProgressAgeMilliseconds: Math.max(0, now - tracker.updatedAtMilliseconds),
    phaseElapsedMilliseconds: Math.max(0, now - tracker.phaseStartedAtMilliseconds),
    phaseStartedAtMilliseconds: tracker.phaseStartedAtMilliseconds,
    startedAtMilliseconds: tracker.startedAtMilliseconds,
    updatedAtMilliseconds: tracker.updatedAtMilliseconds,
  };
}

function refreshStatusAt(status: CodeGraphRefreshStatus, now: number): CodeGraphRefreshStatus {
  if (status.state !== 'indexing') return status;
  const lastProgressAgeMilliseconds = Math.max(0, now - status.timing.updatedAtMilliseconds);
  const estimate = status.timing.estimatedPhaseRemainingMilliseconds;
  const adjustedEstimate =
    estimate === undefined || lastProgressAgeMilliseconds >= estimate
      ? undefined
      : roundUpToSecond(estimate - lastProgressAgeMilliseconds);
  const {
    estimateConfidence: _estimateConfidence,
    estimatedPhaseRemainingMilliseconds: _estimatedPhaseRemainingMilliseconds,
    estimateScope: _estimateScope,
    ...timing
  } = status.timing;
  return {
    ...status,
    timing: {
      ...timing,
      elapsedMilliseconds: Math.max(0, now - status.timing.startedAtMilliseconds),
      ...(adjustedEstimate === undefined
        ? {}
        : {
            estimateConfidence: status.timing.estimateConfidence,
            estimatedPhaseRemainingMilliseconds: adjustedEstimate,
            estimateScope: 'phase' as const,
          }),
      lastProgressAgeMilliseconds,
      phaseElapsedMilliseconds: Math.max(0, now - status.timing.phaseStartedAtMilliseconds),
    },
  };
}

function persistedRefreshStatus(status: ObservedCodeGraphBuildStatus): CodeGraphRefreshStatus {
  if (status.observation.liveness === 'completed' && status.result) {
    return {edges: status.result.edges, state: 'ready', symbols: status.result.symbols};
  }
  if (status.observation.liveness === 'failed' || status.observation.liveness === 'abandoned') {
    return {
      message:
        status.error?.summary ??
        (status.observation.reason === 'pid-reused'
          ? 'Code graph build owner PID was reused; the abandoned build can be retried.'
          : 'Code graph build owner exited before completion; retry the build.'),
      state: 'failed',
    };
  }
  const startedAtMilliseconds = Date.parse(status.timestamps.startedAt);
  const phaseStartedAtMilliseconds = Date.parse(status.timestamps.phaseStartedAt);
  const updatedAtMilliseconds = Date.parse(status.timestamps.updatedAt);
  const now = Date.parse(status.timestamps.heartbeatAt) + status.observation.heartbeatAgeMilliseconds;
  return {
    state: 'indexing',
    timing: {
      buildId: status.buildId,
      elapsedMilliseconds: Math.max(0, now - startedAtMilliseconds),
      ...(status.eta
        ? {
            estimateConfidence: status.eta.confidence,
            estimatedPhaseRemainingMilliseconds: status.eta.remainingMilliseconds,
            estimateScope: 'phase' as const,
          }
        : {}),
      lastProgressAgeMilliseconds: Math.max(0, now - updatedAtMilliseconds),
      phaseElapsedMilliseconds: Math.max(0, now - phaseStartedAtMilliseconds),
      phaseStartedAtMilliseconds,
      startedAtMilliseconds,
      updatedAtMilliseconds,
    },
  };
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
