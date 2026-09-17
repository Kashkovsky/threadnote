import {defineJsonAgentAdapter} from '../surfaces.js';

export const ampAdapter = defineJsonAgentAdapter(
  'amp-cli',
  {
    root: 'amp',
    xdg: true,
    mcpFile: 'settings.json',
    container: 'amp.mcpServers',
    instructionFile: 'AGENTS.md',
    skillRoot: 'shared',
  },
  {
    importMode: 'first-existing',
    importPaths: ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'],
    projection: {relativePath: 'AGENTS.md'},
  },
);
