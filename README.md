# Threadnote

Threadnote gives development agents durable local memory, branch handoffs, curated repo guidance, and opt-in team
sharing. Version 4 is self-contained: canonical content, indexes, model files, locks, logs, migration receipts, and
share metadata are owned under `~/.threadnote`.

The installed product requires Node.js 22.19 or newer. It does not require Python, a second memory platform, or a
background daemon.

## Install

```sh
npm install --global threadnote
threadnote install
threadnote doctor
threadnote mcp-install codex --apply
```

Use `claude`, `cursor`, or `copilot` instead of `codex` for another supported client. MCP is a local stdio process.
The default `core` toolset stays compact; install `--toolset full` for maintenance and artifact-sharing tools.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1 | iex
```

## Daily workflow

```sh
threadnote recall "threadnote latest handoff" --caller-cwd "$PWD"
threadnote read threadnote://user/me/memories/handoffs/active/threadnote/release.md
threadnote remember --kind durable --project threadnote --topic storage-contract --text "..."
threadnote handoff --project threadnote --topic release --text "..."
```

Repo files remain authoritative. `threadnote seed` imports only the files selected by the seed manifest. Canonical
resources and memories keep stable `threadnote://` identifiers while their bytes live in the Threadnote-owned store.

## Recall

`threadnote install` automatically downloads, verifies, and selects the pinned 36.7 MB BGE Small embedding model.
Recall combines its in-process `node-llama-cpp` vectors with deterministic lexical, field, scope, lifecycle, authority,
time, graph, and feedback signals. The lexical path remains available as a fail-open fallback if native inference is
temporarily unavailable.

```sh
threadnote models list
threadnote index verify
threadnote index status
```

The core model download is resumable and is preserved across upgrades and repeat installs. Every built-in manifest
pins its immutable revision, filename, size, SHA-256, license, runtime version, and memory class; checksums are verified
before atomic promotion, and native compilation is disabled. Additional embedding, reranking, and generation models
remain explicit choices. BGE Small passes the frozen category and no-answer gates; the measured Jina reranker does not
and is not selected. Reviewed candidate summaries are checked in under
`test/evaluation/candidates/threadnote-4.0.0/`.

## Upgrade from 3.x

```sh
threadnote migrate
threadnote migrate --apply
threadnote doctor
threadnote index status
```

Migration inventories the legacy home, rejects unsafe links, checks free space, copies into sibling staging, validates
every copied hash, and atomically promotes `~/.threadnote`. If beta.1 already created an empty target, migration safely
recovers memories, resources, configured shares, and verified installed models into it without overwriting different
content. Canonical account data lives at `~/.threadnote/data/<account>`. The source home is never modified or deleted,
so rollback is simply restoring the previous `THREADNOTE_HOME` while investigating.

## Quality contract

The reviewed recall-v2 corpus contains 200 documents and 250 queries across lexical, semantic, code, scope, lifecycle,
authority, time, graph, no-answer, adversarial, chunking, and multilingual categories. Frozen 3.0.3 quality and M1 Max
performance baselines are checked in under `test/evaluation/baselines/threadnote-3.0.3/`.

```sh
npm run eval:recall:v2 -- \
  --baseline test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json \
  --fail-on-regression
npm run eval:recall:models -- --embedding bge-small-en-v1.5-q8 --install
npm run bench:recall:micro -- --json
```

See the [evaluation contract](test/evaluation/README.md), [4.0 plan](docs/4.0-plan.md),
[migration](docs/migration.md), [sharing](docs/share.md), and
[troubleshooting](docs/troubleshooting.md).

## License

Threadnote is licensed under AGPL-3.0-or-later. Model licenses are recorded separately in their manifests and
third-party notices.
