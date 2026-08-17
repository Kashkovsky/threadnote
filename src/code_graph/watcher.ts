import {
  Cause,
  Clock,
  Context,
  Crypto,
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
import {worktreeBuildRequestState, worktreeOverlayState} from './inventory.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance_coordinator.js';
import {CodeGraphStore, type CodeGraphRoutineMaintenanceResult, type CodeGraphStoreShape} from './store.js';
import {CommandExecutor, type CommandOptions} from '../effect/command.js';
import {SystemInfo} from '../effect/system.js';
import type {CommandResult} from '../types.js';
import type {
  CodeGraphProgress,
  CodeGraphStoreFailureCode,
  CodeGraphStoreRecovery,
  RepositoryIdentity,
} from './types.js';
import {CodeGraphRuntimeReconnectRequiredError} from './types.js';
import {
  currentCodeGraphBuildStatus,
  readCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {isCodeGraphIsolatedBuilderHost, runIsolatedCodeGraphIndex} from './isolated_builder.js';
import {codeGraphLayout} from './layout.js';
import {runCodeGraphLifecycleOpportunity} from './lifecycle_opportunity.js';
import {classifyCodeGraphStoreFailure} from './store_failure.js';
import {
  codeGraphEtaMeasurement,
  makeCodeGraphEtaTracker,
  observeCodeGraphEta,
  type CodeGraphEtaTracker,
} from './progress_eta.js';
import {resolveRepositoryIdentity} from './repository.js';
import {
  makeCodeGraphAutomaticRecoveryCoordinator,
  type CodeGraphAutomaticRecoveryAdmission,
  type CodeGraphAutomaticRecoveryCoordinatorShape,
} from './recovery_coordinator.js';
import {codeGraphAnonymousTelemetryComponent, emitCodeGraphBackgroundFailure} from './anonymous_telemetry.js';
import {anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure} from '../telemetry/diagnostic.js';
import type {CodeGraphBuilderAdmissionClass} from './builder_admission.js';
import {codeGraphBuildRequestKey} from './indexer_build.js';
import {CodeGraphLanguagePackRegistry} from './languages/registry.js';

export interface CodeGraphWatchOptions {
  readonly admissionClass?: CodeGraphBuilderAdmissionClass;
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

export interface CodeGraphRefreshFailure {
  readonly code: CodeGraphStoreFailureCode;
  readonly operation: 'refresh code graph';
  readonly recovery: CodeGraphStoreRecovery;
  readonly retryable: boolean;
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
      readonly failure: CodeGraphRefreshFailure;
      readonly state: 'deferred';
    };

export interface CodeGraphWatcherMetrics {
  readonly activeRefreshKeys: number;
  readonly activeWatches: number;
  readonly executingRefreshes: number;
  readonly executingRefreshHighWater: number;
  readonly idleSweepFibers: 0 | 1;
  readonly maximumWatchers: number;
  readonly pendingTrailingRefreshes: number;
  readonly retainedStatuses: number;
}

export interface CodeGraphWatcherShape {
  readonly ensure: (options: CodeGraphWatchOptions) => Effect.Effect<void>;
  readonly metrics: Effect.Effect<CodeGraphWatcherMetrics>;
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
  /** @internal Closed terminal observation for detached refresh work. */
  readonly onRefreshFailure?: (failure: CodeGraphRefreshFailure) => Effect.Effect<void>;
  readonly sweepIntervalMilliseconds?: number;
}

export type CodeGraphWatchRun = (
  options: CodeGraphWatchOptions,
  initialRefresh: boolean,
  requestRefresh: () => Effect.Effect<void>,
) => Effect.Effect<void, unknown>;

export type CodeGraphRefreshRun = (options: CodeGraphWatchOptions) => Effect.Effect<void, unknown>;

export type CodeGraphRecoveryRun = (
  options: CodeGraphWatchOptions,
  failure: CodeGraphRefreshFailure,
) => Effect.Effect<void, unknown>;

export interface CodeGraphWatchReconciliationHooks {
  readonly changeRefreshRequired?: Effect.Effect<boolean, unknown>;
  readonly periodicRefreshRequired: Effect.Effect<boolean, unknown>;
  readonly requestAfterChange: Effect.Effect<void, unknown>;
  readonly requestInitial?: Effect.Effect<void, unknown>;
}

export interface CodeGraphAutomaticRecoveryIdentity extends Partial<RepositoryIdentity> {
  readonly checkoutId: string;
  readonly worktreeId: string;
}

export interface CodeGraphAutomaticRecoveryDependencies {
  readonly coordinator: CodeGraphAutomaticRecoveryCoordinatorShape;
  readonly resolveIdentity: (cwd: string) => Effect.Effect<CodeGraphAutomaticRecoveryIdentity, unknown>;
  readonly routineMaintenance: (
    options: CodeGraphWatchOptions,
    identity: CodeGraphAutomaticRecoveryIdentity,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, unknown>;
}

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
  etaTracker: CodeGraphEtaTracker;
  estimatedPhaseRemainingMilliseconds?: number;
  estimateConfidence?: CodeGraphProgressTiming['estimateConfidence'];
  phase?: CodeGraphProgress['phase'];
  phaseStartedAtMilliseconds: number;
  startedAtMilliseconds: number;
  updatedAtMilliseconds: number;
}

interface RefreshExecutionMetrics {
  readonly executing: number;
  readonly highWater: number;
}

class CodeGraphWatcherError extends Error {
  readonly _tag = 'CodeGraphWatcherError' as const;
}

const DEFAULT_IDLE_TIMEOUT_MILLISECONDS = 30 * 60_000;
const DEFAULT_MAXIMUM_WATCHERS = 32;
const DEFAULT_SWEEP_INTERVAL_MILLISECONDS = 60_000;
const CODE_GRAPH_REFRESH_OPERATION = 'refresh code graph' as const;
const CODE_GRAPH_REFRESH_FAILURE_METADATA = {
  busy: {recovery: 'defer', retryable: true},
  'confirmed-corruption': {recovery: 'manual-rebuild', retryable: false},
  'incompatible-schema': {recovery: 'manual-migration', retryable: false},
  'no-space': {recovery: 'free-space', retryable: false},
  permission: {recovery: 'fix-permissions', retryable: false},
  'schema-additive': {recovery: 'migrate-additive', retryable: false},
  'transient-io': {recovery: 'retry-read-only', retryable: true},
  unknown: {recovery: 'diagnose', retryable: false},
} as const satisfies Record<CodeGraphStoreFailureCode, Pick<CodeGraphRefreshFailure, 'recovery' | 'retryable'>>;

/** Convert native/store failures into a bounded record that cannot retain paths or raw causes. */
export function codeGraphRefreshFailure(cause: unknown): CodeGraphRefreshFailure {
  const classified = classifyCodeGraphStoreFailure(CODE_GRAPH_REFRESH_OPERATION, cause);
  const code = Object.hasOwn(CODE_GRAPH_REFRESH_FAILURE_METADATA, classified.code) ? classified.code : 'unknown';
  const defaults = CODE_GRAPH_REFRESH_FAILURE_METADATA[code];
  const reconnectRequired = classified instanceof CodeGraphRuntimeReconnectRequiredError;
  return {
    code,
    operation: CODE_GRAPH_REFRESH_OPERATION,
    recovery: reconnectRequired ? classified.recovery : defaults.recovery,
    retryable: reconnectRequired ? classified.retryable : defaults.retryable,
  };
}

function codeGraphRefreshFailureFromCause(cause: Cause.Cause<unknown>): CodeGraphRefreshFailure {
  return codeGraphRefreshFailure(Option.getOrUndefined(Cause.findErrorOption(cause)));
}

export class CodeGraphWatcher extends Context.Service<CodeGraphWatcher, CodeGraphWatcherShape>()(
  'threadnote/codeGraph/CodeGraphWatcher',
) {
  static readonly layer = Layer.effect(
    CodeGraphWatcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const commandExecutor = yield* CommandExecutor;
      const systemInfo = yield* SystemInfo;
      const indexer = yield* CodeGraphIndexer;
      const languagePacks = yield* CodeGraphLanguagePackRegistry;
      const maintenance = yield* CodeGraphMaintenanceCoordinator;
      const store = yield* CodeGraphStore;
      const scope = yield* Effect.scope;
      const automaticRecovery = yield* makeCodeGraphAutomaticRecoveryCoordinator();
      const anonymousTelemetryComponent = codeGraphAnonymousTelemetryComponent(systemInfo.environment());
      const prewarmSemaphore = yield* Semaphore.make(1);
      const prewarmedCommits = yield* SynchronizedRef.make(new Set<string>());
      // MCP stdio must not own multi-hour index-repository work; spawn CLI graph index instead.
      // Prewarm stays in-process only for CLI watchers — MCP skips it so the stdio process
      // does not take the repository lock for secondary ensureCommit work.
      const isolateBuilder = isCodeGraphIsolatedBuilderHost(systemInfo);
      const schedulePrewarm = (options: CodeGraphWatchOptions) =>
        systemInfo.environment().THREADNOTE_CODE_GRAPH_PREWARM === '0'
          ? Effect.void
          : prewarmLikelyCleanSnapshots({
              commandExecutor,
              indexer,
              options,
              path,
              prewarmedCommits,
              prewarmSemaphore,
              store,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, systemInfo),
              Effect.forkIn(scope),
              Effect.asVoid,
            );
      const refresh = (options: CodeGraphWatchOptions) =>
        Effect.gen(function* () {
          if (isolateBuilder) {
            const identity = yield* resolveRepositoryIdentity(options.cwd).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, systemInfo),
            );
            const requestedOverlay = yield* worktreeBuildRequestState(identity, options.threadnoteHome).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, systemInfo),
            );
            const summary = yield* runIsolatedCodeGraphIndex({
              admissionClass: options.admissionClass,
              assertRuntimeSchemaCompatible: databasePath => store.assertRuntimeSchemaCompatible(databasePath),
              cwd: options.cwd,
              onProgress: options.onProgress,
              requestKey: codeGraphBuildRequestKey(identity, requestedOverlay, languagePacks, undefined),
              threadnoteHome: options.threadnoteHome,
            }).pipe(
              Effect.provideService(CommandExecutor, commandExecutor),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(SystemInfo, systemInfo),
            );
            yield* options.onRefreshed?.(summary.symbols, summary.edges) ?? Effect.void;
            return;
          }
          yield* indexRepository(indexer, options);
          yield* schedulePrewarm(options);
        });
      const resolveRecoveryIdentity = (cwd: string) =>
        resolveRepositoryIdentity(cwd).pipe(
          Effect.provideService(CommandExecutor, commandExecutor),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        );
      const requestWatchMaintenance = (options: CodeGraphWatchOptions, identity: RepositoryIdentity) => {
        const layout = codeGraphLayout(path, options.threadnoteHome, identity.checkoutId, identity.worktreeId);
        return maintenance.request({
          allowIndexPreparation: true,
          anchorIdentity: identity,
          checkoutId: layout.checkoutId,
          databasePath: layout.databasePath,
          threadnoteHome: options.threadnoteHome,
          writerLockPath: layout.databaseWriteLockPath,
        });
      };
      const watchReconciliationHooks = (options: CodeGraphWatchOptions): CodeGraphWatchReconciliationHooks => ({
        changeRefreshRequired: Effect.gen(function* () {
          const identity = yield* resolveRecoveryIdentity(options.cwd);
          const layout = codeGraphLayout(path, options.threadnoteHome, identity.checkoutId, identity.worktreeId);
          const ready = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
          if (ready === undefined) return true;
          const statuses = yield* readCodeGraphBuildStatuses(layout);
          return codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh(ready.id, statuses);
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        ),
        periodicRefreshRequired: Effect.gen(function* () {
          const identity = yield* resolveRecoveryIdentity(options.cwd);
          yield* requestWatchMaintenance(options, identity);
          const layout = codeGraphLayout(path, options.threadnoteHome, identity.checkoutId, identity.worktreeId);
          const ready = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
          if (ready === undefined) return true;
          const statuses = yield* readCodeGraphBuildStatuses(layout);
          if (!codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh(ready.id, statuses)) return false;
          const overlay = yield* worktreeOverlayState(identity).pipe(
            Effect.provideService(CommandExecutor, commandExecutor),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, systemInfo),
          );
          return codeGraphWatcherSnapshotStale(ready, identity, overlay);
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, systemInfo),
        ),
        requestAfterChange: resolveRecoveryIdentity(options.cwd).pipe(
          Effect.flatMap(identity => requestWatchMaintenance(options, identity)),
        ),
      });
      const run = (
        options: CodeGraphWatchOptions,
        initialRefresh: boolean,
        requestRefresh: () => Effect.Effect<void>,
      ) => watchRepository(fs, path, options, initialRefresh, requestRefresh, watchReconciliationHooks(options));
      const recover = (options: CodeGraphWatchOptions, failure: CodeGraphRefreshFailure) =>
        requestCodeGraphAutomaticRecovery(
          {
            coordinator: automaticRecovery,
            resolveIdentity: resolveRecoveryIdentity,
            routineMaintenance: (recoveryOptions, identity) => {
              const layout = codeGraphLayout(
                path,
                recoveryOptions.threadnoteHome,
                identity.checkoutId,
                identity.worktreeId,
              );
              return runCodeGraphLifecycleOpportunity({
                maintenance,
                opportunity: 'critical-error',
                targets: [
                  {
                    // This production dependency is wired directly to
                    // resolveRepositoryIdentity above; test seams may retain
                    // the intentionally smaller recovery identity shape.
                    anchorIdentity: identity as RepositoryIdentity,
                    checkoutId: layout.checkoutId,
                    databasePath: layout.databasePath,
                  },
                ],
                threadnoteHome: recoveryOptions.threadnoteHome,
              }).pipe(
                Effect.map(result =>
                  result.state === 'completed'
                    ? result.result
                    : ({reason: 'schema-unavailable', state: 'skipped'} as const),
                ),
                Effect.provideService(CommandExecutor, commandExecutor),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, systemInfo),
              );
            },
          },
          options,
          failure,
        ).pipe(Effect.asVoid);
      const watcher = yield* makeCodeGraphWatcher(
        run,
        refresh,
        {
          onRefreshFailure: failure =>
            emitCodeGraphBackgroundFailure(
              anonymousTelemetryComponent,
              'graph-refresh',
              anonymousTelemetryDiagnosticFromCodeGraphRefreshFailure(failure),
            ),
        },
        recover,
      );
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
  recoverRun: CodeGraphRecoveryRun = () => Effect.void,
) {
  const scope = yield* Effect.scope;
  const idleTimeoutMilliseconds = positiveInteger(
    lifecycleOptions.idleTimeoutMilliseconds,
    DEFAULT_IDLE_TIMEOUT_MILLISECONDS,
  );
  const maximumWatchers = positiveInteger(lifecycleOptions.maximumWatchers, DEFAULT_MAXIMUM_WATCHERS);
  const onRefreshFailure = lifecycleOptions.onRefreshFailure;
  const sweepIntervalMilliseconds = positiveInteger(
    lifecycleOptions.sweepIntervalMilliseconds,
    DEFAULT_SWEEP_INTERVAL_MILLISECONDS,
  );
  const activeWatches = yield* SynchronizedRef.make(new Map<string, ActiveWatch>());
  const activeRefreshes = yield* SynchronizedRef.make(new Map<string, ActiveRefresh>());
  const refreshStatuses = yield* SynchronizedRef.make(new Map<string, CodeGraphRefreshStatus>());
  const refreshSemaphore = yield* Semaphore.make(2);
  const refreshExecutionMetrics = yield* Ref.make<RefreshExecutionMetrics>({executing: 0, highWater: 0});
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
        yield* refreshSemaphore
          .withPermit(
            Effect.uninterruptibleMask(restore =>
              Ref.update(refreshExecutionMetrics, current => {
                const executing = current.executing + 1;
                return {executing, highWater: Math.max(current.highWater, executing)};
              }).pipe(
                Effect.andThen(restore(refreshRun(trackedRefreshOptions(options, tracker)))),
                Effect.ensuring(
                  Ref.update(refreshExecutionMetrics, current => ({
                    ...current,
                    executing: current.executing - 1,
                  })),
                ),
              ),
            ),
          )
          .pipe(
            Effect.catchCause(cause => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              const failure = codeGraphRefreshFailureFromCause(cause);
              lastFailure = classifyCodeGraphStoreFailure(
                CODE_GRAPH_REFRESH_OPERATION,
                Option.getOrUndefined(Cause.findErrorOption(cause)),
              );
              return setStatus(key, {failure, state: 'deferred'}).pipe(
                Effect.andThen(
                  onRefreshFailure === undefined
                    ? Effect.void
                    : Effect.suspend(() => onRefreshFailure(failure)).pipe(Effect.catchCause(() => Effect.void)),
                ),
                Effect.andThen(
                  Effect.logWarning(
                    `Code graph background refresh deferred (${failure.code}; recovery: ${failure.recovery}).`,
                  ),
                ),
                Effect.andThen(
                  recoverRun(options, failure).pipe(
                    Effect.catchCause(recoveryCause =>
                      Cause.hasInterruptsOnly(recoveryCause)
                        ? Effect.failCause(recoveryCause)
                        : Effect.logWarning(
                            'Code graph automatic recovery scheduling failed (unknown; recovery: diagnose).',
                          ),
                    ),
                    Effect.forkIn(scope),
                    Effect.asVoid,
                  ),
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
    scheduleRefresh({...options, admissionClass: 'background'}, queueTrailing).pipe(
      Effect.map(decision => decision.start),
    );
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
    metrics: Effect.gen(function* () {
      const watches = yield* SynchronizedRef.get(activeWatches);
      const refreshes = yield* SynchronizedRef.get(activeRefreshes);
      const statuses = yield* SynchronizedRef.get(refreshStatuses);
      const execution = yield* Ref.get(refreshExecutionMetrics);
      const idleSweepStarted = yield* Ref.get(sweepStarted);
      let pendingTrailingRefreshes = 0;
      for (const refresh of refreshes.values()) {
        if (refresh.pending) pendingTrailingRefreshes += 1;
      }
      return {
        activeRefreshKeys: refreshes.size,
        activeWatches: watches.size,
        executingRefreshes: execution.executing,
        executingRefreshHighWater: execution.highWater,
        idleSweepFibers: idleSweepStarted ? 1 : 0,
        maximumWatchers,
        pendingTrailingRefreshes,
        retainedStatuses: statuses.size,
      };
    }),
    refresh: options =>
      Effect.gen(function* () {
        yield* touchWatch(options.key);
        return yield* scheduleRefresh({...options, admissionClass: 'current-required'}, false).pipe(
          Effect.map(decision => decision.start),
        );
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
      requestRefreshAndWait({...options, admissionClass: 'current-required'}).pipe(
        Effect.andThen(run(options, true, () => requestBackgroundRefresh(options, true).pipe(Effect.asVoid))),
        Effect.ensuring(removeStatuses([options.key])),
      ),
  });
});

/** @internal Keep identity resolution inside the already-detached failure hook. */
export const requestCodeGraphAutomaticRecovery = Effect.fn('codeGraph.requestAutomaticRecovery')(function* (
  dependencies: CodeGraphAutomaticRecoveryDependencies,
  options: CodeGraphWatchOptions,
  failure: CodeGraphRefreshFailure,
) {
  if (failure.code !== 'schema-additive') {
    return yield* dependencies.coordinator.request({failureCode: failure.code, recoveryKey: options.key});
  }
  if (/^[0-9a-f]{64}$/u.test(options.key)) {
    const routineMaintenance = dependencies
      .resolveIdentity(options.cwd)
      .pipe(
        Effect.flatMap(identity =>
          identity.worktreeId === options.key
            ? dependencies.routineMaintenance(options, identity)
            : Effect.fail(
                new CodeGraphWatcherError('Code graph recovery identity changed before maintenance admission.'),
              ),
        ),
      );
    return yield* dependencies.coordinator
      .request({failureCode: failure.code, recoveryKey: options.key, routineMaintenance})
      .pipe(Effect.tap(logAutomaticRecoveryAdmission));
  }
  const identity = yield* dependencies.resolveIdentity(options.cwd);
  return yield* dependencies.coordinator
    .request({
      failureCode: failure.code,
      recoveryKey: identity.worktreeId,
      routineMaintenance: dependencies.routineMaintenance(options, identity),
    })
    .pipe(Effect.tap(logAutomaticRecoveryAdmission));
});

function logAutomaticRecoveryAdmission(admission: CodeGraphAutomaticRecoveryAdmission): Effect.Effect<void> {
  return admission.state === 'scheduled'
    ? Effect.logInfo('Code graph automatic recovery maintenance scheduled (schema-additive).')
    : Effect.void;
}

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
    etaTracker: makeCodeGraphEtaTracker(),
    phaseStartedAtMilliseconds: startedAtMilliseconds,
    startedAtMilliseconds,
    updatedAtMilliseconds: startedAtMilliseconds,
  };
}

function observeProgress(tracker: ProgressTracker, progress: CodeGraphProgress, now: number): void {
  if (tracker.phase !== progress.phase) {
    tracker.phase = progress.phase;
    tracker.phaseStartedAtMilliseconds = now;
  }
  const eta = observeCodeGraphEta(tracker.etaTracker, codeGraphEtaMeasurement(progress), now);
  tracker.etaTracker = eta.tracker;
  const estimate = Option.getOrUndefined(eta.estimate);
  tracker.estimatedPhaseRemainingMilliseconds = estimate?.remainingMilliseconds;
  tracker.estimateConfidence = estimate?.confidence;
  tracker.updatedAtMilliseconds = now;
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
      failure: codeGraphRefreshFailure(undefined),
      state: 'deferred',
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

const PREWARM_REFS = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
] as const;

/** @internal Deterministic and property-tested admission for bounded prewarming. */
export function prewarmCandidatesFromRefOutput(output: string, currentCommit: string, maximum = 2): readonly string[] {
  const limit = Number.isSafeInteger(maximum) && maximum > 0 ? Math.min(maximum, 2) : 2;
  return [
    ...new Set(
      output
        .split(/\r?\n/u)
        .map(value => value.trim().toLowerCase())
        .filter(value => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value) && value !== currentCommit.toLowerCase()),
    ),
  ].slice(0, limit);
}

