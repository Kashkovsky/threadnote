# Remote-memory operations

Status: reference runbook. The numeric objectives below are beta engineering targets, not public availability promises.

## Local development stack

Copy `deploy/remote-memory/.env.example` to an untracked `.env`, replace every placeholder, and keep it out of Git. The
database URL must match the PostgreSQL password; URL-encode special characters. Then use:

```sh
docker compose --env-file deploy/remote-memory/.env \
  -f deploy/remote-memory/compose.yaml up --build
```

The port binds only to `127.0.0.1:8787`. The reference container runs unprivileged, read-only, with all Linux
capabilities dropped. Local HTTP is permitted only on loopback. Production requires TLS at the edge and TLS to
PostgreSQL, managed secrets, network isolation, encryption at rest, signed images, and a regional backup policy. Do not
treat Compose as a production topology.

### Git-canonical organization composer

Default Compose is the hosted Postgres-body flavor (`THREADNOTE_REMOTE_CANONICAL_STORE=postgres`). Organization mode
sets `THREADNOTE_REMOTE_CANONICAL_STORE=git` and clones the team memory repository into
`THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE` (`/var/threadnote/memory-git` in the reference Compose volume). The runtime
container stays read-only; Git writes go only to that mounted worktree. The runtime image installs `git`, and
`memory-git-prepare` chowns the Compose volume to the unprivileged `bun` user (uid 1000). Git-mode readiness fails
closed when `git` is missing, the worktree is not a repository, or it is not writable. Git deploy keys stay on the
composer host, never in a cloud agent VM. Initialize the worktree as a clone of the share remote before enabling git
mode; an empty volume is not a repository.

Git mode also requires `THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID` and
`THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID`, matching the operator-provisioned tenant and share. One composer clone
serves exactly that pair. Requests, Git ingestion, index projection and handoff expiry cannot use it for another
share, even if another share is provisioned in the same database. Local `composer serve` supplies this binding
from its tenant/share options. Existing Git-mode deployments must add these values before upgrading; missing
bindings fail startup. The Postgres canonical-body flavor continues to support its existing multi-share model.

Operator provisioning also creates a dedicated `system:git-ingest` identity for each tenant/share. Re-run the
existing provisioning document once when upgrading a Git deployment; runtime credentials cannot create this
identity. Its grant follows share feature flags and active projects, independently of interactive members.
Git may add previously unknown projects to the catalog but cannot reactivate an archived project. Member
permissions still govern every client read and write. Re-provisioning does not undo an explicit revocation of
the ingestion identity. Missing or revoked ingestion authority fails ingestion; `git_ingest_failed` keeps
readiness unhealthy until a subsequent ingestion succeeds, including across intervening projection-only passes.

Remote body replacement currently accepts only the metadata emitted by the basic remote editor. A Git memory
with citations, relations, keywords, provenance, unknown headers, or legacy metadata is rejected before any
canonical write. Edit those records through the Git share until the remote API supports their metadata; this
prevents silent loss of local product information. Basic remote documents retain their identity and creation time.

### Database roles

The Compose stack demonstrates three separate database identities:

| Identity                       | Where it is available                         | Contract                                                                                        |
| ------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PostgreSQL bootstrap superuser | Database bootstrap/container only             | Creates the database roles. Never inject it into an application, migration, worker, or canary.  |
| `threadnote_remote_migrator`   | One-shot migration and approved operator jobs | `NOSUPERUSER NOBYPASSRLS`; owns the service schema and may apply reviewed DDL.                  |
| `threadnote_remote_runtime`    | HTTP service and data-plane workers only      | `NOSUPERUSER NOBYPASSRLS`; schema `USAGE` plus table DML only; no schema creation or migration. |

`THREADNOTE_REMOTE_AUTO_MIGRATE=false` is mandatory on every runtime service. Migrations run as a separate, one-shot
job before the runtime starts. A second one-shot grant job revokes any prior runtime privileges and applies the explicit
table-operation allowlist in `deploy/remote-memory/grants/001-runtime.sql`; it fails closed when a schema change has not
updated that contract. The runtime cannot modify schema migrations, control-plane policy, provisioning directories, or
import receipts. Each identity has a different password and URL; URL-encode password characters in a connection URL.
The `.env.example` values are local placeholders, not secret-management guidance.

`THREADNOTE_REMOTE_ENABLED=false` is the environment-wide kill switch. Keep it false until the selected tenant/share
canary is approved; both this switch and the share-scoped `remote_memory_ga` flag must be enabled for MCP traffic.

