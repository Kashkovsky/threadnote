# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 ghcr.io/project-zot/zot:v2.1.20@sha256:95a837a0afacf5b7edc0c92493f04beee6891989b8d2fd50a00cf65a1e6d4fd5 AS zot

FROM --platform=linux/amd64 oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu && rm -rf /var/lib/apt/lists/*
COPY --from=zot /usr/local/bin/zot-linux-amd64 /usr/local/bin/zot
COPY deploy/threadnote-org-registry/render-config.ts /opt/threadnote-org-registry/render-config.ts
COPY deploy/threadnote-org-registry/entrypoint.sh /usr/local/bin/threadnote-org-registry-entrypoint
RUN chmod 755 /usr/local/bin/zot /usr/local/bin/threadnote-org-registry-entrypoint && mkdir -p /data
EXPOSE 5000
ENTRYPOINT ["/usr/local/bin/threadnote-org-registry-entrypoint"]
