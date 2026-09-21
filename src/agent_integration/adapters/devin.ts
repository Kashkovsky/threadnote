import {defineJsonAgentAdapter} from '../surfaces.js';

export const devinAdapter = defineJsonAgentAdapter(
  'devin-local',
  {
    root: 'devin',
    xdg: true,
    windowsAppData: true,
    projectRoot: '.devin',
    mcpFile: 'mcp_config.json',
    localMcpFile: 'mcp_config.local.json',
    container: 'mcpServers',
    instructionFile: 'AGENTS.md',
    projectInstructionFile: 'global_rules.md',
    skillRoot: 'native',
  },
  {
    importDirectories: [{extensions: ['.md'], relativePath: '.devin/rules'}],
    importPaths: ['.devin/global_rules.md', 'AGENTS.md', 'AGENT.md', 'CLAUDE.md', '.windsurfrules'],
    projection: {relativePath: '.devin/global_rules.md'},
  },
);
