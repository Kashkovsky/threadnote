# Agent Instructions

Threadnote installs this as user-level agent guidance for Codex, Claude, Cursor, and Copilot.

## Shared Context

Use OpenViking through Threadnote as a shared local context and memory layer. Repo files remain authoritative: always
follow the nearest `AGENTS.md`, `CLAUDE.md`, or other checked-in instruction file first.

When OpenViking MCP tools are available, use them directly. Prefer Threadnote-named MCP tools when present:
`recall_context`, `read_context`, `list_context`, `remember_context`, `compact_context`, and `share_publish`. Always
pass JSON arguments to MCP tools. When a recall query says "current repo" or "this branch", include the current
workspace path as `callerCwd`, for example
`recall_context({"query":"current repo latest handoff","callerCwd":"/absolute/workspace/path"})`. Older Threadnote MCP
adapters may expose `search`, `read`, `list`, and `store` instead.

If MCP is unavailable, use the `threadnote` CLI fallback.

## Recall

At the start of a non-trivial task, recall relevant context before making changes. Search for:

- the current repo and branch;
- recent handoffs;
- durable feature memories for the branch, feature name, project/topic, or issue;
- seeded project guidance under `viking://resources/repos/<project>` — README, AGENTS.md, CLAUDE.md, SKILL.md, docs/\*\*
  — for canonical conventions, test commands, release process, on-call runbooks, and anything the team has checked into
  the repo;
- task-specific skills or workflow guidance;
- user or team preferences that may affect the work.

Include the repo or project name as a token in the recall query so the project-guidance pass fires. `recall_context`
runs a parallel scoped search against `viking://resources/repos/<project>` whenever the query mentions a seeded project
name, so memories AND project documentation come back in the same response. Treat seeded resources as the canonical
source for "how does this repo do X" and personal memories as in-flight or per-author context layered on top.

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

Bare `threadnote handoff` stores the current repo/current branch handoff by default. Use `threadnote handoff
--timestamped` only when you intentionally want a historical note instead of updating the active branch handoff.

When recall/read surfaces several memories that describe the same durable fact, incident, branch, or handoff, run a
scoped hygiene dry-run before deciding what to change:

```bash
threadnote compact --project my-repo --topic active-bug --dry-run
```

```text
compact_context({"project":"my-repo","topic":"active-bug","dryRun":true})
```

- Store one concise replacement memory that preserves the current status, the important facts, and the source `viking://`
  URIs you merged.
- Remove superseded duplicates with `threadnote forget <uri>` only when they are clearly redundant or stale and contain
  no unique useful detail.
- Use `threadnote archive <uri>` instead of `forget` when the old handoff still has provenance value but should no
  longer be treated as current context.
- Keep hygiene scoped to the current project/topic. Do not run global cleanup.
- For cross-repo features, link related durable memories explicitly in the body so recall can bridge the projects.
- If the memories disagree or you are not sure what can be deleted, keep them and mention the possible cleanup instead.

Never compact secrets, credentials, customer data, raw production logs, or checked-in canonical docs into memory.

## Sharing memories with teammates

Threadnote can publish a curated subset of durable memories into a team git repo so other engineers' agents can pull them.
The mechanism lives under the `viking://user/<you>/memories/shared/<team>/...` subtree; only memories that are explicitly
published leave the machine. Personal handoffs, preferences, and unpublished durable notes always stay local.

Publish a durable memory when its content is useful to other engineers working on the same project (intended behavior,
design decisions, API contracts, gotchas) and is safe to share. Do NOT publish:

- handoffs or anything carrying machine-local paths, branch state, or in-flight task context;
- memories under `memories/preferences/`;
- anything mentioning secrets, customer data, raw logs, or material a teammate's git history shouldn't carry.

The MCP tool `share_publish` runs the same scrubber as the CLI and refuses to publish memories containing common secret
patterns (PEM private keys, `sk-...`, `gh[pousr]_...`, `Bearer ...`, `AKIA...`, `xox[abprs]-...`). It is a destructive
operation: it removes the personal copy after the shared copy is committed.

Incoming shared memories are normally fetched and synced automatically before MCP `recall_context` / `read_context` and
CLI `threadnote recall` / `threadnote read` return. If automatic sync reports a dirty worktree, a conflict, or another
git issue, run `threadnote share sync` after resolving the local state to pull, reindex, and push explicitly.

```
# MCP call shape
share_publish({"uri":"viking://user/you/memories/durable/projects/foo/bar.md"})
share_publish({"uri":"viking://user/you/memories/durable/projects/foo/bar.md","team":"friends","push":false})
```

Before publishing, confirm with the user unless they have already instructed you to share durable memories autonomously.

## Handoff

Before pausing, switching agents, or ending meaningful work with local changes, store a concise handoff. Include:

- repo and branch;
- related durable feature memory URI or topic, when known;
- files touched;
- current status;
- tests or checks run;
- blockers;
- next suggested step.

If you wrote or read multiple memories for the same project/topic during the task, run a scoped hygiene dry-run before
the handoff. Do not do global memory cleanup.

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
threadnote compact --project example --topic active-issue --dry-run
threadnote archive viking://user/example/memories/handoffs/active/example/old-issue.md
threadnote forget viking://user/example/memories/events/duplicate.md
threadnote handoff --project example --topic active-issue --task "short task summary" --tests "checks run" --next-step "what to do next"
threadnote share init git@github.com:org/team-memories.git
threadnote share publish viking://user/example/memories/durable/projects/foo/bar.md
threadnote share sync
```
