import {defineJsonAgentAdapter} from '../surfaces.js';

export const continueAdapter = defineJsonAgentAdapter('continue-project', {
  root: '.continue',
  defaultScope: 'project',
  mcpFile: 'mcpServers/threadnote.json',
  container: 'mcpServers',
  instructionFile: 'rules/threadnote.md',
  instructionPrefix: '---\nname: Threadnote\nalwaysApply: true\n---\n\n',
  instructionContent:
    'Use Threadnote MCP for non-trivial work: recall_context with the project and absolute callerCwd, then read useful threadnote:// pointers with read_context. Inspect the code graph before broad source search. Repository instructions remain authoritative. Store a concise handoff before ending meaningful work. Never store secrets, credentials, customer data or raw production logs. Confirm with the user before publishing durable memory.',
  skillRoot: 'none',
});
