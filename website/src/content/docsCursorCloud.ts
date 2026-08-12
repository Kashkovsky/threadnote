import type {DocsSection} from './docsTypes.js';

export const cursorCloudDocsSection: DocsSection = {
  id: 'cloud-agents',
  title: 'Cloud agents',
  description: 'Run Threadnote in disposable cloud environments without treating VM-local memory as durable.',
  articles: [
    {
      id: 'cursor-cloud-agents',
      title: 'Use Threadnote with Cursor Cloud Agents',
      summary:
        'Run Threadnote inside each Cursor cloud VM while a read-only Git share remains the only durable memory source.',
      keywords: [
        'Cursor Cloud Agents',
        'Cursor cloud MCP',
        'cloud agent memory',
        'ephemeral agent memory',
        'read-only shared memory',
        'Git memory share',
        'stdio MCP',
      ],
      body: [
        {
          type: 'warning',
          text: 'Full first-class Cursor Cloud Agents integration is in development. This preview is a manual, read-only setup: a checked-in instruction contract restricts memory reads to one shared namespace, and the Git share enforces that cloud agents cannot publish or push. The current core MCP profile still exposes VM-local write tools, so instruction-level scoping is required until the cloud-safe MCP profile ships.',
        },
        {
          type: 'paragraph',
          text: 'Cursor Cloud Agents run in isolated Ubuntu machines and support custom stdio MCP servers inside the VM. Threadnote can therefore run beside the checked-out repository for current-source graph work. Do not rely on ~/.threadnote memories created during a cloud run being available to a later run: treat the VM-local home as disposable and use a read-only Git-backed memory share as the only durable memory plane.',
        },
        {
          type: 'note',
          text: 'This guide uses the shared team name `cursor-cloud` and the stable Threadnote user `cursor-cloud`. Together they make the exclusive memory root `threadnote://user/cursor-cloud/memories/shared/cursor-cloud/` predictable in every VM.',
        },
        {
          type: 'heading',
          text: 'Before you start',
        },
        {
          type: 'list',
          items: [
            'Create a Git repository containing only reviewed durable Threadnote memories. Populate it from a trusted, persistent Threadnote installation using the [team sharing workflow](sharing-setup/).',
            'Give the cloud environment read-only Git credentials for that repository. Keep tokens and private keys in Cursor environment settings or the Git provider; never place them in the repository, MCP JSON, remote URL, or agent instructions.',
            'Use Cursor environment Builds for installation state. Build scripts should be idempotent, and saved Builds persist disk state rather than running processes.',
            'Add the cloud-only instruction block below to the repository guidance read by your agents, such as AGENTS.md. Repository files remain authoritative.',
          ],
        },
        {
          type: 'heading',
          text: '1. Install Threadnote in the cloud environment',
        },
        {
          type: 'paragraph',
          text: 'In the initial Cursor environment setup terminal or Build, install the standalone Linux release. `--no-start` avoids a readiness message; Threadnote does not need a daemon.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | \\
  sh -s -- --no-start

"$HOME/.local/bin/threadnote" doctor --dry-run`,
        },
        {
          type: 'heading',
          text: '2. Attach the memory share read-only',
        },
        {
          type: 'paragraph',
          text: 'Set `THREADNOTE_MEMORY_SHARE_URL` in the Cursor environment to the Git remote URL. Keep authentication separate from the URL. Run `share init` once while preparing the initial saved environment:',
        },
        {
          type: 'code',
          language: 'sh',
          code: `"$HOME/.local/bin/threadnote" share init "$THREADNOTE_MEMORY_SHARE_URL" \\
  --team cursor-cloud \\
  --read-only
"$HOME/.local/bin/threadnote" share sync --team cursor-cloud
"$HOME/.local/bin/threadnote" share status --team cursor-cloud`,
        },
        {
          type: 'paragraph',
          text: 'Save the successful Cursor Build after initialization. On a later build derived from that state, rerun the installer and `share sync`, but do not rerun `share init` for an already configured team. An idempotent cloud bootstrap command that safely handles both states is part of the integration in development.',
        },
        {
          type: 'note',
          text: 'Read-only is persistent. Threadnote may fetch, rebase a clean team worktree, ingest shared memories, recall them, report status, and install reviewed shared artifacts, but publication and pushes fail before mutation. Keep the Git hosting credential read-only as an independent boundary.',
        },
        {
          type: 'heading',
          text: '3. Register Threadnote as a cloud MCP server',
        },
        {
          type: 'paragraph',
          text: 'In Cursor Dashboard → Integrations & MCP, add a custom stdio server for the cloud environment. The shell wrapper expands the VM home before starting Threadnote:',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "type": "stdio",
  "command": "/bin/sh",
  "args": ["-lc", "exec \\"$HOME/.local/bin/threadnote\\" mcp-server"],
  "env": {
    "THREADNOTE_ACCOUNT": "local",
    "THREADNOTE_USER": "cursor-cloud",
    "THREADNOTE_AGENT_ID": "cursor-cloud",
    "THREADNOTE_MCP_TOOLSET": "core"
  }
}`,
        },
        {
          type: 'warning',
          text: 'Do not run `threadnote mcp-install cursor --apply` for this cloud setup. That command manages a user-specific local Cursor configuration under the VM home; Cursor Cloud MCP configuration is owned by the Dashboard integration.',
        },
        {
          type: 'paragraph',
          text: 'Cursor currently supports custom stdio and Streamable HTTP MCP transports for cloud agents. Threadnote uses stdio for this preview because its server runs inside the VM. See [Cursor Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities) and [Cursor MCP configuration](https://cursor.com/docs/mcp) for the current platform controls.',
        },
        {
          type: 'heading',
          text: '4. Make the share the exclusive memory scope',
        },
        {
          type: 'paragraph',
          text: 'Add this cloud-specific contract to the checked-in agent instructions. It keeps historical recall inside the read-only shared namespace while still allowing the run-local code graph to inspect the current checkout:',
        },
        {
          type: 'code',
          language: 'md',
          code: `## Cursor Cloud Threadnote contract

When running in Cursor Cloud, use Threadnote memory only below:
threadnote://user/cursor-cloud/memories/shared/cursor-cloud/

- At the start of non-trivial work, call recall_context with project,
  absolute callerCwd, and uri set to that exact shared root.
- Read only threadnote:// results below that root.
- Do not use context_brief for memory recall because it is not URI-scoped.
- Do not call remember_context, review_session_context,
  apply_memory_candidates, share_publish, or obsidian_publish.
- Treat ~/.threadnote outside the shared namespace as disposable VM state.
- Use inspect_code_graph and analyze_code_graph for current checkout evidence.
- Put any handoff needed by a later cloud run in the repository, pull request,
  or team task system until durable remote handoffs are supported.`,
        },
        {
          type: 'paragraph',
          text: 'The first recall in a task should use this MCP payload, changing only the task query, project, and checkout path:',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "query": "the task or decision to recover",
  "project": "your-project",
  "callerCwd": "/workspace/your-repository",
  "uri": "threadnote://user/cursor-cloud/memories/shared/cursor-cloud/"
}`,
        },
        {
          type: 'note',
          text: 'Read only the returned `threadnote://` records that remain below the shared root. A missing shared answer is a real no-answer; do not broaden the recall to personal, seeded, or other team namespaces.',
        },
        {
          type: 'heading',
          text: '5. Verify a new cloud run',
        },
        {
          type: 'list',
          items: [
            '`threadnote doctor --dry-run` reports a usable installation and no credential material.',
            '`threadnote share status --team cursor-cloud` reports `read-only`, a clean worktree, and the expected remote.',
            '`threadnote share sync --team cursor-cloud` fetches and ingests a newly published test memory.',
            'Cursor lists `recall_context`, `read_context`, `inspect_code_graph`, and `analyze_code_graph` from the MCP server.',
            'A scoped recall returns only URIs below `threadnote://user/cursor-cloud/memories/shared/cursor-cloud/`.',
            'A publication attempt fails at the read-only share boundary, and a later fresh VM can still recall the shared test memory.',
          ],
        },
        {
          type: 'heading',
          text: 'What persists',
        },
        {
          type: 'table',
          headers: ['State', 'Cloud contract'],
          rows: [
            [
              'Shared durable memories',
              'Persist in the read-only Git memory repository and are recalled by URI scope.',
            ],
            ['Personal memories and handoffs', 'VM-local only; do not use them for continuity between cloud runs.'],
            [
              'Code graph',
              'Derived inside the VM from the current checkout and dirty overlay; rebuildable, not durable memory.',
            ],
            [
              'Repository changes',
              'Persist through the normal branch, commit, pull request, and task-system workflow.',
            ],
            ['Secrets and Git credentials', 'Remain in Cursor or the Git provider and never enter Threadnote memory.'],
          ],
        },
        {
          type: 'heading',
          text: 'What the full integration will add',
        },
        {
          type: 'list',
          items: [
            'One idempotent Cursor Cloud bootstrap and configuration command.',
            'A capability-enforced read-only MCP profile that does not register memory write or publish tools.',
            'Cloud-aware doctor checks for identity, share access, URI scope, Git authentication, and MCP transport.',
            'A durable remote handoff path with explicit identity, authorization, conflict, and concurrency contracts.',
            'Automated clean-VM, resumed-Build, read-only enforcement, and multi-agent canary coverage.',
            'A future hybrid transport: local stdio for checkout-specific graph evidence and remote Streamable HTTP for durable shared memory.',
          ],
        },
      ],
    },
  ],
};
