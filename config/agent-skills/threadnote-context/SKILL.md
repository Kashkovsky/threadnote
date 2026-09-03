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
Context Brief anchors. The accepted response budget is 800–1,500 estimated tokens. Task and repository cwd text accept
at most 4,096 UTF-8 bytes; project and Workset names accept at most 256.

Call `recall_context` with the stable project and absolute `callerCwd` when you need a memory-focused search or more
control over ranking. In monorepos, use the nested package or app cwd. Omit `project` for global recall or use a named
Workset for cross-repository work.

When a relevant memory is already known and adjacent evidence would help, pass its stable memory ID or canonical
managed-memory URI in `memoryRefs`. Keep a topical `query` when both retrieval lanes are useful, or omit it for pure
seed-only navigation. Optionally narrow the one-hop expansion with `relationTypes`: `depends_on`, `evidence_for`,
`references`, `related_to`, or `supersedes`. This is explicit navigation, not recursive graph discovery. A response with
confidence basis `explicit-memory-connection` puts a verified neighbor first in `nextAction`; that confidence covers
pointer navigation, not entailment. Use the returned premise and connection receipts to understand resolution,
currentness, direction, and truncation; read only useful neighbor pointers before relying on them. An unresolved,
conflicted, or out-of-scope premise does not expand, and truncated connection coverage is not evidence that other
neighbors are absent.

Recall results are unread pointers, not evidence. Read every relevant `threadnote://` result with `read_context` before
using it. Paged text is the default; optional image projection can return a complete memory as PNG pages. Keep recall
compact; use `explain: true` only to diagnose ranking.

Complete the code-brief round trip in both directions. For memory-to-code, follow cited paths and graph IDs from a memory
into the current graph and exact source before relying on the claim. For graph-to-memory, feed relevant current paths or
stable graph IDs back through `context_brief.codeRefs` to retrieve the decisions and handoffs attached to that code.
Treat historical citations as provenance, not proof that current code is unchanged.

When a code-linked brief is truncated and reports `rerun-required`, use the concrete retained follow-up selector to
narrow the next graph call or brief; do not treat omitted cards or memories as absent. Code-linked lookup is local to a
repository. When anchor resolution is partial, use `unresolvedOrdinals` as zero-based positions in the deduplicated
request, correct or remove those refs, and rerun. Keep Workset `cgr_` handles in `inspect_code_graph` instead of passing
them as Context Brief code refs. If a ready graph read fails and the retained action is `graph-status`, inspect that
status and rerun the same brief after the transient condition clears; ready coverage plus an empty card lane is not
evidence that the code is absent.
<!-- END THREADNOTE USER INSTRUCTIONS -->