const prewarmLikelyCleanSnapshots = Effect.fn('codeGraph.prewarmLikelyCleanSnapshots')(function* (input: {
  readonly commandExecutor: {
    readonly execute: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, unknown>;
  };
  readonly indexer: CodeGraphIndexerShape;
  readonly options: CodeGraphWatchOptions;
  readonly path: Path.Path;
  readonly prewarmedCommits: SynchronizedRef.SynchronizedRef<Set<string>>;
  readonly prewarmSemaphore: Semaphore.Semaphore;
  readonly store: CodeGraphStoreShape;
}) {
  const identity = yield* resolveRepositoryIdentity(input.options.cwd);
  const refs = yield* input.commandExecutor.execute(
    'git',
    ['-C', identity.repoRoot, 'for-each-ref', '--format=%(objectname)', ...PREWARM_REFS],
    {allowFailure: true, maxOutputBytes: 16 * 1024, timeoutMs: 10_000},
  );
  const commits = prewarmCandidatesFromRefOutput(refs.stdout, identity.headCommit);
  if (commits.length === 0) return;
  const layout = codeGraphLayout(input.path, input.options.threadnoteHome, identity.checkoutId, identity.worktreeId);
  yield* input.prewarmSemaphore.withPermit(
    Effect.forEach(
      commits,
      commit =>
        Effect.gen(function* () {
          const key = `${identity.checkoutId}:${commit}`;
          const reserved = yield* SynchronizedRef.modify(input.prewarmedCommits, current => {
            if (current.has(key)) return [false, current] as const;
            const next = new Set(current);
            if (next.size >= 64) next.delete(next.values().next().value!);
            next.add(key);
            return [true, next] as const;
          });
          if (!reserved) return;
          yield* input.indexer
            .ensureCommit({
              commit,
              cwd: input.options.cwd,
              threadnoteHome: input.options.threadnoteHome,
            })
            .pipe(
              Effect.flatMap(lease => input.store.releaseSnapshotLease(layout.databasePath, lease.leaseToken)),
              Effect.catchCause(cause => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                const failure = codeGraphRefreshFailureFromCause(cause);
                return SynchronizedRef.update(input.prewarmedCommits, current => {
                  const next = new Set(current);
                  next.delete(key);
                  return next;
                }).pipe(
                  Effect.andThen(
                    Effect.logDebug(`Code graph prewarm deferred (${failure.code}; recovery: ${failure.recovery}).`),
                  ),
                );
              }),
            );
        }),
      {concurrency: 1, discard: true},
    ),
  );
});

