# Agent Instructions

Threadnote installs this as user-level agent guidance for Codex, Claude, and Cursor.

## Shared Context

Use OpenViking through Threadnote as a shared local context and memory layer. Repo files remain authoritative: always
follow the nearest `AGENTS.md`, `CLAUDE.md`, or other checked-in instruction file first.

When OpenViking MCP tools are available, use them directly. Prefer Threadnote-named MCP tools when present:
`recall_context`, `read_context`, `list_context`, and `remember_context`. Always pass JSON arguments to MCP tools, for
example `recall_context({"query":"current repo latest handoff"})`. Older Threadnote MCP adapters may expose
`search`, `read`, `list`, and `store` instead.

If MCP is unavailable, use the `threadnote` CLI fallback.

## Recall

At the start of a non-trivial task, recall relevant context before making changes. Search for:

- the current repo and branch;
- recent handoffs;
- task-specific skills or workflow guidance;
- user or team preferences that may affect the work.

Skip proactive recall for tiny one-shot questions where context would add noise.

Search results are not the final payload. Treat returned `viking://` URIs as pointers: read the relevant URI, or list a
directory when the result is an abstract/overview node.

## Remember

When the user asks you to remember something, store it unless it contains secrets, credentials, customer data, production
logs, or other sensitive data.

Also remember durable workflow facts you discover during work when they would help future agents and are not already in
canonical docs. Prefer updating checked-in docs for canonical repo rules.

## Memory Compaction

When recall/read surfaces several memories that describe the same durable fact, incident, branch, or handoff, compact
them when it is safe:

- Store one concise replacement memory that preserves the current status, the important facts, and the source `viking://`
  URIs you merged.
- Remove superseded duplicates with `threadnote forget <uri>` only when they are clearly redundant or stale and contain
  no unique useful detail.
- If the memories disagree or you are not sure what can be deleted, keep them and mention the possible cleanup instead.

Never compact secrets, credentials, customer data, raw production logs, or checked-in canonical docs into memory.

## Handoff

Before pausing, switching agents, or ending meaningful work with local changes, store a concise handoff. Include:

- repo and branch;
- files touched;
- current status;
- tests or checks run;
- blockers;
- next suggested step.

Do not store long diffs, secrets, raw logs, or customer data in handoffs.

## CLI Fallback

Use these only when MCP tools are not available:

```bash
threadnote start
threadnote recall --query "last handoff for this branch"
threadnote read viking://agent/threadnote/memories/.abstract.md
threadnote list viking://agent/threadnote/memories --all --recursive
threadnote remember --text "Durable engineering note..."
threadnote forget viking://user/example/memories/events/duplicate.md
threadnote handoff --task "short task summary" --tests "checks run" --next-step "what to do next"
```