The init script runs only when PostgreSQL creates an empty data volume. Changing `.env` does not rotate roles in an
existing volume. Production role creation and rotation must use the managed database's privileged bootstrap path and
then revoke that access from deploy/runtime automation. Verify with `pg_roles` that both service roles have
`rolsuper=false` and `rolbypassrls=false`, and prove RLS using two-tenant negative tests under the runtime role. Do not
grant table ownership, `BYPASSRLS`, or a superuser credential to work around a failed migration or policy.

Run the checkout-local operator with the migrator/operator URL—never put credentials on its command line:

```sh
THREADNOTE_REMOTE_DATABASE_URL='postgresql://...' \
  bun src/standalone.ts remote-memory-operator migrate

THREADNOTE_REMOTE_DATABASE_URL='postgresql://...' \
  bun src/standalone.ts remote-memory-operator provision --input ./provision.v1.json
```

Provisioning input contains tenant/share/principal IDs, issuer/subject mapping, capability and project policy, Cursor
owner/team policy, feature flags, region, and repository bindings. Restrict the file to the operator and delete it under
the normal change record. It must not contain an access token, client secret, database password, or private key.

The share-wide project catalog and repository bindings are versioned separately from each member grant. A new share
can be provisioned with a document shaped like this:

```json
{
  "tenantId": "tenant-example",
  "shareId": "share-example",
  "principalId": "principal-example",
  "issuer": "https://auth.example.test",
  "subject": "opaque-oauth-subject",
  "displayName": "Example managed memory",
  "region": "eu-example-1",
  "sharePolicyVersion": "share-v1",
  "policyVersion": "grant-v1",
  "projects": ["threadnote"],
  "repositoryBindings": {
    "threadnote": ["https://github.com/example/threadnote"]
  },
  "allowedProjects": ["threadnote"],
  "capabilities": ["memory:read", "memory:write:durable", "memory:write:handoff"],
  "cursorSubjects": ["user:12345"],
  "cursorOwnerIds": ["12345"],
  "cursorTeamId": "6789",
  "cursorAttestationRequired": true,
  "featureFlags": [
    "remote_memory_read",
    "remote_memory_durable_write",
    "remote_memory_handoff_write",
    "cursor_oidc_required",
    "remote_memory_ga"
  ]
}
```

Adding or replacing a member grant does not replace that catalog. A share-wide change must provide a new
`sharePolicyVersion`, the exact `expectedCurrentSharePolicyVersion`, and the complete `projects`,
`repositoryBindings`, and `featureFlags` desired state. A grant change uses its own `policyVersion` and
`expectedCurrentPolicyVersion`; an omitted `allowedProjects` means every active project in the share catalog, not an
unprovisioned project name.

## OAuth provider configuration

Set `THREADNOTE_REMOTE_OAUTH_ISSUER` to the provider's exact issuer identifier, including any trailing slash.
The same string must appear in the signed token's `iss` claim and the operator-provisioned member identity.
For an Auth0 tenant this is typically `https://<tenant>.<region>.auth0.com/`. Issuer comparison is exact; do not
remove the slash to match an origin. JWKS must stay on the issuer's origin.

The API audience must equal the public `/mcp` URL. Configure RS256 access tokens with a five-minute lifetime;
the verifier requires `sub`, `iat`, and `exp`, caps lifetime at ten minutes plus five seconds of clock tolerance,
and validates `nbf` when present. A missing optional `nbf` claim is accepted; malformed or inconsistent time
claims are rejected. The loopback demo issuer remains restricted to local development.

Register a public OAuth client for each agent and use authorization code with S256 PKCE. A public client has
no client secret in the agent configuration. Pass its ID when attaching Cursor on a laptop:

```sh
threadnote mcp-install cursor --project /absolute/repository \
  --composer-url https://memory.example.test/mcp --share-id engineering \
  --composer-client-id REGISTERED_PUBLIC_CLIENT_ID --apply
```

For Cursor Cloud, `threadnote cloud cursor config --mode org --endpoint https://memory.example.test/mcp
--share-id engineering --client-id REGISTERED_PUBLIC_CLIENT_ID` prints the corresponding configuration.
Both commands retain the existing stdio/graph split and bind the share in the HTTP header. Omitting the client ID
retains the legacy `threadnote-composer` demo ID; use that default only with the loopback demo issuer. Production
issuers require their registered ID. These commands do not obtain or persist tokens; complete OAuth login in the agent.

Cursor's published callbacks are `http://localhost:8787/callback` for desktop and
`https://www.cursor.com/agents/mcp/oauth/callback` for web/cloud. Register only the surfaces in use and validate an
actual login after installation. Configuration shape alone does not establish provider or agent compatibility.

