import {Context, Deferred, Effect, FileSystem, Layer, Path, SynchronizedRef} from 'effect';
import {SystemInfo} from '../effect/system.js';
import {CodeGraphStore, type CodeGraphRoutineMaintenanceResult} from './store.js';
import {codeGraphMaintenanceIntentActive, CodeGraphMaintenanceActiveError} from './maintenance_gate.js';
import {CodeGraphStoreBusyError, CodeGraphStoreError, type RepositoryIdentity} from './types.js';
import {makeLiveCodeGraphWorktreeReconciler} from './worktree_reconciliation.js';
import {inspectCodeGraphViewDatabaseTarget} from './view_removal.js';

export const CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT = 128;

export interface CodeGraphRoutineMaintenanceTick {
  readonly allowIndexPreparation?: true;
  readonly anchorIdentity?: RepositoryIdentity;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly threadnoteHome: string;
  readonly writerLockPath: string;
}

export interface CodeGraphMaintenanceCoordinatorShape {
  readonly request: (input: CodeGraphRoutineMaintenanceTick) => Effect.Effect<void>;
  readonly tick: (
    input: CodeGraphRoutineMaintenanceTick,
  ) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>;
}

export type CodeGraphRoutineMaintenanceRun = (
  input: CodeGraphRoutineMaintenanceTick,
) => Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>;

export type CodeGraphRoutineMaintenanceIntentCheck = (
  threadnoteHome: string,
) => Effect.Effect<boolean, CodeGraphStoreError>;

export interface CodeGraphMaintenanceCoordinatorInterlocks {
  /** @internal Deterministic cancellation barrier after request admission and before child handoff. */
  readonly afterRequestAdmission?: () => Effect.Effect<void>;
}

interface ActiveMaintenanceTick {
  readonly completion: Deferred.Deferred<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>;
  readonly databasePath: string;
  readonly input: CodeGraphRoutineMaintenanceTick;
}

interface HomeMaintenanceState {
  readonly active: ActiveMaintenanceTick;
  readonly pending: ReadonlyMap<string, CodeGraphRoutineMaintenanceTick>;
}

type MaintenanceTickDecision =
  | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'join'}
  | {readonly state: 'deferred'}
  | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'start'};

type MaintenanceRequestDecision =
  {readonly state: 'queued'} | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'start'};

export class CodeGraphMaintenanceCoordinator extends Context.Service<
  CodeGraphMaintenanceCoordinator,
  CodeGraphMaintenanceCoordinatorShape
>()('threadnote/codeGraph/CodeGraphMaintenanceCoordinator') {
  static readonly layer = Layer.effect(
    CodeGraphMaintenanceCoordinator,
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const reconciler = yield* makeLiveCodeGraphWorktreeReconciler();
      const runRoutineMaintenance = (input: CodeGraphRoutineMaintenanceTick) =>
        store.runRoutineMaintenance(input.databasePath, {
          checkoutId: input.checkoutId,
          threadnoteHome: input.threadnoteHome,
          writerLockPath: input.writerLockPath,
        });
      const runReconciliation: CodeGraphRoutineMaintenanceRun = input =>
        reconciler.tick(input).pipe(
          Effect.flatMap(result =>
            result.state === 'removed'
              ? Effect.succeed({
                  cleanup: 'removed-worktree-view',
                  expiredLeases: 0,
                  remaining: true,
                  retiredSnapshots: result.retiredSnapshots,
                  rowsDeleted: 0,
                  state: 'completed',
                } as const satisfies CodeGraphRoutineMaintenanceResult)
              : result.reason === 'external-maintenance'
                ? Effect.succeed({reason: 'external-maintenance', state: 'deferred'} as const)
                : result.state === 'deferred' && result.reason === 'writer-busy'
                  ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                  : result.state === 'deferred' && result.reason === 'catalog-unavailable'
                    ? Effect.succeed({reason: 'schema-unavailable', state: 'skipped'} as const)
                    : runRoutineMaintenance(input),
          ),
        );
      return yield* makeCodeGraphMaintenanceCoordinator(
        input => {
          if (input.anchorIdentity === undefined) return runRoutineMaintenance(input);
          if (input.allowIndexPreparation !== true) return runReconciliation(input);
          return store
            .prepareWorktreeReconciliationIndexes(input.databasePath, {
              beforeDatabaseOpen: () =>
                Effect.gen(function* () {
                  const inspected = yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
                  if (inspected.state !== 'ready' || inspected.databasePath !== input.databasePath) {
                    return yield* Effect.fail(
                      new Error('Code graph database target changed before index preparation.'),
                    );
                  }
                  if (yield* codeGraphMaintenanceIntentActive(input.threadnoteHome)) {
                    return yield* Effect.fail(new CodeGraphMaintenanceActiveError());
                  }
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                ),
              waitTimeoutMilliseconds: 0,
            })
            .pipe(
              Effect.flatMap(result =>
                result.state === 'prepared'
                  ? Effect.succeed({
                      cleanup: 'reconciliation-index',
                      expiredLeases: 0,
                      remaining: true,
                      retiredSnapshots: 0,
                      rowsDeleted: 0,
                      state: 'completed',
                    } as const satisfies CodeGraphRoutineMaintenanceResult)
                  : result.state === 'deferred'
                    ? Effect.succeed({reason: 'schema-unavailable', state: 'skipped'} as const)
                    : runReconciliation(input),
              ),
              Effect.catch((error): Effect.Effect<CodeGraphRoutineMaintenanceResult> =>
                error instanceof CodeGraphMaintenanceActiveError
                  ? Effect.succeed({reason: 'external-maintenance', state: 'deferred'} as const)
                  : error instanceof CodeGraphStoreBusyError
                    ? Effect.succeed({reason: 'writer-busy', state: 'deferred'} as const)
                    : Effect.succeed({reason: 'schema-unavailable', state: 'skipped'} as const),
              ),
            );
        },
        threadnoteHome =>
          codeGraphMaintenanceIntentActive(threadnoteHome).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
            Effect.mapError(() => new CodeGraphStoreError('Could not inspect code graph maintenance coordination.')),
          ),
      );
    }),
  );
}

