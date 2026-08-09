import {Effect, Option, Path} from 'effect';
import {codeGraphDatabaseWriteLockPath, codeGraphLayout} from './layout.js';
import {readCodeGraphLocalAssociation} from './local_provenance.js';
import {codeGraphDatabasePaths} from './maintenance.js';
import {type CodeGraphMaintenanceCoordinatorShape} from './maintenance_coordinator.js';
import {compareCodeUnits} from './ordering.js';
import {inspectCodeGraphStorage} from './storage.js';
import {codeGraphStorageAccounting, type CodeGraphStoragePressure} from './storage_pressure.js';
import {CodeGraphStore} from './store.js';
import {type CodeGraphRoutineMaintenanceResult} from './store_models.js';
import {type RepositoryIdentity} from './types.js';

export const CODE_GRAPH_LIFECYCLE_OPPORTUNITIES = [
  'startup',
  'catalog',
  'diagnostics',
  'index-completion',
  'critical-error',
] as const;

export type CodeGraphLifecycleOpportunity = (typeof CODE_GRAPH_LIFECYCLE_OPPORTUNITIES)[number];

export interface CodeGraphLifecycleOpportunityTarget {
  readonly anchorIdentity?: RepositoryIdentity;
  /** Trusted local path used only to re-resolve a live anchor; never returned. */
  readonly anchorPath?: string;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly pressure?: Extract<CodeGraphStoragePressure, 'critical' | 'elevated'>;
}

export type CodeGraphLifecycleOpportunityResult =
  | {readonly opportunity: CodeGraphLifecycleOpportunity; readonly state: 'no-target'}
  | {
      readonly opportunity: CodeGraphLifecycleOpportunity;
      readonly reason: 'deadline';
      readonly state: 'deferred';
    }
  | {
      readonly checkoutId: string;
      readonly opportunity: CodeGraphLifecycleOpportunity;
      readonly result: CodeGraphRoutineMaintenanceResult;
      readonly state: 'completed';
    };

const LIFECYCLE_OPPORTUNITY_CURSOR_LIMIT = 128;
export const CODE_GRAPH_LIFECYCLE_OPPORTUNITY_UNIT_MILLISECONDS = 2_000;
const opportunityCursors = new Map<string, string>();

/** Read bounded active-pointer provenance without invoking Git on the healthy hot path. */
export const observeCodeGraphLifecycleOpportunityTargets = Effect.fn('codeGraph.observeLifecycleOpportunityTargets')(
  function* (threadnoteHome: string) {
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const databases = yield* codeGraphDatabasePaths(threadnoteHome);
    return yield* Effect.forEach(
      databases,
      databasePath =>
        Effect.gen(function* () {
          const checkoutId = path.basename(path.dirname(databasePath));
          const [views, storage] = yield* Effect.all(
            [
              store.loadActiveViewIdentities(databasePath, 8).pipe(Effect.catch(() => Effect.succeed([]))),
              inspectCodeGraphStorage(threadnoteHome, checkoutId).pipe(Effect.catch(() => Effect.succeed(undefined))),
            ],
            {concurrency: 2},
          );
          const associations = yield* Effect.forEach(
            views,
            view =>
              readCodeGraphLocalAssociation(threadnoteHome, {
                checkoutId,
                repositoryId: view.repositoryId,
                worktreeId: view.worktreeId,
              }).pipe(Effect.catch(() => Effect.succeed({available: false, state: 'invalid'} as const))),
            {concurrency: 1},
          );
          const anchor = associations.find(association => association.state === 'verified' && 'path' in association);
          const anchorPath = anchor !== undefined && 'path' in anchor ? anchor.path : undefined;
          const pressure = storage?.state === 'available' ? codeGraphStorageAccounting(storage).pressure : undefined;
          return {
            ...(anchorPath === undefined ? {} : {anchorPath}),
            checkoutId,
            databasePath,
            ...(pressure === 'critical' || pressure === 'elevated' ? {pressure} : {}),
          } satisfies CodeGraphLifecycleOpportunityTarget;
        }),
      {concurrency: 2},
    );
  },
);

