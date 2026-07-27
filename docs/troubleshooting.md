# Troubleshooting

## Start and stop do not launch a service

Threadnote 4 owns no daemon. `threadnote start` verifies the on-demand runtime and `threadnote stop` is a compatibility
no-op. Use `threadnote doctor` for storage, index, and model diagnostics.

## Home or migration problems

The owned home defaults to `~/.threadnote`. Check for an accidental override:

```sh
echo "$THREADNOTE_HOME"
threadnote doctor
threadnote migrate
```

`migrate` is a dry run unless `--apply` is present. It never deletes the legacy source. An interrupted copy can be
resumed; a promoted target has a checksummed receipt. If the target is unrelated or free space is insufficient,
migration stops before promotion.

## Semantic recall is unavailable

Lexical recall remains available. Inspect the explicit model and index state:

```sh
threadnote models list
threadnote models runtime
threadnote models verify <model-id>
threadnote index status
threadnote index verify
```

Install and select an embedding model before rebuilding. Model downloads require HTTPS access to the manifest’s pinned
repository revision. A checksum mismatch deletes the invalid partial file and never activates it.

The runtime requests prebuilt `node-llama-cpp` binaries only. If `models runtime` reports that no compatible prebuilt
binary exists, use a supported Node/platform combination; Threadnote will not silently compile one.

## An index rebuild was interrupted

Re-run `threadnote index rebuild`. Checkpoints contain a checksum and reuse unchanged URI+fingerprint chunks from both
the active generation and an interrupted staging generation. Activation occurs only after the complete sidecar and
pointer are durably written.

```sh
threadnote index verify
threadnote index rebuild
```

## MCP does not appear in the agent

```sh
threadnote mcp-install codex --apply
threadnote doctor
```

Then start a fresh agent session. Replace `codex` with the relevant client. Threadnote supports local stdio MCP only;
there is no HTTP endpoint, bearer token, host, or port to configure.

## Recall quality changed

Run the frozen release gate before changing ranking weights, chunking, model manifests, or fixture judgments:

```sh
npm run eval:recall:v2 -- \
  --baseline test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json \
  --fail-on-regression --fail-on-contract
```

Inspect global and per-category deltas. Safety metrics and failure counts cannot regress.
