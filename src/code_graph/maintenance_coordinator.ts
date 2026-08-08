import {Context, Deferred, Effect, FileSystem, Layer, Path, SynchronizedRef} from 'effect';
import {SystemInfo} from '../effect/system.js';
import {CodeGraphStore, type CodeGraphRoutineMaintenanceResult} from './store.js';
import {codeGraphMaintenanceIntentActive} from './maintenance_gate.js';
import {CodeGraphStoreError} from './types.js';

export interface CodeGraphRoutineMaintenanceTick {
  readonly databasePath: string;
  readonly threadnoteHome: string;
  readonly writerLockPath: string;
}

export interface CodeGraphMaintenanceCoordinatorShape {
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

interface ActiveMaintenanceTick {
  readonly completion: Deferred.Deferred<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>;
  readonly databasePath: string;
}

type MaintenanceTickDecision =
  | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'join'}
  | {readonly state: 'deferred'}
  | {readonly completion: ActiveMaintenanceTick['completion']; readonly state: 'start'};

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
      return yield* makeCodeGraphMaintenanceCoordinator(
        input => store.runRoutineMaintenance(input.databasePath, {writerLockPath: input.writerLockPath}),
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
 * Coalesce callers for one database and keep distinct databases in the same
 * Threadnote home from turning an idle sweep into a writer queue.
 */
export const makeCodeGraphMaintenanceCoordinator = Effect.fn('codeGraph.makeMaintenanceCoordinator')(function* (
  run: CodeGraphRoutineMaintenanceRun,
  externalMaintenanceActive: CodeGraphRoutineMaintenanceIntentCheck = () => Effect.succeed(false),
) {
  const activeByHome = yield* SynchronizedRef.make(new Map<string, ActiveMaintenanceTick>());

  const tick = (input: CodeGraphRoutineMaintenanceTick) =>
    Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<CodeGraphRoutineMaintenanceResult, CodeGraphStoreError>();
        const decision = yield* SynchronizedRef.modify<Map<string, ActiveMaintenanceTick>, MaintenanceTickDecision>(
          activeByHome,
          current => {
            const active = current.get(input.threadnoteHome);
            if (active !== undefined) {
              const decision: MaintenanceTickDecision =
                active.databasePath === input.databasePath
                  ? {completion: active.completion, state: 'join'}
                  : {state: 'deferred'};
              return [decision, current] as const;
            }
            const next = new Map(current);
            next.set(input.threadnoteHome, {completion: candidate, databasePath: input.databasePath});
            return [{completion: candidate, state: 'start'}, next] as const;
          },
        );

        if (decision.state === 'deferred') {
          return {reason: 'home-tick-active', state: 'deferred'} as const;
        }
        if (decision.state === 'join') return yield* restore(Deferred.await(decision.completion));

        const exit = yield* restore(
          externalMaintenanceActive(input.threadnoteHome).pipe(
            Effect.flatMap(active =>
              active ? Effect.succeed({reason: 'external-maintenance', state: 'deferred'} as const) : run(input),
            ),
          ),
        ).pipe(Effect.exit);
        yield* Deferred.done(candidate, exit);
        yield* SynchronizedRef.update(activeByHome, current => {
          if (current.get(input.threadnoteHome)?.completion !== candidate) return current;
          const next = new Map(current);
          next.delete(input.threadnoteHome);
          return next;
        });
        return yield* restore(Deferred.await(candidate));
      }),
    );

  return CodeGraphMaintenanceCoordinator.of({tick});
});
