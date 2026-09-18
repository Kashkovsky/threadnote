# Organization pilot provisioning

The organization pilot uses a preview-first operator flow for PostgreSQL memory shares. A plan records the exact
tenant, share, principal, OAuth issuer/subject/client binding, requested grant, and current control-plane versions. Apply
revalidates that state and uses the recorded policy versions as compare-and-swap guards. The resulting receipt contains
identifiers and policy digests, but no memory content, OAuth subject, or client ID.

The implementation is provider-neutral. Configure the access-token claim that carries the OAuth client ID; for an Okta
custom authorization server this is `cid`:

```sh
export THREADNOTE_REMOTE_OAUTH_CLIENT_ID_CLAIM=cid
export THREADNOTE_REMOTE_DATABASE_URL='postgresql://...'
```

Do not place database credentials, OAuth client secrets, access tokens, or refresh tokens in a provisioning manifest.

When upgrading subject-only identities, first set an explicit transition deadline no more than 31 days ahead, then
create an exact client-bound plan for every admitted identity:

```sh
export THREADNOTE_REMOTE_OAUTH_LEGACY_CLIENT_ID_COMPATIBILITY_UNTIL='2026-10-01T00:00:00.000Z'
```

During this bounded window, an exact client binding takes precedence over the legacy subject-only row. Remove the
compatibility setting after every pilot identity has an exact binding. At the deadline, unmatched legacy rows stop
authorizing automatically. Do not enable client-claim extraction on an upgraded deployment without either completing
the backfill first or setting this bounded bridge.

## Read-only enrollment

Omit `capabilities` to use the safe `memory:read` default. Bind every pilot identity to its exact issuer, subject, and
client ID. This prevents another OAuth application with the same user subject from inheriting the grant.

```json
{
  "clientId": "OKTA_NATIVE_CLIENT_ID",
  "displayName": "Pilot organization memory",
  "issuer": "https://example.okta.com/oauth2/threadnote",
  "policyVersion": "pilot-reader-v1",
  "principalId": "pilot-reader",
  "projects": ["threadnote"],
  "region": "eu-pilot-1",
  "repositoryBindings": {
    "threadnote": ["https://github.com/example/threadnote.git"]
  },
  "shareId": "pilot-memory",
  "sharePolicyVersion": "pilot-share-v1",
  "subject": "00u-example-reader",
  "tenantId": "pilot-organization"
}
```

Create and inspect a preview. The output path must not already exist:

```sh
threadnote remote-memory-operator provision-plan \
  --input pilot-reader.json \
  --output pilot-reader.preview.json
```

After reviewing the preview, create a state-bound apply plan and apply it:

```sh
threadnote remote-memory-operator provision-plan \
  --input pilot-reader.json \
  --output pilot-reader.apply.json \
  --for-apply

threadnote remote-memory-operator provision-apply \
  --plan pilot-reader.apply.json \
  --receipt pilot-reader.receipt.json
```

Apply fails before writing when the plan is a preview, its digest is invalid, its grant has expired, or the tenant,
identity, membership, share, or grant changed after planning. The reviewed state is compared while the authorization
rows are locked. A revoked membership or grant is never resumed by provisioning. Generate a new preview and apply plan
after resolving the reported state change through a separate lifecycle action.

The database stores the plan identity and content-free receipt in the same transaction as provisioning. Reapplying the
same plan returns the same receipt after a process exit or receipt-file failure; reusing its plan ID with a different
digest or outcome is rejected.

## Time-bounded write enrollment

Any capability beyond `memory:read` is treated as write-capable for pilot provisioning. A write grant must list one or
more `allowedProjects`, bind an OAuth client ID, and use an exact ISO `grantExpiresAt` no more than 31 days after plan
creation. External identities cannot receive `memory:admin`.

```json
{
  "allowedProjects": ["threadnote"],
  "capabilities": ["memory:read", "memory:write:durable"],
  "clientId": "OKTA_NATIVE_CLIENT_ID",
  "cursorAttestationRequired": true,
  "cursorSubjects": ["user:12345"],
  "displayName": "Pilot organization memory",
  "grantExpiresAt": "2026-10-01T00:00:00.000Z",
  "issuer": "https://example.okta.com/oauth2/threadnote",
  "policyVersion": "pilot-writer-v1",
  "principalId": "pilot-writer",
  "projects": ["threadnote"],
  "region": "eu-pilot-1",
  "repositoryBindings": {
    "threadnote": ["https://github.com/example/threadnote.git"]
  },
  "shareId": "pilot-memory",
  "sharePolicyVersion": "pilot-share-v1",
  "subject": "00u-example-writer",
  "tenantId": "pilot-organization"
}
```

