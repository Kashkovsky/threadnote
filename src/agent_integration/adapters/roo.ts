import {defineJsonAgentAdapter} from '../surfaces.js';

export const rooAdapter = defineJsonAgentAdapter('roo-project', {
  root: '.roo',
  defaultScope: 'project',
  mcpFile: 'mcp.json',
  container: 'mcpServers',
  instructionFile: 'rules/threadnote.md',
  skillRoot: 'native',
});
