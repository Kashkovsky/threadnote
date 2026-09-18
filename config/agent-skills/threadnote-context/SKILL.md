---
name: threadnote-context
description: Load relevant Threadnote decisions, handoffs, and graph-backed context before non-trivial work.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote context

For non-trivial repository work, begin with `context_brief` using the task, absolute `callerCwd`, and a mode (`locate`,
`trace`, `impact`, or `explain`). Add canonical `codeRefs` (repository-relative POSIX paths or exact `cgs_` IDs) when
current anchors are known. This is the normal Context Brief lifecycle. For memory-focused retrieval, use
`recall_context` with project and absolute `callerCwd`, then `read_context` every relevant `threadnote://` pointer before
relying on it. Recall output is pointers, not evidence.

Use `memoryRefs` and optional typed `relationTypes` for deliberate one-hop navigation; this is not recursive discovery.
Follow memory citations back through the current graph and exact source, and feed current graph anchors back into
`context_brief.codeRefs` for the graph-to-memory round trip. Treat historical citations and bounded/truncated results as
provenance, not proof of current code or absence. If a brief retains a selector, rerun narrowly; if it retains
`graph-status`, inspect status before retrying. Do not tight-poll active, queued, or deferred refreshes.

Call `inspect_code_graph`/`analyze_code_graph` through the code-graph skill before broad search, then verify claims in
exact source. `cgr_` handles are for graph inspection, not `codeRefs`; use up to eight canonical anchors. Named Worksets
use only their published ready generation; prepare one explicitly when needed. If graph tooling is unavailable, say so
and use targeted search. Skip graph for known exact paths/symbols, remote reviews without a checkout, or binary/visual
evidence.

<!-- END THREADNOTE USER INSTRUCTIONS -->
