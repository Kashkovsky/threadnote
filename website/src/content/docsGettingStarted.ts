import type {DocsArticle} from './docsTypes.js';

export const connectAgentDocsArticle: DocsArticle = {
  id: 'connect-an-agent',
  title: 'Connect a coding agent',
  summary: 'Prepare one repository, connect a supported agent, and verify that Threadnote is ready to help.',
  body: [
    {
      type: 'paragraph',
      text: 'Installing Threadnote adds the local `threadnote` command and its private data directory. It does not change any coding agent. The next step is to connect the agent you want to use and prepare the repository where you are working.',
    },
    {
      type: 'heading',
      text: 'Recommended for your first project: setup',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote agents list
# Preview everything Threadnote would change:
threadnote setup <surface>
# Apply the same plan:
threadnote setup <surface> --apply`,
    },
    {
      type: 'paragraph',
      text: 'A coding-agent environment is the editor, CLI, or hosted integration where an agent works; the catalog calls that declared integration a surface. Choose one from `threadnote agents list`, then run setup from the repository you want Threadnote to understand. The first command is a read-only preview; `--apply` performs that plan.',
    },
    {
      type: 'heading',
      text: 'What setup does',
    },
    {
      type: 'list',
      items: [
        'Finishes Threadnote’s local initialization if this is the first run.',
        'Adds the current repository to Threadnote’s local project configuration and loads its configured guidance.',
        'Connects the selected coding agent to Threadnote and installs the instructions, skills, and supported hooks declared for that agent.',
        'Builds a local code graph so the agent can trace symbols, dependencies, and affected code.',
        'Runs health checks.',
        'Produces a real Context Brief—a short, cited briefing about the current repository—to prove the connection works.',
      ],
    },
    {
      type: 'note',
      text: 'Setup is resumable. If it is interrupted, run the same command again. If everything is already current, it does nothing.',
    },
    {
      type: 'note',
      text: 'You do not need `--task` for setup. Threadnote uses a built-in repository-orientation task for its final verification brief. Add `--task "..."` only when you want to customize that one-time check; it does not start or configure later agent tasks.',
    },
    {
      type: 'heading',
      text: 'Why not install only the MCP connection?',
    },
    {
      type: 'paragraph',
      text: 'You can. `threadnote agents install` is the narrower command for adding or repairing Threadnote inside one agent. It installs that surface’s managed MCP connection, instructions, and skills. The older `threadnote mcp-install` shortcut remains available for Codex, Claude, Cursor, Copilot, and OMP. Neither command prepares the current repository, builds its code graph, runs all setup checks, or proves the result with a Context Brief.',
    },
    {
      type: 'table',
      headers: ['Command', 'Use it when', 'What you get'],
      rows: [
        [
          '`threadnote setup <surface> --apply`',
          'This is your first Threadnote project or you want the recommended end-to-end setup',
          'Agent connection, repository preparation, code graph, checks, and a verified Context Brief',
        ],
        [
          '`threadnote agents install <surface> --apply`',
          'Threadnote and the repository are already prepared, and you only need to connect another agent',
          'The agent’s managed MCP connection, Threadnote instructions, and skills',
        ],
        [
          '`threadnote mcp-install <agent> --apply`',
          'You use its Codex, Claude, Cursor, Copilot, or OMP compatibility shortcut',
          'The same managed connection for those five agents',
        ],
        [
          'A hand-written MCP entry',
          'You deliberately want to manage the integration yourself',
          'Tool access only; repository preparation and agent guidance remain your responsibility',
        ],
      ],
    },
    {
      type: 'code',
      language: 'sh',
      code: `# Connect only the selected agent:
threadnote agents install <surface> --apply

# Compatibility shortcut for Codex, Claude, Cursor, Copilot, or OMP:
threadnote mcp-install codex --apply
threadnote mcp-install codex --toolset full --apply`,
    },
    {
      type: 'paragraph',
      text: 'The MCP server runs locally as a child process of the agent. There is no Threadnote host, token, port, cloud account, or daemon to configure. Only the selected agent is changed. Restart it after installing or updating the integration.',
    },
    {
      type: 'heading',
      text: 'Undo setup-created changes',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote setup <surface> --undo
threadnote setup <surface> --undo --apply`,
    },
    {
      type: 'paragraph',
      text: 'Undo is preview-first too. It removes only unchanged files and settings that this setup created. It does not remove pre-existing configuration or local project data such as the code graph.',
    },
    {
      type: 'note',
      text: 'After restarting the agent, ask “What can I do with Threadnote?” for a short guided tour. The tour loads only when you ask for it.',
    },
    {
      type: 'note',
      text: 'For individual use, see [Personal Cursor Cloud setup](personal-cursor-cloud/): one personal stdio MCP can expose one or more private Git memory shares and bootstrap installs Cloud-specific Cursor skills.',
    },
  ],
};

export const firstWorkflowDocsArticle: DocsArticle = {
  id: 'first-workflow',
  title: 'Work one task with evidence',
  summary:
    'Let the connected agent load relevant context, verify exact local evidence, and close with reviewed knowledge.',
  body: [
    {
      type: 'heading',
      text: 'Start the task',
    },
    {
      type: 'list',
      items: [
        'Give the connected agent a normal engineering task. Its installed Threadnote instructions and skills automatically compile a Context Brief with the task, stable project, absolute callerCwd, and any known current-code anchors.',
        'Read selected `threadnote://` pointers before relying on them; a ranked pointer is not evidence by itself.',
        'Use exact files and `inspect_code_graph` for current-source claims. The graph is the current-code verification engine, and the local worktree wins over historical context.',
        'At meaningful closeout, the agent writes the required private handoff and, when the task produced reusable knowledge, presents an optional Knowledge Delta. Review it before any durable knowledge is applied.',
      ],
    },
    {
      type: 'heading',
      text: 'The manual CLI equivalent',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote context brief \\
  --task "Continue the mobile auth rollout" \\
  --project mobile \\
  --budget-tokens 1250
threadnote graph query --query "refresh token boundary"
threadnote handoff --project mobile --topic auth-rollout \\
  --task "Finish refresh-token rollout" \\
  --tests "bun test auth" \\
  --next-step "Update the iOS caller"`,
    },
    {
      type: 'paragraph',
      text: 'The installed agent skill normally creates this review at meaningful closeout. For scripting or troubleshooting, create the same review through the coding-agent integration; the result supplies the review ID and revision used by the following closeout preview.',
    },
    {
      type: 'code',
      language: 'json',
      code: `{
  "tool": "review_session_context",
  "arguments": {
    "task": "Finish refresh-token rollout",
    "outcome": "Completed the current task and recorded its checks.",
    "project": "mobile",
    "evidence": ["focused auth tests passed"]
  }
}`,
    },
    {
      type: 'code',
      language: 'sh',
      code: `# Copy review ID and revision from the review result.
threadnote closeout preview --review-id <review-id>`,
    },
    {
      type: 'note',
      text: 'Use a stable project/topic pair and replace the existing active record. Timestamped duplicates make currentness harder to judge and should be reserved for historical records.',
    },
  ],
};
