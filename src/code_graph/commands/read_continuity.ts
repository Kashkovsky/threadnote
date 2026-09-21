import {Effect} from 'effect';
import type {RuntimeConfig} from '../../types.js';
import {
  codeGraphCliReadPlan,
  codeGraphCliUsesBorrowedContinuity,
  type CodeGraphCliFreshnessPolicy,
  type CodeGraphCliReadPlan,
} from '../cli/freshness.js';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '../query.js';
import type {CodeGraphQueryOptions, CodeGraphStatus} from '../types.js';
import {CodeGraphWatcher} from '../watcher.js';

type CodeGraphQueryServiceShape = Parameters<typeof CodeGraphQueryService.of>[0];

/** Resolve a shared read before any bounded foreground refresh is considered. */
export const resolveCodeGraphCliReadContinuity = Effect.fn('codeGraph.command.resolveReadContinuity')(function* (
  config: RuntimeConfig,
  service: CodeGraphQueryServiceShape,
  initialStatus: CodeGraphStatus,
  operation: CodeGraphQueryOptions['operation'],
  freshness: CodeGraphCliFreshnessPolicy,
) {
  let status = initialStatus;
  if (status.stale || !status.readySnapshot) {
    status = yield* service.attachSharedReadySnapshot(config.agentContextHome, status.identity, status, {
      allowBorrowedStale: freshness !== 'current' || (operation !== 'impact' && operation !== 'path'),
    });
  }
  const statusObservation = observationFromCodeGraphStatus(status);
  const borrowedContinuity = codeGraphCliUsesBorrowedContinuity(
    freshness,
    operation,
    status,
    statusObservation?.borrowedSnapshotId !== undefined,
  );
  let backgroundRefreshRegistered = false;
  if (borrowedContinuity) {
    const watcher = yield* CodeGraphWatcher;
    backgroundRefreshRegistered = yield* watcher
      .request({
        cwd: status.identity.repoRoot,
        key: status.identity.worktreeId,
        ...(statusObservation?.projectScope?.project === undefined
          ? {}
          : {project: statusObservation.projectScope.project}),
        threadnoteHome: config.agentContextHome,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
  }
  const readPlan = borrowedContinuity
    ? ({refresh: false, strictFreshness: false, unavailable: false} satisfies CodeGraphCliReadPlan)
    : codeGraphCliReadPlan(freshness, status);
  return {backgroundRefreshRegistered, borrowedContinuity, readPlan, status, statusObservation};
});
