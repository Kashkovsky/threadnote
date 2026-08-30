---
name: threadnote-memory
description: Preserve reusable Threadnote decisions and concise work handoffs. Use after meaningful work, when a contract changes, or before pausing and transferring a task.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote memory

Store reusable decisions and contracts with `kind: durable`. Store status, checks, blockers, and next steps with
`kind: handoff`. Use stable `project` and `topic` identities and update existing memory with `replaceUri` instead of
creating timestamped duplicates. Use `review_session_context` only for additional candidates that require explicit
approval.

For consequential source claims, attach graph-indexed repository paths or returned `cgs_` and `cgr_` handles as code
references. Threadnote first attempts capture from a ready exact-current graph and never starts indexing during the
write. For active personal memory with explicit code references, a retryable graph-readiness failure stores the memory
and queues a private pending anchor by default. Shared and inactive writes remain strict. Use MCP
`citationPolicy: "require-current"` or CLI `--require-current-code-refs` only when the memory must fail before writing.

Pending locators are not citations or graph-to-memory backlinks and cannot be shared. Prepare the graph explicitly;
Threadnote then retries matching intents automatically after graph/Workset preparation and during the next local
code-linked Context Brief. If an intent remains pending, call `finalize_code_refs`, run
`threadnote finalize-code-refs`, or replace the stored memory using the receipt URI. These anchors power the code-brief
round trip: future agents can move from memory back to verified current code and from graph evidence to the memories
that cite it. Prefer a few consequential anchors over broad file lists.

When a memory moves during replacement, publication, or unpublication, old `threadnote://` pointers may resolve through
a private identity-fenced relocation receipt. Follow the `canonicalUri` returned by `read_context`; a relocation is
pointer continuity, not evidence that the memory's claims are still current.

Never store secrets, credentials, customer data, or raw production logs. Confirm with the user before publishing
durable memory; never publish handoffs or preferences, overwrite conflicting changes, or force synchronization without
explicit approval.
<!-- END THREADNOTE USER INSTRUCTIONS -->
