# Threadnote telemetry gateway

This Fly service accepts anonymous OTLP/HTTP protobuf traces at `/v1/traces`
and forwards the allowlisted envelope to Grafana Cloud. Logs and metrics do not
have pipelines. The public Go ingress is deliberately small and emits no access
logs; the Collector only listens on loopback.

The Go ingress validates the complete request against the immutable,
version-selected [`telemetry-schema-v1.json`](./telemetry-schema-v1.json),
[`telemetry-schema-v2.json`](./telemetry-schema-v2.json), or
[`telemetry-schema-v3.json`](./telemetry-schema-v3.json) contract before the
Collector can see it. Versions 1 and 2 remain frozen and accepted for deployed
clients. Version 2 added closed, path-free terminal graph-build classifications
and power-of-two buckets. Version 3 inherits that surface and adds only closed
graph request/scope, query-phase, query-stage/subphase, snapshot selection/freshness,
and published snapshot-size buckets. It rejects unknown or duplicate protobuf fields, schema
surface mixing, mixed valid/invalid batches, unrecognized attributes and
values, invalid field combinations, span events, links, trace state, status
messages, and malformed identifiers. Accepted
data is rebuilt into a fresh canonical protobuf envelope rather than forwarding
the caller's bytes. The Collector repeats the attribute projection as defense in
depth. Logs and metrics have no pipelines.

The edge ingress also enforces route, method, media type, body, concurrency, and
request-rate limits. A 32 KiB accepted-byte budget per Machine per minute keeps
the required two-Machine deployment below 3 GB of canonical input per month
even under continuous saturation. Collector queues and retries are disabled so
accepted telemetry receives one best-effort export attempt rather than
amplifying provider-side volume. Source addresses are used
only as process-ephemeral HMAC rate-limit keys; they are neither logged nor
forwarded. Production deployment, credential rotation, storage canary,
certificate, DNS, monitoring, and rollback requirements live in the
[production runbook](../../docs/operations/telemetry-production.md).

The scheduled canary checks the actual Fly Machine inventory against the shared
budget before sending four traces: one frozen-v1 completion, one complete-v2
terminal graph build, one v3 execute checkpoint, and one v3 completion carrying
the execute-inherited snapshot surface. At the 20 GB operator gate, setting the
Fly secret `THREADNOTE_TELEMETRY_PUBLIC_INGESTION=disabled` makes `/v1/traces`
return `503` while `/healthz` remains available; the runbook contains the exact
shutdown and recovery procedure.

## Configure Fly

Use the Grafana Cloud OTLP base endpoint (without `/v1/traces`) and a literal
HTTP Basic authorization value:

```sh
fly secrets set \
  GRAFANA_CLOUD_OTLP_ENDPOINT='https://otlp-gateway-<region>.grafana.net/otlp' \
  GRAFANA_CLOUD_AUTHORIZATION='Basic <base64(instance-id:access-policy-token)>'
```

Do not commit either value. The production policy requires a single-stack,
`traces:write`-only access policy and the shortest available trace retention.

## Import the dogfood dashboard

[`threadnote-anonymous-telemetry-dashboard.json`](./threadnote-anonymous-telemetry-dashboard.json)
is a portable Classic dashboard model. In Grafana, open **Dashboards**, choose
**New > Import**, upload the JSON file, and map the `Tempo` input to the
preconfigured **Grafana Cloud Traces** data source. The import replaces
`${DS_TEMPO}` with that data source's UID; it does not need or contain ingestion
credentials.

The suggested dashboard UID is `threadnote-telemetry`. Importing it again into
the same organization updates that dashboard after confirmation. Change the UID
on the import screen when a separate copy is desired. Keep the dashboard private:
its tables can show opaque random session and invocation IDs for correlation, so
do not publish snapshots or use those IDs as metric groupings or alert labels.
Schemas v2 and v3 inherit that existing ephemeral base correlation envelope; no
identifier is part of the graph-build or graph-query surfaces or their metric
groupings.

