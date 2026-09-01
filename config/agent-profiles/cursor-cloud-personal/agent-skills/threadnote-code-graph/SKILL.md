---
name: threadnote-code-graph
description: Investigate current source relationships in the Personal Cursor Cloud checkout before broad text search.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph in Personal Cursor Cloud

For unfamiliar source or relationship claims, call `inspect_code_graph` before broad text search. Start with `query`,
then round-trip a stable `cgs_` or `cgr_` ID through `node`, `neighbors`, or `path`. Use `impact` for reverse dependencies
and `analyze_code_graph` for repository-wide structure. Follow graph evidence with exact path or literal search.

The graph belongs only to the current ephemeral checkout. Named Worksets are unavailable. If indexing is in progress,
continue safe work and retry after the returned delay. Skip the graph only for a known exact path or symbol, remote
evidence without a checkout, or visual/binary evidence; use it if scope expands. Memory citations are provenance, not
proof that current code is unchanged.
<!-- END THREADNOTE USER INSTRUCTIONS -->
