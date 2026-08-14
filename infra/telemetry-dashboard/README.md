# Threadnote telemetry dashboard Git Sync

This directory is the dashboard-only deployment surface for Grafana Cloud Git
Sync. The portable import model remains
[`../telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json`](../telemetry-gateway/threadnote-anonymous-telemetry-dashboard.json),
and `scripts/telemetry-dashboard.ts` deterministically converts it into the
Grafana App Platform resource under `git-sync/` by:

- replacing `${DS_TEMPO}` with the operated `grafanacloud-traces` data-source
  UID;
- removing import-only and server-owned root fields;
- wrapping the Classic dashboard model in the required
  `dashboard.grafana.app/v1` resource; and
- canonicalizing object keys while preserving array order.

Do not hand-edit the generated dashboard. After changing the portable source,
run:

```sh
bun scripts/telemetry-dashboard.ts render
bun scripts/telemetry-dashboard.ts check
bun --bun vitest run test/unit/telemetry-gateway-dashboard.test.ts \
  test/unit/telemetry-dashboard-provisioning.test.ts
```

## One-time production migration

The existing unmanaged dashboard needs an explicit migration into Git Sync;
do not assume that an ordinary repository pull will safely adopt it. Perform
the migration in a controlled maintenance window:

1. Export the live dashboard and compare its normalized model with the
   generated resource. Retain the export privately as rollback evidence; it can
   contain operational table configuration and must not be published.
2. In Grafana Cloud, create a Git Sync connection for this repository's `main`
   branch and set its exact repository path to
   `infra/telemetry-dashboard/git-sync`. Configure the repository as read-only
   in Grafana so the UI cannot write dashboard changes back to Git; changes must
   originate in the portable source and pass review. Do not grant Actions a
   dashboard writer token, and retain repository protection on `main`.
3. If setup offers **Migrate existing resources**, prefer that provider flow
   only when its preview can be bounded to this dashboard and folder. Require
   it to retain UID `threadnote-telemetry`, emit a model semantically equal to
   the generated resource, and leave no unrelated repository changes. Stop and
   investigate rather than accepting a broader migration.
4. If the bounded migration flow is unavailable, use Grafana's documented
   export fallback: while stack access is limited to administrators, delete
   only the exported unmanaged dashboard, trigger a pull, and require Grafana
   to recreate the same UID in the `threadnote-telemetry-private` provisioned
   folder. This fallback does not carry dashboard history or permissions; the
   private export is its rollback evidence.
5. In either flow, remove the provisioned folder's default Viewer and Editor
   role grants before reopening ordinary stack access. Leave only explicit
   service-owner user/team entries; Grafana administrators retain inherent
   access. The checked-in `_folder.json` gives this folder a stable UID so its
   permissions survive repository path moves.
6. Enable post-sync verification only after the first pull succeeds. Set the
   repository variable `THREADNOTE_TELEMETRY_GRAFANA_GIT_SYNC_ENABLED=true`,
   create the protected `telemetry-dashboard-production` GitHub Environment,
   restrict it to `main`, and configure:
   - Environment variable `THREADNOTE_TELEMETRY_GRAFANA_URL` with the
     uncredentialed Grafana Cloud HTTPS origin.
   - Environment variable `THREADNOTE_TELEMETRY_GRAFANA_NAMESPACE` with the
     stack namespace from Grafana Cloud, in the exact
     `stacks-<numeric Stack ID>` form. `default` is only an on-premises example
     namespace and is rejected by this workflow.
   - Environment variable
     `THREADNOTE_TELEMETRY_GRAFANA_GIT_SYNC_MANAGER_ID` with the exact
     Kubernetes `metadata.name` of the Grafana Git Sync Repository resource,
     not its display title or Git URL.
   - Environment secret `THREADNOTE_TELEMETRY_GRAFANA_READ_TOKEN` with a
     read-only service-account token scoped as narrowly as Grafana supports. It
     needs `dashboards:read`, `folders:read`, `folders.permissions:read`,
     `datasources:read`, and `datasources:query`; bind dashboard and data-source
     actions to these exact UIDs. Grafana's legacy folder-permission read API
     may require the read-only `folders:*` scope. It must have no dashboard,
     folder, data-source, or alert write permission.

Treat the namespace and Repository resource name as private deployment
metadata: configure them only in the protected Environment and do not print
them in workflow output. Before enabling verification, confirm the Git Sync
Repository reports that exact resource name and that its configured root is
`infra/telemetry-dashboard/git-sync`.

Until the enable variable is exactly `true`, pull requests and `main` validate
the generated resource but the live verification job is intentionally skipped.
Once enabled, every dashboard-path change and the daily 03:17 UTC drift check
run the same main-only protected-Environment verification. Missing credentials,
non-HTTPS configuration, dashboard/folder sync drift, broad default folder
grants, query parse errors, and query responses missing a target fail closed.
Verification uses a five-minute range, one point/result per query, and never
logs response bodies, permission principals, trace identifiers, stack
namespaces, or Repository resource names. The live check reads the Grafana App
Platform Dashboard and Folder resources in the configured Cloud namespace and
requires exact Git Sync provenance:
`grafana.app/managedBy=repo`, the configured `grafana.app/managerId`, source
paths `threadnote-telemetry/threadnote-telemetry.json` and
`threadnote-telemetry`, and folder UID `threadnote-telemetry-private` on the
dashboard. It compares the canonical resource specs after omitting dashboard
`uid`, `id`, and `version`, which Grafana's Git Sync parser owns and removes
before storage.

Grafana Git Sync is the deployment mechanism. GitHub Actions waits for the
read-only live model to converge and then parser-checks every bounded TraceQL
target; it never pushes dashboard state through the Grafana API. Roll back with
a reviewed Git revert and require the same verification job to pass.

Provider references:

- [Grafana Git Sync](https://grafana.com/docs/grafana/latest/as-code/observability-as-code/git-sync/)
- [Grafana App Platform API structure](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/apis/)
- [Export an unmanaged dashboard for Git Sync](https://grafana.com/docs/grafana/latest/as-code/observability-as-code/git-sync/export-resources/)
- [Provisioned dashboards](https://grafana.com/docs/grafana/latest/as-code/observability-as-code/git-sync/provisioned-dashboards/)
