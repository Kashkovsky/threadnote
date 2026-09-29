---
name: threadnote-memory
description: Preserve reusable Threadnote decisions and concise work handoffs after meaningful work or before transfer.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote memory

Close out in this order:

1. Always write the required private handoff directly with `remember_context(kind=handoff)`, for example
   `remember_context({"kind":"handoff","project":"threadnote","topic":"active-task","callerCwd":"/abs/repo","text":"Status, checks, blockers, and next steps."})`.
   Use a stable project/topic and `replaceUri` when updating an existing handoff.
   Omit `keywords` and `regenerateKeywords` for handoff writes. On replacement, `clearKeywords` is the only supported
   keyword control and removes preserved legacy keywords.
2. Only when the session produced reusable durable knowledge, preview a five-field Knowledge Delta (`decisions` +
   `rationale`, `constraints`, `verificationPerformed`, `knowledgeInvalidated`, `unresolvedRisks`) with
   `review_session_context` using a complete call:
   `review_session_context({"task":"<task>","outcome":"<outcome>","project":"threadnote","callerCwd":"/abs/repo","sourceCommit":"<commit>","decisions":["<decision>"],"rationale":"<why>","constraints":[],"verificationPerformed":["<check>"],"knowledgeInvalidated":[],"unresolvedRisks":[]})`.
   Candidate material requires evidence such as `sourceCommit`, `sourceSessionId`, or an evidence pointer.
3. The Knowledge Delta and returned memory candidates are one optional review lifecycle, not separate writes. Present
   candidates to the user and call `apply_memory_candidates` only after an explicit `approve` (optionally with
   `editedText`), `defer`, or `reject`. Without a user decision, leave candidates unapplied. If there is no reusable
   durable delta, stop after the handoff. Never auto-apply or auto-share proposals.

Use `kind: durable` for reusable decisions and contracts; keep status, checks, blockers, and next steps in
`kind: handoff`. Stable project/topic identities and `replaceUri` prevent duplicates. Confirm before durable sharing.
Author `relations` only from memories you read or explicit review evidence; a replacement supplies the complete set, so
carry forward every still-valid relation when using `replaceUri`.

For consequential code claims, cite a few graph-indexed paths or `cgs_`/`cgr_` handles and state observed verification.
Active personal writes with code refs use MCP `citationPolicy: "defer"` or CLI `--defer-code-refs`; strict/shared writes
use `citationPolicy: "require-current"` or `--require-current-code-refs`. Finalize the private pending anchor with
`finalize_code_refs` or `threadnote finalize-code-refs` after a ready graph; unresolved locators require replacing refs.
Use `share_publish` for ordinary approved durable team publication; use `share_propose` only for an applied reviewed
delta export. Never share pending anchors.

Maintenance: `threadnote context check --project <name>` checks direct citations for changed, deleted, and renamed paths.
Inspect health with `context_health`/`context_health_aggregate`; preview and apply repairs or metadata through
`context_health_repair_preview`/`context_health_repair_apply` and `context_metadata_preview`/`context_metadata_apply`;
use `context_health_schedule` for recurring checks.
Record `recall_feedback` as useful/wrong/pin/dismiss/applied; inspect it with `threadnote value report`.
`procedure_publish_preview` precedes approved `procedure_publish_apply`; verify with
`threadnote procedure verify <manifest>`. `threadnote guidance import` and `threadnote guidance project` manage CLI
guidance. Use `complete_activation_retrieval_proof` where applicable. Procedures never auto-execute. Use
`threadnote_guide` for a state-aware capability/setup tour; follow tool-returned actions for uncommon recovery.

Do not store secrets, credentials, customer data, or raw production logs. Never publish handoffs or preferences,
overwrite conflicting changes, or force synchronization without explicit approval.

<!-- END THREADNOTE USER INSTRUCTIONS -->
