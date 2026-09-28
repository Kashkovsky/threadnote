import {defineJsonAgentAdapter} from '../surfaces.js';

export const antigravityCliAdapter = defineJsonAgentAdapter('antigravity-cli', {
  root: '.gemini',
  mcpFile: 'config/mcp_config.json',
  container: 'mcpServers',
  skillRoot: {user: '.gemini/antigravity-cli/skills', project: '.agents/skills'},
  skillLayout: 'flat',
});

export const antigravityIdeAdapter = defineJsonAgentAdapter('antigravity-ide', {
  root: '.gemini',
  mcpFile: 'config/mcp_config.json',
  container: 'mcpServers',
  instructionFile: 'GEMINI.md',
  skillRoot: {user: '.gemini/config/skills', project: '.agents/skills'},
});
