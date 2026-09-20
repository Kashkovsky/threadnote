import type {FileLockOwner} from '../../effect/file/lock.js';
import type {ObservedCodeGraphBuildStatus} from '../build_status.js';

export function annotateBuildCoordination(
  statuses: readonly ObservedCodeGraphBuildStatus[],
  lockOwner: FileLockOwner | undefined,
): readonly ObservedCodeGraphBuildStatus[] {
  return statuses.map(status => {
    const terminal = status.state === 'completed' || status.state === 'failed';
    const progressSilent = status.observation.liveness === 'stalled';
    const legacyQueuedPastLock =
      status.phase === 'waiting' &&
      (status.subphase === 'database-writer' ||
        status.subphase === 'disk-capacity' ||
        status.subphase === 'snapshot-build');
    const legacyMayOwnLock = status.state !== 'queued' || legacyQueuedPastLock;
    const ownsLock =
      !terminal &&
      status.observation.liveness !== 'abandoned' &&
      (status.worktreeLockHeld ?? legacyMayOwnLock) &&
      lockOwner !== undefined &&
      sameProcessOwner(status, lockOwner);
    const role = ownsLock
      ? ('owner' as const)
      : !terminal && status.state === 'queued'
        ? ('waiter' as const)
        : 'history';
    const observation =
      ownsLock && progressSilent
        ? {heartbeatAgeMilliseconds: status.observation.heartbeatAgeMilliseconds, liveness: 'active' as const}
        : status.observation;
    return {
      ...status,
      coordination: {lockVerified: ownsLock, ...(progressSilent ? {progressSilent} : {}), role},
      observation,
    };
  });
}

export function groupBuildStatusesByWorktree(
  statuses: readonly ObservedCodeGraphBuildStatus[],
): readonly (readonly [string, readonly ObservedCodeGraphBuildStatus[]])[] {
  const groups = new Map<string, ObservedCodeGraphBuildStatus[]>();
  for (const status of statuses) {
    const group = groups.get(status.identity.worktreeId) ?? [];
    group.push(status);
    groups.set(status.identity.worktreeId, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right));
}

export function sameProcessOwner(status: ObservedCodeGraphBuildStatus, lockOwner: FileLockOwner): boolean {
  if (status.owner.processId !== lockOwner.processId) return false;
  if (!status.owner.processStartIdentity || !lockOwner.processStartIdentity) return true;
  return status.owner.processStartIdentity === lockOwner.processStartIdentity;
}
