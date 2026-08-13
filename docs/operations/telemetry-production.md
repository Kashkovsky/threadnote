# Telemetry production runbook

This runbook gates the public `telemetry.threadnote.io` destination. Do not map
DNS or release a build using the default endpoint until every preflight item is
recorded and the storage canary has succeeded.

## Production record

Keep this section current without placing token values in the repository.

| Field                       | Required record                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Service owner and responder | Named owner, backup, escalation channel, and tested Grafana contact point                                   |
| Fly deployment              | Organization, app name, primary/secondary EU regions, Machine IDs/count/sizes, current image and release ID |
| Public edge                 | Gateway URL, DNS provider/record/TTL, Fly certificate status and expiry                                     |
| Grafana Cloud               | Stack name/ID, portal-reported region and data residency, Tempo query URL, trace retention and review date  |
| Credentials                 | Access-policy IDs, scope, owner, created/expiry/rotation/revocation dates; never token values               |
| Canary                      | Workflow URL, frequency, last success, maximum visibility delay, monitor/rule ID and notification test date |
| Logging/privacy             | Fly/DPA review date, application log contents, retention, log exporter and access list                      |
| Availability                | Machine/region topology, accepted RTO/RPO, capacity and ingress rate limits                                 |

Production policy is an EU Grafana Cloud stack with the shortest available
trace retention. Grafana currently documents a 14-day minimum for Free and a
30-day minimum for paid accounts. Verify the configured value and region in the
Grafana Cloud portal; endpoint naming is only a hint, not proof of either.
Fly's searchable application logs currently retain seven days.
Threadnote emits no access logs and only fixed operational error codes and
Collector warnings. Do not add payloads, headers, source addresses, session IDs,
or trace IDs to stdout/stderr. Fly Proxy necessarily observes the transport IP
and adds `Fly-Client-IP`; the gateway uses it only in an in-memory, per-process
HMAC rate key and never forwards it. Record the Fly/Grafana DPAs, subprocessors,
support confirmation about transport-log retention, and the privacy-policy
owner's approval before launch.

## Free-plan and ingestion budget

Production must remain on Grafana Cloud **Free**, not a Pro trial or paid plan.
Before DNS and every release, confirm the organization and stack both show
Free/Always free at $0 with no credit card, 14-day trace retention, and the
current 50 GB monthly trace-ingestion limit. Free is a hard product boundary:
do not add a payment method, accept a Pro trial or upgrade, increase retention,
or enable a paid feature for this service. If the account or stack ever shows
Pro or a payment method, disable public ingestion immediately and resolve the
account state before resuming.

The gateway independently caps accepted canonical protobuf at 32 KiB per
minute per Machine. The reviewed upper bound is exactly
`32768 × 2 × 31 × 24 × 60 = 2,925,527,040` canonical bytes per 31 days. The
Collector queue and retry loop are disabled, so it makes one best-effort export
attempt per accepted batch rather than intentionally amplifying that volume.
Grafana's provider-side accounting remains authoritative and can differ from
canonical wire bytes, which is why the first operator gate is still more than
three times the gateway ceiling.

Keep the live Fly inventory at exactly two started Machines. The scheduled
storage canary reads the real Machine inventory with a read-only Fly token and
fails before sending telemetry if the count or state drifts. Scaling out,
weakening the byte cap, enabling Collector retries/queues, adding another
signal, or sharing the stack requires a reviewed budget change before
deployment. CI keeps the per-Machine cap, two-Machine inventory, 31-day
accounting period, 3 GB internal ceiling, and 10/20/50 GB gates ordered.

In **Cost Management and Billing > Usage Alerts**, create a global **Traces**
usage alert with a 20 GB monthly threshold and custom alert levels at 50% and
100%, yielding notifications at 10 GB and 20 GB. Route both to the named service
owner and backup, test the contact point, and record the rule IDs and test date.
Also monitor `grafanacloud_traces_instance_usage`,
`grafanacloud_traces_instance_bytes_received_per_second`, and discarded spans
from the `grafanacloud-usage` data source. These alerts are safety gates, never
permission to upgrade:

- **10 GB:** acknowledge the alert the same day; verify the stack is still Free
  with 14-day retention, run the live Machine-budget check, identify any shared
  or unexpected signal usage, and deploy a reviewed lower gateway cap. Do not
  increase the Grafana limit or move to Pro.
- **20 GB:** immediately stop public trace ingestion while keeping `/healthz`
  available:

  ```sh
  fly secrets set THREADNOTE_TELEMETRY_PUBLIC_INGESTION=disabled \
    --app threadnote-telemetry
  curl --output /dev/null --silent --write-out '%{http_code}\n' \
    --request POST --header 'Content-Type: application/x-protobuf' \
    --data-binary '' https://threadnote-telemetry.fly.dev/v1/traces
  ```

  The POST must return `503`; the storage canary and heartbeat will then fail by
  design and the incident must be acknowledged. Resume only after the provider
  allowance window resets, the cause is fixed, the owner approves, and a
  preflight canary succeeds. Restore the checked-in `enabled` value and restart
  the Machines with:

  ```sh
  fly secrets unset THREADNOTE_TELEMETRY_PUBLIC_INGESTION \
    --app threadnote-telemetry
  ```

  Never resume by upgrading the Grafana plan.

