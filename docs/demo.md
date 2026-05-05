# Demo: Cross-Agent Development Context

This demo shows `threadnote` as a shared local memory layer for engineering work. The story is intentionally simple:
one agent starts a task in a worktree, stores a handoff, and another agent or worktree recalls it without the
developer copy-pasting chat history, PR notes, or terminal output.

## Demo Goal

Show engineers that:

- repo instructions still live in `AGENTS.md`, `CLAUDE.md`, and checked-in docs;
- OpenViking adds durable, searchable context across agent sessions, worktrees, and repos;
- agents should use MCP directly, while `threadnote` is the human-readable fallback and diagnostic path;
- memories survive branch merges and worktree deletion because they live under the developer's OpenViking home, not in
  the git worktree;
- `repair` fixes the common stale-worktree and MCP launcher problems that show up during real local development.

## Use Case

Use "continue a PR after switching agents" as the live scenario.

The engineer has a PR that updates a local tool. Codex has already done some work and creates a handoff. The engineer
opens Claude, or a fresh Codex session from another repo/worktree, and asks it to continue. The new agent
recalls the handoff, reads the relevant `viking://` memory, discovers repo guidance, and stores an updated handoff when
it finishes.

This is the highest-signal demo because it exercises the behavior engineers actually feel every day: context transfer,
stale local setup, and "what did the previous agent already learn?"

## Prep Checklist

Run these before the meeting from this checkout:

```bash
npm install
npm run doctor -- --dry-run
npm run threadnote -- install
threadnote start
threadnote doctor --dry-run
threadnote init-manifest --repo "$(pwd)"
threadnote seed --dry-run
threadnote seed
threadnote seed-skills --dry-run
threadnote seed-skills
threadnote mcp-install codex --apply
threadnote mcp-install claude --apply
```

Open a fresh Codex or Claude session after installing MCP. Existing sessions may not pick up newly registered MCP
servers.

Optional: create a deterministic demo handoff so the search result is easy to find.

```bash
threadnote handoff \
  --task "Demo PR: continue the threadnote rollout after adding repair and docs" \
  --tests "doctor --dry-run, mcp-install dry runs, local TypeScript checks" \
  --next-step "Recall this handoff, read the most relevant viking URI, then summarize what changed and what to do next"
```

## Live Script

### 1. Open With The Problem

Say:

```text
When we switch from one agent session to another, we usually lose the useful middle: what was tried, what failed, what
the branch is about, and what the next agent should avoid re-discovering. This tool gives agents a shared local context
layer without replacing repo instructions or indexing entire repos.
```

Show that the repo still has normal instructions:

```bash
ls AGENTS.md CLAUDE.md
```

### 2. Show Local Health

Run:

```bash
threadnote doctor --dry-run
threadnote start
```

Say:

```text
The server is local. The default is 127.0.0.1:1933, so it does not conflict with apps running on localhost:80 or
localhost:443. If the exact port is taken, we can set THREADNOTE_PORT.
```

### 3. Show MCP Is Installed

Run the client-specific check you want to demo:

```bash
codex mcp list
claude mcp list
```

Say:

```text
MCP is the expected agent path. The CLI exists so humans can inspect, repair, and reproduce what the agent is doing.
Claude installs at user scope by default, so it works from other repos and worktrees.
```

If the MCP server does not appear in an already-open agent session, restart that session after `mcp-install --apply`.

### 4. Recall The Previous Handoff

In the agent UI, ask:

```text
Before touching code, recall recent OpenViking context for this branch and read the most relevant handoff.
```

For a terminal fallback, run:

```bash
threadnote recall --query "last handoff for threadnote rollout"
```

Point out that recall returns candidate `viking://` URIs and abstracts. Then read the best match:

```bash
threadnote read "<paste the most relevant viking:// URI>"
```

Say:

```text
Search is intentionally a pointer step. The agent should read or list the selected URI before treating it as context.
That keeps recall cheap and makes the result auditable.
```

### 5. Discover Repo Guidance

Ask the agent:

```text
Find any repo guidance or skills that matter for this task before you continue.
```

Terminal fallback:

```bash
threadnote recall --query "repo agent instructions testing guidance"
threadnote recall --query "skills for this repo"
```

Say:

```text
This is not source navigation. It is a curated catalog of instructions, skills, and durable notes that helps the agent
start in the right neighborhood.
```

### 6. Show Cross-Repo Or Cross-Worktree Continuity

Switch to another repo or worktree and run the same recall:

```bash
cd ~/work/another-repo
threadnote recall --query "last handoff for threadnote rollout"
```

Or ask a fresh Claude session from another repo:

```text
Use OpenViking to recall the latest handoff for the threadnote rollout and summarize the next step.
```

Say:

```text
The repo list is developer-local and manifest-driven. Nothing assumes a fixed source path. Memories are stored in the
local OpenViking home, so deleting a worktree removes launcher paths, not the remembered handoff.
```

### 7. Remember A Durable Fact

Ask the agent:

```text
Remember this workflow fact: threadnote MCP for Claude should be installed at user scope so it works from any repo or
worktree.
```

Terminal fallback:

```bash
threadnote remember \
  --text "Workflow fact: install Claude OpenViking MCP at user scope so it works from any repo or worktree."
```

Say:

```text
The rule is: remember durable workflow facts, not secrets, customer data, raw logs, or long diffs. Canonical repo rules
should still be checked in.
```

### 8. Create The Next Handoff

Ask the agent:

```text
Create a handoff for the next agent with the current status, tests run, blockers, and next step.
```

Terminal fallback:

```bash
threadnote handoff \
  --task "Demo: verified cross-agent recall for the threadnote rollout" \
  --tests "doctor --dry-run, recall, read, remember, handoff" \
  --next-step "Open a fresh agent session and ask it to recall this handoff before continuing"
```

Say:

```text
This is the part we want agents to do automatically before pausing or finishing meaningful code changes.
```

### 9. Show Repair

Run:

```bash
threadnote repair --dry-run
```

Say:

```text
This catches the ugly local cases: stale command shims, MCP launchers pointing at deleted worktrees, missing manifests,
and a stopped local server. Repair rewrites paths from the current checkout.
```

### 10. Close

Say:

```text
The important design choice is that this does not replace the repo. It makes the useful working memory around the repo
available to whichever agent session picks up the task next.
```

## Expected Signals

- `doctor --dry-run` reports no failures or prints concrete repair steps.
- `recall` returns `memory`, `resource`, or `skill` rows with `viking://` URIs.
- `read` turns a selected URI into actual handoff or memory content.
- A fresh agent session can use the OpenViking MCP tools after MCP install.
- `repair --dry-run` explains what it would fix without mutating anything.

## Recovery Branches

- MCP is installed but the current agent says no OpenViking tools are registered: open a fresh agent session.
- `claude mcp list` does not show OpenViking: run `threadnote mcp-install claude --apply`; the default scope is
  `user`.
- `/health` is OK but `/mcp` fails: this is expected for OpenViking `0.3.12`; use the default stdio adapter instead of
  `--native-http`.
- The old checkout or worktree was deleted: run
  `npm run threadnote -- repair` from any fresh checkout.
- Recall returns only overview nodes: read the URI, or list the directory with
  `threadnote list <uri> --all --recursive`.

## What Not To Demo

- Do not seed an entire repo.
- Do not store secrets, tokens, customer data, raw production logs, or long diffs.
- Do not present CLI commands as the ideal daily workflow. For normal work, the developer should ask the agent in
  natural language and the agent should use MCP directly.
