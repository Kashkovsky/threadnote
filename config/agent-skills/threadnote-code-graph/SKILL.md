---
name: threadnote-code-graph
description: Investigate unfamiliar local source relationships with Threadnote's code graph before broad text search. Use for locating concepts, tracing callers and dependencies, impact analysis, and repository architecture.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph

For unfamiliar source or relationship claims, call `inspect_code_graph` before broad text search. Start with `query`,
then round-trip a stable `cgs_` or `cgr_` ID through `node`, `neighbors`, or `path`. Use `impact` for reverse dependencies
and `analyze_code_graph` for repository-wide structure. Follow graph evidence with exact path or literal search for
verification.

If indexing is in progress, continue safe work and retry after the returned delay. If graph tooling is unavailable,
say so and use targeted text search. Skip graph only for known exact paths or symbols, remote review without a checkout,
or visual and binary evidence; use it if the scope expands.

Named Worksets read only their published ready generation. Run `threadnote workset prepare <name>` explicitly when a
member needs a ready or fresher snapshot. Treat bounded results as evidence with provenance, not proof of absence.

For the code-brief workflow, use graph paths and stable IDs as bidirectional anchors: pass them to
`context_brief.codeRefs` to find memories attached to current code, and use memory citations to return to the current
graph before making relationship claims. Carry the most consequential anchors into the final handoff.
<!-- END THREADNOTE USER INSTRUCTIONS -->
