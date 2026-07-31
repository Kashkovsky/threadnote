# Troubleshooting

## The executable does not start

Threadnote releases are standalone executables with an embedded Bun runtime; users do not need Bun, Node, npm, or
Python installed. Verify the immutable release and archive checksum, then run `threadnote doctor --dry-run`. On macOS,
`codesign --verify --strict --verbose=2 "$(command -v threadnote)"` checks the Developer ID signature. On Windows,
`Get-AuthenticodeSignature (Get-Command threadnote).Source` should report `Valid`.

If an older npm-based Threadnote command shadows the standalone launcher, compare every result from
`command -v -a threadnote` on POSIX or `Get-Command threadnote -All` in PowerShell. The standalone installer removes
verified npm-distributed Threadnote installations automatically, including early Node-based 4.0 betas. If it warns
that a package manager could not remove one, run the exact printed uninstall command and rerun the installer. Threadnote
does not remove unverified third-party files. Threadnote 3 cannot install v4 through `threadnote update`; a fresh
standalone install is the supported upgrade path.

Preserve the release channel when reinstalling. The bootstrap defaults to stable; beta users select the beta channel:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh -s -- --beta
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1))) -Beta
```

The PowerShell beta path is available for testing but no official Windows 4 beta asset is published until Authenticode
signing is re-enabled.

## Start and stop do not launch a service

Threadnote 4 owns no daemon. `threadnote start` verifies the on-demand runtime and `threadnote stop` is a compatibility
no-op. Use `threadnote doctor` for storage, index, and model diagnostics.

## Collect production logs for support

Run `threadnote logs` to list the available files. Threadnote writes JSON Lines operational diagnostics under
`~/.threadnote/logs/threadnote.log`, rotates at 1 MiB, and retains five rotated files (`threadnote.log.1` through
`threadnote.log.5`). Appends and rotation are serialized both within one process and across concurrent agent
processes.

The log schema is intentionally narrower than console output: it includes the Threadnote and embedded Bun versions,
operating system and architecture, CLI command or MCP tool name, duration, outcome, and typed failure name. It never
records command arguments, environment values, memory content, recall queries or results, MCP request/response
payloads, or exception messages. Help, dry-run, implicit preview, and `report-issue` commands do not write logs.
Logging starts only after Threadnote owns a valid home, never creates a home before migration, and is best-effort so a
logging failure cannot fail the command.

Review the files before attaching them to a support report. The active file is newest; numbered files are progressively
older.

Create a Threadnote GitHub issue through an exact public preview:

```sh
threadnote report-issue \
  --title "Short failure summary" \
  --body "What happened, what was expected, and how to reproduce it"
