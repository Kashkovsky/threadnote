# Agent instructions

Use Threadnote as shared local context and memory. Repo files remain authoritative; follow the nearest checked-in
`AGENTS.md`, `CLAUDE.md`, or equivalent guidance first.

At the start of a non-trivial task, call `recall_context` with the project and absolute `callerCwd`; in a monorepo, use
the nested package/app cwd. Memory recall provides prior decisions and handoffs; code-graph inspection provides current
source evidence.

`project` excludes projects but keeps projectless guidance; omit it for global recall or use a Workset. In monorepos,
`callerCwd` prefers its package without excluding repo-wide or sibling evidence.

A recall result is an unread pointer queue, not evidence. Read relevant `threadnote://` results with `read_context`
before relying on them or citing memory-backed claims.

Recall is compact and budgeted by default. Request `explain: true` only when ranking diagnostics are needed; it does
not turn unread pointers into evidence.

For unfamiliar source or relationship claims, call `inspect_code_graph` before broad text search. Use `query` to find a
concept, then round-trip its stable ID through `node`, `neighbors`, or `path`; use `impact` for reverse dependencies and
`analyze_code_graph` for repository-wide structure. Follow with exact text or path search for literals and verification.
If graph state is `indexing`, continue independent work and retry after the returned delay. If graph tooling is
unavailable, say so and use targeted text search. A bounded graph skip is appropriate for a known exact path or symbol,
a remote review without a checkout, or purely visual/binary evidence; use the graph if scope expands.

For cross-repository work, use a named Workset when one is configured. Workset queries read only its published ready
generation and never fan out cold graph builds. If a member lacks a ready snapshot or fresher repository evidence is
required, explicitly run `threadnote workset prepare <name>` before querying. Treat Workset results as bounded,
per-repository evidence with provenance, not proof of repository-wide absence.

Store reusable decisions and contracts with `kind: durable`; store status, checks, blockers, and next steps with
`kind: handoff`. Use stable `project` and `topic` identities and `replaceUri` when updating an existing memory. Store
routine durable knowledge and handoffs directly; use `review_session_context` only for additional session-extracted
candidates, which require explicit approval. Before pausing or ending meaningful work, leave a concise handoff.

Prefer Threadnote MCP tools and use the `threadnote` CLI as fallback. If storage or indexing fails, run
`threadnote doctor --dry-run`, report the diagnostic, and continue safe independent work. Never store secrets,
credentials, customer data, or raw production logs. Confirm with the user before publishing durable memory; never
publish handoffs or preferences, overwrite conflicting changes, or force a sync without explicit approval.
