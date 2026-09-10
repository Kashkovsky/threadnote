import {Effect, Layer} from 'effect';
import {resolveRepositoryIdentity} from '../code_graph/repository.js';
import {CodeGraphWatcher} from '../code_graph/watcher.js';
import {succeedUndefined} from '../effect/optional.js';
import type {RuntimeConfig} from '../types.js';
import {listDeferredCodeAnchorIntents, type DeferredCodeAnchorIntentV1} from './deferred_code_anchor.js';
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
  identityByCwd: ReadonlyMap<string, {readonly repositoryId: string; readonly worktreeId: string} | undefined>,
): readonly DeferredCodeAnchorWorkspaceRefreshTarget[] {
  const seen = new Set<string>();
  const targets: DeferredCodeAnchorWorkspaceRefreshTarget[] = [];
  for (const intent of intents) {
    if (intent.recovery.preparation.target === 'workset') continue;
    const identity = identityByCwd.get(intent.callerCwd);
    if (
      identity === undefined ||
      identity.repositoryId !== intent.repositoryId ||
      identity.worktreeId !== intent.worktreeId
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

export const listDeferredCodeAnchorWorkspaceRefreshTargets = Effect.fn('memoryCodeAnchor.listWorkspaceRefreshTargets')(
  function* (config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>) {
    const intents = (yield* listDeferredCodeAnchorIntents(config)).flatMap(entry =>
      entry.kind === 'valid' ? [entry.intent] : [],
    );
    const identityByCwd = new Map<string, {readonly repositoryId: string; readonly worktreeId: string} | undefined>();
    for (const cwd of new Set(intents.map(intent => intent.callerCwd))) {
      identityByCwd.set(
        cwd,
        yield* resolveRepositoryIdentity(cwd).pipe(
          Effect.map(identity => ({repositoryId: identity.repositoryId, worktreeId: identity.worktreeId})),
          Effect.catch(() => succeedUndefined),
        ),
      );
    }
    return selectDeferredCodeAnchorWorkspaceRefreshTargets(intents, identityByCwd);
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
    const targets = yield* listDeferredCodeAnchorWorkspaceRefreshTargets(config);
    yield* Effect.forEach(
      targets,
      target => scheduleDeferredCodeAnchorWorkspaceRefresh(config, target).pipe(Effect.ignoreCause),
      {concurrency: 1},
    );
  },
);
