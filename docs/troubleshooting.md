# Troubleshooting

## Node is unsupported or npm reports EBADENGINE

Threadnote requires Node `^22.22.2`, `^24.15.0`, or `>=26.0.0`; Node 24 LTS is recommended. The bootstrap installers
and `threadnote update` stop before npm changes the package when the active Node is incompatible. A direct
`npm install --global threadnote` can print npm's engine warning before Threadnote's package preflight runs, so prefer
the bootstrap installer for recovery.

```sh
# nvm on macOS/Linux
nvm install 24
nvm use 24

# Homebrew on macOS
brew update
brew upgrade node
```

```powershell
# nvm-windows
nvm install 24.18.0
nvm use 24.18.0

# Windows Package Manager
winget upgrade --id OpenJS.NodeJS.LTS -e
```

Open a new terminal after changing Node, then rerun the same Threadnote bootstrap installer. Global npm packages are
version-scoped under nvm, so the old command may no longer be on `PATH`; this is expected. After the new installation
succeeds, Threadnote finds packages whose manifest name is exactly `threadnote` under other nvm Node versions and asks
those versions' own npm to uninstall them. It does not recursively delete unverified directories and does not
automatically modify Node itself.

Preserve the release channel when reinstalling. The bootstrap defaults to stable; beta users should set the package
selection explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh |
  THREADNOTE_PACKAGE=threadnote@beta sh
```

```powershell
$env:THREADNOTE_PACKAGE = 'threadnote@beta'
irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1 | iex
```

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
binary exists, use a supported Node/platform combination; Threadnote will not silently compile one.

Install and repair also retire the old 3.x Python local-AI daemon after migration. Threadnote signals a process only
after its legacy receipt, loopback health response, PID, launch ID, model ID, and token-derived proof all agree.
Unverified or unresponsive PIDs are left untouched with a warning.

## An index rebuild was interrupted

Re-run `threadnote repair` or `threadnote index rebuild`. The lexical SQLite database is disposable and rebuilt from
canonical Markdown after corruption. Vector checkpoints contain a checksum and reuse unchanged URI+fingerprint chunks
from both the active generation and an interrupted staging generation. Activation occurs only after the complete
sidecar and pointer are durably written.

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
