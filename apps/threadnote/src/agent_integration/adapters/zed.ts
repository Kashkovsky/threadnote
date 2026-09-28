import {defineJsonAgentAdapter} from '../surfaces.js';

export const zedAdapter = defineJsonAgentAdapter('zed-native', {
  root: 'zed',
  xdg: true,
  windowsAppData: true,
  windowsRoot: 'Zed',
  mcpFile: 'settings.json',
  codec: 'jsonc',
  container: 'context_servers',
  instructionFile: 'AGENTS.md',
  skillRoot: 'shared',
});
