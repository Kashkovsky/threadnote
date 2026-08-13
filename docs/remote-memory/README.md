# Managed remote memory

This directory is the engineering and operator documentation for Threadnote's managed remote-memory service. The
service gives ephemeral agents one durable, share-scoped memory plane over Streamable HTTP while exact checkout and
dirty-overlay code evidence stays in the local stdio server.

This is a deployable reference implementation, not a statement that the hosted product is generally available. A
production launch still requires a selected hosting platform and region, an OAuth authorization server, managed keys,
backup policy, external security review, measured SLO evidence, and live Cursor canaries. Public website availability
must not change until those release gates and the corresponding service and CLI releases are live.

## Documents

- [Architecture and decisions](design-decisions.md)
- [Threat model](threat-model.md)
- [Operations, backup, restore, and incidents](operations.md)
- [Git beta migration and exit portability](migration.md)
- [Canary and staged-release gates](canaries-and-release.md)

The local development stack lives in [`deploy/remote-memory`](../../deploy/remote-memory). Use the checkout-local Bun
commands in these documents; a global Threadnote install is neither required nor appropriate for service operation.
The reference deployment separates bootstrap, migration, and runtime PostgreSQL identities; the HTTP runtime never
receives a superuser or schema-owner credential and starts with automatic migration disabled.

## Invariants

- OAuth authorization resolves one immutable tenant/share before any database or index access.
- A Cursor workload attestation attributes a VM/run; it does not make code executing in that VM trusted.
- PostgreSQL heads and immutable revisions are authoritative. The lexical index is derived and recoverable.
- Writes require an operation ID and compare-and-swap semantics; prose is never silently merged.
- Memory is untrusted evidence in MCP descriptions and results.
- The remote share is the exclusive persistent memory source in remote-hybrid mode. There is no local personal-memory,
  Git-share, or alternate-share fallback.
- Git import is one-way. Cutover requires a verified receipt and an explicit Dashboard configuration change. Import
  never deletes the source and never enables dual-write.
- Source, dirty overlays, memory bodies, queries, credentials, and absolute paths do not belong in service telemetry or
  support previews.