const indexRepository = (indexer: CodeGraphIndexerShape, options: CodeGraphWatchOptions) =>
  indexer
    .index(codeGraphWatcherRefreshIndexRequest(options))
    .pipe(
      Effect.tap(
        summary => options.onRefreshed?.(summary.snapshot.symbolCount, summary.snapshot.edgeCount) ?? Effect.void,
      ),
    );

/** Watcher-driven refresh never owns embedding; explicit `graph index` still does. */
export function codeGraphWatcherRefreshIndexRequest(options: CodeGraphWatchOptions): {
  readonly cwd: string;
  readonly ensureVectors: false;
  readonly onProgress: CodeGraphWatchOptions['onProgress'];
  readonly threadnoteHome: string;
} {
  return {
    cwd: options.cwd,
    ensureVectors: false,
    onProgress: options.onProgress,
    threadnoteHome: options.threadnoteHome,
  };
}

/** @internal Exported for deterministic watch-failure/reconciliation tests. */
export const watchRepository = Effect.fn('codeGraph.watchRepository')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  options: CodeGraphWatchOptions,
  _initialRefresh: boolean,
  requestRefresh: () => Effect.Effect<void>,
  reconciliationHooks: CodeGraphWatchReconciliationHooks = {
    periodicRefreshRequired: Effect.succeed(true),
    requestAfterChange: Effect.void,
  },
) {
  yield* (reconciliationHooks.requestInitial ?? reconciliationHooks.requestAfterChange).pipe(
    Effect.catch(() => Effect.logWarning('Code graph initial maintenance scheduling failed; watch remains active.')),
  );
  const changes = fs.watch(options.cwd).pipe(
    Stream.filter(event => relevantWatchPath(path, options.cwd, event.path)),
    Stream.debounce('750 millis'),
    Stream.map(() => 'change' as const),
    Stream.catchCause(cause =>
      Cause.hasInterruptsOnly(cause)
        ? Stream.failCause(cause)
        : Stream.fromEffect(
            Effect.logWarning('Code graph filesystem watch stopped; periodic reconciliation remains active.'),
          ),
    ),
  );
  const reconciliation = Stream.fromSchedule(Schedule.spaced('5 minutes')).pipe(Stream.map(() => 'periodic' as const));
  yield* Stream.merge(changes, reconciliation).pipe(
    Stream.runForEach(event =>
      event === 'change'
        ? reconciliationHooks.requestAfterChange.pipe(
            Effect.catch(() =>
              Effect.logWarning('Code graph change maintenance scheduling failed; refresh remains active.'),
            ),
            Effect.andThen(
              (reconciliationHooks.changeRefreshRequired ?? Effect.succeed(true)).pipe(
                Effect.match({
                  onFailure: () => false,
                  onSuccess: refreshRequired => refreshRequired,
                }),
                Effect.flatMap(refreshRequired => (refreshRequired ? requestRefresh() : Effect.void)),
              ),
            ),
          )
        : reconciliationHooks.periodicRefreshRequired.pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: refreshRequired => refreshRequired,
            }),
            Effect.flatMap(refreshRequired => (refreshRequired ? requestRefresh() : Effect.void)),
          ),
    ),
  );
});

