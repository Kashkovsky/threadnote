<p align="center">
  <img src="./assets/brand/threadnote-logo.svg" alt="Threadnote logo" width="112">
</p>

# Threadnote

[![release](https://img.shields.io/github/v/release/Kashkovsky/threadnote?include_prereleases&label=release)](https://github.com/Kashkovsky/threadnote/releases) [![CI](https://img.shields.io/github/actions/workflow/status/Kashkovsky/threadnote/ci.yml?branch=main&label=CI)](https://github.com/Kashkovsky/threadnote/actions/workflows/ci.yml) [![downloads](https://img.shields.io/github/downloads/Kashkovsky/threadnote/total?label=downloads)](https://github.com/Kashkovsky/threadnote/releases) [![license](https://img.shields.io/github/license/Kashkovsky/threadnote)](./LICENSE) [![Bun](https://img.shields.io/badge/runtime-Bun%201.3.14-f9f1e1?logo=bun)](https://bun.com/)

> One engineer teaches it once. Every teammate's coding agent can use it.

Threadnote is a shared, local-first memory layer for the coding agents your team already uses. Alice's Codex can
publish a hard-won architecture decision; Bob's Claude Code, Cursor, or Copilot can auto-sync and recall it during the
next task. No copy-pasted handoff, vendor lock-in, or shared chat window required.

Personal working state stays local. Only curated durable knowledge or reusable artifacts that you explicitly publish
enter the team's Git-backed memory, with an exact preview, secret scanner, explicit soft-leak redaction, and history.
Persistence across sessions is the foundation; the differentiator is useful context moving safely between
**different users and different agents**.

Threadnote 4 is a self-contained native executable with an embedded Bun runtime. Canonical content, local models,
indexes, locks, logs, migration receipts, and sharing metadata are owned under `~/.threadnote`—no separately installed
runtime, Python service, external memory platform, or background daemon required.

**Website:** https://threadnote.io/

**Performance:** https://threadnote.io/performance/

**Documentation:** https://threadnote.io/docs/

## The Value

```text
Alice + Codex ──publish curated memory──▶ team Git repo
                                              │
                                      auto-sync on recall
                                              ▼
                              Bob + Claude Code / Cursor / Copilot
```

- **Cross-user and cross-agent.** Teammates share one knowledge layer without standardizing on one AI vendor.
- **Explicit, reviewable sharing.** Publish one durable memory or reusable artifact; preview and scan the exact shared
  bytes before they land in Git, and explicitly redact soft leaks when needed.
- **Private by default.** Personal handoffs, preferences, incidents, and unpublished memories stay on the local
  machine.
- **Targeted local recall.** A pinned BGE Small model runs in a supervised local worker through `node-llama-cpp`;
  agents load selected `threadnote://` records instead of replaying the entire memory history or sending it to a hosted
  embedding service.
- **Current-code relationships.** Separate native graph tools find definitions, paths, calls, inheritance, change
  impact, stable community membership, structural n-ary groups, hubs, confidence gaps, and cross-community links
  across broad source-language packs from the current Git commit plus this worktree's dirty overlay—without Python,
  Graphify, an external compiler, or a daemon.
- **Recall explains itself.** Semantic and BM25 relevance, fields, graph links, scope, lifecycle, currentness,
  authority, and feedback produce a confidence level and inspectable ranking reasons.
- **Routine continuity is automatic.** At meaningful task closeout, agents store normal durable feature knowledge and
  handoffs. Additional extracted candidates still require review before they become durable truth.
- **Durable and addressable.** Stable pointers let agents replace one current `project/topic` memory instead of
  accumulating stale notes.
- **Built for engineering work.** Decisions, invariants, preferences, handoffs, release workflows, and branch state
  have distinct lifecycles instead of becoming an undifferentiated chat summary.
- **Optional Obsidian bridge.** Allowlisted vault notes can join recall, and explicitly selected Threadnote memories can
  appear as generated, drift-protected Markdown in a vault without installing a plugin.
- **Shareable diagnostics without transcripts.** Bounded rotating logs capture versions, platform, command or MCP tool
  names, timings, and typed failures—never arguments, memory content, recall results, or MCP payloads. Preview and
  explicitly submit a support report with `threadnote report-issue`.
- **Optional anonymous telemetry.** Explicit versioned opt-in sends only allowlisted CLI/MCP operation traces with a
  random agent-session identity, duration, bounded process memory, subsystem phases, and typed failures. Successful
  automatic-update workers add only a closed result and, when updated, a repair-required boolean; failed workers retain
  the bounded failure outcome/type. Successful
  graph builds can additionally send coarse path-free build-kind, materialization, fallback, closure, efficiency,
  file-count, fact-byte, and amplification buckets. MCP graph inspections can add only closed request/scope,
  snapshot-selection/freshness, phase/stage, and published file/symbol/edge-count buckets. Failed graph-build lifecycle
  observations add only bounded outcome/type and interrupted ones only outcome/duration; neither adds graph
  classifications or buckets. Successful Context Briefs can add only closed scope, task-only/code-anchored contract,
  brief/locate/explain/trace/impact mode, five phase timings, returned lane, anchor coverage/gap/recovery classes,
  power-of-two anchor-work buckets, citation coverage/result/unknown-reason classes, output truncation, and coarse
  citation/status/repository/cache buckets. Deferred code-anchor finalization checkpoints add only a closed
  trigger/result and coarse work/latency buckets; non-successful operations never add result-derived fields. Telemetry
  never includes prompts, payloads, task/query text, code-ref selectors, paths,
  memory/citation/node/repository/workset/commit/snapshot/hash identity, exact private counts, error messages, stacks, or
  a persistent installation ID. The current schema-v6 surface requires consent version 6 unless the user previously
  chose automatic acceptance of future data-contract updates.

## Quickstart

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
threadnote mcp-install codex --apply # or claude / cursor / copilot
threadnote doctor
```

Each applied `mcp-install` registers only the selected host and installs its MCP configuration, compact user-level
bootstrap, and progressively loaded Threadnote skills. Cursor uses its supported user rule and skill directories; the
Marketplace plugin remains an optional alternative instruction provider. Threadnote never writes to Cursor's
local-plugin directory. See the [Cursor plugin guide](./docs/cursor-plugin.md) for the alternative provider and
publishing workflow.

To select the Threadnote 4 beta channel on macOS or Linux, pass `--beta`. This inclusive preview channel installs the
newest immutable release across stable and prerelease builds, so a newer stable release wins when one is available:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh -s -- --beta
```

On POSIX systems the installer adds `~/.local/bin` to the detected shell profile when needed. A piped installer cannot
change its parent shell, so it also prints absolute next commands and the shell-specific `PATH` command that works
immediately; open a new terminal or run that command before invoking `threadnote` by name.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1 | iex
threadnote mcp-install codex --apply # or claude / cursor / copilot
threadnote doctor
```

Or install a specific release from the
[GitHub Releases page](https://github.com/Kashkovsky/threadnote/releases) and run:

```sh
threadnote install
threadnote doctor
threadnote mcp-install codex --apply
```

The downloaded executable embeds the pinned Bun runtime. Users do not need Bun or Node installed. Installers accept
only immutable GitHub releases and SHA-256 verify archives before atomic promotion. Threadnote 4 releases currently publish
Developer ID signed and notarized macOS builds plus checksum-verified Linux and Windows builds. Threadnote 4.6 Windows
archives are intentionally unsigned: the installer verifies the immutable GitHub release and SHA-256 checksum and
prints that limitation before activation. Windows may still show a SmartScreen warning.

After the standalone payload is active, installation removes only verified global npm-distributed Threadnote packages,
including early Node-based 4.0 betas, and Threadnote-owned OpenViking tools found through uv, pipx, or a user-local pip
installation. It unloads the legacy Threadnote OpenViking LaunchAgent on macOS, then writes the new standalone launcher.
Canonical rollback and migration data under `~/.openviking` is always preserved.

The CLI is the complete execution surface. MCP is a local stdio process with a focused default toolset; install
`--toolset full` only when an agent needs maintenance and artifact-sharing tools.

New to Threadnote? Ask your agent **"what can I do with Threadnote?"** It calls `threadnote_guide`, returns a short
walkthrough tailored to your setup, and offers to run each step with you. The walkthrough loads only when requested, so
it does not occupy context during normal work.

Anonymous operational telemetry is off by default. Review the exact contract with `threadnote telemetry enable`, then
opt in with `threadnote telemetry enable --apply`. See [optional anonymous telemetry](./docs/telemetry.md) for its
allowlist, session semantics, kill switches, network-privacy limitation, and collector architecture.

## Development

Threadnote's infrastructure and orchestration run on Effect 4 beta. Each CLI, MCP, or manager process owns one root
Effect runtime and scope; raw filesystem, process, HTTP, digest, SQLite, and native-addon access stay behind capability
services and adapters.

Contributors need Bun `1.3.14`. Run `bun install --frozen-lockfile`, then `bun run typecheck && bun run test`.

See the [contribution guide](CONTRIBUTION.md), [evaluation contract](test/evaluation/README.md),
[migration guide](docs/migration.md), [Obsidian bridge](docs/obsidian.md), [sharing guide](docs/share.md),
[release signing guide](docs/releasing.md), [website guide](docs/website.md), and
[troubleshooting guide](docs/troubleshooting.md).

## License

Threadnote is licensed under [AGPL-3.0-or-later](./LICENSE). Model licenses are recorded separately in their manifests
and third-party notices.