The dashboard defaults to six hours and should remain at 24 hours or less because
TraceQL metrics queries have a default 24-hour range limit. Every semantic query
pins its telemetry schema version and the anonymous diagnostic span name.
Every Tempo query excludes the exact synthetic canary version
`0.0.0-canary` in TraceQL, before aggregation or table selection.
Existing operation panels admit schema versions 1, 2, and 3 so producer upgrades
do not make them go dark. Graph-build panels admit versions 2 and 3 and aggregate
only by app version, closed mode/fallback/efficiency classifications, and coarse
buckets; their incident table selects the same bounded fields plus duration.
Graph-query panels admit version 3 only. They show successful end-to-end p50,
p95, and p99 by closed request kind; p50 and p95 for each closed query phase and
request kind; p95 by snapshot file-count bucket; and selection/freshness counts.
Metric panels never group by or select session, invocation, repository, path,
commit, query text, symbol name, or exact graph counts. Operation outcomes and
latency use `threadnote.outcome` and the numeric `threadnote.duration_ms`; OTLP
span status and duration do not represent the operation result. Phase panels
use checkpoint events so a completion's copy of the last phase is not counted
again. Memory values are intentionally coarse string buckets and are only
grouped and counted.

The dashboard includes an unexpected-full percentage and rewrite/replay
amplification distributions. The percentage denominator is dirty builds, and
its guarded Grafana expression renders an empty zero-count bucket as 0% instead
of dividing by zero. Synthetic canaries are excluded before both counts. The
amplification panels require a nonzero coarse denominator so clean cold builds
cannot dilute or pollute the incident signal. These are not alert rules. The
operated Tempo data source does not support Grafana-managed alerting, and this
repository has no separate metrics pipeline for these observations. Until a privacy-equivalent
derived-metrics monitor exists, responders must inspect the dashboard during
telemetry review; do not attach identifiers to an external workaround.

The query design follows Grafana's official documentation for the
[dashboard JSON model](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/view-dashboard-json-model/),
[Tempo queries in Grafana](https://grafana.com/docs/grafana/latest/datasources/tempo/query-editor/),
and [TraceQL metrics functions](https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/functions/).
If an imported panel is empty, widen the dashboard range up to 24 hours and
confirm that the selected Tempo data source returns this query in Explore:

```traceql
{ resource.service.name = "threadnote" && resource.service.version != "0.0.0-canary" && (resource.threadnote.telemetry.schema_version = 1 || resource.threadnote.telemetry.schema_version = 2 || resource.threadnote.telemetry.schema_version = 3) && span:name = "threadnote.anonymous-diagnostic" } with (most_recent=true)
```

Validate the artifact locally with:

```sh
bun --bun vitest run test/unit/telemetry-gateway-dashboard.test.ts
```

## Validate and smoke locally

Roll out schema v3 gateway-first: deploy the revision that accepts v1, v2, and
v3, then require the production canary to store and read all four traces across
the three schemas. Deploy and validate the v3-capable dashboard before
releasing a v3 producer. Only after those gates pass may a consent-v3 producer
ship; its older consent-v1/v2 configurations fail closed until the user reviews
and reapplies consent. Keep the frozen v1/v2 ingress contracts and canary
coverage while supported older producers remain. A passing v1 or v2 canary does
not waive a failing v3 canary.

Validate the Collector config without contacting a backend:

```sh
docker run --rm \
  -e GRAFANA_CLOUD_OTLP_ENDPOINT='https://example.invalid/otlp' \
  -e GRAFANA_CLOUD_AUTHORIZATION='Basic ZHVtbXk6ZHVtbXk=' \
  -v "$PWD/infra/telemetry-gateway/collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.158.0@sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5 \
  validate --config=/etc/otelcol-contrib/config.yaml
```

Build the exact Fly image and confirm health with dummy exporter credentials:

```sh
docker build -f infra/telemetry-gateway/Dockerfile -t threadnote-telemetry-gateway .
docker run --rm -d --name threadnote-telemetry-gateway \
  -p 127.0.0.1:18080:8080 \
  -e GRAFANA_CLOUD_OTLP_ENDPOINT='https://otlp-gateway-prod-eu-west-2.grafana.net/otlp' \
  -e GRAFANA_CLOUD_AUTHORIZATION='Basic MTIzNDU2OnRva2Vu' \
  -e THREADNOTE_TELEMETRY_PUBLIC_INGESTION='enabled' \
  threadnote-telemetry-gateway
curl --fail --silent --show-error http://127.0.0.1:18080/healthz
docker stop threadnote-telemetry-gateway
```

Run `fly config validate` before deployment, then follow the production runbook.
