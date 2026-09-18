---
name: threadnote-code-graph
description: Investigate unfamiliar local source relationships with Threadnote's code graph before broad text search.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph

For unfamiliar source or relationship claims, call `inspect_code_graph` before broad text search: start with `query`,
then round-trip stable `cgs_`/`cgr_` IDs through `node`, `neighbors`, or `path`. Use `impact` for reverse dependencies
and `analyze_code_graph` for repository-wide structure. Follow graph evidence with exact path or literal search.

Use canonical repository-relative POSIX paths or exact lowercase `cgs_<32 hex>` IDs as Context Brief `codeRefs`; `cgr_`
handles remain inspection handles. If a brief is truncated, follow its retained selector. Treat bounded cards as
provenance, not proof of absence. During indexing, use compatible stale/deferred cards, verify exact source, and retry
only before strict current/relationship claims or when no usable cards survive; never tight-poll refresh state.

Named Worksets expose only their published ready generation; run `threadnote workset prepare <name>` when a fresher ready
snapshot is required. If graph tooling is unavailable, say so and use targeted search. Skip graph for known exact paths
or symbols, remote review without a checkout, and visual/binary evidence. Carry consequential anchors into the handoff.

<!-- END THREADNOTE USER INSTRUCTIONS -->
