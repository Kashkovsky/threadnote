# Remote-memory architecture and ADRs

Status: implemented reference architecture; production activation pending release gates.

## System boundary

Cursor remote-hybrid mode deliberately configures two MCP servers:

```text
Cursor Cloud Agent
  |-- threadnote-local  (stdio, VM checkout)
  |     code graph, exact commit, dirty overlay, diagnostics, attestation helper
  |
  `-- threadnote-memory (Streamable HTTP, managed service)
        durable memories, durable handoffs, lifecycle, generations
```

The HTTP service never receives repository source or a dirty overlay. The stdio server never reads or writes persistent
memory in remote-hybrid mode. If the HTTP service is unavailable, memory fails closed while local graph inspection
remains available.

## ADR 1: two servers, not a transport multiplexer

Decision: use one local stdio server for checkout evidence and one share-scoped HTTP server for persistent memory.

Why:

- VM-local source truth and remotely durable context have different trust, lifetime, and failure boundaries.
- A single fallback chain could silently broaden memory scope or upload source.
- Each plane can be verified, revoked, and operated independently.

Consequence: clients must show failures by plane. Remote failure never selects personal memory or the Git beta.

## ADR 2: OAuth principal plus Cursor workload OIDC

Decision: MCP OAuth authenticates and authorizes the human/service principal. A short-lived, nonce-bound Cursor OIDC
token completes an out-of-band challenge and attributes managed-cloud writes.

Authorization is the conjunction of active tenant membership, active share grant, OAuth scope, share/project
containment, feature flags, write-kind policy, and—when required—a fresh workload attestation matching configured
owner, team, and complete repository claims.

The provider contract follows Cursor's published Cloud Agent identity API: mint over `CURSOR_AGENT_SOCKET` with the
service audience and challenge nonce; require issuer `https://api.cursor.com`, JWKS `https://api.cursor.com/keys`,
`RS256`, `agent_runtime: managed`, the default owner `sub`, the current `owner_user_id` or
`owner_service_account_id`, and the complete scheme-free `repo_urls`/`repo_count` set. See
[Cursor OIDC tokens](https://cursor.com/docs/cloud-agent/identity) and
[Cursor Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities).

The service stores only the verified claim subset and token identifier. It never stores or returns the raw Cursor JWT.
Attestation is not authentication on its own and cannot widen OAuth/share authority.

Production choice still required: select and operate the OAuth authorization server, client-registration policy, key
rotation, and revocation path. The resource-server implementation consumes standards-compatible access tokens and JWKS;
it does not pretend to be that authorization server.

## ADR 3: immutable remote addressing

Decision: canonical URIs use opaque immutable share IDs:

```text
threadnote://share/<share-id>/memories/durable/<project>/<topic>.md
threadnote://share/<share-id>/memories/handoffs/active/<project>/<topic>.md
```

Names and slugs are display metadata, never authority. A client URI may narrow only within the share injected by the
authorized grant. Git-beta aliases are resolved only after tenant/share authorization and always return the new
canonical URI.

## ADR 4: PostgreSQL is authoritative for the hosted SaaS flavor

Decision: in the hosted Cursor Cloud / Postgres-as-body flavor, current heads and immutable revisions live in
PostgreSQL. Every committed mutation atomically records the head change, share generation, idempotency outcome, outbox
event, and bounded audit metadata.

This ADR is **not** the organization default. Organization shared-memory bodies are Git-canonical (ADR 8). Keep this
flavor as an optional hosted path with one-way Git import/export. Do not dual-write Git and Postgres bodies.

Controls:

- application tenant/share predicates and forced PostgreSQL row-level security;
- per-logical-key locking and mandatory base-revision checks;
- caller/principal-scoped operation idempotency;
- canonical Markdown and SHA-256 content identity;
- server-side sensitive-data/path blocking;
- no memory body or query in audit events.

The lexical index is a derived projection. Recall overlays not-yet-indexed authoritative revisions and reports both
committed and indexed generations. A failed index can be rebuilt without rewriting revisions.

## ADR 5: no implicit Git fallback or dual-write

Decision: a Cursor environment uses either the Git beta memory plane or managed remote memory, never both. Migration
plans are deterministic and content-hash verified. Apply creates aliases and an immutable receipt. A successful receipt
still says `switch: explicit_required`, `dualWrite: disabled`, and `sourceDeletion: not_performed`.

Rollback from managed memory means export, verify, intentionally update the Dashboard configuration, then make the Git
destination authoritative. The service does not replay writes into an old checkout.

## ADR 6: lifecycle and retention are non-destructive first

Decision: handoffs transition `active -> superseded`, `active -> archived`, or `active -> expired -> archived` through
the same immutable revision/CAS machinery. The retention worker expires eligible heads; it does not delete content.

Durable memories do not accept lifecycle/expiry input in this contract. Supporting it later requires an explicit
durable retention, export, legal-hold, backup-expiry, and deletion design rather than silently reusing handoff expiry.

Retention and indexing are share-fair: each batch takes at most one item per share per round and rotates the starting
share between passes. Multiple workers may contend, but `SKIP LOCKED` misses are not reported as progress and lifecycle
CAS permits only the committed transition to count as expiry.

Deletion requires an organization policy, export-before-delete evidence, backup-expiry accounting, and a separate
audited operator action. No default may silently remove the last active handoff.

## ADR 7: one explicit region per tenant for beta

Decision: each tenant is provisioned in one named region. Database, backups, logs, and workers for that tenant stay in
the selected region. Cross-region movement is an export/restore/re-authorization operation, not transparent
replication.

Production choice still required: supported regions, backup locations and retention, deletion SLA, failover topology,
and customer-visible residency controls.

## ADR 8: Git is canonical for organization shared-memory bodies

Decision: organization composer mode (`THREADNOTE_REMOTE_CANONICAL_STORE=git`) stores Markdown bodies in the same Git
memory repository local `share publish` / `share sync` already uses. PostgreSQL keeps grants, OAuth, generations,
idempotency, outbox, and `git_commit` / `git_path` / `content_hash` pointers. `markdown_body` is empty in this mode.

The HTTP composer is an additional Git writer for credential-less agents. It is not the only writer. Concurrent Git
updates fail closed with an explicit conflict; the composer never silent-merges. Local share remains a Git writer of
the same repository. The derived lexical index is rebuildable from Git.

Deploy-time configuration selects `git` or `postgres`. This is not a product feature flag.

## Compatibility

All remote request, receipt, portability, and operator artifacts carry explicit version `1`. Schema rollouts use
expand/migrate/contract and must keep old and new binaries compatible during deployment. Canonical Markdown is the exit
format; a service-specific database dump is not the only portability path.