/**
 * Await one zero-wait maintenance unit at a foreground lifecycle opportunity.
 * Distinct databases rotate in code-unit order; a short-lived CLI therefore
 * commits one bounded unit instead of abandoning a detached request at exit.
 */
export const runCodeGraphLifecycleOpportunity = Effect.fn('codeGraph.runLifecycleOpportunity')(function* (input: {
  readonly maintenance: CodeGraphMaintenanceCoordinatorShape;
  readonly opportunity: CodeGraphLifecycleOpportunity;
  readonly pressure?: Extract<CodeGraphStoragePressure, 'critical' | 'elevated'>;
  readonly targets: readonly CodeGraphLifecycleOpportunityTarget[];
  readonly threadnoteHome: string;
}) {
  const path = yield* Path.Path;
  const cursorKey = `${input.threadnoteHome}\0${input.opportunity}`;
  const target = selectCodeGraphLifecycleOpportunityTarget(input.targets, opportunityCursors.get(cursorKey));
  if (target === undefined) return {opportunity: input.opportunity, state: 'no-target'} as const;
  rememberOpportunityCursor(cursorKey, lifecycleTargetKey(target));

  let anchorIdentity = target.anchorIdentity;
  if (anchorIdentity !== undefined) {
    const layout = codeGraphLayout(path, input.threadnoteHome, anchorIdentity.checkoutId, anchorIdentity.worktreeId);
    if (anchorIdentity.checkoutId !== target.checkoutId || layout.databasePath !== target.databasePath) {
      anchorIdentity = undefined;
    }
  }
  const pressure = target.pressure ?? input.pressure;
  const observed = yield* input.maintenance
    .tick({
      ...(anchorIdentity === undefined ? {} : {allowIndexPreparation: true as const, anchorIdentity}),
      ...(anchorIdentity === undefined && target.anchorPath !== undefined
        ? {allowIndexPreparation: true as const, anchorPath: target.anchorPath}
        : {}),
      automaticTail: false,
      checkoutId: target.checkoutId,
      databasePath: target.databasePath,
      joinActive: false,
      ...(pressure === undefined ? {} : {pressure}),
      threadnoteHome: input.threadnoteHome,
      writerLockPath: codeGraphDatabaseWriteLockPath(path, input.threadnoteHome, target.checkoutId),
    })
    .pipe(Effect.timeoutOption(CODE_GRAPH_LIFECYCLE_OPPORTUNITY_UNIT_MILLISECONDS));
  if (Option.isNone(observed)) {
    return {opportunity: input.opportunity, reason: 'deadline', state: 'deferred'} as const;
  }
  return {
    checkoutId: target.checkoutId,
    opportunity: input.opportunity,
    result: observed.value,
    state: 'completed',
  } as const;
});

/** @internal Pure round-robin selector retained for fairness properties. */
export function selectCodeGraphLifecycleOpportunityTarget(
  targets: readonly CodeGraphLifecycleOpportunityTarget[],
  cursor?: string,
): CodeGraphLifecycleOpportunityTarget | undefined {
  const unique = new Map<string, CodeGraphLifecycleOpportunityTarget>();
  for (const target of targets) {
    if (/^[0-9a-f]{64}$/u.test(target.checkoutId) && target.databasePath.length > 0) {
      unique.set(lifecycleTargetKey(target), target);
    }
  }
  const ordered = [...unique.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
  if (ordered.length === 0) return undefined;
  if (cursor === undefined) return ordered[0]![1];
  return (ordered.find(([key]) => compareCodeUnits(key, cursor) > 0) ?? ordered[0])![1];
}

function lifecycleTargetKey(target: CodeGraphLifecycleOpportunityTarget): string {
  return `${target.checkoutId}\0${target.databasePath}`;
}

function rememberOpportunityCursor(key: string, cursor: string): void {
  opportunityCursors.delete(key);
  opportunityCursors.set(key, cursor);
  while (opportunityCursors.size > LIFECYCLE_OPPORTUNITY_CURSOR_LIMIT) {
    const oldest = opportunityCursors.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    opportunityCursors.delete(oldest);
  }
}
