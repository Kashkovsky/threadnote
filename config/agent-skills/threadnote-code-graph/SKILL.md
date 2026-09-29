---
name: threadnote-code-graph
description: Investigate unfamiliar local source relationships with Threadnote's code graph before broad text search.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph

Before a local call, construct the complete payload once. Both tools require an absolute `callerCwd` and an
`operation`; never probe with an empty or partial payload. Start with one of these valid calls:

- `inspect_code_graph({"callerCwd":"/abs/repo","operation":"query","query":"exclusive file lock"})`
- `analyze_code_graph({"callerCwd":"/abs/repo","operation":"stats","freshness":"allow-stale"})`

For inspect selectors use `query` -> `query`, `node`/`neighbors` -> `nodeId`, `explain` -> `symbol` or `query`, and
`path` -> `from` + `to`; `impact` normally uses `query`. Analysis `community` additionally requires `communityId`.
When validation names a missing key, correct that same payload before making another graph call.

For unfamiliar relationships, call `inspect_code_graph` before broad text search: `query` discovers;
`node`/`neighbors` round-trip stable `cgs_`/`cgr_` handles; `explain` expands symbols or queries; `path` connects local
`cgs_` or qualified Workset endpoints; `impact` finds reverse dependencies; `topology` summarizes Worksets.
Use `analyze_code_graph` for repository-wide `stats`, `communities`, `community`, `groups`, `hubs`, `surprises`,
`confidence`, or `full`. Verify source.

Analysis defaults to `freshness: current`. `ready` accepts compatible stale project evidence or refreshes if cold;
`allow-stale` never indexes and returns `no-ready-snapshot` if absent. Preserve freshness and snapshot identity;
stale analysis cannot authorize exact-current path, impact, or citation claims. Contention/failures return recovery
states, not necessarily analysis. Follow recovery guidance; never tight-poll.

For local-repository `inspect_code_graph`, omit `responseFormat` for the default schema-aware, text-only `agent`
projection; budgets apply after final formatting and semantic truncation. Analysis defaults to bounded text.
Named Worksets do not yet support agent projection and default to lossless JSON in one text block.
Request `dual` when canonical structured content is needed. Check advertised schemas; older servers accept `text`/`dual`.

Context Brief `codeRefs` accept repository-relative POSIX paths or lowercase `cgs_<32 hex>` IDs, not `cgr_`.
Follow retained selectors when truncated. Bounded cards cannot prove absence. During indexing, verify stale/deferred
evidence against source; retry for strict current/relationship claims or unusable cards.

Preserve the Context Brief `project` selector and inspect `projectCoverage`: project graphs cover configured roots,
forward dependencies, and explicit includes, not repository-wide absence. For `outside-project-graph`, partial coverage,
or ambiguity, follow returned actions or task/repository selectors; never guess, silently widen, or force a full rebuild.

Worksets expose published ready generations; run `threadnote workset prepare <name>` for fresher evidence.
If tools are unavailable, disclose and search narrowly. Skip graph for known exact paths/symbols, remote reviews without
checkouts, or visual/binary evidence. Carry consequential anchors into the handoff.

<!-- END THREADNOTE USER INSTRUCTIONS -->
