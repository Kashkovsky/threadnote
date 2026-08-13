# Remote-memory canaries and staged release

The repository includes a privacy-safe MCP canary at `scripts/remote-memory-canary.ts`. It emits check names, mode,
status, and stable error classes only. It never prints an access token, attestation, query, URI, memory body, source, or
absolute path.

## Checkout-local invocation

Use only an isolated fixture tenant/share and an access token injected by a protected runner. Do not expose service
credentials to repository code running inside a Cursor agent. Read mode is non-mutating:

```sh
THREADNOTE_CANARY_ENDPOINT='https://memory.example.test/mcp' \
THREADNOTE_CANARY_SHARE_ID='sh_fixture' \
THREADNOTE_CANARY_ACCESS_TOKEN="$PROTECTED_FIXTURE_TOKEN" \
THREADNOTE_CANARY_PROJECT='threadnote-canary' \
THREADNOTE_CANARY_MODE='read' \
  bun scripts/remote-memory-canary.ts
```

Optional `THREADNOTE_CANARY_EXPECT_URI` proves a durable memory from an earlier run remains available to a fresh client.
`write` mode creates an isolated topic and reads it through a fresh stateless HTTP request. `concurrency` additionally
checks one-winner same-topic CAS behavior and independent-topic progress. If the share requires Cursor OIDC, inject only
the opaque `THREADNOTE_CANARY_ATTESTATION_ID`; obtain it through a real Cursor-managed attestation flow.

The script is a protocol/data-plane canary, not proof of a Cursor environment. Real clean/resumed VM tests must run as
protected manual/scheduled Cursor jobs against fixture-only repositories and shares.

## Required matrices

Every release candidate:

- Streamable HTTP initialize/tool list/call/error/cancellation tests;
- OAuth discovery, resource indicator, PKCE/static client policy, expiry, revocation, and JWKS rotation;
- PostgreSQL rollback injection, two-tenant RLS, CAS/idempotency, outbox/overlay, alias expiry, lifecycle;
- backup restore followed by hash reconciliation and full index rebuild;
- load/soak with bounded bodies/responses and fault injection for database, JWKS, network, and worker failures;
- dependency/SBOM, container, secret, and license scan.

Protected real Cursor canaries:

- completely clean VM with no memory checkout;
- equivalent resumed Build with idempotent setup;
- stale local binary detection;
- two agents writing different topics;
- two agents racing from one base revision;
- long run with attestation expiry and renewal;
- wrong repository, multi-repository, and revoked-grant cases;
- remote outage while local graph inspection continues without memory fallback;
- fresh VM recalling a durable memory and handoff written by an earlier VM.

Record only opaque run/build/share/request identifiers and pass/fail metrics. Do not retain agent prompts, source,
memory bodies, queries, tokens, or raw production logs as canary evidence.

## Feature flags and stages

Flags are tenant/share scoped:

```text
remote_memory_read
remote_memory_durable_write
remote_memory_handoff_write
cursor_oidc_required
git_beta_import
remote_memory_ga
```

Rollout:

1. Local protocol/storage fixtures.
2. Internal tenant, read-only.
3. Internal durable writes with Cursor OIDC required.
4. Internal multi-agent handoffs.
5. Selected external read-only canaries.
6. Selected external writable canaries.
7. Remote beta with verified migration tooling.
8. GA only after measured SLO, security, restore, and live Cursor gates.

At each stage, define tenant owners, region, backup/deletion policy, OAuth client policy, alert routing, observation
window, success thresholds, and the exact flags to disable. Any cross-tenant access, source upload, token/content leak,
unreconciled hash/generation, acknowledged-write loss, or unavailable local graph during memory outage blocks rollout.

## Rollback

Disable new traffic or writable flags first; never rewrite/delete committed revisions. Keep the prior verified service
and index generation. A schema rollback must use compatible expand/migrate/contract sequencing. Return to Git only by
verified export and explicit Dashboard configuration as documented in migration.md—never automatic replication.

## Website and release gate

Do not describe the managed integration as live on the public website until the service and CLI releases are deployed,
supported OAuth/regions/retention are chosen, live clean/resumed/concurrency/multi-agent canaries pass for the intended
audience, security/privacy and restore evidence is approved, and public instructions can take a user from OAuth setup
through a fresh-VM durable-memory and handoff recall. Until then, repository docs must say reference implementation or
in development.
