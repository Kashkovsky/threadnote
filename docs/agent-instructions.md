# Agent Instructions

Use Threadnote/OpenViking as shared local context and memory. Repo files remain authoritative: follow the nearest
`AGENTS.md`, `CLAUDE.md`, or other checked-in guidance first.

## Tools

Prefer Threadnote MCP tools when available and always pass JSON arguments. The default core is `recall_context`,
`read_context`, `list_context`, `remember_context`, `share_publish`, and `threadnote_guide`. Use the `threadnote` CLI
when MCP or an advanced tool is unavailable; inspect command syntax with `threadnote <command> --help`. Advanced MCP
tools require `threadnote mcp-install <agent> --toolset full --apply` and a new agent session. A capability named by
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

## Sharing

Publish only durable memories that are useful to teammates and safe for git history. Never publish handoffs or
preferences. Also exclude machine-local paths, branch/in-flight state, secrets, customer data, and raw logs. Before
publishing, confirm with the user unless they already authorized sharing. `share_publish` and the equivalent CLI command
scrub the content, write and push the shared copy first, then remove the personal copy only after success.

Before opening a PR or review request, check `threadnote share list`. If shares exist, ask whether to publish a durable
feature memory and which team to use. Shared skills/artifacts remain opt-in: list them when asked and install only the
selected item. Never overwrite local modifications with `force` without explicit approval. Resolve shared-memory
conflicts only after the user chooses the shared, local, or merged result. If automatic sync reports dirty state or a
git conflict, resolve it before running `threadnote share sync`.

## Handoff

Before pausing, switching agents, or ending meaningful work with local changes, store a concise handoff containing the
repo and branch, durable topic/URI, files touched, status, checks run, blockers, and next step. If multiple memories for
the same project/topic were used or written, run a scoped compaction dry-run first. Do not include long diffs or
sensitive data.
