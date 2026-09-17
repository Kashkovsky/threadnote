import {defineJsonAgentAdapter} from '../surfaces.js';

export const geminiAdapter = defineJsonAgentAdapter('gemini-cli', {
  root: '.gemini',
  mcpFile: 'settings.json',
  container: 'mcpServers',
  instructionFile: 'GEMINI.md',
  skillRoot: 'native',
  unverifiedPolicyFile: 'mcp-server-enablement.json',
});
