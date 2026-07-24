<p align="center">
  <img src="./docs/threadnote-logo.svg" alt="Threadnote logo" width="200">
</p>

# Threadnote

[![npm version](https://img.shields.io/npm/v/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![CI](https://img.shields.io/github/actions/workflow/status/Kashkovsky/threadnote/ci.yml?branch=main&label=CI)](https://github.com/Kashkovsky/threadnote/actions/workflows/ci.yml) [![npm downloads](https://img.shields.io/npm/dm/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![license](https://img.shields.io/npm/l/threadnote.svg)](./LICENSE) ![node version](https://img.shields.io/node/v/threadnote.svg)

> One engineer teaches it once. Every teammate's coding agent can use it.

Threadnote is a shared, Git-backed memory layer for the coding agents your team already uses. Alice's Codex can publish
a hard-won architecture decision; Bob's Claude Code, Cursor, or Copilot can auto-sync and recall it during the next
task. No copy-pasted handoff, vendor lock-in, or shared chat window required.

Personal working state stays local. Only curated durable knowledge or reusable artifacts that you explicitly publish
enter the team's memory repo, with a preview, secret scrubber, and Git history. Persistence across sessions still
matters, but it is the foundation: the differentiator is useful context moving safely between **different users and
different agents**.

**Walkthrough:** https://kashkovsky.github.io/threadnote/  
**Wiki:** https://github.com/Kashkovsky/threadnote/wiki

## The Value in One Screen

```text
Alice + Codex ──publish curated memory──▶ team Git repo
                                              │
                                      auto-sync on recall
                                              ▼
                              Bob + Claude Code / Cursor / Copilot
```

- **Cross-user and cross-agent.** Teammates can use one shared knowledge layer without standardizing on one AI vendor.
- **Explicit, reviewable sharing.** Publish one durable memory or reusable skill; preview and scrub it before it lands
  in Git.
- **Private by default.** Personal handoffs, preferences, incidents, and unpublished memories stay on the local
  machine.
- **Targeted local recall.** OpenViking runs a local GGUF embedding model through `llama.cpp` to rank semantic matches;
  agents load selected `viking://` records instead of replaying the entire memory history.
- **Optional local query expansion.** `threadnote local-ai install` can add a pinned, verified Gemma model that helps
  weak and medium-confidence paraphrase recalls while deterministic retrieval remains in control.
- **Recall explains itself.** Semantic and BM25 relevance, fields, graph links, currentness, authority, and bounded
  feedback produce a confidence level and inspectable ranking reasons.
- **Routine continuity is automatic.** At meaningful task closeout, the agent writes normal durable feature knowledge
  and handoffs directly. It proposes only additional extracted candidates and writes those after user approval.
- **Durable and addressable.** Stable pointers let agents update one current `project/topic` instead of accumulating
  stale notes.
- **Built for engineering work.** Decisions, contracts, gotchas, release workflows, and current branch state have
  distinct lifecycles instead of becoming an undifferentiated chat summary.


## Quickstart

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
threadnote mcp-install claude --apply   # or codex / cursor / copilot
threadnote doctor --dry-run
```

Native Windows PowerShell (experimental):

```powershell
irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1 | iex
threadnote mcp-install codex --apply    # or claude / cursor / copilot
threadnote doctor --dry-run
```

Native Windows support is experimental, and the PowerShell installer currently installs Threadnote from npm's `beta`
channel by default. It uses npm's native `threadnote.cmd` launcher and installs OpenViking through `uv`; it does not
require WSL, Git Bash, or a POSIX shim. Node.js 22.19 or newer is required on every platform. The manual native flow is
`npm install --global threadnote@beta` followed by `threadnote install`.

The CLI remains Threadnote's complete execution surface. The default stdio adapter is a compact interoperability layer
with eight core tools: `recall_context`, `read_context`, `list_context`, `remember_context`,
`review_session_context`, `apply_memory_candidates`, `share_publish`, and `threadnote_guide`. Advanced workflows can
run through the CLI without reconfiguring MCP; install with `--toolset full` only when the agent needs those workflows
as MCP tools.

New to Threadnote? Ask your agent **"what can I do with Threadnote?"** — it calls the
`threadnote_guide` MCP tool, which returns a short walkthrough tailored to your setup
(server health, configured share teams, seeded projects) and offers to run each step
with you. The walkthrough only loads when you ask, so it never sits in context otherwise.

## Updates

```bash
threadnote update         # latest stable release
threadnote update --beta  # latest beta release
```

Stable installs only report and install stable releases. After opting into a beta, ordinary `threadnote version` and
`threadnote update` calls stay on the beta channel until a stable Threadnote version is installed again.

## Why Not Just Markdown Files?

Use Markdown files. Threadnote makes them operational.

- **`AGENTS.md` / `CLAUDE.md` / repo docs:** stable, reviewed, version-controlled rules.
- **Random notes:** easy to write, hard for agents to rank, scope, update, or know when stale.
- **Threadnote memories:** Markdown on disk plus semantic recall, stable URIs, lifecycle (`durable`, `handoff`,
  `archived`), scoped compaction, MCP tools, and safe team sharing.

The source of truth is still local files. The benefit is that agents know how to find the right file, decide whether it
is current, update it without creating duplicates, and safely move the useful part into a teammate's agent.
The default semantic index is built locally with a GGUF embedding model through `llama.cpp`, so recall can rank
relevant records without sending the memory corpus to a hosted embedding service.

## Agent Perspective

These are workflow examples from an agent's point of view:

**Codex before Threadnote:** "I inspect the repo, ask what changed, rediscover the test command, and hope the compacted
chat summary did not drop the important caveat."

**Codex with Threadnote:** "I recall the branch handoff and durable feature memory first. I can name the files touched,
the last failing check, the design decision behind the code, and the next step before editing."

**Claude Code before Threadnote:** "A long debugging thread compacts into a vague narrative. The next turn knows the arc,
but not the exact command, blocker, or decision."

**Claude Code with Threadnote:** "The pre-compact handoff captures the concrete state. The next session reads the same
memory and continues without asking the user to reconstruct it."

## Real-World Uses

- **Share a team decision:** Alice publishes an API contract; Bob's different agent auto-syncs it on its next recall.
- **Continue a branch:** "Continue where we left off" -> agent recalls the active handoff and durable feature memory.
- **Switch agents:** "Save where we are" -> agent stores a handoff the next MCP-enabled agent can read.
- **Survive compaction:** Claude Code's hook can snapshot a handoff before compaction; other agents can recall it later.
- **Remember a repo fact:** "This repo cuts release notes from CI" -> agent stores a durable workflow memory.
- **Review additional context from a task:** after storing the normal durable memory and handoff, the agent proposes up
  to three extra candidates; approve, edit, defer, or reject them in the same conversation.
- **Share with teammates:** publish a curated durable memory or reusable skill to a team git repo.
- **Clean up overlap:** run `threadnote compact --project <repo> --topic <issue> --dry-run` before archiving stale
  handoffs or forgetting exact duplicates.

The adapter keeps the eight core tools above as its default surface. `threadnote_guide` catalogs advanced categories and
their CLI equivalents without loading their schemas into every agent session. Pass `--toolset full` to `mcp-install`
to expose compatibility aliases, memory maintenance, advanced sharing/artifact tools, and raw OpenViking parity tools
with `ov_*` names.

## Development

Threadnote's infrastructure and orchestration run on Effect 4 beta, including typed command/HTTP failures, scoped
resources, deterministic polling and retries, Effect Schema MCP inputs, and optional structured Effect AI
consolidation. See [`docs/effect.md`](./docs/effect.md) for boundaries, opt-in configuration, parity gates, and the beta
upgrade procedure. See [`CONTRIBUTION.md`](./CONTRIBUTION.md) for development setup, validation requirements, and pull
request guidance.

## Acknowledgments

Threadnote is a workflow layer over [OpenViking](https://openviking.ai/) (AGPL-3.0).
It installs OpenViking on your machine (via `uv tool install openviking[local-embed]`) and runs it as a **separate program** —
shelling out to the `ov` CLI and talking to `openviking-server` over MCP. Threadnote does **not** bundle, modify, or
redistribute OpenViking; its source and license reach you independently through PyPI. Threadnote's own license covers
only Threadnote's code.

See [`THIRD_PARTY.md`](./THIRD_PARTY.md) for the full attribution.

## License

Threadnote is licensed under [AGPL-3.0-or-later](./LICENSE).
