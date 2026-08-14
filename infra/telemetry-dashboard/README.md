# Threadnote telemetry dashboard deployment

This directory is the reviewable deployment surface for the existing private
Grafana Cloud dashboard. The portable import model remains
[`../telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json`](../telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json).
`scripts/telemetry-dashboard.ts` deterministically renders it into
`threadnote-telemetry.artifact` by replacing `${DS_TEMPO}` with the operated
`grafanacloud-traces` UID, removing import-only and server-owned root fields,
fixing the dashboard and folder identities, and canonicalizing object keys
without reordering arrays.

The generated file deliberately has neither a Git Sync-recognized
`.json`/`.yaml` extension nor `apiVersion`, `kind`, or `metadata` resource
fields. The provisioner constructs the fixed App API resource only in memory
after all live checks pass. This prevents a broadly rooted legacy Git Sync
connection from discovering the direct-deployment history file on merge.

The legacy resources under `git-sync/` are intentionally retained in this
slice. Removing them while an unknown Git Sync connection is still active
could make Grafana delete the live folder or dashboard. Treat them as inert
migration/rollback material; remove them only in a later reviewed cleanup after
direct deployment is live and an operator has confirmed that no repository
reconciler remains.

Do not hand-edit the generated artifact. After changing the portable source,
run:

```sh
bun scripts/telemetry-dashboard.ts render
bun scripts/telemetry-dashboard.ts check
bun --bun vitest run test/unit/telemetry-gateway-dashboard.test.ts \
  test/unit/telemetry-dashboard-provisioning.test.ts
```

## Safety contract

GitHub Actions updates only the already-existing Dashboard resource at the
fixed App API path
`/apis/dashboard.grafana.app/v1/namespaces/<stack>/dashboards/threadnote-telemetry`.
It never calls a create, delete, folder-write, permission-write, or legacy
dashboard-save endpoint. Every PUT carries the exact non-empty opaque
`metadata.resourceVersion` read immediately beforehand. Grafana therefore
rejects a stale update or a dashboard deleted between GET and PUT rather than
creating a replacement. Only HTTP 200 is accepted; 404, 409, 412, 500, and all
other statuses fail terminally. A transport failure is never retried: one GET
classifies whether the first PUT completed, and any old or unexpected state
fails closed.

Before a write, the provisioner requires all of the following:

- the exact dashboard UID, immutable `metadata.uid`, namespace, folder
  annotation, folder UID/title, and private folder ACL;
- no current or legacy Grafana managed/provisioned metadata, including the
  `managedBy`, manager, source, repository, and `provisioning.grafana.app/*`
  annotation/label families;
- a live semantic model equal to either the current canonical artifact or one
  of at most 64 validated first-parent historical artifacts; and
- an effective writer permission set limited to exact-target dashboard
  read/write plus exact-folder read and permission-read. Grafana also reports
  its built-in `folders:uid:sharedwithme` virtual folder for every authenticated
  account; that one additional `folders:read` scope is accepted, while any
  other extra, duplicate, or wildcard scope is rejected. Dashboard/folder
  create/delete, folder/ACL write, query, and admin grants are rejected.

If live already equals current, deployment is a no-op. If it equals a trusted
historical artifact, the provisioner updates to current. Any third state is
treated as out-of-band drift and is not overwritten. This bounded history
allows a newer run to recover when an intermediate run was skipped or failed;
it does not trust dispatch order. Historical artifacts are read as the
reviewed canonical models committed on protected first-parent history and are
validated for fixed identity and JSON shape without reapplying the current
renderer contract. That keeps a prior model eligible during an intentional
renderer or datasource migration. `queue: max` and
`cancel-in-progress: false` prevent relevant main runs from replacing one
another, while two content-aware remote-main checks prevent an older run from
executing after a newer commit changes the workflow, provisioner, portable
source, or generated artifact.

Grafana owns the root `schemaVersion`. The PUT preserves the exact live value
and the post-write GET requires it to remain unchanged, preventing schema
downgrades. Semantic comparison ignores that root field and the other App API
server fields. The only structural migration noise tolerated is omission of
an exactly empty `{defaults: {}, overrides: []}` `fieldConfig` on the six
known panels 14–19. Query, panel, nonempty field configuration, layout, and all
other differences remain drift.

After a successful PUT, a second GET must show the same immutable UID, a
different resourceVersion, the preserved schemaVersion, and the exact intended
semantics. A separate read-only job then checks folder privacy and submits one
bounded five-minute Tempo parser/query request for every TraceQL target. It
first audits that credential against a closed allowlist of exact dashboard,
folder, ACL-read, datasource-read, and datasource-query scopes. It then
requires an HTTP 200 result with every expected refId, no target error or
failing status, and a frames array; empty frames are valid. No response body,
permission principal, trace ID, namespace, token, or other private deployment
identifier is logged.

