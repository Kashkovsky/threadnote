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

## Quickstart

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
threadnote mcp-install codex --apply # or claude / cursor / copilot
threadnote doctor
```

Cursor instructions are distributed separately as the **Threadnote** Cursor Marketplace plugin. Threadnote never writes
to Cursor's local-plugin directory; install the plugin from Cursor after it is listed, or ask a team administrator to
add it to the team's marketplace. The MCP command above remains required because it writes the user- and
platform-specific server configuration. See the [Cursor plugin guide](./docs/cursor-plugin.md) for installation,
diagnostics, and publishing.

To opt into prerelease builds, install the Threadnote 4 beta channel on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh -s -- --beta
```

On POSIX systems the installer adds `~/.local/bin` to the detected shell profile when needed. A piped installer cannot
change its parent shell, so it also prints absolute next commands and the shell-specific `PATH` command that works
immediately; open a new terminal or run that command before invoking `threadnote` by name.

Windows PowerShell, once Threadnote 4 Windows publishing is re-enabled:

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
Developer ID signed and notarized macOS builds plus checksum-verified Linux builds. Windows 4 publishing is temporarily
disabled until Authenticode signing is approved and verified; Threadnote will not ship an unsigned official Windows
archive.

After the standalone payload is active, installation removes only verified global npm-distributed Threadnote packages,
including early Node-based 4.0 betas, and Threadnote-owned OpenViking tools found through uv, pipx, or a user-local pip
installation. It unloads the legacy Threadnote OpenViking LaunchAgent on macOS, then writes the new standalone launcher.
Canonical rollback and migration data under `~/.openviking` is always preserved.

The CLI is the complete execution surface. MCP is a local stdio process with a focused default toolset; install
`--toolset full` only when an agent needs maintenance and artifact-sharing tools.

New to Threadnote? Ask your agent **"what can I do with Threadnote?"** It calls `threadnote_guide`, returns a short
walkthrough tailored to your setup, and offers to run each step with you. The walkthrough loads only when requested, so
it does not occupy context during normal work.

## Daily Workflow

```sh
threadnote recall "threadnote latest handoff" --caller-cwd "$PWD"
threadnote read threadnote://user/me/memories/handoffs/active/threadnote/release.md
threadnote remember --kind durable --project threadnote --topic storage-contract --text "..."
threadnote handoff --project threadnote --topic release --text "..."
threadnote graph query --query "release update lifecycle"
threadnote graph analyze --view hubs
```

Repo files remain authoritative. `threadnote seed` imports only files selected by the seed manifest. Canonical
resources and memories keep stable `threadnote://` identifiers while their bytes live in the Threadnote-owned store.

Memory recall and code search are deliberately separate. Agents use `recall_context` for historical decisions,
handoffs, and seeded guidance; `inspect_code_graph` with `query`, exact `node`/`neighbors` drill-down, `explain`, `path`,
or `impact` for scoped current-source questions; and `analyze_code_graph` for whole-repository statistics, structural communities, hubs or god nodes, and
surprising cross-community links. Analysis also supports stable community drill-down, structural groups, confidence
audits, and suggested follow-up questions. MCP impact accepts either an explicit symbol/path query or a Git `base` ref.
A task can combine the tools without a graph build adding latency or surprise I/O to ordinary recall.

## Native Code Graph

The first graph query lazily builds a disposable snapshot below `~/.threadnote/indexes/code-graph/`. Committed source
comes from bounded Git object reads; eligible dirty and untracked files are overlaid per worktree. Clean worktrees
share an immutable commit snapshot, while dirty snapshots store only changed facts and deletion markers. Independent
clones keep separate operational stores, and one worktree can never see another's dirty graph. Eligible file, byte,
symbol, edge, lexical-term, and vector counts are not capped by repository size; fixed-size processing batches bound
transient work without truncating the stored graph.

TypeScript and JavaScript retain the compiler-backed extractor that shipped with the first native graph. Java,
Kotlin, Swift, Bash, C, C++, C#, Dart, Elixir, Go, HCL/Terraform, Julia, Lua, Objective-C, PHP, PowerShell, Python,
Ruby, Rust, Scala, Solidity, Svelte, SystemVerilog/Verilog, Vue, and Zig use exact-pinned, bundled Tree-sitter WASM
grammars for portable structural extraction. Apex, Fortran, and Razor use bounded deterministic text-structural packs
because no compatible prebuilt WASM is available or the format mixes template languages. Compiler-backed TypeScript
relationships remain higher-fidelity than structural packs; every pack advertises its actual capabilities and
unresolved relationships remain syntactic. Deterministic extractors also cover SQL, GraphQL, protobuf, common
configuration/schema formats, Dockerfiles, manifests, Bazel/Starlark build metadata, and workspace metadata. A generated language-pack catalog owns
file matching, parser/cache identity, workspace discovery, lookup rules, capabilities, and verified assets, so future
first-party languages do not require changes to inventory, storage, query, CLI, or MCP architecture.

