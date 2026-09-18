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