Authorization and repository policy revalidation both reject an expired grant. Rotate a grant by changing its immutable
`policyVersion`, generating a new preview, and applying the new state-bound plan. The older direct `provision` command
remains available for existing operators; pilot enrollment should use `provision-plan` and `provision-apply`.

For a new share, planning requires the complete project and repository catalog. When `featureFlags` are omitted, the
planner enables `remote_memory_ga`, `remote_memory_read`, and only the additional durable or handoff feature needed by
the requested capabilities. If feature flags are supplied explicitly, they must enable every requested capability.

## Organization Cloud admission (O2)

Use the same Git knowledge remote for laptop shares and the hosted composer. PostgreSQL holds authorization, indexes,
revision pointers, and operation receipts; Git remains the sole memory-body authority. Configure the hosted service
with the existing restricted runtime database role and its provider-neutral OAuth settings, then bind its Git store:

```sh
export THREADNOTE_REMOTE_ENABLED=true
export THREADNOTE_REMOTE_CANONICAL_STORE=git
export THREADNOTE_REMOTE_MEMORY_GIT_TENANT_ID=pilot-organization
export THREADNOTE_REMOTE_MEMORY_GIT_SHARE_ID=pilot-memory
export THREADNOTE_REMOTE_MEMORY_GIT_WORKTREE=/srv/threadnote/pilot-memory
export THREADNOTE_REMOTE_MEMORY_GIT_CLONE_URL=https://git.example.com/pilot/knowledge.git
export THREADNOTE_REMOTE_MEMORY_GIT_PUSH=true
threadnote remote-memory-service
```

The service's ingest worker imports laptop publications from that Git remote. A successful laptop push alone is not
proof of completed ingestion: read the exact record from Cloud and retain its revision and freshness receipt. Git
push/CAS conflicts and uncertain commit outcomes retain the existing operation-ID retry contract; retry the same
operation ID and exact payload after an uncertain response instead of creating another operation.

Provision a separate Cloud reader identity using the read-only enrollment above and set
`"cloudAdmissionRequired": true` in that identity's provisioning manifest. This server-side grant field makes the
paired Cloud headers mandatory without changing attestation-enabled desktop identities. Generate its Dashboard
configuration with every repository in the current authorized repository set (the union of its project bindings):

```sh
threadnote cloud cursor config --mode org \
  --endpoint https://composer.example.com/mcp \
  --share-id pilot-memory --client-id PILOT_CLOUD_READER_CLIENT \
  --repository https://github.com/example/threadnote.git > pilot-cloud-reader.json

threadnote cloud cursor bootstrap --mode org \
  --endpoint https://composer.example.com/mcp --share-id pilot-memory \
  --cwd /workspace/threadnote
```

Repeat `--repository` for each repository, up to 256 entries. Repository identities use the existing workload identity
canonicalization: credential-free HTTPS URLs and canonical host/path identities are accepted; URL `.git` suffixes are
removed, paths remain case sensitive, and duplicates and ordering do not affect the binding. Empty sets are rejected.
The generated remote entry contains only an opaque share ID and a versioned SHA-256 digest of that share and canonical
set; it contains no repository names, memory bodies, or credentials. The digest is binding evidence, not a secret or an
authorization credential.

The `threadnote-org` entry requests only `memory:read`. Every request carrying Cloud admission headers must match the
current authorized set and the service's Git tenant/share binding before MCP dispatch. Partial, malformed, wrong, or
stale binding headers fail closed. Unmarked desktop requests keep their existing authorization path; Cloud identities
must still receive the separate bounded grants described above. A read-only profile also limits a reused broader OAuth token to read access. Desktop
and legacy remote-hybrid configurations retain their existing behavior. Cloud flags require `--mode org`.