The same snapshot can index searchable text and explicit links from local text documents, notebooks, HTML/XML,
text-based diagrams, PDFs, OpenXML documents (`docx`, `pptx`, `xlsx`), OpenDocument files (`odt`, `odp`, `ods`), and
EPUB. Diagram markup is indexed as text; it is not interpreted as visual semantics. Images, audio, and video become
searchable asset nodes with deterministic format, size, and available dimension metadata, but Threadnote performs no
OCR, image understanding, audio transcription, or video/frame analysis. PDFs without extractable text are likewise
represented as assets rather than guessed. A corpus artifact over 64 MiB remains indexed as a metadata-only asset
instead of being rejected or semantically decompressed. Selected OpenXML, OpenDocument, and EPUB text entries have
bounded expansion. These are per-artifact extraction safety budgets, not repository or graph-size caps.

Hidden directories and conventional generated roots such as `node_modules`, `dist`, `build`, `out`, `.nx`,
`graphify-out`, and `bazel-*` are pruned before content is read, including when a broad package root contains them. Large unknown JSON,
JSONC, and YAML files keep only bounded structure, while recognized snapshots, golden files, fixtures, datasets, and
animation payloads are fingerprinted with a streaming read and represented by their file/module metadata only. Package
manifests, schemas, and configuration files keep their dedicated extraction paths.

Comments marked `NOTE`, `WHY`, `HACK`, `RATIONALE`, `DECISION`, `SAFETY`, or `INVARIANT`, plus ADR/RFC citations,
become first-class rationale nodes linked to the nearest source declaration. They remain repository evidence, not
canonical Threadnote memory.

Small cold graphs normally finish inside the first MCP call. If a large monorepo needs longer, `inspect_code_graph`
returns a structured `state: "indexing"` response with the current phase and `retryAfterMilliseconds` while the
session-scoped build continues. Agents retry the same graph call instead of waiting for the MCP transport timeout or
falling back to broad text search. Concurrent `threadnote graph index` commands show that they are waiting for the
active build and remain interruptible; they do not fail after a fixed graph-lock deadline. Interactive indexing reports
Git read batches, each extraction file and language with parse timing, and each persistence batch. Extraction runs in
a bounded worker pool shared across concurrent Threadnote processes, while one backpressured SQLite writer preserves
deterministic order.

```sh
threadnote graph status
threadnote graph query --query "exclusive file lock"
threadnote graph node --node-id cgs_…
threadnote graph neighbors --node-id cgs_… --direction incoming --depth 2
threadnote graph explain --symbol CodeGraphQueryService
threadnote graph path --from runApplication --to cgs_…
threadnote graph impact --base origin/main
threadnote graph analyze --view communities
threadnote graph community --community-id cgc_…
threadnote graph groups
threadnote graph stats
threadnote graph hubs
threadnote graph surprises
threadnote graph report --output architecture-report.md
threadnote graph export --format graphml --output code-graph.graphml
threadnote graph index --full
threadnote graph diagnostics --analyze
threadnote graph repair --all --dry-run
threadnote graph compact --dry-run
```

`graph status` reports active SQLite database, WAL, and SHM bytes plus page/freelist and reclaimable-byte diagnostics.
When both 512 MiB and 20% of the database are reclaimable it recommends explicit compaction. `graph compact` takes
zero-wait maintenance and checkout locks, verifies the active snapshot before and after SQLite's transactional
`VACUUM`, and defers safely during a build. Preview it with `--dry-run`; `--force` is available below the reviewed
threshold.

`graph diagnostics` is home-wide and does not resolve a repository from the current directory. It reports every local
graph database, ready snapshot, indexed view, active build, waiter, storage total, health issue, and obsolete store;
add `--analyze` for bounded structural statistics per ready indexed view, `--deep` for full SQLite integrity checks,
or `--json` for the versioned diagnostic document. `graph repair --all` immediately runs pending persistent-schema
migrations instead of waiting for a later graph query. Its default quick pass avoids scanning every page of a large
database; use `--deep` only when a full integrity check and destructive recovery are intended, and preview either mode
with `--dry-run`.

