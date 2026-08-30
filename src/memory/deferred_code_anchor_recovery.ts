import {Effect} from 'effect';
import type {RepositoryIdentity} from '../code_graph/types.js';
import type {RuntimeConfig} from '../types.js';
import {withCodeAnchorFinalizationAnonymousTelemetry} from '../telemetry/code_anchor_finalization.js';
import {finalizeDeferredCodeAnchorsForRoute} from './deferred_code_anchor.js';

const AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 8;
// A first cold publication may need to open the graph, memory store, and recall
// invalidation boundary before it can commit the citation. Keep the ordinary
// Context Brief pass short, but give an explicit preparation command enough
// bounded time to complete the recovery it just made possible.
const AUTOMATIC_DEFERRED_CODE_ANCHOR_PASS_TIMEOUT_MILLISECONDS = 5_000;

/** Fail-soft product hook for an already-published exact repository graph. */
export const healAnchorsAfterGraphIndex = Effect.fn('memoryCodeAnchor.healAfterGraphIndex')(function* (
  config: RuntimeConfig,
  callerCwd: string,
  identity: Pick<RepositoryIdentity, 'repositoryId' | 'worktreeId'>,
) {
  yield* withCodeAnchorFinalizationAnonymousTelemetry(
    'graph-index',
    finalizeDeferredCodeAnchorsForRoute(
      config,
      {
        callerCwd,
        kind: 'repository',
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      },
      {
        limit: AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
        passTimeoutMilliseconds: AUTOMATIC_DEFERRED_CODE_ANCHOR_PASS_TIMEOUT_MILLISECONDS,
      },
    ),
  ).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.asVoid,
  );
});

/** Fail-soft product hook for an already-published ready Workset generation. */
export const healAnchorsAfterWorksetPrepare = Effect.fn('memoryCodeAnchor.healAfterWorksetPrepare')(function* (
  config: RuntimeConfig,
  name: string,
) {
  yield* withCodeAnchorFinalizationAnonymousTelemetry(
    'workset-prepare',
    finalizeDeferredCodeAnchorsForRoute(
      config,
      {kind: 'workset', name},
      {
        limit: AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
        passTimeoutMilliseconds: AUTOMATIC_DEFERRED_CODE_ANCHOR_PASS_TIMEOUT_MILLISECONDS,
      },
    ),
  ).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.asVoid,
  );
});