Import the two `mcpServers` entries into Cursor Dashboard and complete organization IdP OAuth for `threadnote-org`.
Keep `threadnote-local` enabled: it owns current checkout/dirty-worktree graph evidence and status independently of the
hosted service. Hosted memory does not establish that a dirty local checkout is current. Changing project repository
bindings requires regenerating the Cloud configuration and reconnecting; do not work around a stale digest by dropping
its headers.

For an explicitly approved contributor, use a separate identity with the time-bounded write enrollment above, including
`cloudAdmissionRequired: true`, `cursorAttestationRequired: true`, exact `cursorSubjects`, project repository bindings,
and `memory:write:durable`.
Then generate the writer configuration:

```sh
threadnote cloud cursor config --mode org --contribute \
  --endpoint https://composer.example.com/mcp \
  --share-id pilot-memory --client-id PILOT_CLOUD_WRITER_CLIENT \
  --repository https://github.com/example/threadnote.git > pilot-cloud-writer.json
```

This requests `memory:read` and `memory:write:durable`, with no handoff, proposal, review, or admin scopes. It cannot
create a server grant. The IdP must issue those scopes and the current server grant must allow them. Before writing,
call remote `begin_cursor_attestation`, pass its challenge to local `complete_cursor_attestation`, and include the
returned `attestationId` in `remember_context`. Cloud admission always requires fresh Cursor attestation for writes;
current grant, policy, and attestation checks run again at canonical commit. The Okta `cid` profile is an operator
configuration of the generic issuer/client verifier, not a provider-specific runtime path.

Successful admitted MCP responses return `threadnote-share-id`, `threadnote-repository-set`, and
`threadnote-memory-authority: git` headers. Memory receipts retain revision, consistency/freshness, policy versions,
share/index generations, and actor provenance. Retain these bounded fields for operational evidence; do not retain
memory bodies, raw MCP responses, OAuth tokens, or workload tokens as telemetry.

### Repeatable cross-client acceptance

Run the isolated acceptance test against a disposable PostgreSQL 17 database service with a maintenance role permitted
to create and drop test databases and roles. Supply its URL through the environment, not a checked-in file. The optional
receipt path must not already exist:

```sh
export THREADNOTE_ORG_CLOUD_ACCEPTANCE_RECEIPT=/tmp/org-cloud-acceptance.json
bun --bun vitest run test/integration/remote-memory-org-cloud.test.ts
```

`THREADNOTE_TEST_POSTGRES_URL` must be set; without it Vitest skips this database integration test, which is not an
acceptance pass. The test creates isolated Git remotes, databases, roles, and laptop homes and removes them afterward.
It exercises a reviewed laptop Git commit → ingest → Cloud read; attested Cloud durable write → fresh laptop clone,
share import, and MCP read; stale CAS and read-only-write denials; wrong share/repository bindings; grant expiry and
downgrade after authentication but before Git publication; and remote outage while local graph/status remains usable.
It verifies that every denied mutation leaves both canonical Git and the PostgreSQL head unchanged and that PostgreSQL
revision bodies stay empty. Only token verifier boundaries are synthetic; this is a repeatable protocol drill, not proof
of live Okta/Cursor issuance. The optional JSON receipt contains only share, repository-set digest, Git provenance,
revision, freshness, and passed check names.

### Rollback

First replace the contributor's server grant with `capabilities: ["memory:read"]` and a new immutable `policyVersion`
using the same reviewed `provision-plan --for-apply` / `provision-apply` flow. Keep the existing share catalog and policy
unless deliberately changing them. Current requests revalidate that grant at commit. Regenerate its configuration
without `--contribute`, reconnect with the reader identity, and verify that a durable write is forbidden. Merely editing
the Dashboard configuration does not revoke an already issued credential or server grant.

If hosted access must stop entirely, set `THREADNOTE_REMOTE_ENABLED=false` and restart the service. Preserve the Git
remote and laptop share configuration and leave local stdio enabled. A fresh laptop can recover the canonical records
with `threadnote share init <knowledge-remote> --team pilot --read-only` and `threadnote share sync --team pilot --no-push`.
Do not switch to PostgreSQL canonical bodies or create another writable authority during recovery. Resume hosted reads
only after the Git binding, current grant, ingest freshness, and acceptance drill pass again.