The local Manager exposes the same graph administration lifecycle from its Graph panel: home-wide quick or deep
diagnostics, immediate repair, per-view status, index/reindex, compaction previews, obsolete-store pruning, and
per-graph or all-graph purge. Destructive actions require an explicit browser confirmation. When an older indexed
view has no live worktree association, Manager asks for a local path and verifies its checkout/worktree identity before
acting.

`threadnote manage` fails fast when graph repair or another native graph maintenance operation is already active;
an already-running Manager returns an explicit busy response for graph requests until maintenance finishes.

Maven, Gradle, Kotlin Multiplatform/Android conventions, SwiftPM, conservative Xcode metadata, and nested or integrated
Bazel workspaces form a static workspace model; repository build scripts are never executed. Bazel `WORKSPACE`,
`MODULE.bazel`, `BUILD`, `.bzl`, and `.bazelrc` files contribute declared targets, loads, and labels without invoking
Bazel or evaluating macros. Nested workspaces remain distinct, while an app that is also integrated into the outer
monorepo can resolve only its explicitly declared project dependencies. Ambiguous or dynamic relationships stay
syntactic.

Exact and normalized SQLite lexical search always work. If the core embedding model is installed—as it is by default—
Threadnote also maintains code-symbol vectors in a paged, snapshot-atomic SQLite generation through the same
supervised local-model worker. Vector construction, reuse, and exact search operate in fixed pages rather than decoding
one repository-sized sidecar. Every relationship is labeled declared, resolved, syntactic, heuristic, or model-derived
and includes a repository-relative evidence location. `threadnote doctor` checks graph integrity; `threadnote repair`
cleans only disposable graph state.

Every returned symbol includes a stable `cgs_` identity. `graph node` resolves that ID exactly, `graph neighbors`
walks its bounded incoming, outgoing, or bidirectional neighborhood, and `graph path` accepts stable IDs as either
endpoint. This lets agents round-trip a selected symbol without relying on fuzzy names in large or repetitive codebases.

Whole-graph analysis is deterministic and SQLite-paged. It has no repository-size admission cap; elapsed-time and
response-size budgets return explicit partial-coverage warnings instead of rejecting a large monorepo. The Manager
loads the same topology signals only when the user selects **Analyze**, so opening a graph does not force a full
analysis. `graph report` writes a deterministic Markdown architecture report. `graph export` streams JSON, GraphML,
HTML, or SVG without materializing the graph in memory: JSON, GraphML, and HTML select the complete snapshot by
default, while SVG defaults to a readable 300-node/1,000-edge overview. Explicit `--node-limit all --edge-limit all`
is accepted for every format; those output controls are not graph admission limits.

## Updates

```sh
threadnote update          # latest stable release
threadnote update --beta   # opt into the latest beta release
threadnote update --stable # return to the stable channel
```

Stable installs report and install stable releases only. After opting into beta, ordinary `threadnote version` and
`threadnote update` calls stay on the beta channel. Run `threadnote update --stable` to switch back, even when the
stable release has a lower version than the installed beta.

Threadnote 3 cannot cross the new standalone-runtime boundary with `threadnote update`. Install v4 fresh using the
installer above; after that, `threadnote update` manages all later 4.x releases.

## Why Not Just Markdown Files?

Use Markdown files. Threadnote makes them operational.

- **`AGENTS.md` / `CLAUDE.md` / repo docs:** stable, reviewed, version-controlled rules.
- **Random notes:** easy to write, hard for agents to rank, scope, update, or recognize as stale.
- **Threadnote memories:** Markdown in a canonical local store plus hybrid recall, stable URIs, explicit lifecycle,
  scoped compaction, MCP tools, safe team sharing, and optional Obsidian views.

The source of truth remains ordinary files. Threadnote lets agents find the right record, understand why it ranked,
decide whether it is current, update it without creating duplicates, and safely move the reusable part into a
teammate's agent.

## Agent Perspective

**Without Threadnote:** "I inspect the repo, ask what changed, rediscover the test command, and hope the compacted chat
summary did not drop the important caveat."

**With Threadnote:** "I recall the branch handoff and durable feature memory first. I can name the files touched, the
last failing check, the design decision behind the code, and the next step before editing."

**After a team publishes a decision:** "My agent auto-syncs the curated memory during recall, even if it is a different
agent from the one that originally learned it."

## Real-World Uses

