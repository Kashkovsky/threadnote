---
name: threadnote-context
description: Load relevant Threadnote decisions, handoffs, and graph-backed context before non-trivial work. Use for planning, resuming work, unfamiliar repositories, and questions that depend on prior decisions.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote context

Call `context_brief` when the task benefits from one bounded response combining ready graph evidence, decisions, and
handoffs. Use `mode: locate` to find implementation surfaces, `trace` for relationships, `impact` for downstream
effects, and `explain` when a concise rationale is needed. When starting from current code, pass up to eight canonical
graph-indexed POSIX repository-relative paths or exact lowercase `cgs_<32 hex>` IDs in `codeRefs` so the brief can
retrieve memories that explicitly cite those anchors. `cgr_` IDs are graph-inspection handles and are not valid
Context Brief anchors. The accepted response budget is 800–1,500 estimated tokens.

Call `recall_context` with the stable project and absolute `callerCwd` when you need a memory-focused search or more
control over ranking. In monorepos, use the nested package or app cwd. Omit `project` for global recall or use a named
Workset for cross-repository work.

Recall results are unread pointers, not evidence. Read every relevant `threadnote://` result with `read_context` before
using it. Keep recall compact; use `explain: true` only to diagnose ranking.

Complete the code-brief round trip in both directions. For memory-to-code, follow cited paths and graph IDs from a memory
into the current graph and exact source before relying on the claim. For graph-to-memory, feed relevant current paths or
stable graph IDs back through `context_brief.codeRefs` to retrieve the decisions and handoffs attached to that code.
Treat historical citations as provenance, not proof that current code is unchanged.

When a code-linked brief is truncated and reports `rerun-required`, use the concrete retained follow-up selector to
narrow the next graph call or brief; do not treat omitted cards or memories as absent. Code-linked lookup is local to a
repository. Keep Workset `cgr_` handles in `inspect_code_graph` instead of passing them as Context Brief code refs.
<!-- END THREADNOTE USER INSTRUCTIONS -->
