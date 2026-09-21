import {defineJsonAgentAdapter} from '../surfaces.js';

export const rooAdapter = defineJsonAgentAdapter(
  'roo-project',
  {
    root: '.roo',
    defaultScope: 'project',
    mcpFile: 'mcp.json',
    container: 'mcpServers',
    instructionFile: 'rules/threadnote.md',
    skillRoot: 'native',
  },
  {
    directoryFallbackPaths: ['.roorules'],
    importDirectories: [{extensions: ['.md', '.txt'], relativePath: '.roo/rules'}],
    importPaths: ['.roo/rules/threadnote.md', 'AGENTS.md'],
    projection: {
      activeFallbackBlocker: {
        inactiveWhenImportDirectoryHasFiles: true,
        reason: 'The active .roorules fallback must be migrated to .roo/rules/ before projection.',
        relativePath: '.roorules',
      },
      relativePath: '.roo/rules/threadnote.md',
    },
  },
);
