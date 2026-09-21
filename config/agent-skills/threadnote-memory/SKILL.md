---
name: threadnote-memory
description: Preserve reusable Threadnote decisions and concise work handoffs after meaningful work or before transfer.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote memory

At closeout, write the required private `remember_context(kind=handoff)` separately. For optional durable knowledge,
review a five-field Knowledge Delta (`decisions` + `rationale`, `constraints`, `verificationPerformed`,
`knowledgeInvalidated`, `unresolvedRisks`) with `review_session_context`; apply candidates only after explicit
`approve` (optionally with `editedText`), `defer`, or `reject` via `apply_memory_candidates`. Never auto-apply or
auto-share proposals. Use `kind: durable` for reusable decisions and `kind: handoff` for status, checks, blockers, and
next steps; stable project/topic identities and `replaceUri` prevent duplicates. Confirm before durable sharing.
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
