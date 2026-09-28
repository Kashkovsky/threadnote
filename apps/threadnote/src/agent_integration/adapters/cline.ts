import {defineJsonAgentAdapter} from '../surfaces.js';

export const clineAdapter = defineJsonAgentAdapter(
  'cline',
  {
    root: '.cline',
    mcpRoot: 'data',
    mcpRootEnvironment: 'CLINE_DATA_DIR',
    mcpFile: 'settings/cline_mcp_settings.json',
    container: 'mcpServers',
    instructionFile: 'rules/threadnote.md',
    skillRoot: 'native',
  },
  {
    directoryFallbackPaths: ['.clinerules'],
    importDirectories: [{extensions: ['.md', '.txt'], relativePath: '.clinerules'}],
    importPaths: ['.cursorrules', '.windsurfrules', 'AGENTS.md'],
    projection: {
      activeFallbackBlocker: {
        reason: 'The active single-file .clinerules layout must be migrated to .clinerules/ before projection.',
        relativePath: '.clinerules',
      },
      relativePath: '.clinerules/threadnote.md',
    },
  },
);
