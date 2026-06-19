<p align="center">
  <img src="./docs/threadnote-logo.svg" alt="Threadnote logo" width="200">
</p>

# Threadnote

[![npm version](https://img.shields.io/npm/v/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![CI](https://img.shields.io/github/actions/workflow/status/Kashkovsky/threadnote/ci.yml?branch=main&label=CI)](https://github.com/Kashkovsky/threadnote/actions/workflows/ci.yml) [![npm downloads](https://img.shields.io/npm/dm/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![license](https://img.shields.io/npm/l/threadnote.svg)](./LICENSE) ![node version](https://img.shields.io/node/v/threadnote.svg)

> Stop re-explaining your project to every AI coding agent.

`threadnote` gives Codex, Claude Code, Cursor, and Copilot one shared local memory for development work: durable
decisions, current handoffs, seeded repo docs, reusable skills, and curated team knowledge.

It is not a bigger prompt, and it is not just an auto-compacter. It is a workflow around Markdown-backed local memory:
agents recall the relevant `viking://` pointers, read only what they need, update one stable `project/topic` record, and
leave your canonical repo docs alone.

**Walkthrough:** https://kashkovsky.github.io/threadnote/  
**Wiki:** https://github.com/Kashkovsky/threadnote/wiki

## Why Engineers Use It

- **Fresh agents start with recall, not amnesia.** A new session can read the latest handoff before touching code.
- **Compaction becomes a checkpoint, not memory loss.** Durable facts and current status survive the summary.
- **Agent switching stops resetting the task.** Codex can leave a handoff that Claude Code, Cursor, or Copilot can read.
- **Repo docs stay clean.** `AGENTS.md`, `CLAUDE.md`, and docs remain stable policy; Threadnote carries living context.
- **Team context is explicit.** Publish only curated durable memories to a team git repo; personal handoffs stay local.

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
threadnote mcp-install claude --apply   # or codex / cursor / copilot
threadnote doctor --dry-run
```

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
is current, update it without creating duplicates, and hand it to the next agent.

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

- **Continue a branch:** "Continue where we left off" -> agent recalls the active handoff and durable feature memory.
- **Switch agents:** "Save where we are" -> agent stores a handoff the next MCP-enabled agent can read.
- **Survive compaction:** Claude Code's hook can snapshot a handoff before compaction; other agents can recall it later.
- **Remember a repo fact:** "This repo cuts release notes from CI" -> agent stores a durable workflow memory.
- **Share with teammates:** publish a curated durable memory or reusable skill to a team git repo.
- **Clean up overlap:** run `threadnote compact --project <repo> --topic <issue> --dry-run` before archiving stale
  handoffs or forgetting exact duplicates.

The adapter keeps Threadnote workflow tools (`recall_context`, `remember_context`, `compact_context`, `share_publish`,
and related aliases) as the default surface. It also exposes raw OpenViking parity tools with `ov_*` names for native
behaviors such as code symbol navigation, raw search/read/list/store/remember, grep/glob, resource import, and forget.

## Acknowledgments

Threadnote is a workflow layer over [OpenViking](https://openviking.ai/) (AGPL-3.0).
It installs OpenViking on your machine (via `uv tool install openviking[local-embed]`) and runs it as a **separate program** —
shelling out to the `ov` CLI and talking to `openviking-server` over MCP. Threadnote does **not** bundle, modify, or
redistribute OpenViking; its source and license reach you independently through PyPI. Threadnote's own license covers
only Threadnote's code.

See [`THIRD_PARTY.md`](./THIRD_PARTY.md) for the full attribution.

## License

Threadnote is licensed under [AGPL-3.0-or-later](./LICENSE).
