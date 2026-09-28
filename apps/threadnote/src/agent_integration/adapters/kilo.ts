import {defineJsonAgentAdapter} from '../surfaces.js';

export const kiloAdapter = defineJsonAgentAdapter('kilo', {
  root: 'kilo',
  xdg: true,
  mcpFile: 'kilo.jsonc',
  codec: 'jsonc',
  container: 'mcp',
  commandArray: true,
  entryType: 'local',
  skillRoot: {user: '.kilo/skills', project: '.kilo/skills'},
});
