<p align="center">
  <img src="./docs/threadnote-logo.svg" alt="Threadnote logo" width="200">
</p>

# Threadnote

[![npm version](https://img.shields.io/npm/v/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![CI](https://img.shields.io/github/actions/workflow/status/Kashkovsky/threadnote/ci.yml?branch=main&label=CI)](https://github.com/Kashkovsky/threadnote/actions/workflows/ci.yml) [![npm downloads](https://img.shields.io/npm/dm/threadnote.svg)](https://www.npmjs.com/package/threadnote) [![license](https://img.shields.io/npm/l/threadnote.svg)](./LICENSE) ![node version](https://img.shields.io/node/v/threadnote.svg)

`threadnote` is a safe local workflow for using [OpenViking](https://openviking.ai/) as shared, agent-neutral context for development work.
It is intentionally scoped to curated docs, memories, skills, and handoffs. It is not a source-navigation replacement,
and it does not index whole repositories by default.

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

**Working through a long task until the agent context window fills up?**  
After compaction, the next agent turn can recall the relevant Threadnote memories and handoffs instead of relying only on the compressed conversation summary.

**Found a durable workflow fact, like how a repo runs tests or where release notes live?**  
Ask the agent to remember it. Threadnote keeps that memory local and searchable without editing unrelated repo files.

**Have reusable agent workflows already installed as skills?**\
Run `threadnote seed-skills` to make local `SKILL.md` guidance discoverable through recall. Agents can find relevant testing, release, on-call, debugging, or plugin-provided workflows without you reopening the same skill files by hand.

**Recall returned several overlapping memories?**
Run `threadnote compact --project <repo> --topic <issue> --dry-run` or ask the agent to use
`compact_context({"project":"<repo>","topic":"<issue>","dryRun":true})`. Threadnote produces a scoped plan first:
which memory to keep/update, which old handoffs to archive, and which exact duplicates are safe to forget.

**Still working on the same issue?**
Use `threadnote remember --replace <uri>` or `threadnote handoff --replace <uri>` to keep one current-state memory fresh
instead of accumulating near-duplicate progress notes. Replacing a shared `durable/` URI updates that shared memory in
place and pushes the shared repo, so you do not need a separate `share publish` step.