There is no automatic rollback. Revert the portable source through normal
review; the same history check, optimistic update, post-read, and query
verification apply to the rollback.

## Controlled production activation

The repository intentionally contains no live credential and does not create,
delete, or move production resources. Complete this migration interactively in
a maintenance window before setting the enable variable:

1. Disable and remove any Grafana Git Sync repository that can reconcile this
   dashboard or folder. Read the raw Dashboard and Folder resources and confirm
   that no management/provisioning annotations or labels remain. Do not delete
   the retained `git-sync/` files in this activation change.
2. Export the existing dashboard privately as rollback evidence. In Grafana,
   create folder UID `threadnote-telemetry-private` with title
   `Threadnote private telemetry`, move only dashboard UID
   `threadnote-telemetry` into it, and remove default Viewer and Editor grants.
   Leave only explicit service-owner user/team access; administrators retain
   inherent access. These are deliberate UI/admin operations because CI has no
   folder-create, move, or ACL-write permission.
3. Compare the raw App API model with the checked-in artifact using the narrow
   semantic normalization above. First activation is allowed only when live is
   already semantically current; it performs no write. Do not enable the lane
   to adopt a different live model.
4. Create a read-only service account for `dashboards:read`, `folders:read`,
   `folders.permissions:read`, `datasources:read`, and `datasources:query`,
   scoped to the exact dashboard, folder, and `grafanacloud-traces` datasource.
   Grafana may derive the exact datasource read scope from the query grant;
   audit the effective permissions rather than duplicating it in the custom
   role. The effective folder-read scopes must be exactly the private folder
   and Grafana's built-in `folders:uid:sharedwithme` virtual folder.
   Store its token only as `THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN` in the
   existing `telemetry-dashboard-production` Environment. Keep that Environment
   main-only and read-only (`deployment: false`).
5. Create a separate service account with basic role **None**. Grant only
   `dashboards:read` and `dashboards:write` on dashboard UID
   `threadnote-telemetry`, plus `folders:read` and
   `folders.permissions:read` on folder UID
   `threadnote-telemetry-private`. It must have no dashboard create/delete,
   folder/ACL write, datasource query, wildcard, or admin permission. Store its
   token only as `THREADNOTE_TELEMETRY_GRAFANA_WRITE_TOKEN` in a new
   `telemetry-dashboard-production-deploy` Environment.
   If the Grafana Cloud plan cannot express these exact custom RBAC scopes,
   leave direct mode and telemetry ingestion disabled. Do not substitute basic
   Editor/Admin access or a broader token; the runtime permission audit rejects
   those grants.
6. Restrict the deploy Environment to `main`, require the service owner as a
   reviewer, leave self-review allowed while the repository has only that one
   trusted operator, and remove administrator bypass. Add a second independent
   trusted reviewer before enabling self-review prevention. Configure
   `THREADNOTE_TELEMETRY_GRAFANA_URL` and
   `THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE` as variables in both Environments.
   The URL must be an uncredentialed root Grafana Cloud HTTPS origin whose
   hostname ends in `.grafana.net`, with no non-default port. The namespace must
   use the private `stacks-<numeric Stack ID>` form and must not be printed.
7. Keep the repository ruleset, CODEOWNERS rules, signed/linear history, and
   code-owner review active. The deploy job also requires the exact repository
   identity `Kashkovsky/threadnote`. This workflow uses only GitHub
   `contents: read`; it has no GitHub write credential.
8. After this code has been on `main` long enough to provide a historical
   canonical baseline, set repository variable
   `THREADNOTE_TELEMETRY_GRAFANA_DIRECT_ENABLED=true` and land a reviewed
   dashboard-path change. The protected push job should report a no-op and the
   read-only verification should pass. Leave the variable unset or anything
   other than exact `true` until every gate above is complete.

The `telemetry-dashboard-production-deploy` Environment and both credentials
are not provisioned by this repository. Missing configuration fails a selected
live job closed; with the enable variable disabled, PRs and `main` remain
secretless validation only. Scheduled and manually dispatched runs are always
read-only. The daily drift check runs at 03:17 UTC once enabled.

`Dashboard checks complete` is path-filtered and must not yet be configured as
a repository-wide required check: unrelated pull requests would never produce
it. Add it to a compatible path-scoped ruleset, or make this workflow trigger
and classify every pull request, only after the first enabled run is green.

Provider references:

- [Grafana App Platform API structure](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/apis/)
- [Grafana dashboard API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/dashboard/)
- [Grafana RBAC HTTP API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/access_control/)