## Credentials and rotation

Use five distinct identities:

1. `threadnote-telemetry-ingest` is single-stack and `traces:write` only. Its
   exact OTLP base URL becomes the Fly secret `GRAFANA_CLOUD_OTLP_ENDPOINT`.
   Its numeric instance ID and token become the Fly secret
   `GRAFANA_CLOUD_AUTHORIZATION` in the form
   `Basic <base64(instance-id:write-token)>`. It cannot read traces.
2. `threadnote-telemetry-canary-read` is single-stack and `traces:read` only.
   Store its numeric Tempo **User**, token, and exact Tempo data-source URL as
   protected `telemetry-production` GitHub Environment secrets:
   `THREADNOTE_TELEMETRY_CANARY_TEMPO_USER`,
   `THREADNOTE_TELEMETRY_CANARY_TEMPO_TOKEN`, and
   `THREADNOTE_TELEMETRY_CANARY_TEMPO_URL`. The URL ends in `/tempo`; it is not
   the OTLP gateway or Grafana UI URL.
3. The secret `THREADNOTE_TELEMETRY_CANARY_HEARTBEAT_URL` is the endpoint of a
   dedicated Grafana IRM Webhook integration with Heartbeat enabled. Treat the
   endpoint as a credential and expose it only to the canary job.
4. `THREADNOTE_TELEMETRY_CANARY_FLY_READ_TOKEN` is a short-lived, read-only Fly
   organization token used only to list the live Machine inventory. Create it
   with `fly tokens create readonly`, use the shortest practical expiry (30
   days or less), store it in the protected `telemetry-production` GitHub
   Environment, and rotate it before expiry. Never use a personal or deploy
   token for the scheduled canary.
   Set the non-secret `THREADNOTE_TELEMETRY_CANARY_GATEWAY_URL` Environment
   variable to the exact `.fly.dev/v1/traces` preflight URL until DNS and TLS
   are live. Change it to `https://telemetry.threadnote.io/v1/traces` during
   the hostname cutover; manual workflow dispatch input overrides this value.
5. Dashboard/alert provisioning, when automated, uses a separate Grafana
   service account restricted to the required dashboard and alert resources.

Rotate without an ingestion gap:

1. Create a replacement token on the same least-privilege policy. Keep the old
   token active.
2. Update only the relevant Fly or GitHub Environment secret. Never echo a
   token or build a Basic header in shell output.
3. Deploy/restart when rotating Fly ingest auth, then run the storage canary.
   For read auth, dispatch the canary directly after updating the secret.
4. Confirm one stored canary and normal exporter logs, then revoke the old
   token. Record policy/token IDs and dates, not values.
5. A failed canary blocks revocation and release. Restore the old secret while
   it remains valid and investigate.

## Storage canary and alert

[`telemetry-delivery-canary.yml`](../../.github/workflows/telemetry-delivery-canary.yml)
runs every 15 minutes and on demand. It first pipes `flyctl machine list --json`
into the budget verifier; no Machine identifiers are logged. It then generates
one random, schema-valid, content-free trace, posts it through the public
gateway, and polls Grafana Tempo by that exact trace ID until the stored
protobuf contains the expected resource and span identity. The synthetic
version is `0.0.0-canary`, making it filterable from product telemetry. Success
proves the two-Machine budget, public TLS, route and schema validation,
Collector export, Grafana ingestion, storage, read credentials, and query
availability. `/healthz` proves none of the storage/read path.

The exact query contract is:

```text
GET <TEMPO_URL>/api/v2/traces/<32-lowercase-hex-trace-id>?start=<unix-seconds>&end=<unix-seconds>
Accept: application/protobuf
Authorization: Basic base64(<numeric Tempo User>:<traces:read token>)
```

Tempo `404` means not visible yet and is retried for 60 seconds. Other non-200
responses, a wrong trace, malformed protobuf, or timeout fail immediately. The
canary never prints credentials, trace/session IDs, response bodies, or URLs.

Protect the `telemetry-production` GitHub Environment with a default-branch
deployment rule and restrict secret access to this workflow. Do not require a
human approval on scheduled jobs. Enable Actions failure notifications to the
service owner.

In Grafana IRM, create a dedicated Webhook integration named
`threadnote-telemetry-canary`, configure its escalation route, enable Heartbeat
with a 30-minute interval, and store its endpoint as
`THREADNOTE_TELEMETRY_CANARY_HEARTBEAT_URL`. The workflow pings it only after a
trace is stored and verified. Missing secrets, rejected traces, query failures,
disabled schedules, and GitHub incidents therefore all become a missed
heartbeat and an IRM alert. Test both firing and resolution by temporarily
using a one-minute heartbeat interval, withholding a success, acknowledging
the alert, restoring 30 minutes, and dispatching a successful run. Do not rely
on a Tempo Grafana-managed alert: Grafana documents the Tempo data source as
not supporting alerting.

