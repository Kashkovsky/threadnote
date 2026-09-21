import {defineJsonAgentAdapter} from '../surfaces.js';

export const factoryAdapter = defineJsonAgentAdapter(
  'factory-droid',
  {
    root: '.factory',
    mcpFile: 'mcp.json',
    container: 'mcpServers',
    instructionFile: 'AGENTS.md',
    skillRoot: 'native',
    entryType: 'stdio',
  },
  {
    importMode: 'first-existing',
    importPaths: ['AGENTS.md', 'agents.md', 'Agents.md', 'CLAUDE.md', 'Claude.md'],
    maxProjectionCharacters: 80_000,
    projection: {relativePath: 'AGENTS.md'},
  },
);
