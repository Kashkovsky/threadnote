import {defineJsonAgentAdapter} from '../surfaces.js';

export const kiroAdapter = defineJsonAgentAdapter(
  'kiro-cli',
  {
    root: '.kiro',
    rootEnvironment: 'KIRO_HOME',
    mcpFile: 'settings/mcp.json',
    container: 'mcpServers',
    instructionFile: 'steering/threadnote.md',
    skillRoot: 'native',
  },
  {
    importDirectories: [{extensions: ['.md'], relativePath: '.kiro/steering'}],
    importPaths: ['.kiro/steering/threadnote.md', 'AGENTS.md'],
    projection: {relativePath: '.kiro/steering/threadnote.md'},
  },
);
