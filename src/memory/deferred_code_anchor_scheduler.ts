import {Context, Effect, Option} from 'effect';
import type {RuntimeConfig} from '../types.js';

export interface DeferredCodeAnchorRefreshSchedulerShape {
  readonly schedule: (options: {
    readonly cwd: string;
    readonly key: string;
    readonly threadnoteHome: string;
  }) => Effect.Effect<void>;
}

export class DeferredCodeAnchorRefreshScheduler extends Context.Service<
  DeferredCodeAnchorRefreshScheduler,
  DeferredCodeAnchorRefreshSchedulerShape
>()('threadnote/memory/deferred_code_anchor_scheduler/DeferredCodeAnchorRefreshScheduler') {}

export const scheduleDeferredCodeAnchorWorkspaceRefresh = Effect.fn('memoryCodeAnchor.scheduleWorkspaceRefresh')(
  function* (
    config: Pick<RuntimeConfig, 'agentContextHome'>,
    target: {readonly cwd: string; readonly worktreeId: string},
  ) {
    const scheduler = yield* Effect.serviceOption(DeferredCodeAnchorRefreshScheduler);
    if (Option.isNone(scheduler)) return;
    yield* scheduler.value.schedule({
      cwd: target.cwd,
      key: target.worktreeId,
      threadnoteHome: config.agentContextHome,
    });
  },
);
