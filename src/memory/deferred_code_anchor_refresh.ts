import {Effect, Layer} from 'effect';
import {CodeGraphWatcher} from '../code_graph/watcher.js';
import type {RuntimeConfig} from '../types.js';
import {
  finalizeDeferredCodeAnchors,
  listDeferredCodeAnchorIntents,
  MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
  type DeferredCodeAnchorIntentV1,
} from './deferred_code_anchor.js';
import {
  observeDeferredCodeAnchorCallerCheckout,
  type DeferredCodeAnchorCallerCheckoutObservation,
} from './deferred_code_anchor_checkout.js';
import {
  DeferredCodeAnchorRefreshScheduler,
  scheduleDeferredCodeAnchorWorkspaceRefresh,
} from './deferred_code_anchor_scheduler.js';

export {
  DeferredCodeAnchorRefreshScheduler,
  scheduleDeferredCodeAnchorWorkspaceRefresh,
} from './deferred_code_anchor_scheduler.js';

export interface DeferredCodeAnchorWorkspaceRefreshTarget {
  readonly cwd: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

export function selectDeferredCodeAnchorWorkspaceRefreshTargets(
  intents: readonly DeferredCodeAnchorIntentV1[],
  observationByCwd: ReadonlyMap<string, DeferredCodeAnchorCallerCheckoutObservation>,
): readonly DeferredCodeAnchorWorkspaceRefreshTarget[] {
  const seen = new Set<string>();
  const targets: DeferredCodeAnchorWorkspaceRefreshTarget[] = [];
  for (const intent of intents) {
    if (intent.recovery.preparation.target === 'workset') continue;
    const observation = observationByCwd.get(intent.callerCwd);
    if (
      observation === undefined ||
      observation.state !== 'present' ||
      observation.repositoryId !== intent.repositoryId ||
      observation.worktreeId !== intent.worktreeId
    ) {
      continue;
    }
    if (seen.has(intent.worktreeId)) continue;
    seen.add(intent.worktreeId);
    targets.push({
      cwd: intent.callerCwd,
      repositoryId: intent.repositoryId,
      worktreeId: intent.worktreeId,
    });
  }
  return targets;
}

export function selectDeferredCodeAnchorMissingCheckoutIntents(
  intents: readonly DeferredCodeAnchorIntentV1[],
  observationByCwd: ReadonlyMap<string, DeferredCodeAnchorCallerCheckoutObservation>,
): readonly DeferredCodeAnchorIntentV1[] {
  return intents.filter(intent => observationByCwd.get(intent.callerCwd)?.state === 'missing');
}

const observeDeferredCodeAnchorCallerCheckouts = Effect.fn('memoryCodeAnchor.observeCallerCheckouts')(function* (
  intents: readonly DeferredCodeAnchorIntentV1[],
) {
  const observationByCwd = new Map<string, DeferredCodeAnchorCallerCheckoutObservation>();
  for (const cwd of new Set(intents.map(intent => intent.callerCwd))) {
    observationByCwd.set(cwd, yield* observeDeferredCodeAnchorCallerCheckout(cwd));
  }
  return observationByCwd;
});

export const listDeferredCodeAnchorWorkspaceRefreshTargets = Effect.fn('memoryCodeAnchor.listWorkspaceRefreshTargets')(
  function* (config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
    const intents = (yield* listDeferredCodeAnchorIntents(config)).flatMap(entry =>
      entry.kind === 'valid' ? [entry.intent] : [],
    );
    return selectDeferredCodeAnchorWorkspaceRefreshTargets(
      intents,
      yield* observeDeferredCodeAnchorCallerCheckouts(intents),
    );
  },
);

export const deferredCodeAnchorRefreshSchedulerLayer = Layer.effect(
  DeferredCodeAnchorRefreshScheduler,
  Effect.gen(function* () {
    const watcher = yield* CodeGraphWatcher;
    return DeferredCodeAnchorRefreshScheduler.of({
      schedule: options =>
        watcher
          .refresh({
            admissionClass: 'background',
            cwd: options.cwd,
            key: options.key,
            threadnoteHome: options.threadnoteHome,
          })
          .pipe(Effect.asVoid, Effect.ignoreCause),
    });
  }),
);

export const refreshPendingDeferredCodeAnchorWorkspaces = Effect.fn('memoryCodeAnchor.refreshPendingWorkspaces')(
  function* (config: RuntimeConfig) {
    const intents = (yield* listDeferredCodeAnchorIntents(config)).flatMap(entry =>
      entry.kind === 'valid' ? [entry.intent] : [],
    );
    const observationByCwd = yield* observeDeferredCodeAnchorCallerCheckouts(intents);
    const missingUris = [
      ...new Set(
        selectDeferredCodeAnchorMissingCheckoutIntents(intents, observationByCwd).map(intent => intent.memoryUri),
      ),
    ];
    if (missingUris.length > 0) {
      yield* finalizeDeferredCodeAnchors(config, {
        limit: Math.min(missingUris.length, MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT),
        uris: missingUris,
      }).pipe(Effect.ignoreCause);
    }
    yield* Effect.forEach(
      selectDeferredCodeAnchorWorkspaceRefreshTargets(intents, observationByCwd),
      target => scheduleDeferredCodeAnchorWorkspaceRefresh(config, target).pipe(Effect.ignoreCause),
      {concurrency: 1},
    );
  },
);
