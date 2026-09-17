import {defineJsonAgentAdapter} from '../surfaces.js';

export const windsurfAdapter = defineJsonAgentAdapter('windsurf-legacy', {
  root: '.codeium/windsurf',
  mcpFile: 'mcp_config.json',
  container: 'mcpServers',
  instructionFile: 'memories/global_rules.md',
  skillRoot: 'native',
});
