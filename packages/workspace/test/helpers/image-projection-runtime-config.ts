import type {RuntimeConfig} from '@threadnote/workspace/config';

export function imageProjectionRuntimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/manifest.yaml`,
    user: 'tester',
  };
}
