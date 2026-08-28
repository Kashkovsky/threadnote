# Agent instructions

Use Threadnote as shared memory. Repo files remain authoritative; follow checked-in
`AGENTS.md`, `CLAUDE.md`, or equivalent guidance.

For non-trivial tasks, call `recall_context` with project and absolute `callerCwd`; use the nested package/app cwd in
monorepos. Recall gives decisions/handoffs; graph gives current code evidence.

`project` excludes projects but retains projectless guidance; omit it for global recall or use a Workset. In monorepos,
`callerCwd` prefers its package without excluding repo-wide or sibling evidence.

Recall returns an unread pointer queue, not evidence. Read relevant `threadnote://` results with `read_context`
before relying on them or citing memory-backed claims.

Recall is compact/budgeted; `explain: true` is only for ranking diagnostics and cannot make unread pointers evidence.

For unfamiliar source/relationship claims, call `inspect_code_graph` before broad text search. Use `query` to find a
concept, then round-trip its stable ID through `node`, `neighbors`, or `path`; use `impact` for reverse dependencies and
`analyze_code_graph` for repo-wide structure. Follow with exact text or path search for literals and verification. If
`indexing`, work; retry after its delay. If graph tooling is unavailable, say so; use targeted text search. Skip graph
only for known exact paths/symbols, remote review without checkout, or visual/binary evidence; use it if scope expands.

For cross-repo work, use a named Workset when one is configured. Queries read only its published ready generation and
never fan out cold graph builds. If a member lacks a ready snapshot or needs fresher evidence, run
`threadnote workset prepare <name>` explicitly. Results are bounded, per-repository evidence with provenance, not proof
of repository-wide absence.

Store decisions/contracts as `kind: durable`; status/checks/blockers/next steps as `kind: handoff`. Use stable `project`
and `topic` identities; update memories with `replaceUri`. Store routine durable knowledge and handoffs
directly; use `review_session_context` only for additional session-extracted candidates requiring explicit approval.
Before pausing or ending meaningful work, leave a concise handoff.

For consequential source claims, cite graph-indexed repo paths or returned `cgs_`/`cgr_` handles via MCP `codeRefs` or
repeated CLI `--code-ref`. Capture needs a ready exact-current graph; it never indexes. Replacement without refs clears
citations. Legacy uncited memories stay recallable at coarse/unknown freshness; see
[Citations](https://threadnote.io/docs/code-citations/).

Prefer Threadnote MCP; use the `threadnote` CLI fallback. On storage/indexing failure, run `threadnote doctor --dry-run`,
report it and continue safe work. Never store secrets,
credentials, customer data, or raw production logs. Confirm with the user before publishing durable memory; never
publish handoffs or preferences, overwrite conflicting changes, or force a sync without explicit approval.
