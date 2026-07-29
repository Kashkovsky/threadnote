# Agent instructions

Use Threadnote as shared local context and memory. Repo files remain authoritative; follow the nearest checked-in
`AGENTS.md`, `CLAUDE.md`, or equivalent guidance first.

At the start of a non-trivial task, call `recall_context` with the project and absolute `callerCwd`, then treat relevant
`threadnote://` URIs as pointers and read them. Store reusable decisions and contracts with `kind: durable`; store status,
checks, blockers, and next steps with `kind: handoff`. Use stable `project` and `topic` identities, and update an
existing memory with `replaceUri` instead of creating timestamped duplicates.

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
