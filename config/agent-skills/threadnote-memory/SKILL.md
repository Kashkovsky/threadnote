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
references. Capture requires a ready exact-current graph. These anchors power the code-brief round trip: future agents
can move from memory back to verified current code and from graph evidence to the memories that cite it. Prefer a few
consequential anchors over broad file lists. Never store secrets, credentials, customer data, or raw production logs.
Confirm with the user before publishing durable memory; never publish handoffs or preferences, overwrite conflicting
changes, or force synchronization without explicit approval.
<!-- END THREADNOTE USER INSTRUCTIONS -->
