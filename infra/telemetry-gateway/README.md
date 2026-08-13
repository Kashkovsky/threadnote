# Threadnote telemetry gateway

This Fly service accepts anonymous OTLP/HTTP protobuf traces at `/v1/traces`
and forwards the allowlisted envelope to Grafana Cloud. Logs and metrics do not
have pipelines. The public Go ingress is deliberately small and emits no access
logs; the Collector only listens on loopback.

The gateway is defense in depth, not a general OTLP schema firewall. It removes
unknown attributes, resource/scope identifiers, span events, links, trace state,
and status messages. The edge ingress enforces route, method, media type, body,
concurrency, and request-rate limits. Exact closed-enum validation remains the
producer's contract and should be expanded here as the schema stabilizes.
Source addresses are used only as process-ephemeral HMAC rate-limit keys; they
are neither logged nor forwarded. This Fly deployment is for bounded dogfooding,
not the broadly advertised default endpoint. Add generated, exact value/type
validation and a managed WAF before that wider rollout.

## Configure Fly

Use the Grafana Cloud OTLP base endpoint (without `/v1/traces`) and a literal
HTTP Basic authorization value:

```sh
fly secrets set \
  GRAFANA_CLOUD_OTLP_ENDPOINT='https://otlp-gateway-<region>.grafana.net/otlp' \
  GRAFANA_CLOUD_AUTHORIZATION='Basic <base64(instance-id:access-policy-token)>'
```

Do not commit either value. Grafana Cloud owns trace retention; choose its
shortest practical retention for dogfooding and revisit before wider rollout.

## Validate and smoke locally

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
  threadnote-telemetry-gateway
curl --fail --silent --show-error http://127.0.0.1:18080/healthz
docker stop threadnote-telemetry-gateway
```

Run `fly config validate` before `fly deploy`. Deployment is intentionally a
separate, operator-approved step.