VS Code/Copilot uses `type: "http"` and `oauth.clientId`; the installer and dry-run output select that schema
for `mcp-install copilot`. Cursor uses `auth.CLIENT_ID` and explicit scopes. Register a separate public client
with the callback URLs required by the selected application. See the
[VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

Codex has its own HTTP OAuth configuration; do not copy Cursor's `auth.CLIENT_ID` object into it. Register the
client with `codex mcp add threadnote-org --url https://memory.example.test/mcp --oauth-client-id
REGISTERED_PUBLIC_CLIENT_ID --oauth-resource https://memory.example.test/mcp`, then configure its share header
and registered callback in the existing `mcp_servers.threadnote-org` entry:

```toml
http_headers = { threadnote-share-id = "engineering" }
oauth = { client_id = "REGISTERED_PUBLIC_CLIENT_ID", callback_url = "http://127.0.0.1:18789/callback", callback_port = 18789 }
```

The listener port must match the registered callback, and the issuer must advertise issuer-response support for a
fixed callback without Codex's server-specific suffix. Complete `codex mcp login threadnote-org --scopes
memory:read,memory:write:durable,memory:write:handoff`. Keep the local Threadnote stdio entry enabled.
Threadnote's `mcp-install --composer-url` workflow currently automates Cursor/Copilot JSON configuration only.

References: [Cursor static OAuth](https://prod.cursor.com/docs/mcp#static-oauth-for-remote-servers),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), and
[Auth0 MCP setup](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server).

## Health and safe telemetry

- `/healthz`: process liveness only.
- `/readyz`: constant-time readiness from two privacy-safe `worker_health` aggregate rows plus the instance-local worker
  supervisor. Both workers need a successful pass and a heartbeat no older than two minutes; the indexer also becomes
  unavailable when the oldest pending event is older than five minutes or a dead letter/failure is present. This public
  path never enumerates tenants, shares, or outbox rows.
- `memory_status`: authorized share generations, consistency, policy version, and writable capabilities.

An indexer or retention task that rejects or exits normally before shutdown immediately fails local readiness, drains
the HTTP server, stops the other worker, closes PostgreSQL, and terminates the service non-zero. The Compose
`restart: unless-stopped` policy then starts a fresh instance. The worker rows contain only a fixed worker name,
timestamps, bounded counts, and a stable failure class—never a tenant/share identifier, URI, query, or memory body.

Worker scheduling is share-fair: a batch claims at most one ready item per share per round and rotates the first share
between passes. An outbox `FOR UPDATE SKIP LOCKED` miss is not counted as processed; claim, projection, projection
failure bookkeeping, and the returned outcome are transactionally aligned. Retention uses the same rotating share
boundary, and lifecycle CAS makes concurrent expiry losers report contention rather than duplicate success.

Track request count/duration/result by tool/region/privacy-safe tenant bucket, OAuth and authorization failure class,
attestation success/failure/age, transaction conflicts/replays, share-index generation lag, oldest outbox age, handoff
lifecycle counts, rate-limit/circuit events, and backup/restore/migration/index-rebuild status.

Never record memory bodies, query text, canonical URI paths, repository source, absolute paths, bearer/OIDC tokens, or
JWKS contents. Error and support paths must use stable classes and opaque request IDs only.

Initial beta targets:

- 99.9% monthly authenticated read/write availability;
- p95 read under 300 ms in-region;
- p95 bounded recall under 1.5 seconds in-region;
- p95 write transaction under 750 ms, excluding asynchronous indexing;
- 99% of mutations indexed within 10 seconds;
- revocation effective for new requests within 60 seconds;
- zero acknowledged writes lost in restore drills.

## Deploy and schema changes

1. Verify image provenance, lockfile, dependency/SBOM and container scans.
2. Back up PostgreSQL and record the last verified restore point.
3. Run the operator `migrate` job once with the `NOSUPERUSER NOBYPASSRLS` migrator role under an advisory lock. A
   changed applied migration checksum is fatal.
4. Apply and review the versioned runtime grant allowlist; confirm the runtime role has no DDL/control-plane mutation,
   set `THREADNOTE_REMOTE_AUTO_MIGRATE=false`, and deploy expand-compatible service and worker versions. Watch
   readiness, auth failures, conflicts, outbox age, and lag.
5. Run read canaries, then write/concurrency canaries only for an isolated fixture share.
6. Advance tenant/share feature flags in the documented stage order.
7. Contract old schema only in a later release after old binaries are gone and rollback no longer needs it.

If a migration or binary fails, disable new/writable traffic and roll back the binary. Never edit or delete committed
revisions to make a rollback pass. Restore only for proven data corruption/loss and follow the reconciliation procedure.

## Outage and incident behavior

### PostgreSQL unavailable

Remove unhealthy instances from traffic. Reject reads/writes; never acknowledge or buffer a mutation only in memory.
Keep local graph tools available. Investigate database availability without logging connection strings. Restore service,
verify migrations and generations, drain outbox, then run read/write canaries.

### OAuth/JWKS unavailable or revocation uncertain

Fail authentication closed. Do not use stale/unverified keys beyond the configured verifier policy. Keep health
diagnostics privacy-safe, restore issuer reachability, verify rotation/revocation, then canary.

### Index lag or worker failure

Authorized reads remain authoritative. Recall uses the recent-write overlay and reports committed/indexed generations.
Page when oldest outbox age or generation lag breaches target. Fix the cause, retry named dead letters, and verify
contiguous generation advancement. Do not manually set `indexed_generation` ahead of unprocessed events.

### Expired control-plane state

Every retention pass performs bounded cleanup. It enumerates only the opaque share directory outside RLS and enters the
tenant context before touching tenant data, including disabled tenants and deleted shares. Per-tenant work clears an
expired idempotency replay `outcome` but permanently retains its operation ID and request-hash tombstone, deletes only
aliases whose explicit compatibility expiry has elapsed, and replaces expired workload identity evidence with opaque
sentinels while clearing turn/team/owner/repository metadata. Already-cleared rows do not churn on later passes.

The operation ID binds to its request hash permanently. For 24 hours, an exact retry replays the committed receipt
(with the current invocation's request ID) or the retained terminal rejection. A cancellation or uncertain driver
outcome is retained as `service_unavailable` and is never re-executed. After the replay outcome expires, an exact retry
fails with `idempotency_mismatch` and `reason: outcome_expired`; a changed request always fails with
`idempotency_mismatch`. Recovery therefore uses a new operation ID only after the caller has reconciled authoritative
state.

Lifecycle expiry is supported only for handoffs. Durable-memory lifecycle input is rejected until a separate durable
retention and deletion contract exists; operators must not infer durable deletion from handoff cleanup.

### Excess authorization failures

Determine stable failure class and affected privacy-safe tenant bucket. Check issuer/audience, grants, flags, share and
repository policy, revocation, and clock health. Do not inspect raw access tokens. Suspected cross-tenant access is a
security incident: disable affected flags/traffic, preserve bounded audit evidence, rotate/revoke as required, and
notify the security owner.

### Suspected content or credential leak

Disable writes/export/support preview for the affected scope. Do not paste the suspected value into tickets or logs.
Record only opaque IDs and detection category, revoke exposed credentials through their authority, preserve audit
metadata, follow deletion/backup-expiry obligations, repair the scrubber, and add a redacted regression fixture.

## Backup and restore

Use encrypted, region-bound PostgreSQL backups with point-in-time recovery. Back up every authoritative table, including
revisions, heads, grants/policy, aliases and expiry, idempotency/import receipts, outbox, audit, and attestations. The
derived `search_documents` table may be backed up for speed but is never the only recovery source.

Restore drill:

1. Restore into an isolated network and credentials; keep client traffic disabled.
2. Verify schema migration checksums.
3. Reconcile every head to an existing revision and recompute every revision content hash.
4. Compare per-share head/revision counts and maximum committed generation with pre-backup evidence.
5. Clear/rebuild the derived index as below; do not mutate revisions.
6. Run two-tenant RLS, alias-expiry, idempotent replay, read, write, lifecycle, and canary checks.
7. Switch traffic only after the prior acknowledged generation is present. Keep the previous environment until signed
   verification completes.

Backup expiry and deletion SLA remain production policy choices. A deletion is not complete until primary data, index,
exports, replicas, and backups have reached their documented expiry obligations.

## Full index rebuild

Perform rebuild in an isolated maintenance window or a new index generation:

1. Keep PostgreSQL heads/revisions available; optionally leave recall on the previous verified projection plus overlay.
2. Reset the derived search projection and mark or recreate one `memory_head_changed` event per current head without
   changing share generations or revisions.
3. Run the indexer until no ready event remains and no dead letter is unresolved.
4. Verify every current head has a search document for its current revision and generation.
5. Advance only the contiguous indexed generation; compare bounded recall fixtures against authoritative records.
6. Make the rebuilt generation ready, retain the prior ready generation until verification, then retire it.

The current worker exposes outbox processing and named dead-letter retry. A one-command destructive rebuild is
intentionally not exposed yet; operators must use a reviewed, tenant-scoped maintenance script and change record.

## Rollback

Feature-flag rollback order is `remote_memory_ga`, handoff write, durable write, then read. Disabling a flag blocks new
operations but never rewrites/deletes committed data. Roll back service/worker binaries only across schema-compatible
versions. Returning a tenant to Git requires a verified export and explicit Cursor Dashboard switch; see migration.md.
