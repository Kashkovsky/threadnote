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
  const readPlan = borrowedContinuity
    ? ({refresh: false, strictFreshness: false, unavailable: false} satisfies CodeGraphCliReadPlan)
    : codeGraphCliReadPlan(freshness, status);
  return {borrowedContinuity, readPlan, status, statusObservation};
});
