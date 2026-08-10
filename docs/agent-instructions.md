# Agent instructions

Use Threadnote as shared local context and memory. Repo files remain authoritative; follow the nearest checked-in
`AGENTS.md`, `CLAUDE.md`, or equivalent guidance first.

At the start of a non-trivial task, call `recall_context` with the project and absolute `callerCwd`, then treat relevant
`threadnote://` URIs as pointers and read them. Store reusable decisions and contracts with `kind: durable`; store status,
checks, blockers, and next steps with `kind: handoff`. Use stable `project` and `topic` identities, and update an
existing memory with `replaceUri` instead of creating timestamped duplicates.

For non-trivial investigation of existing source, use `inspect_code_graph` before broad `rg` or grep searches.
`query` finds definitions and concepts; use the returned stable `cgs_` ID with `node` for exact lookup, `neighbors` for
bounded directional adjacency, or as a `path` endpoint. `explain` accepts a human-readable symbol selector, and `impact`
traces reverse dependencies from a query or Git `base`. Use the separate `analyze_code_graph` tool for whole-repository
statistics, stable community drill-down, structural groups, hubs or god nodes, confidence audits, and surprising
cross-community links. Use text search afterward for exact literals, unsupported files, or verification. If either
graph tool returns `state: "indexing"`, continue useful independent work such as targeted text or path search, then
retry after `retryAfterMilliseconds` before making relationship-aware graph claims. The optional estimate is scoped
only to the current measured phase; it is not a full-build promise. Indexing is expected cold-start progress, not graph
failure. If graph search is unavailable or fails, report the issue and use text search as the fallback; do not silently
skip graph search. Memory recall answers what was learned or decided; code-graph search answers what the current Git
snapshot and worktree contain. Call both when a task needs historical context and present code evidence, but do not
treat one as a fallback answer from the other.

Graph-first applies to unfamiliar local source and relationship claims. An explicit graph skip is honest when the task
is confined to an already-known exact path or symbol, a remote review has no local checkout, or the evidence is purely
visual or a binary asset Threadnote does not interpret. Use the exact file, diff, or asset and state that bounded reason;
call the graph if the scope expands. A package-local zero-result is an absence hint, not proof of repository-wide
absence. A named workset query reports per-repository provenance from existing ready snapshots and does not fan out
cold builds.

At closeout, store normal durable feature knowledge and handoffs directly without asking. Use
`review_session_context` only for additional session-extracted candidates, and apply those only after explicit user
approval. Never store secrets, credentials, customer data, or raw production logs.

Use MCP tools when available and the `threadnote` CLI as fallback. If native storage or indexing fails, run
`threadnote doctor --dry-run`, report the diagnostic, and continue independent work when possible. The 4.0 runtime has
no daemon to start.

If Threadnote itself returns an error, use `threadnote report-issue --title <title> --body <description>` to prepare the
public GitHub issue preview without sensitive information. Create it only after explicit user approval by rerunning
with `--apply --approval <preview-digest>`; add `--include-logs` only when the user approves posting the bounded
privacy-safe production logs. If GitHub CLI is missing or signed out, ask before helping the user install it or run
`gh auth login`.

Before publishing safe durable memory, confirm with the user. Never publish handoffs or preferences. Resolve dirty git
or share conflicts before syncing, and never overwrite local modifications with force without explicit approval.
Before pausing, switching agents, or ending meaningful work with local changes, store a concise handoff.
