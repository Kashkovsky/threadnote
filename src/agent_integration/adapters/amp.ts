import {defineJsonAgentAdapter} from '../surfaces.js';

export const ampAdapter = defineJsonAgentAdapter('amp-cli', {
  root: 'amp',
  xdg: true,
  mcpFile: 'settings.json',
  container: 'amp.mcpServers',
  instructionFile: 'AGENTS.md',
  skillRoot: 'shared',
});
