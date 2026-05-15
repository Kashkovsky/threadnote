# Agent Instructions

Threadnote installs this as user-level agent guidance for Codex, Claude, Cursor, and Copilot.

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
- durable feature memories for the branch, feature name, project/topic, or issue;
- task-specific skills or workflow guidance;
- user or team preferences that may affect the work.

When a recalled handoff describes an active branch or feature, do a second recall for durable memories about that
feature before coding. The handoff tells you the current work state; durable feature memories tell you the design,
decisions, invariants, interfaces, and gotchas that should survive beyond one session.

Skip proactive recall for tiny one-shot questions where context would add noise.

Search results are not the final payload. Treat returned `viking://` URIs as pointers: read the relevant URI, or list a
directory when the result is an abstract/overview node.

## Remember

When the user asks you to remember something, store it unless it contains secrets, credentials, customer data, production
logs, or other sensitive data.

Also remember durable workflow facts you discover during work when they would help future agents and are not already in
canonical docs. Prefer updating checked-in docs for canonical repo rules.

During feature work on a branch, maintain durable feature knowledge in addition to handoffs. Store or update a durable
memory when you learn something future agents should know about the feature itself: the intended behavior, design
decisions, API contracts, data flow, migration semantics, edge cases, known limitations, or why an implementation choice
was made. Do not wait until the end of the branch; update the feature memory whenever a valuable change lands or a
decision becomes clear.

Use lifecycle metadata when storing memories:

- `kind: durable` for facts future agents should use by default.
- `kind: handoff` for current work logs and next steps.
- `project` for the repo/product namespace.
- `topic` for the active issue or stable fact. Reusing the same project/topic keeps one current memory updated.

Archived handoffs are provenance, not default working context. Read them only when current durable memories or active
handoffs are insufficient.

For branch feature work, prefer two stable memories with the same project and topic:

- `kind: durable` for the feature knowledge that should remain useful after the current agent session.
- `kind: handoff` for current status, files touched, tests, blockers, and next step.

If a durable feature memory already exists, update it in place with the same project/topic or with `--replace <uri>` /
`replaceUri`. Avoid creating a new timestamped durable memory for every small progress note.

## Memory Compaction

When working on the same active issue, prefer keeping one current-state memory updated instead of creating many small
progress memories. If an existing memory is clearly the current state for the issue, store the updated version with
`remember_context({"text":"...","replaceUri":"<uri>"})`, `threadnote remember --replace <uri>`, or
`threadnote handoff --replace <uri>` so the old memory is removed only after the replacement is stored.

When the issue has a stable name, prefer project/topic storage over timestamped memories:

```bash
threadnote recall --query "my-repo active-bug durable feature knowledge"
threadnote remember --kind durable --project my-repo --topic active-bug --text "Feature knowledge: ..."
threadnote handoff --project my-repo --topic active-bug --task "..." --tests "..."
```

When recall/read surfaces several memories that describe the same durable fact, incident, branch, or handoff, compact
them when it is safe:

- Store one concise replacement memory that preserves the current status, the important facts, and the source `viking://`
  URIs you merged.
- Remove superseded duplicates with `threadnote forget <uri>` only when they are clearly redundant or stale and contain
  no unique useful detail.
- Use `threadnote archive <uri>` instead of `forget` when the old handoff still has provenance value but should no
  longer be treated as current context.
- If the memories disagree or you are not sure what can be deleted, keep them and mention the possible cleanup instead.

Never compact secrets, credentials, customer data, raw production logs, or checked-in canonical docs into memory.

## Handoff

Before pausing, switching agents, or ending meaningful work with local changes, store a concise handoff. Include:

- repo and branch;
- related durable feature memory URI or topic, when known;
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
threadnote recall --query "durable feature knowledge for this branch"
threadnote read viking://agent/threadnote/memories/.abstract.md
threadnote list viking://agent/threadnote/memories --all --recursive
threadnote remember --kind durable --project example --topic workflow --text "Durable engineering note..."
threadnote remember --kind durable --project example --topic active-issue --text "Feature knowledge..."
threadnote remember --replace viking://user/example/memories/durable/projects/example/workflow.md --text "Updated durable engineering note..."
threadnote archive viking://user/example/memories/handoffs/active/example/old-issue.md
threadnote forget viking://user/example/memories/events/duplicate.md
threadnote handoff --project example --topic active-issue --task "short task summary" --tests "checks run" --next-step "what to do next"
```
