import {Effect, Option} from 'effect';
import {
  readAllCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
  type ObservedCodeGraphBuildStatus,
} from './build_status.js';
import {runCodeGraphLifecycleOpportunity} from './lifecycle_opportunity.js';
import {observeManagerGraphCatalogStatus} from './manager_catalog_revision.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance_coordinator.js';
import {observeCodeGraphMaintenanceStatus, type CodeGraphMaintenanceStatus} from './maintenance_gate.js';

export interface ManagerGraphBuildCatalog {
  readonly builds: readonly ObservedCodeGraphBuildStatus[];
  readonly catalogRevision?: string;
  readonly lifecyclePending: boolean;
  readonly maintenance?: CodeGraphMaintenanceStatus;
  readonly queuedWorktreeIds: readonly string[];
  readonly waiterCount: number;
  readonly waiters: readonly ObservedCodeGraphBuildStatus[];
}

/** Bounded live status plus one non-tailing missing-view reconciliation opportunity. */
export const managerGraphBuildCatalog = Effect.fn('codeGraph.managerBuildCatalog')(function* (threadnoteHome: string) {
  const selection = selectCodeGraphBuildStatuses(yield* readAllCodeGraphBuildStatuses(threadnoteHome));
  const maintenance = yield* observeCodeGraphMaintenanceStatus(threadnoteHome).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  const active = [...selection.builds, ...selection.waiters].some(
    status => status.state === 'queued' || status.state === 'running',
  );
  let statusObservation =
    active || maintenance !== undefined
      ? undefined
      : yield* observeManagerGraphCatalogStatus(threadnoteHome).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const lifecycleMaintenance = yield* Effect.serviceOption(CodeGraphMaintenanceCoordinator);
  if (statusObservation?.lifecyclePending === true && Option.isSome(lifecycleMaintenance)) {
    const lifecycle = yield* runCodeGraphLifecycleOpportunity({
      maintenance: lifecycleMaintenance.value,
      opportunity: 'status',
      targets: statusObservation.lifecycleTargets,
      threadnoteHome,
    }).pipe(Effect.catch(() => Effect.void));
    if (
      lifecycle?.state === 'completed' &&
      lifecycle.result.state === 'completed' &&
      lifecycle.result.cleanup === 'removed-worktree-view'
    ) {
      statusObservation = yield* observeManagerGraphCatalogStatus(threadnoteHome).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
    }
  }
  const catalogRevision = statusObservation?.catalogRevision;
  return {
    builds: selection.builds,
    ...(catalogRevision === undefined ? {} : {catalogRevision}),
    lifecyclePending: statusObservation?.lifecyclePending === true,
    ...(maintenance === undefined ? {} : {maintenance}),
    queuedWorktreeIds: [...new Set(selection.waiters.map(status => status.identity.worktreeId))],
    waiterCount: selection.waiters.length,
    waiters: selection.waiters,
  } satisfies ManagerGraphBuildCatalog;
});