export function codeGraphWatcherSnapshotStale(
  snapshot: {readonly commit: string; readonly dirty: boolean; readonly overlayFingerprint?: string},
  identity: Pick<RepositoryIdentity, 'headCommit'>,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
): boolean {
  return (
    snapshot.commit !== identity.headCommit ||
    snapshot.dirty !== overlay.dirty ||
    (overlay.dirty && snapshot.overlayFingerprint !== overlay.fingerprint)
  );
}

/**
 * Background watch/timer work is admitted only after the current ready base
 * was produced by a successful bounded overlay assessment. Missing or full
 * outcomes remain fail-closed until an explicit current-only request records a
 * new result.
 */
export function codeGraphCachedOverlayAssessmentAllowsBackgroundRefresh(
  readySnapshotId: string,
  statuses: readonly Pick<ObservedCodeGraphBuildStatus, 'materialization' | 'result' | 'state' | 'timestamps'>[],
): boolean {
  const matching = statuses.filter(
    status => status.state === 'completed' && status.result?.snapshotId === readySnapshotId,
  );
  const latest = matching.sort((left, right) => {
    const leftTime = Date.parse(left.timestamps.completedAt ?? left.timestamps.updatedAt);
    const rightTime = Date.parse(right.timestamps.completedAt ?? right.timestamps.updatedAt);
    return rightTime - leftTime;
  })[0];
  return latest?.result?.overlayAssessment?.outcome === 'overlay-success';
}

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
