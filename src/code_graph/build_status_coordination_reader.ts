import {Effect, Option, type FileSystem, type Path} from 'effect';
import {readExclusiveFileLockOwner} from '../effect/file_lock.js';
import {codeGraphScopeViewKey} from './scope_identity.js';
import type {CodeGraphLayout} from './layout.js';
import type {ObservedCodeGraphBuildStatus} from './build_status.js';
import {annotateBuildCoordination, groupBuildStatusesByWorktree} from './build_status_coordination.js';

export function annotateCheckoutBuildCoordination(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  layout: CodeGraphLayout,
  statuses: readonly ObservedCodeGraphBuildStatus[],
) {
  return Effect.forEach(
    groupBuildStatusesByWorktree(statuses),
    ([worktreeId, worktreeStatuses]) =>
      readExclusiveFileLockOwner(
        fs,
        path.join(layout.worktreeLockRoot, `${codeGraphScopeViewKey(worktreeId, layout.scopeId)}.lock`),
      ).pipe(Effect.map(lockOwner => annotateBuildCoordination(worktreeStatuses, Option.getOrUndefined(lockOwner)))),
    {concurrency: 8},
  ).pipe(Effect.map(groups => groups.flat().sort(compareObservedBuildStatus)));
}

export function annotateBuildCoordinationByWorktree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  statuses: readonly ObservedCodeGraphBuildStatus[],
) {
  return Effect.forEach(
    groupBuildStatusesByWorktree(statuses),
    ([worktreeId, worktreeStatuses]) =>
      readExclusiveFileLockOwner(
        fs,
        path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'worktrees', checkoutId, `${worktreeId}.lock`),
      ).pipe(Effect.map(lockOwner => annotateBuildCoordination(worktreeStatuses, Option.getOrUndefined(lockOwner)))),
    {concurrency: 8},
  ).pipe(Effect.map(groups => groups.flat().sort(compareObservedBuildStatus)));
}

function compareObservedBuildStatus(left: ObservedCodeGraphBuildStatus, right: ObservedCodeGraphBuildStatus): number {
  const priority = (status: ObservedCodeGraphBuildStatus) => {
    if (status.coordination?.role === 'owner') return 0;
    if (status.observation.liveness === 'active') return status.state === 'running' ? 1 : 2;
    if (status.observation.liveness === 'completed') return 3;
    if (status.observation.liveness === 'failed') return 4;
    if (status.observation.liveness === 'stalled') return status.state === 'running' ? 5 : 6;
    return 7;
  };
  return (
    priority(left) - priority(right) || Date.parse(right.timestamps.updatedAt) - Date.parse(left.timestamps.updatedAt)
  );
}
