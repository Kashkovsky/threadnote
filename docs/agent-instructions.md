# Agent Instructions

Use Threadnote/OpenViking as shared local context and memory. Repo files remain authoritative: follow the nearest
`AGENTS.md`, `CLAUDE.md`, or other checked-in guidance first.

## Tools

Prefer Threadnote MCP tools and pass JSON arguments. Core: `recall_context`,
`read_context`, `list_context`, `remember_context`, `review_session_context`, `apply_memory_candidates`,
`share_publish`, and `threadnote_guide`. Use the `threadnote` CLI when a tool is unavailable; inspect syntax with
`threadnote <command> --help`. Advanced MCP tools require
`threadnote mcp-install <agent> --toolset full --apply` and a new session. A capability named by
`threadnote_guide` is not callable unless its tool is present.

## Recall

At the start of a non-trivial task, recall the current repo and branch, active handoffs, durable feature knowledge,
seeded project guidance, relevant skills, and user/team preferences. Include the repo/project name in the query so
seeded guidance under `viking://resources/repos/<project>` is searched. For "current repo" or "this branch", pass the
absolute workspace path as `callerCwd`.

If a handoff describes an active feature, recall durable knowledge for that feature before coding. Treat seeded repo
resources as canonical and personal memories as supplemental. Treat returned `viking://` URIs as pointers: read the
relevant file or list the relevant directory. Skip proactive recall for tiny one-shot questions.

## Remember

Store information when the user asks, and store durable workflow or feature facts that would help future agents when
they do not belong in checked-in docs. Never store secrets, credentials, customer data, or raw production logs.

Use `kind: durable` for reusable decisions, contracts, invariants, edge cases, and gotchas. Use `kind: handoff` for
current status and next steps. Set stable `project` and `topic` values so each issue has one current durable memory and
one current handoff. Update existing state with the same project/topic or `replaceUri`; do not create timestamped notes
for routine progress. Shared durable replacements update the shared memory in place. Archived handoffs are provenance,
not default working context.

When several memories cover the same project/topic, first run a scoped `compact_context` or `threadnote compact`
dry-run. Preserve unique facts and source URIs in one replacement. Forget only clearly redundant memories; archive
useful provenance; keep disagreements or uncertain cases. Never run global cleanup or compact checked-in canonical
docs or sensitive data.

## Task closeout

After meaningful work, call `review_session_context` with the outcome and only decisions, invariants, explicit
preferences, and unresolved handoff state useful later. Skip tiny answers, inconclusive exploration, and abandoned
work. Include evidence, a source session ID, or a source commit; unsupported prose is ineligible.

The tool never creates active memory. Present up to three suggestions. Call `apply_memory_candidates` with the review
ID and revision per decision. For replace/manual-review candidates, pass `operation: create`, or `operation: replace`
plus the exact `replaceUri`. Set `approved: true` only after explicit approval. Silence is not approval; never copy the
whole transcript. If nothing is recommended, do not prompt.

`THREADNOTE_CANDIDATE_POLICY=suggest` is the default. `handoff-only` limits closeout proposals to unresolved work, and
`off` disables session suggestions while preserving explicit `remember_context`.

## Sharing

Publish only durable memories useful to teammates and safe for git history. Never publish handoffs or preferences.
Exclude machine-local paths, branch/in-flight state, secrets, customer data, and raw logs. Before publishing, confirm
with the user unless already authorized. `share_publish` writes and pushes the scrubbed shared copy before removing the
personal copy.

Before opening a PR or review request, check `threadnote share list`. If shares exist, ask whether to publish a durable
feature memory and which team to use. Shared skills/artifacts remain opt-in: list them when asked and install only the
selected item. Never overwrite local modifications with `force` without explicit approval. Resolve shared-memory
conflicts only after the user chooses the shared, local, or merged result. If automatic sync reports dirty state or a
git conflict, resolve it before running `threadnote share sync`.

## Handoff

Before pausing, switching agents, or ending meaningful work with local changes, include a concise handoff candidate with
the repo and branch, durable topic/URI, files touched, status, checks, blockers, and next step. Store it only after
approval. Lifecycle hooks may still create a bounded emergency handoff during compaction. If multiple memories for the
same project/topic were used or written, run a scoped compaction dry-run first. Exclude long diffs and sensitive data.
