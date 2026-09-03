import type {RuntimeConfig} from '../../src/types.js';

export function imageProjectionRuntimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/manifest.yaml`,
    user: 'tester',
  };
}
