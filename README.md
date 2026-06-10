<p align="center">
  <img src="./docs/threadnote-logo.svg" alt="Threadnote logo" width="200">
</p>

# Threadnote

[![npm version](https://img.shields.io/npm/v/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![CI](https://img.shields.io/github/actions/workflow/status/Kashkovsky/threadnote/ci.yml?branch=main&label=CI)](https://github.com/Kashkovsky/threadnote/actions/workflows/ci.yml) [![npm downloads](https://img.shields.io/npm/dm/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![license](https://img.shields.io/npm/l/threadnote.svg)](./LICENSE) ![node version](https://img.shields.io/node/v/threadnote.svg)

`threadnote` is a safe local workflow for using [OpenViking](https://openviking.ai/) as shared, agent-neutral context for development work.
It is intentionally scoped to curated docs, memories, skills, and handoffs.

**Walkthrough:** https://kashkovsky.github.io/threadnote/  
**Wiki:** https://github.com/Kashkovsky/threadnote/wiki

## Real-World Uses

**Want to continue work in a fresh agent session?**  
`threadnote install` adds user-level Codex, Claude, Cursor, and Copilot instructions so new agents automatically recall recent handoffs and relevant memories before they start changing code.

**Working on a feature branch over several sessions?**
Agents recall the branch handoff for current status, then recall durable feature memories for the design, decisions,
interfaces, and gotchas behind the feature. As useful implementation knowledge appears, agents update the durable feature
memory instead of leaving everything buried in transient handoffs.

**Implemented a feature a while ago and need to pick it up again?**  
Ask the agent to recall the feature, branch, or repo. Threadnote returns auditable `viking://` pointers that the agent can read before deciding what still matters.

**Switching between Codex, Claude, Cursor, and Copilot?**\
Install the MCP adapter for each agent you use. The user-level instructions tell agents to store a handoff before they pause, so the next agent can search the same local memory layer instead of reconstructing context
from chat history.

The adapter keeps Threadnote workflow tools (`recall_context`, `remember_context`, `share_publish`, and related aliases)
as the default surface, and also exposes raw OpenViking parity tools with `ov_*` names for native behaviors such as
code symbol navigation, watch management, raw search/read/list/store/remember, grep/glob, resource import, and forget.

**Working through a long task until the agent context window fills up?**  
After compaction, the next agent turn can recall the relevant Threadnote memories and handoffs instead of relying only on the compressed conversation summary.

**Found a durable workflow fact, like how a repo runs tests or where release notes live?**  
Ask the agent to remember it. Threadnote keeps that memory local and searchable without editing unrelated repo files.

**Have reusable agent workflows already installed as skills?**\
Run `threadnote seed-skills` to make local `SKILL.md` guidance discoverable through recall. Agents can find relevant testing, release, on-call, debugging, or plugin-provided workflows without you reopening the same skill files by hand.

**Want teammates to use the same skill or command?**\
Publish it into a shared team repo with `threadnote share publish-artifact <path>`. Teammates can recall the shared
artifact immediately after sync, then opt in to local installation with `threadnote share install-artifacts --apply`.

**Recall returned several overlapping memories?**
Run `threadnote compact --project <repo> --topic <issue> --dry-run` or ask the agent to use
`compact_context({"project":"<repo>","topic":"<issue>","dryRun":true})`. Threadnote produces a scoped plan first:
which memory to keep/update, which old handoffs to archive, and which exact duplicates are safe to forget.

**Still working on the same issue?**
Use `threadnote remember --replace <uri>` or `threadnote handoff --replace <uri>` to keep one current-state memory fresh
instead of accumulating near-duplicate progress notes. Replacing a shared `durable/` URI updates that shared memory in
place and pushes the shared repo, so you do not need a separate `share publish` step.

## Acknowledgments

Threadnote is a workflow layer over [OpenViking](https://openviking.ai/) (AGPL-3.0).
It installs OpenViking on your machine (via `uv tool install openviking[local-embed]`) and runs it as a **separate program** —
shelling out to the `ov` CLI and talking to `openviking-server` over MCP. Threadnote does **not** bundle, modify, or
redistribute OpenViking; its source and license reach you independently through PyPI. Threadnote's own license covers
only Threadnote's code.

See [`THIRD_PARTY.md`](./THIRD_PARTY.md) for the full attribution.

## License

Threadnote is licensed under [AGPL-3.0-or-later](./LICENSE).
