import {cursorCloudScopeTeams, type CursorCloudMemoryScope} from '../../cursor/cloud.js';
import {syncSharedReposBeforeAgentRead} from '../../effect/share.js';
import type {RuntimeConfig} from './common.js';

export function syncCursorCloudMemoryShares(
  config: RuntimeConfig,
  memoryScope: CursorCloudMemoryScope | undefined,
  teamSelector?: string | readonly string[],
) {
  if (!memoryScope) return syncSharedReposBeforeAgentRead(config);
  const teams =
    teamSelector === undefined
      ? cursorCloudScopeTeams(memoryScope)
      : typeof teamSelector === 'string'
        ? [teamSelector]
        : teamSelector;
  return syncSharedReposBeforeAgentRead(config, teams);
}