/**
 * Coalesce callers for one database and retain a bounded insertion-order queue
 * for distinct databases without making their foreground callers await it.
 */
export const makeCodeGraphMaintenanceCoordinator = Effect.fn('codeGraph.makeMaintenanceCoordinator')(function* (
  run: CodeGraphRoutineMaintenanceRun,
  externalMaintenanceActive: CodeGraphRoutineMaintenanceIntentCheck = () => Effect.succeed(false),
  interlocks: CodeGraphMaintenanceCoordinatorInterlocks = {},
) {
  const scope = yield* Effect.scope;
  const stateByHome = yield* SynchronizedRef.make(new Map<string, HomeMaintenanceState>());

  const execute = (
    input: CodeGraphRoutineMaintenanceTick,
    completion: ActiveMaintenanceTick['completion'],
  ): Effect.Effect<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError> =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const exit = yield* restore(
          externalMaintenanceActive(input.threadnoteHome).pipe(
            Effect.flatMap(active =>
              active ? Effect.succeed({reason: 'external-maintenance', state: 'deferred'} as const) : run(input),
            ),
          ),
        ).pipe(Effect.exit);
        yield* Deferred.done(completion, exit);
        const nextCompletion = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>();
        const next = yield* SynchronizedRef.modify<
          Map<string, HomeMaintenanceState>,
          CodeGraphRoutineMaintenanceTick | undefined
        >(stateByHome, current => {
          const home = current.get(input.threadnoteHome);
          if (home?.active.completion !== completion) return [undefined, current] as const;
          const nextEntry = home.pending.entries().next().value as
            [string, CodeGraphRoutineMaintenanceTick] | undefined;
          const updated = new Map(current);
          if (nextEntry === undefined) {
            updated.delete(input.threadnoteHome);
            return [undefined, updated] as const;
          }
          const [databasePath, nextInput] = nextEntry;
          const pending = new Map(home.pending);
          pending.delete(databasePath);
          updated.set(input.threadnoteHome, {
            active: {completion: nextCompletion, databasePath, input: nextInput},
            pending,
          });
          return [nextInput, updated] as const;
        });
        if (next !== undefined) {
          yield* execute(next, nextCompletion).pipe(
            Effect.tapError(error => Effect.logWarning(`Deferred code graph maintenance failed (${error.code}).`)),
            Effect.ignore,
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        }
        return yield* restore(Deferred.await(completion));
      }),
    );

  const tick = (input: CodeGraphRoutineMaintenanceTick) =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>();
        const decision = yield* SynchronizedRef.modify<Map<string, HomeMaintenanceState>, MaintenanceTickDecision>(
          stateByHome,
          current => {
            const home = current.get(input.threadnoteHome);
            if (home !== undefined) {
              const pending = new Map(home.pending);
              const decision: MaintenanceTickDecision =
                home.active.databasePath === input.databasePath
                  ? {completion: home.active.completion, state: 'join'}
                  : {state: 'deferred'};
              const existingPending = pending.get(input.databasePath);
              const needsAuthoritativeTrailing =
                decision.state === 'join' &&
                home.active.input.anchorIdentity === undefined &&
                input.anchorIdentity !== undefined;
              const needsPreparationTrailing =
                decision.state === 'join' &&
                home.active.input.allowIndexPreparation !== true &&
                input.allowIndexPreparation === true;
              const needsTrailing = needsAuthoritativeTrailing || needsPreparationTrailing;
              const ordinaryPendingCount = [...pending.keys()].filter(
                databasePath => databasePath !== home.active.databasePath,
              ).length;
              if (decision.state === 'deferred' && existingPending !== undefined) {
                pending.set(input.databasePath, mergeMaintenanceTick(existingPending, input));
              } else if (
                decision.state === 'deferred' &&
                ordinaryPendingCount < CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT - 1
              ) {
                pending.set(input.databasePath, input);
              } else if (needsTrailing) {
                pending.set(input.databasePath, mergeMaintenanceTick(existingPending ?? home.active.input, input));
              }
              if (pending.size === home.pending.size && existingPending === pending.get(input.databasePath)) {
                return [decision, current] as const;
              }
              const updated = new Map(current);
              updated.set(input.threadnoteHome, {...home, pending});
              return [decision, updated] as const;
            }
            const next = new Map(current);
            next.set(input.threadnoteHome, {
              active: {completion: candidate, databasePath: input.databasePath, input},
              pending: new Map(),
            });
            return [{completion: candidate, state: 'start'}, next] as const;
          },
        );

        if (decision.state === 'deferred') {
          return {reason: 'home-tick-active', state: 'deferred'} as const;
        }
        if (decision.state === 'join') return yield* restore(Deferred.await(decision.completion));

        return yield* restore(execute(input, candidate));
      }),
    );

  const request = (input: CodeGraphRoutineMaintenanceTick) =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>();
        const decision = yield* SynchronizedRef.modify<Map<string, HomeMaintenanceState>, MaintenanceRequestDecision>(
          stateByHome,
          current => {
            const home = current.get(input.threadnoteHome);
            if (home === undefined) {
              const next = new Map(current);
              next.set(input.threadnoteHome, {
                active: {completion: candidate, databasePath: input.databasePath, input},
                pending: new Map(),
              });
              return [{completion: candidate, state: 'start'}, next] as const;
            }
            const pending = new Map(home.pending);
            const existing = pending.get(input.databasePath);
            if (home.active.databasePath === input.databasePath) {
              pending.set(input.databasePath, mergeMaintenanceTick(existing ?? home.active.input, input));
            } else if (existing !== undefined) {
              pending.set(input.databasePath, mergeMaintenanceTick(existing, input));
            } else {
              const ordinaryPendingCount = [...pending.keys()].filter(
                databasePath => databasePath !== home.active.databasePath,
              ).length;
              if (ordinaryPendingCount < CODE_GRAPH_MAINTENANCE_PENDING_DATABASE_LIMIT - 1) {
                pending.set(input.databasePath, input);
              }
            }
            if (pending.size === home.pending.size && existing === pending.get(input.databasePath)) {
              return [{state: 'queued'}, current] as const;
            }
            const next = new Map(current);
            next.set(input.threadnoteHome, {...home, pending});
            return [{state: 'queued'}, next] as const;
          },
        );
        yield* interlocks.afterRequestAdmission?.() ?? Effect.void;
        if (decision.state === 'queued') return;
        yield* execute(input, decision.completion).pipe(
          Effect.interruptible,
          Effect.tapError(error => Effect.logWarning(`Requested code graph maintenance failed (${error.code}).`)),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      }),
    );

  return CodeGraphMaintenanceCoordinator.of({request, tick});
});

function mergeMaintenanceTick(
  existing: CodeGraphRoutineMaintenanceTick | undefined,
  incoming: CodeGraphRoutineMaintenanceTick,
): CodeGraphRoutineMaintenanceTick {
  if (existing === undefined) return incoming;
  return {
    ...incoming,
    allowIndexPreparation:
      incoming.allowIndexPreparation === true || existing.allowIndexPreparation === true ? true : undefined,
    anchorIdentity: incoming.anchorIdentity ?? existing.anchorIdentity,
  };
}