## Availability and deployment

Production requires two always-running, stateless Machines before DNS. Two
Machines in `fra` cover host and rolling-deploy failure; place one in a second
approved EU region if the availability objective includes a regional outage.
Keep the Collector backend in its confirmed EU region. Service-level `/healthz`
checks must gate Fly routing and deployments, and deployments must be rolling
or canary with at most one unavailable Machine. A health check must have its
own trusted capacity path; it must not consume public per-source or global
ingestion budget, and a path-only public bypass is forbidden.

Pre-deploy:

```sh
go test ./...
docker build --pull --file infra/telemetry-gateway/Dockerfile \
  --tag threadnote-telemetry-gateway:release .
fly config validate --config fly.toml
fly scale count 2 --app threadnote-telemetry --region fra
fly machine list --app threadnote-telemetry --json | \
  go -C infra/telemetry-gateway run ./cmd/budget
```

Deploy the exact reviewed commit, record its image digest and Fly release ID,
then verify both Machines, routing health, logs, and the storage canary. Do not
make a single-Machine production exception: it creates avoidable downtime for
host failure and deploys. If one Machine is temporarily lost, restore count two
before any deployment or credential rotation.

## DNS and TLS launch checklist

1. Lower the existing DNS TTL one retention window before launch. Confirm no
   conflicting A, AAAA, or CNAME records.
2. Add the hostname to Fly and copy the records Fly actually reports:

   ```sh
   fly certs add telemetry.threadnote.io --app threadnote-telemetry
   fly certs setup telemetry.threadnote.io --app threadnote-telemetry
   ```

3. Create the exact CNAME and any `_fly-ownership`/ACME record shown by Fly.
   Do not infer the target from an example.
4. Wait for DNS propagation and a valid Fly-managed certificate:

   ```sh
   fly certs check telemetry.threadnote.io --app threadnote-telemetry
   curl --fail --silent --show-error https://telemetry.threadnote.io/healthz
   ```

5. Before DNS, dispatch the storage canary with
   `https://threadnote-telemetry.fly.dev/v1/traces`; only this preflight host and
   the production host are admitted. After DNS and certificate issuance,
   dispatch it again against the default public hostname and require success.
6. Test TLS from two networks, wrong routes/methods/content types, rate limits,
   and opt-in CLI plus isolated MCP flows. Confirm the Grafana trace contains
   only the documented schema and exact app version.
7. Confirm dashboard access is private, alert/dead-man notifications arrive,
   retention/region records are complete, and two healthy Machines are live.
8. Release progressively and watch the canary, Fly state/logs, Grafana discard
   metrics, request rate, and trace volume. Restore normal DNS TTL only after
   the observation window.

## Incident response and rollback

First distinguish the failing segment: public DNS/TLS and `/healthz`; Fly
Machine count/state/routing; gateway fixed error codes and Collector warnings;
canary POST status; Tempo query status/visibility; Grafana service status and
discard metrics. Never capture a raw production request or paste credentials,
payloads, trace IDs, or IP addresses into an incident ticket.

For a bad Fly release, retrieve the last known-good image from `fly releases
--image --app threadnote-telemetry`, deploy that immutable image with the same
rolling/maximum-unavailable policy, require two healthy Machines, and rerun the
storage canary. If data safety or privacy is uncertain, disable the public
route or remove the CNAME and publish the telemetry kill switch; telemetry is
best-effort and product operation must continue without it. DNS rollback is
slower than image rollback and remains cached for the active TTL.

After recovery, record timeline, affected path, release/image, canary evidence,
provider status, trace volume, credential action, rollback, and follow-up owner.
Do not increase retention or enable richer logging as an incident shortcut.

## Provider references

- [Grafana Tempo query API](https://grafana.com/docs/tempo/latest/api_docs/)
- [Locate the Grafana Cloud Tempo URL and User](https://grafana.com/docs/grafana-cloud/send-data/traces/set-up/locate-url-user-password/)
- [Create scoped Grafana Cloud access policies](https://grafana.com/docs/grafana-cloud/send-data/traces/set-up/add-access-policy/)
- [Grafana Cloud retention](https://grafana.com/docs/grafana-cloud/cost-management-and-billing/manage-invoices/understand-your-invoice/logs-invoice/)
- [Grafana Cloud Free pricing and trace allowance](https://grafana.com/pricing/)
- [Grafana Cloud usage alerts](https://grafana.com/docs/grafana-cloud/cost-management-and-billing/usage-cost-alerts/create-alerts/)
- [Grafana IRM heartbeat monitoring](https://grafana.com/docs/grafana-cloud/alerting-and-irm/irm/integrations/configure-integrations/#enable-heartbeat-monitoring)
- [Fly read-only tokens](https://fly.io/docs/security/tokens/)
- [Fly Machine availability](https://fly.io/docs/apps/app-availability/)
- [Fly application-log retention](https://fly.io/docs/monitoring/logging-overview/)
- [Fly Proxy request headers and transport IP](https://fly.io/docs/networking/request-headers/)
- [Fly custom domains and certificates](https://fly.io/docs/networking/custom-domain/)
