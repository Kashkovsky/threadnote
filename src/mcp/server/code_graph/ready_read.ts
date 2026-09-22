import {Effect} from 'effect';
import {codeGraphScopeAdmitsPath} from '../../../code_graph/scope/applicability.js';
import {
  codeGraphProjectCoverage,
  discloseCodeGraphProjectCoverage,
  outsideCodeGraphProjectPaths,
  type CodeGraphQueryScope,
} from '../../../code_graph/query/scope.js';
import type {
  CodeGraphQueryOptions,
  CodeGraphQueryResult,
  CodeGraphSnapshot,
  RepositoryIdentity,
} from '../../../code_graph/types.js';
import type {
  CodeGraphRefreshStatus,
  CodeGraphRefreshContinuity,
  CodeGraphWatcherShape,
  CodeGraphWatchOptions,
} from '../../../code_graph/watcher.js';
import type {CodeGraphStatusObservation} from '../../../code_graph/query/contract.js';

type CodeGraphInspectionOperation = CodeGraphQueryResult['operation'];

export function codeGraphRefreshBlocksReadyInspection(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  refreshStatus: CodeGraphRefreshStatus | undefined,
  allowStaleReadySnapshot = false,
): boolean {
  if (refreshStatus?.state === 'deferred' && refreshStatus.failure.recovery === 'reconnect-runtime') return true;
  const refreshBlocks = refreshStatus?.state === 'deferred' || refreshStatus?.state === 'indexing';
  return refreshBlocks && (!status.readySnapshot || (status.stale && !allowStaleReadySnapshot));
}

export function codeGraphInspectionAllowsStaleReady(operation: CodeGraphInspectionOperation): boolean {
  return operation !== 'impact' && operation !== 'path';
}

export function codeGraphInspectionObservesWorktree(operation: CodeGraphInspectionOperation): boolean {
  return !codeGraphInspectionAllowsStaleReady(operation);
}

export function codeGraphInspectionObservation(
  observation: CodeGraphStatusObservation | undefined,
  operation: CodeGraphInspectionOperation,
): CodeGraphStatusObservation | undefined {
  if (observation === undefined || codeGraphInspectionObservesWorktree(operation)) return observation;
  return {
    identity: observation.identity,
    ...(observation.borrowedSnapshotId === undefined ? {} : {borrowedSnapshotId: observation.borrowedSnapshotId}),
    ...(observation.manifestPath === undefined ? {} : {manifestPath: observation.manifestPath}),
    ...(observation.projectScope === undefined ? {} : {projectScope: observation.projectScope}),
  };
}

export function codeGraphInspectionStartsRefresh(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  operation: CodeGraphInspectionOperation,
): boolean {
  return !status.readySnapshot || (status.stale && !codeGraphInspectionAllowsStaleReady(operation));
}

export function codeGraphInspectionRequestsBackgroundRefresh(
  status: {readonly readySnapshot?: unknown; readonly stale: boolean},
  operation: CodeGraphInspectionOperation,
): boolean {
  return status.readySnapshot !== undefined && status.stale && codeGraphInspectionAllowsStaleReady(operation);
}

export function selectCodeGraphReadySnapshotForInspection<T>(
  status: {readonly readySnapshot?: T; readonly stale: boolean},
  refreshStatus: CodeGraphRefreshStatus | undefined,
  allowStaleReadySnapshot = false,
): T | undefined {
  return codeGraphRefreshBlocksReadyInspection(status, refreshStatus, allowStaleReadySnapshot)
    ? undefined
    : status.readySnapshot;
}

export const completeCodeGraphReadyReadRefresh = Effect.fn('codeGraph.completeReadyReadRefresh')(function* (input: {
  readonly backgroundRefreshRequested: boolean;
  readonly ensureWatcher: boolean;
  readonly key: string;
  readonly refresh?: CodeGraphRefreshContinuity;
  readonly target: Omit<CodeGraphWatchOptions, 'key'>;
  readonly watcher: CodeGraphWatcherShape;
}) {
  if (input.ensureWatcher) yield* input.watcher.ensure({...input.target, key: input.key});
  if (!input.backgroundRefreshRequested) return input.refresh;
  // A compatible ready read may establish a watcher, but never turns its
  // successful response into a hidden build request. Current-required reads,
  // explicit indexing, and watcher-observed changes own refresh admission.
  return (
    input.refresh ?? {
      type: 'code-graph-refresh-continuity' as const,
      version: 1 as const,
      state: 'deferred' as const,
    }
  );
});

export function selectCodeGraphReadyReadChangedPaths(
  projectScope: CodeGraphQueryScope | undefined,
  paths: readonly string[] | undefined,
): readonly string[] | undefined {
  return paths?.filter(path => codeGraphScopeAdmitsPath(projectScope?.scope, path));
}

export function presentCodeGraphScopedReadyRead(input: {
  readonly identity: RepositoryIdentity;
  readonly options: CodeGraphQueryOptions;
  readonly projectScope: CodeGraphQueryScope | undefined;
  readonly result: CodeGraphQueryResult;
  readonly selectedChangedPathCount?: number;
  readonly snapshot: Pick<CodeGraphSnapshot, 'commit'>;
  readonly totalChangedPathCount?: number;
}): CodeGraphQueryResult {
  if (input.projectScope === undefined) return input.result;
  const outsidePaths = outsideCodeGraphProjectPaths(input.options, input.projectScope.scope);
  const result =
    outsidePaths.length === 0
      ? input.result
      : {...input.result, edges: [], nodes: [], scope: undefined, searchCoverage: undefined, warnings: []};
  return discloseCodeGraphProjectCoverage(
    result,
    codeGraphProjectCoverage(input.projectScope, input.identity, input.snapshot, result.freshness === 'current'),
    outsidePaths,
    input.totalChangedPathCount === undefined
      ? undefined
      : input.totalChangedPathCount - (input.selectedChangedPathCount ?? 0),
  );
}
