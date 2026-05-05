# Migration

This guide explains how to switch a developer workflow to `threadnote` without losing the repo-local instruction
model that current agents rely on.

## Short Answer

Do not remove `AGENTS.md`, `CLAUDE.md`, `.claude/`, or `.agents/` as part of the migration.

Those files remain the versioned source of truth for repo-local behavior. OpenViking becomes a shared, searchable
context and memory layer on top of them. It helps agents recall handoffs, skills, and curated guidance across tools,
but it should not replace the files that fresh agents read directly from the working tree.

## Authority Model

- `AGENTS.md` and `CLAUDE.md`: canonical repo instructions. Keep these small, current, and checked in.
- Nested `AGENTS.md` and `CLAUDE.md`: canonical module-specific overrides. Keep them next to the code they govern.
- `.claude/commands` and `.claude/skills`: executable or tool-specific workflows. Keep them where Claude and other
  local tools can discover them.
- `.agents/`: agent/plugin metadata or repo-local automation config. Keep it unless the owning tool no longer uses it.
- OpenViking: durable memory, cross-agent handoffs, searchable snapshots of curated guidance, and seeded skill
  catalogs.

When these sources disagree, the checked-in repo instruction file wins. Update the source file first, then refresh the
OpenViking context.

## DX Model

Developers should not need to run `recall`, `remember`, or `handoff` as a normal habit.

The intended workflow has three layers:

- Agent-first: Codex, Claude, or another MCP-enabled agent calls OpenViking tools when the task calls for shared
  context.
- Short CLI fallback: humans and scripts can run `threadnote recall`, `threadnote remember`, or
  `threadnote handoff` from any repo.
- Checkout-local command: `npm run threadnote -- ...` is the bootstrap and debugging path before the short command shim
  is installed.

After MCP install, developers can use natural language:

```text
Recall the last handoff for this branch.
Remember that this repo uses <durable workflow fact>.
Create a handoff for the next agent before you stop.
```

For better continuity, add the agent-side guidance from `docs/agent-instructions.md` to the relevant `AGENTS.md` and
`CLAUDE.md` files. That guidance tells agents to recall context at task start, store durable memories when explicitly
asked or when a reusable workflow fact is learned, and create handoffs automatically before stopping meaningful work.

## Migration Steps

Run install commands from any working directory. Run manifest commands from a repo root, or pass explicit `--repo`
paths.

1. Check prerequisites:

   ```bash
   npm install --global threadnote
   threadnote doctor --dry-run
   ```

   Bun users can use `bun install --global threadnote`. Deno users can install the npm package with explicit
   permissions:

   ```bash
   deno install --global --name threadnote \
     --allow-read --allow-write --allow-run --allow-env --allow-net \
     npm:threadnote@latest
   ```

2. Install or repair local OpenViking. This also installs the short `threadnote` command shim to `~/.local/bin` by
   default:

   ```bash
   threadnote install --dry-run
   threadnote install
   ```

   If `threadnote` is not found after install, add `~/.local/bin` to `PATH` or rerun install with
   `THREADNOTE_BIN_DIR=<dir-on-path>`.

3. Create the developer-local manifest for the repos this machine actually uses:

   ```bash
   threadnote init-manifest --repo ~/src/my-service --repo ~/work/mobile-app
   ```

   `--repo` can be repeated. Paths may be anywhere on the machine. If no `--repo` is provided, the current git repo is
   used. The manifest is written to `~/.openviking/seed-manifest.yaml` by default and is intentionally not checked in.

4. Start the local service:

   ```bash
   threadnote start
   threadnote doctor --dry-run
   ```

5. Inspect curated repo imports:

   ```bash
   threadnote seed --dry-run
   ```

6. Seed curated repo guidance after reviewing the dry-run output:

   ```bash
   threadnote seed
   ```

7. Inspect and seed shared skills:

   ```bash
   threadnote seed-skills --dry-run
   threadnote seed-skills
   ```

8. Wire one agent at a time:

   ```bash
   threadnote mcp-install codex
   threadnote mcp-install codex --apply
   ```

   Then repeat for Claude:

   ```bash
   threadnote mcp-install claude
   threadnote mcp-install claude --apply
   ```

   Claude installs at user scope by default so it works from every repo/worktree. Use `--scope local` only when a
   repo-specific Claude MCP entry is intentional.

   Later, if the checkout that installed the MCP adapter is deleted or moved, repair it from any fresh checkout:

   ```bash
   threadnote repair
   ```

9. Validate recall:

   ```bash
   threadnote recall --query "repo testing guidance"
   ```

## Daily Workflow

At the start of a task, agents should still read the nearest `AGENTS.md` or `CLAUDE.md` files from the repo. OpenViking
is the cross-session layer.

Preferred developer behavior is conversational:

```text
Recall anything relevant for this branch before you start.
Remember this workflow note for future agents: ...
Create a handoff now.
```

Preferred agent behavior is automatic when the relevant instruction file includes `docs/agent-instructions.md`:

- On non-trivial task start, search OpenViking for recent handoffs and relevant repo guidance.
- When the user says "remember", store the memory after checking that it contains no secret or customer data.
- Before pausing, switching agents, or finishing meaningful code changes, store a concise handoff with status, tests,
  blockers, and next steps.

Manual CLI remains available for scripts and emergencies:

```bash
threadnote recall --query "last handoff for this branch"
threadnote remember --text "Durable engineering note..."
threadnote handoff --task "short task summary" --tests "checks run" --next-step "what the next agent should do"
```

## Repo Paths

The workflow is not tied to any fixed repo list. Repo discovery is manifest-driven:

- `~/.openviking/seed-manifest.yaml`: developer-local default manifest, created by `threadnote init-manifest`.
- `THREADNOTE_MANIFEST`: override for custom teams, experiments, or CI.
- `--manifest <path>`: one-off override for `seed` and `seed-skills`.
- `config/seed-manifest.example.yaml`: checked-in example only.

Use `threadnote init-manifest --repo <path>` whenever a developer adds a new repo they want included. The command
derives a stable `viking://resources/repos/<repo-name>` URI and keeps the seed patterns conservative.

## Refreshing Context

OpenViking stores imported context as durable resources. For v1, treat `seed` as a first-ingest operation. When a
seeded instruction file changes, update the checked-in source first, then refresh the relevant `viking://` resource.

Current practical options:

- Remove the old resource with `forget`, then re-run a scoped seed manifest.
- Use `remember` for short corrections that should be available immediately.
- Export/import packs only for moving a known-good local context between machines.

Do not edit OpenViking directly and leave the repo instruction file stale.

## What To Remove

Remove nothing during the initial migration.

After the workflow is proven, teams may delete or consolidate only content that has a clear owner-approved replacement.
Good candidates are stale handoff notes, obsolete duplicate docs, or abandoned per-agent experiments. Bad candidates are
canonical instructions, active commands, active skills, MCP config, or anything required by existing tools.

## Cutover Checklist

- `doctor --dry-run` reports a healthy OpenViking server.
- `threadnote` works from a different repo or subdirectory.
- `mcp-install` has been applied for the agent the developer actually uses.
- `recall` returns seeded guidance.
- A test `handoff` can be stored and recalled by another agent.
- `AGENTS.md` and `CLAUDE.md` still describe the source-of-truth repo rules.
- The team has agreed on which seeded paths are allowed and which sensitive paths stay excluded.
