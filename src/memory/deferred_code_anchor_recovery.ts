import {Effect} from 'effect';
import type {RepositoryIdentity} from '../code_graph/types.js';
import type {RuntimeConfig} from '../types.js';
import {finalizeDeferredCodeAnchorsForRoute} from './deferred_code_anchor.js';

const AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 8;

/** Fail-soft product hook for an already-published exact repository graph. */
export const healAnchorsAfterGraphIndex = Effect.fn('memoryCodeAnchor.healAfterGraphIndex')(function* (
  config: RuntimeConfig,
  callerCwd: string,
  identity: Pick<RepositoryIdentity, 'repositoryId' | 'worktreeId'>,
) {
  yield* finalizeDeferredCodeAnchorsForRoute(
    config,
    {
      callerCwd,
      kind: 'repository',
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
    },
    {limit: AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT},
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
  yield* finalizeDeferredCodeAnchorsForRoute(
    config,
    {kind: 'workset', name},
    {limit: AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT},
  ).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.asVoid,
  );
});
