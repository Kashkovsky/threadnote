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
        'Use the Threadnote 4.2 beta profile inside each Cursor cloud VM while one writable Git share remains its durable memory plane.',
      keywords: [
        'Threadnote 4.2',
        'Cursor Cloud Agents',
        'Cursor cloud MCP',
        'cloud agent memory',
        'ephemeral agent memory',
        'writable shared memory',
        'Git memory share',
        'stdio MCP',
      ],
      body: [
        {
          type: 'note',
          text: 'Available in [Threadnote 4.2](https://github.com/Kashkovsky/threadnote/releases/tag/v4.2.0) as a beta integration. The released capability-enforced cloud profile uses a local stdio MCP server, an idempotent bootstrap command, and one writable Git-backed memory share. Durable memories are committed and pushed; local handoffs remain transient.',
        },
        {
          type: 'warning',
          text: 'The managed first-class integration is still in development. Threadnote 4.2 does not yet include managed remote memory, provider-backed workload authorization, durable cross-session handoffs, or the complete cloud canary program.',
        },
        {
          type: 'paragraph',
          text: 'The released 4.2 profile runs beside the checked-out repository in each isolated Cursor Cloud Ubuntu VM. It uses custom stdio MCP for current-source graph work and scopes historical context to the configured share. Do not rely on ~/.threadnote memories being available to a later run: use the designated writable Git-backed share for durable memory, and treat local handoffs as workspace-local coordination.',
        },
        {
          type: 'note',
          text: 'This guide uses the shared team name `cursor-cloud` and the stable Threadnote user `cursor-cloud`. Together they make the exclusive memory root `threadnote://user/cursor-cloud/memories/shared/cursor-cloud/` predictable in every VM.',
        },
        {type: 'heading', text: 'Choose the environment scope'},
        {
          type: 'paragraph',
          text: 'MCP registration scope and cloud-VM provisioning are independent. A personal MCP registration controls who can enable the server, but Threadnote 4.2 uses stdio, so `$HOME/.local/bin/threadnote-mcp-server` and the bootstrapped `$HOME/.threadnote` state must already exist inside the selected cloud environment. A local `threadnote: ready` result does not verify either path in a cloud VM.',
        },
        {
          type: 'paragraph',
          text: 'Cursor resolves an environment for a repository or repository group in this order: checked-in `.cursor/environment.json`, a personal saved environment, then a team saved environment. To add Threadnote for one user without changing the team environment, create a personal saved environment for the same repository or repository group. Treat it as a complete override rather than an overlay: preserve the project toolchain and setup from the team environment, then add Threadnote. A checked-in `.cursor/environment.json` still wins. See [Cursor Cloud Environment Setup](https://cursor.com/docs/cloud-agent/setup) for the current resolution contract.',
        },
        {
          type: 'note',
          text: 'Cursor CLI `&` handoff has no documented environment or Build selector. It uses the authenticated user and repository to resolve the environment automatically. For explicit testing, start an agent from a specific Build in the Cloud Agents Dashboard; the [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints) can create a new agent in a named environment, but that does not continue the existing CLI conversation. See [Cursor CLI handoff](https://cursor.com/docs/cli/using) for the documented handoff surface.',
        },
        {type: 'heading', text: 'Before you start'},
        {
          type: 'list',
          items: [
            'Create a dedicated Git repository for durable Threadnote memories. You can seed it from a trusted, persistent Threadnote installation using the [team sharing workflow](sharing-setup/).',
            'Give the cloud environment narrowly scoped read/write Git credentials for that repository. Keep tokens and private keys in Cursor environment settings or the Git provider; never place them in the repository, MCP JSON, remote URL, or agent instructions.',
            "Use Cursor environment Builds for installation state. Put Threadnote installation and share bootstrap in the personal environment's idempotent `install` command. Both must write below the same `$HOME` that the stdio MCP uses; print it during the Build and first agent run to verify the boundary. Saved Builds persist disk state rather than running processes.",
            'Add the cloud-only instruction block below to the repository guidance read by your agents, such as AGENTS.md. Repository files remain authoritative.',
          ],
        },
        {type: 'heading', text: '1. Install or update to Threadnote 4.2'},
        {
          type: 'paragraph',
          text: 'For an existing standalone installation, upgrade on the stable channel and confirm that the active release is 4.2:',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote update
threadnote version`,
        },
        {
          type: 'paragraph',
          text: "For a fresh Cursor environment, add the latest standalone Linux release installation to the personal environment's idempotent `install` command. You can prototype it in Cursor's guided setup terminal, but changes made in an ordinary agent VM do not prepare later Builds. `--no-start` avoids a readiness message; Threadnote does not need a daemon.",
        },
        {
          type: 'code',
          language: 'sh',
          code: `curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | \\
  sh -s -- --no-start

printf 'Threadnote Build HOME=%s\\n' "$HOME"
test -x "$HOME/.local/bin/threadnote-mcp-server"
"$HOME/.local/bin/threadnote" doctor --dry-run`,
        },
        {type: 'heading', text: '2. Bootstrap the exclusive memory share'},
        {
          type: 'paragraph',
          text: 'Set `THREADNOTE_MEMORY_SHARE_URL` in the Cursor environment to the credential-free Git remote URL. Keep authentication separate from the URL. The bootstrap command initializes a missing share, reuses an equivalent writable share, synchronizes it, and rejects conflicting remotes or access modes without mutation.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `"$HOME/.local/bin/threadnote" cloud cursor bootstrap \\
  --remote "$THREADNOTE_MEMORY_SHARE_URL" \\
  --team cursor-cloud \\
  --user cursor-cloud \\
  --agent-id cursor-cloud`,
        },
        {
          type: 'paragraph',
          text: 'Keep this bootstrap in the same personal-environment `install` command as the Threadnote installation. Trigger a Build, confirm it succeeds, and make that latest successful Build active before starting agents. It is safe to rerun the command in a later Build: exact configuration is reused, while a different remote or non-writable team fails closed for explicit review.',
        },
        {
          type: 'warning',
          text: 'Cursor makes team and environment-scoped secrets available during Builds, but adds user secrets only when an agent starts. If bootstrap needs Git credentials during the Build, use supported source-control access or a narrowly scoped environment secret. Keep the remote URL credential-free and never capture a token in the Build snapshot. See [Cloud Agent Builds](https://cursor.com/docs/cloud-agent/builds) for the current secret boundary.',
        },
        {
          type: 'note',
          text: 'The cloud profile writes only durable memories to this share. Each successful durable `remember_context` call updates canonical storage, commits the matching Git path, and pushes it. A `kind=handoff` write stays local and may disappear with the cloud workspace.',
        },
        {type: 'heading', text: '3. Register Threadnote as a cloud MCP server'},
        {
          type: 'paragraph',
          text: 'Generate the Cursor-ready configuration below. For one user, add and enable it as a personal MCP server from the MCP dropdown at `cursor.com/agents`. Team admins can instead add a shared server under Dashboard → Integrations & MCP. Both scopes run the same stdio command inside the selected VM:',
        },
        {
          type: 'code',
          language: 'sh',
          code: `"$HOME/.local/bin/threadnote" cloud cursor config \\
  --team cursor-cloud \\
  --user cursor-cloud \\
  --agent-id cursor-cloud`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "type": "stdio",
  "command": "/bin/sh",
  "args": ["-lc", "exec \\"$HOME/.local/bin/threadnote-mcp-server\\""],
  "env": {
    "THREADNOTE_ACCOUNT": "local",
    "THREADNOTE_USER": "cursor-cloud",
    "THREADNOTE_AGENT_ID": "cursor-cloud",
    "THREADNOTE_CURSOR_CLOUD_TEAM": "cursor-cloud",
    "THREADNOTE_MCP_TOOLSET": "cursor-cloud"
  }
}`,
        },
        {
          type: 'paragraph',
          text: 'The stable `threadnote-mcp-server` launcher brokers the Dashboard-owned stdio session. After a standalone update activates a new runtime, the next MCP request uses that runtime without changing this configuration.',
        },
        {
          type: 'warning',
          text: 'Do not run `threadnote mcp-install cursor --apply` for this cloud setup. That command manages a local Cursor configuration under the current machine home; Cursor Cloud MCP configuration is owned by the personal or team integration at `cursor.com/agents`. Registration does not install the stdio executable in the cloud VM.',
        },
        {
          type: 'paragraph',
          text: 'Cursor currently supports custom stdio and Streamable HTTP MCP transports for cloud agents. Threadnote uses stdio because its server runs inside the VM. See [Cursor Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities) and [Cursor MCP configuration](https://cursor.com/docs/mcp) for current platform controls.',
        },
        {type: 'heading', text: '4. Use the cloud memory contract'},
        {
          type: 'paragraph',
          text: 'The cloud profile enforces this contract server-side. Add the concise version to checked-in agent instructions so agents also understand persistence and choose the right memory kind:',
        },
        {
          type: 'code',
          language: 'md',
          code: `## Cursor Cloud Threadnote contract

When running in Cursor Cloud, use durable Threadnote memory only below:
threadnote://user/cursor-cloud/memories/shared/cursor-cloud/

- At the start of non-trivial work, call recall_context with project and
  absolute callerCwd. The server injects the shared root.
- Read only threadnote:// results below that root.
- Store durable cross-session knowledge with remember_context kind=durable;
  Threadnote commits and pushes it to the designated share.
- Store run-local coordination with kind=handoff only when transient
  cloud-workspace durability is acceptable.
- Do not store incidents, preferences, smoke records, secrets, customer data,
  or raw production logs from the cloud profile.
- Use inspect_code_graph and analyze_code_graph for current checkout evidence.
- Named worksets, candidate review/apply, separate publishing, Obsidian,
  and memory maintenance are not available in this profile.`,
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
  "callerCwd": "/workspace/your-repository"
}`,
        },
        {
          type: 'note',
          text: 'The server injects the configured root and rejects attempts to broaden recall, list, read, or MCP resources access into personal, seeded, or other team namespaces.',
        },
        {type: 'heading', text: '5. Verify a new cloud run'},
        {
          type: 'paragraph',
          text: 'On the first run from the saved Build, verify the effective home, executable, bootstrap state, and Threadnote profile before relying on MCP discovery. The run page records the environment and Build used, so compare that provenance when a personal override unexpectedly falls back to a team environment.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `printf 'Cloud Agent HOME=%s\\n' "$HOME"
test -x "$HOME/.local/bin/threadnote-mcp-server"
test -d "$HOME/.threadnote"

"$HOME/.local/bin/threadnote" cloud cursor verify \\
  --team cursor-cloud \\
  --user cursor-cloud \\
  --agent-id cursor-cloud \\
  --cwd "$PWD"`,
        },
        {
          type: 'list',
          items: [
            'Verification reports the exclusive root, writable share, credential-free remote, worktree, gitdir, and absolute local graph checkout. A non-Linux development host is only a warning.',
            'Cursor lists exactly `recall_context`, `read_context`, `list_context`, `remember_context`, `inspect_code_graph`, `analyze_code_graph`, and `threadnote_guide`.',
            'Recall, list, read, and MCP resources access reject URIs outside `threadnote://user/cursor-cloud/memories/shared/cursor-cloud/`.',
            'A durable test memory is committed and pushed, then a fresh VM can recall it.',
            'A local handoff is stored with a transient-durability receipt and does not appear in the Git share.',
          ],
        },
        {type: 'heading', text: 'What persists'},
        {
          type: 'table',
          headers: ['State', 'Cloud contract'],
          rows: [
            [
              'Shared durable memories',
              'Committed and pushed to the designated Git memory repository; recalled through the exclusive URI scope.',
            ],
            [
              'Local handoffs',
              'VM-local only; useful for active-workspace coordination, not cross-session continuity.',
            ],
            ['Other personal memory kinds', 'Rejected by the cloud profile.'],
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
        {type: 'heading', text: 'Beyond 4.2: what the full integration will add'},
        {
          type: 'list',
          items: [
            'A managed remote memory transport that does not require a VM-local Git checkout.',
            "Cloud-provider identity and authorization beyond the 4.2 profile's stable user, agent, and team identifiers.",
            'A durable remote handoff path with explicit lifecycle and concurrency contracts.',
            'Automated clean-VM, resumed-Build, write-concurrency, and multi-agent canary coverage.',
            'A future hybrid transport: local stdio for checkout-specific graph evidence and remote Streamable HTTP for durable shared memory.',
          ],
        },
      ],
    },
  ],
};