- **Share a team decision:** Alice publishes an API contract; Bob's different agent auto-syncs it on its next recall.
- **Continue a branch:** "Continue where we left off" prompts the agent to recall the active handoff and durable feature
  memory.
- **Switch agents:** "Save where we are" stores a handoff that the next MCP-enabled agent can read.
- **Survive compaction:** a concrete handoff preserves commands, blockers, decisions, and next steps across sessions.
- **Remember a repo fact:** "This repo cuts release notes from CI" becomes a durable workflow memory.
- **Review additional context:** the agent proposes extracted candidates; you approve, edit, defer, or reject them in
  the same conversation.
- **Share with teammates:** publish curated durable memory or reusable artifacts to a team Git repository.
- **Use an Obsidian vault:** recall allowlisted notes as external context or publish selected Threadnote memories as a
  generated human-readable view.

## Obsidian

The optional zero-plugin Obsidian bridge keeps Threadnote authoritative. Explicitly allowlisted vault notes enter the
native store as untrusted external resources, refresh automatically before recall, and participate in normal ranking.
Users can publish explicitly selected memory URIs into a generated, one-way Markdown folder with Obsidian Bases and URI
navigation; connecting a projection does not export the whole memory corpus. Only notes placed in a configured Inbox
can form review candidates, and they are never applied silently.

```sh
# Vault → Threadnote: allowlist notes, then recall normally.
threadnote source add --type obsidian --id engineering \
  --vault "/path/to/Engineering Vault" \
  --include "Engineering/**" \
  --apply
threadnote recall --query "mobile authentication"

# Threadnote → vault: configure a generated view, then publish selected memories.
threadnote projection add --type obsidian --id engineering-memory \
  --vault "/path/to/Engineering Vault" \
  --folder Threadnote \
  --apply
threadnote projection publish engineering-memory \
  --uri threadnote://user/me/memories/durable/projects/mobile/authentication.md \
  --apply
```

Recall automatically refreshes every enabled source before ranking, while failures warn and fall back to the last
successful snapshot. Imported notes remain external and untrusted. Projection files are deterministic, scrubbed, and
drift-protected; Threadnote never treats edits to generated files as memory updates.

See the [Obsidian bridge guide](docs/obsidian.md) for setup, trust boundaries, drift handling, and removal.

## Recall

`threadnote install` automatically downloads, verifies, and selects the pinned 36.7 MB BGE Small embedding model.
Recall combines local `node-llama-cpp` vectors with deterministic lexical, field, scope, lifecycle, authority,
time, graph, and feedback signals. The lexical path remains available as a fail-open fallback if native inference is
temporarily unavailable.

```sh
threadnote models list
threadnote index verify
threadnote index status
```

The model download is resumable and preserved across upgrades. Every built-in manifest pins its immutable revision,
filename, size, SHA-256, license, runtime version, and memory class; checksums are verified before atomic promotion,
and native compilation is disabled. Additional embedding, reranking, and generation models remain explicit choices.
BGE Small passes the frozen category and no-answer gates; the measured Jina reranker does not and is not selected.

## Upgrade from 3.x

```sh
threadnote migrate
threadnote migrate --apply
threadnote doctor
threadnote index status
```

Migration inventories the legacy home, rejects unsafe links, checks free space, copies into sibling staging, validates
every copied hash, and atomically promotes `~/.threadnote`. If an earlier beta created an empty target, migration safely
recovers memories, resources, configured shares, and verified installed models without overwriting different content.
The source home is never modified or deleted, so rollback remains available while investigating.

## Quality Contract

The reviewed recall-v2 corpus contains 200 documents and 250 queries across lexical, semantic, code, scope, lifecycle,
authority, time, graph, no-answer, adversarial, chunking, and multilingual categories. Frozen 3.0.3 quality and M1 Max
performance baselines are checked in under `test/evaluation/baselines/threadnote-3.0.3/`.

The original code-graph-v1 repository fixture preserves compiler-backed TypeScript behavior and gates definitions,
paths, impact, documentation, false edges, no-answer behavior, and worktree isolation against frozen
Graphify/no-graph comparisons and a native baseline. A second frozen `code-graph-polyglot-v1` fixture and performance
baseline exercise Java, Kotlin, Swift, and TypeScript together, including JVM and Swift target dependencies.

```sh
bun run eval:recall:v2 -- \
  --baseline test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json \
  --fail-on-regression
bun run eval:recall:models -- --embedding bge-small-en-v1.5-q8 --install
bun run bench:recall:micro -- --json
bun run eval:code-graph
bun run bench:code-graph
```

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
