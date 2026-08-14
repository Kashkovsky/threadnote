#!/usr/bin/env bash

set -euo pipefail

validate=false
deploy=false
supersede=false

while IFS= read -r -d '' path; do
  case "$path" in
    .dockerignore | fly.toml | \
      .github/workflows/telemetry-gateway.yml | \
      .github/workflows/telemetry-delivery-canary.yml | \
      docs/operations/telemetry-production.md | docs/telemetry.md | \
      infra/telemetry-gateway/* | test/unit/telemetry-gateway-*.test.ts)
      validate=true
      ;;
  esac

  case "$path" in
    .dockerignore | fly.toml | \
      infra/telemetry-gateway/Dockerfile | \
      infra/telemetry-gateway/collector.yaml | \
      infra/telemetry-gateway/go.mod | \
      infra/telemetry-gateway/go.sum | \
      infra/telemetry-gateway/telemetry-schema-v*.json)
      deploy=true
      supersede=true
      ;;
    infra/telemetry-gateway/internal/*)
      if [[ "$path" != *_test.go ]]; then
        deploy=true
        supersede=true
      fi
      ;;
  esac

  if [[ "$path" =~ ^infra/telemetry-gateway/[^/]+\.go$ && "$path" != *_test.go ]]; then
    deploy=true
    supersede=true
  fi

done

printf 'validate=%s\n' "$validate"
printf 'deploy=%s\n' "$deploy"
printf 'supersede=%s\n' "$supersede"
