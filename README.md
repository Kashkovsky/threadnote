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
- **Durable and addressable.** Stable pointers let agents update one current `project/topic` instead of accumulating
  stale notes.
- **Built for engineering work.** Decisions, contracts, gotchas, release workflows, and current branch state have
  distinct lifecycles instead of becoming an undifferentiated chat summary.

## Threadnote vs Native AI Memory

Native memory is useful: ChatGPT, Gemini, and Claude can carry context across conversations. ChatGPT and Claude offer
shared projects, while Gemini can share Gems and chats. Those features keep continuity **inside their own product**.
Threadnote targets the boundary between products, machines, repositories, and users.

|                          | Threadnote                                                                       | Native chat memory                                                 | Vendor collaboration spaces                                               |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Primary job              | Share explicit engineering knowledge between users' coding agents                | Personalize future conversations from account history and settings | Keep a group's project, Gem, chats, files, or instructions in one product |
| Where agents can use it  | Codex, Claude Code, Cursor, and Copilot through one MCP workflow                 | Inside that provider's product and account                         | Inside that provider's shared project, Gem, or chat                       |
| Cross-vendor portability | Yes; teammates may use different supported agents                                | No common memory surface across vendors                            | No common memory surface across vendors                                   |
| Storage and audit        | Local Markdown plus a team Git repo you control                                  | Provider-managed memory, chats, and controls                       | Provider-hosted content and permissions                                   |
| Recall path              | Local semantic index returns scoped URI candidates; agents read selected records | Provider-managed retrieval from available context                  | Provider-managed search and context                                       |
| Curation and lifecycle   | Explicit `durable`, `handoff`, and `archived` records with stable URIs           | Provider-managed synthesis or retrieval from prior context         | Collaboration model varies by provider                                    |
| Privacy boundary         | Personal state local; only explicitly published durable knowledge travels        | Account/workspace controls                                         | Membership, links, and provider controls                                  |
| Best fit                 | Teams using multiple coding agents in real repositories and terminals            | Personal continuity in one assistant                               | Teams that standardize collaboration inside one AI product                |
| Tradeoff                 | Requires a local service, MCP setup, and a Git remote for team sharing           | Built in                                                           | Built in, often plan/workspace dependent                                  |

The comparison is based on current product documentation for
[ChatGPT memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq),
[ChatGPT shared projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt),
[Gemini memory](https://support.google.com/gemini/answer/16598469?hl=en),
[Gemini shared Gems](https://support.google.com/gemini/answer/16504957?hl=en),
[Claude personalization](https://support.anthropic.com/en/articles/10185728-understanding-claude-s-personalization-features),
and [Claude shared projects](https://support.anthropic.com/en/articles/9517075-what-are-projects). Availability varies
by product, plan, account, and region.

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
threadnote mcp-install claude --apply   # or codex / cursor / copilot
threadnote doctor --dry-run
```

The CLI remains Threadnote's complete execution surface. The default stdio adapter is a compact interoperability layer
with six core tools: `recall_context`, `read_context`, `list_context`, `remember_context`, `share_publish`, and
`threadnote_guide`. Advanced workflows can run through the CLI without reconfiguring MCP; install with `--toolset full`
only when the agent needs those workflows as MCP tools.

New to Threadnote? Ask your agent **"what can I do with Threadnote?"** — it calls the
`threadnote_guide` MCP tool, which returns a short walkthrough tailored to your setup
(server health, configured share teams, seeded projects) and offers to run each step
with you. The walkthrough only loads when you ask, so it never sits in context otherwise.

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
- **Share with teammates:** publish a curated durable memory or reusable skill to a team git repo.
- **Clean up overlap:** run `threadnote compact --project <repo> --topic <issue> --dry-run` before archiving stale
  handoffs or forgetting exact duplicates.

The adapter keeps the six core tools above as its default surface. `threadnote_guide` catalogs advanced categories and
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
