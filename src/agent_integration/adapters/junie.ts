import {defineJsonAgentAdapter} from '../surfaces.js';

export const junieAdapter = defineJsonAgentAdapter('junie-cli', {
  root: '.junie',
  mcpFile: 'mcp/mcp.json',
  container: 'mcpServers',
  instructionFile: 'AGENTS.md',
  skillRoot: 'native',
});
