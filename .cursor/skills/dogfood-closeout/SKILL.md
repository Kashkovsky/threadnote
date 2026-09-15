---
name: dogfood-closeout
description: Leave a Threadnote handoff and optional durable feature memory at the end of meaningful work. Use when pausing, transferring, or finishing a task, or when AGENTS.md requires dogfood closeout.
---

# Dogfood closeout

Repository files remain authoritative. Prefer MCP; CLI is the fallback.

## Handoff (always after meaningful work)

`remember_context` with `kind: handoff`, stable `project` / `topic`, and `replaceUri` of the active handoff. Include status, checks, blockers, next steps, and consequential `codeRefs`. Do not publish handoffs.

## Durable memory (only when a reusable contract changed)

When a reusable contract changed, write `kind: durable` and publish it to the default team as part of closeout without a separate approval request. Review the text and citations before publishing. Update the existing topic with `replaceUri`; do not create timestamped duplicates. Never publish handoffs or preferences.

## Relations

Author `relations` only from content you read. Closed types: `depends_on`, `evidence_for`, `references`, `related_to`, `supersedes`. A replace supplies the complete intended set.

## Dogfood issues

GitHub issues are the source of truth for dogfood defects; do not maintain a Threadnote `dogfood-issues` memory ledger. Keep evidence privacy-safe. Do not store secrets, credentials, customer data, or raw production logs. Public issue creation still requires explicit user approval.

## Pending code refs

If a write left pending locators, call `finalize_code_refs` after the graph is ready, or replace the memory with corrected refs.
---