```

Preview does not require GitHub CLI. For submission, install it from [cli.github.com](https://cli.github.com/) (or use
`brew install gh` on macOS / `winget install --id GitHub.cli` on Windows), authenticate with `gh auth login`, and rerun
with `--apply --approval sha256:...` using the approval digest printed by the preview. Threadnote refuses submission if
the title, body, diagnostics, or selected log excerpt changed after review. Add `--include-logs` only when you want the
newest valid production-log entries embedded in the issue. Threadnote re-parses those JSONL entries through a strict
field allowlist, omits older entries beyond the issue-body budget, and never posts raw command output. The request body
is passed to `gh api` through an owner-only temporary file rather than process arguments.

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

The standalone installer removes verified obsolete runtimes, not legacy data. It may uninstall the old global
Threadnote package, the Threadnote-owned OpenViking uv/pipx/user-pip tool, and the macOS
`io.threadnote.openviking` LaunchAgent. It never deletes `~/.openviking`; run `threadnote migrate --apply` to import
that source into the native Threadnote 4 home.

## Seed is slow or skips files

Threadnote applies `.threadnoteignore` while walking the filesystem, before entering ignored directories. The default
rules exclude dependency and build caches such as `node_modules/` and `.nx/`. Broad patterns also skip every directory
whose name starts with `.`, while an explicitly named manifest pattern such as `.github/**` or `.claude/**` still
includes that directory.

Each project is limited to 20,000 candidates, 250,000 visited non-ignored entries, and 4 MiB per file. Narrow the
project's seed patterns or extend `.threadnoteignore` if a limit is reported. A failed project no longer prevents later
projects from being processed, but the command returns a failure after writing the completed project state.

The final summary reports safety skips and project failures. Local POSIX home paths are redacted from every seeded text
file. Windows paths such as `C:/Users/...`, Git-Bash paths such as `/c/Users/...`, and WSL paths such as
`/mnt/c/Users/...` are retained because they describe portable path conventions rather than a macOS home.

## Semantic recall is unavailable

The core BGE embedding model and vector index are installed automatically by `threadnote install`. Repair their
derived state without selecting a model manually:

```sh
threadnote repair
threadnote models list
threadnote models runtime
threadnote models verify bge-small-en-v1.5-q8
threadnote index status
threadnote index verify
```

The initial model download requires HTTPS access to the manifest’s pinned repository revision and resumes after an
interruption. Repeat installs preserve a verified existing model. A checksum mismatch deletes the invalid partial file
and never activates it. Lexical recall remains available if native inference is temporarily unavailable, while
`threadnote doctor` reports the missing core capability as a failure.

The runtime requests prebuilt `node-llama-cpp` binaries only. If `models runtime` reports that no compatible prebuilt
binary exists, install the Threadnote archive matching your operating system and architecture; Threadnote will not
silently compile one.

Install and repair also retire the old 3.x Python local-AI daemon after migration. Threadnote signals a process only
after its legacy receipt, loopback health response, PID, launch ID, model ID, and token-derived proof all agree.
Unverified or unresponsive PIDs are left untouched with a warning.

## An index rebuild was interrupted

Re-run `threadnote repair` or `threadnote index rebuild`. The lexical and vector SQLite databases are disposable and
rebuilt from canonical Markdown after corruption. Vector values are content-addressed, so a retry reuses every valid
value already written. A changed active mapping is committed in one SQLite transaction only after every required
vector is present; an interrupted embedding run leaves the previous mapping available.

Repair and doctor also run a full SQLite integrity check over each derived native code graph. Large monorepo graphs can
take time to scan; both commands print the current graph database and cleanup phase while they work. If a graph is
reported as corrupt, run `threadnote repair`; repair discards unreadable derived graph databases, and the next graph
query rebuilds them.

```sh
threadnote index verify
threadnote index rebuild
```

## Code graph indexing or a language pack fails

The native graph supports TypeScript/JavaScript, Java, Kotlin, and Swift without invoking repository build tools.
TypeScript stays compiler-backed; the standalone archive bundles checksum-verified Java, Kotlin, and Swift grammar
WASM. Check the disposable graph and rebuild it with:

```sh
threadnote graph status
threadnote doctor --dry-run
threadnote graph index --full
```

A large cold MCP inspection can return `state: "indexing"` with measured phase progress, an optional phase-scoped
estimate, and adaptive retry timing. Continue useful targeted text or path investigation while it builds, then retry
the same `inspect_code_graph` call before making relationship-aware graph claims. There is no repository-size admission
limit and no daemon to start. Nested Maven, Gradle, SwiftPM, and Xcode scopes are detected statically. Dynamic build
logic and ambiguous dependencies remain syntactic rather than being guessed.

If doctor reports a missing or mismatched grammar asset, reinstall or update the standalone archive for the current
platform. Threadnote never downloads parser grammars at runtime. Repair may discard and rebuild graph SQLite files, but
it does not modify the repository or canonical memories.

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
bun run eval:recall:v2 -- \
  --baseline test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json \
  --fail-on-regression --fail-on-contract
```

Inspect global and per-category deltas. Safety metrics and failure counts cannot regress.
