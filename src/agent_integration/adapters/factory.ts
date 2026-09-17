import {defineJsonAgentAdapter} from '../surfaces.js';

export const factoryAdapter = defineJsonAgentAdapter('factory-droid', {
  root: '.factory',
  mcpFile: 'mcp.json',
  container: 'mcpServers',
  instructionFile: 'AGENTS.md',
  skillRoot: 'native',
  entryType: 'stdio',
});
