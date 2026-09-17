import {defineJsonAgentAdapter} from '../surfaces.js';

export const windsurfAdapter = defineJsonAgentAdapter(
  'windsurf-legacy',
  {
    root: '.codeium/windsurf',
    mcpFile: 'mcp_config.json',
    container: 'mcpServers',
    instructionFile: 'memories/global_rules.md',
    skillRoot: 'native',
  },
  {
    importPaths: ['.windsurf/rules/threadnote.md', 'AGENTS.md', '.windsurfrules'],
    importDirectories: [{extensions: ['.md'], relativePath: '.windsurf/rules'}],
    maxProjectionCharacters: 12_000,
    importWrappers: [{prefix: '---\ntrigger: always_on\n---\n\n', suffix: ''}],
    projection: {
      relativePath: '.windsurf/rules/threadnote.md',
      wrapper: {prefix: '---\ntrigger: always_on\n---\n\n', required: true, suffix: ''},
    },
  },
);
