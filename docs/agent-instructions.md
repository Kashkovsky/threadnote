# Agent Instructions

Use Threadnote/OpenViking as shared local context and memory. Repo files remain authoritative: follow the nearest
`AGENTS.md`, `CLAUDE.md`, or other checked-in guidance first.

## Tools

Prefer Threadnote MCP tools with JSON arguments. Core: `recall_context`,
`read_context`, `list_context`, `remember_context`, `review_session_context`, `apply_memory_candidates`,
`share_publish`, and `threadnote_guide`. Use the `threadnote` CLI if a tool is unavailable; inspect syntax with
`threadnote <command> --help`. Advanced tools require `threadnote mcp-install <agent> --toolset full --apply` and a new
session; guide capabilities require their tools.

If Threadnote MCP/CLI reports OpenViking unavailable or unreachable, run `threadnote start` without asking and retry
the failed operation once. If startup fails, run `threadnote doctor --dry-run`, report it, and continue independent
work if possible; never loop.

## Recall

At the start of a non-trivial task, recall the repo/branch, active handoffs, durable feature knowledge, seeded guidance,
relevant skills, and user/team preferences. Name the repo/project in the query to search
`viking://resources/repos/<project>`. For "current repo" or "this branch", pass the absolute workspace path as
`callerCwd`.

For an active handoff, recall its durable feature knowledge before coding. Seeded repo resources are canonical;
personal memories are supplemental. Treat returned `viking://` URIs as pointers: read the relevant file or list its
directory. Skip proactive recall for tiny one-shot questions.

## Remember

Store user-requested information and durable workflow or feature facts useful to future agents when they do not belong
in checked-in docs. Never store secrets, credentials, customer data, or raw production logs.

Use `kind: durable` for reusable decisions, contracts, invariants, edge cases, and gotchas. Use `kind: handoff` for
status and next steps. Set stable `project` and `topic` so each issue has one current durable memory and handoff. Update
the same identity or `replaceUri`; avoid timestamped routine notes. Shared durable replacements update in place.
Archived handoffs are provenance, not default working context.

When several memories cover the same project/topic, first run a scoped `compact_context` or `threadnote compact`
dry-run. Preserve unique facts and source URIs in one replacement. Forget only clearly redundant memories; archive
useful provenance; keep disagreements or uncertain cases. Never run global cleanup or compact checked-in canonical
docs or sensitive data.

## Task closeout

After meaningful work, store normal durable feature knowledge and handoffs directly without asking for approval:
decisions, contracts, invariants, and edge cases in durable memory; status, checks, blockers, and next step in the
handoff. Skip tiny answers, inconclusive exploration, and abandoned work.

Use `review_session_context` only for additional session-extracted candidates not already captured by those routine
writes. Include the outcome and evidence or a source session ID/commit. The tool never creates active memory. Present up
to three suggestions, then call `apply_memory_candidates` with the review ID and revision. For replace/manual-review
candidates, pass `operation: create`, or `operation: replace` plus the exact `replaceUri`. Set `approved: true` only
after explicit approval. Silence is not approval; never copy the whole transcript. If nothing is recommended, do not
prompt.

`THREADNOTE_CANDIDATE_POLICY=suggest` is the default. `handoff-only` limits closeout proposals to unresolved work, and
`off` disables session suggestions while preserving explicit `remember_context`.

## Sharing

Publish only safe durable memories useful to teammates. Never publish handoffs or preferences. Exclude machine-local
paths, branch state, secrets, customer data, or raw logs. Before publishing, confirm with the user unless authorized.
`share_publish` writes and pushes the scrubbed shared copy before removing the personal copy.

Before a PR/review request, check `threadnote share list`; if shares exist, ask whether to publish a durable feature
memory and which team. Shared skills/artifacts remain opt-in. Never overwrite local modifications with `force` without
explicit approval. Resolve shared-memory conflicts only after the user chooses the shared, local, or merged result. If
automatic sync reports dirty state or a git conflict, resolve it before `threadnote share sync`.

## Handoff

Before pausing, switching agents, or ending meaningful work with local changes, store a concise handoff directly without
presenting it as a candidate or asking for approval. Include repo/branch, durable topic/URI, files, status, checks,
blockers, and next step. Lifecycle hooks may still create a bounded emergency handoff during compaction. If multiple
memories for the same project/topic were used or written, run a scoped compaction dry-run first. Exclude long diffs and
sensitive data.
