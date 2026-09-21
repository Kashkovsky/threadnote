import {defineJsonAgentAdapter} from '../surfaces.js';

export const continueAdapter = defineJsonAgentAdapter(
  'continue-project',
  {
    root: '.continue',
    defaultScope: 'project',
    mcpFile: 'mcpServers/threadnote.json',
    container: 'mcpServers',
    instructionFile: 'rules/threadnote.md',
    instructionPrefix: '---\nname: Threadnote\nalwaysApply: true\n---\n\n',
    instructionContent:
      'For non-trivial local repo work, call MCP `context_brief` with task + absolute `callerCwd` (`recall_context` + `read_context` is the memory-focused alternative). If MCP is unavailable, run `threadnote context brief --cwd <cwd> --task <task>`. Use `inspect_code_graph`/`analyze_code_graph`, then verify exact source. Repository instructions remain authoritative. End with required private `remember_context(kind=handoff)`. Optionally call `review_session_context` for a five-field Knowledge Delta, then `apply_memory_candidates` only after `approve` (optional `editedText`), `defer`, or `reject`. Never auto-apply or auto-share proposals; confirm durable sharing. Never store secrets, credentials, customer data, or raw production logs.',
    skillRoot: 'none',
  },
  {
    importDirectories: [{extensions: ['.md'], relativePath: '.continue/rules'}],
    importPaths: ['.continue/rules/threadnote-guidance.md', '.continue/rules/threadnote.md'],
    importWrappers: [
      {prefix: '---\nname: Threadnote guidance\nalwaysApply: true\n---\n\n', suffix: ''},
      {prefix: '---\nname: Threadnote\nalwaysApply: true\n---\n\n', suffix: ''},
    ],
    projection: {
      relativePath: '.continue/rules/threadnote-guidance.md',
      wrapper: {
        prefix: '---\nname: Threadnote guidance\nalwaysApply: true\n---\n\n',
        required: true,
        suffix: '',
      },
    },
  },
);
