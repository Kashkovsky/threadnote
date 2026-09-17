import {defineJsonAgentAdapter} from '../surfaces.js';

export const clineAdapter = defineJsonAgentAdapter('cline', {
  root: '.cline',
  mcpRoot: 'data',
  mcpRootEnvironment: 'CLINE_DATA_DIR',
  mcpFile: 'settings/cline_mcp_settings.json',
  container: 'mcpServers',
  instructionFile: 'rules/threadnote.md',
  skillRoot: 'native',
});
