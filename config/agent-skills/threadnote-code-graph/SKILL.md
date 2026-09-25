---
name: threadnote-code-graph
description: Investigate unfamiliar local source relationships with Threadnote's code graph before broad text search.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph

For unfamiliar source or relationship claims, call `inspect_code_graph` before broad text search: `query` discovers;
`node`/`neighbors` round-trip stable `cgs_`/`cgr_` handles; `explain` expands symbols or queries; `path` connects local
`cgs_` endpoints or qualified Workset endpoints; `impact` finds reverse dependencies; `topology` summarizes Worksets.
Use `analyze_code_graph` for repository-wide `stats`, `communities`, `community`, `groups`, `hubs`, `surprises`,
`confidence`, or `full`. Verify with exact source.

For local-repository `inspect_code_graph`, prefer `responseFormat: "agent"` for model-facing bounded reads. It is a
schema-aware, text-only projection and explicit budgets apply after final formatting and semantic truncation. Named
Worksets do not yet support agent projection: use `responseFormat: "text"` for lossless JSON in one text block or omit
the option for dual structured compatibility. Inspect the advertised tool schema first and fall back to `text` or `dual`
on older servers.

Use repository-relative POSIX paths or lowercase `cgs_<32 hex>` IDs as Context Brief `codeRefs`; `cgr_` handles remain
inspection handles. If a brief is truncated, follow its retained selector. Treat bounded cards as provenance, not proof
of absence. During indexing, use compatible stale/deferred cards, verify source, and retry only for strict
current/relationship claims or no usable cards; never tight-poll.

Preserve the Context Brief `project` selector and read `projectCoverage`: a configured project graph covers its roots,
forward dependencies, and explicit includes, not the whole repository. Do not claim repository-wide absence from that
view. For `outside-project-graph`, partial coverage, or ambiguous selection, follow the returned action or choose a
project explicitly identified by the task or repository guidance; never guess, silently widen, or force a full rebuild.

Named Worksets expose only their published ready generation; run `threadnote workset prepare <name>` when a fresher ready
snapshot is required. If graph tooling is unavailable, say so and use targeted search. Skip graph for known exact paths
or symbols, remote review without a checkout, and visual/binary evidence. Carry consequential anchors into the handoff.

<!-- END THREADNOTE USER INSTRUCTIONS -->
