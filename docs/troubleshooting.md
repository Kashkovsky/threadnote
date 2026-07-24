# Troubleshooting

## `openviking-server` Missing

Run:

```bash
threadnote install
```

The installer prefers `uv`, then `pipx`, then the platform Python launcher (`py`/`python` on Windows or `python3` on
macOS and Linux). For `curl | sh` installs, the wrapper reattaches `threadnote install` to your terminal when possible
so it can prompt to install `uv` and continue instead of falling straight through to the pip fallback. Native Windows
uses `scripts/install.ps1`, preserves npm's `threadnote.cmd` launcher, and can install `uv` with its official PowerShell
bootstrap.

## `uv` Fails With `UnknownIssuer`

Some corporate machines trust PyPI through certificates installed in the system keychain. Threadnote passes
`--system-certs` when it uses `uv` so those system certificates are loaded. This flag requires uv 0.11.0 or newer;
Threadnote selects a compatible `uv` elsewhere on `PATH` or tries to update an older installation before using it.

If the automatic update cannot produce a compatible version, update uv and retry:

```bash
uv self update       # standalone uv installation
brew upgrade uv      # Homebrew installation
threadnote update
```

If an older install still fails with `invalid peer certificate: UnknownIssuer`, retry with:

```bash
UV_NATIVE_TLS=1 threadnote install
```

Or use a different Python installer:

```bash
threadnote install --package-manager pipx
threadnote install --package-manager pip
```

## Model Download Fails With `CERTIFICATE_VERIFY_FAILED`

On install or first start, OpenViking may download the local embedding model from Hugging Face. If
`~/.openviking/logs/server.log` shows `SSLCertVerificationError`, `self-signed certificate in certificate chain`, or
`Failed to download local embedding model`, repair the OpenViking Python environment and start again:

```bash
threadnote repair --package-manager uv
threadnote doctor --dry-run
```

Threadnote installs `pip-system-certs` into the OpenViking environment so Python `requests` can use certificates trusted
by the operating system.

If an older Threadnote release tries to reinstall all of OpenViking and fails while fetching packages such as `openai`,
install the certificate bridge directly into the existing OpenViking environment:

```bash
uv pip install --system-certs --python "$(dirname "$(realpath "$(which openviking-server)")")/python" pip-system-certs
threadnote start
```

## Local Embedding Extra Missing

The default OpenViking config uses the local embedding backend. If the server log says `llama-cpp-python` is missing,
rerun:

```bash
threadnote install
```

The installer repairs this by installing `openviking[local-embed]`.

## Server Health Fails

Current Threadnote installs start the local server by default. If `doctor` reports
`WARN openviking health: connect ECONNREFUSED 127.0.0.1:1933`, the local server is not running. Start it and recheck:

```bash
threadnote start
threadnote doctor --dry-run
```

Check whether the server is running:

```bash
curl http://127.0.0.1:1933/health
```

For detached starts, logs are written to:

```text
~/.openviking/logs/server.log
```

If `start` reports that OpenViking did not become healthy, first check whether it finished shortly after the timeout:

```bash
threadnote doctor --dry-run
```

If it still is not healthy, open that log. Certificate failures during the first embedding model download are covered
above.

## Semantic Queue Stuck / Memory Writes Hang

Symptom: agents hang or `remember`/`handoff` get very slow, and `~/.openviking/logs/server.log` repeats:

```
RuntimeError: Failed to list memory directory viking://user/.../memories/.../<name>.md: Directory not found
```

A memory _file_ got enqueued for directory-level semantic processing; older OpenViking releases listed it as a
directory, failed, and re-enqueued the message forever. The entry is AGFS-persisted, so it survives a server restart.
Check the queue — a non-zero `Errors`/`Requeued` on the `Semantic` row is the signature:

```bash
ov observer queue
```

This is fixed upstream in OpenViking 0.4.5. Update Threadnote so it upgrades the pinned OpenViking install and restarts
the server:

```bash
threadnote update
```

If Threadnote is already current but OpenViking is still older than 0.4.5, force a reinstall of the pinned OpenViking
tool:

```bash
threadnote install --force
```

## Port Already In Use

The default bind address is `127.0.0.1:1933`. This does not conflict with projects serving `localhost:80`,
`localhost:443`, or custom hostnames from `/etc/hosts`; those are different host and port bindings.

If another process already uses port `1933`, pick a different port:

```bash
THREADNOTE_PORT=1934 threadnote start
THREADNOTE_PORT=1934 threadnote mcp-install codex --apply
```

Keep the same port in the agent MCP configuration and in future `threadnote` invocations.

## Seed Skips Files

Skipped files usually matched a secret detector after redaction. Inspect the file manually and either remove the risky
content or leave it out of the manifest.

## `seed-skills --native` Fails With `[INTERNAL]`

Native OpenViking skill ingestion generates skill overviews with the configured VLM provider. If the server log shows an
OpenAI quota, rate-limit, or authentication error, run `seed-skills` without `--native`. The default mode stores
`SKILL.md` files as searchable resources and does not require native skill overview generation.

After changing `~/.openviking/ov.conf`, restart the server:

```bash
threadnote stop
threadnote start
```

## Local AI Recall Is Stopped or Unhealthy

Inspect the persisted model path and loopback service:

```bash
threadnote local-ai status
threadnote local-ai start
```

Startup logs are written to `THREADNOTE_HOME/logs/local-ai.log`. If the model file is missing or fails verification,
or the private access token is missing or has unsafe permissions, rerun `threadnote local-ai install --force`. A
local-model failure does not block recall: Threadnote returns its deterministic result without query expansion. Stop
also refuses to signal a recorded PID when the authenticated endpoint cannot prove the same launch identity; inspect
that process manually instead of deleting the safety check.

## Claude MCP Fails While Health Is OK

Threadnote uses its bundled stdio MCP adapter by default, even when the installed OpenViking server exposes native
`/mcp`. The adapter adds Threadnote-specific tools and behavior such as shared-memory sync, exact recall fallback,
seeded-resource recall augmentation, and recall-index repair.

The adapter exposes eight tools by default: `recall_context`, `read_context`, `list_context`, `remember_context`,
`review_session_context`, `apply_memory_candidates`, `share_publish`, and `threadnote_guide`. Install with
`--toolset full` to also expose memory maintenance, advanced sharing/artifact tools, compatibility aliases, and raw
OpenViking parity tools with `ov_*` names for native behaviors such as code symbol navigation, watch management, raw
search/read/list/store/remember, grep/glob, resource import, and forget.

Use the default stdio adapter:

```bash
threadnote mcp-install claude --apply
claude mcp list
```

Changing toolsets rewrites the same MCP entry. For the complete surface, run
`threadnote mcp-install claude --toolset full --apply`, then start a fresh agent session.

`mcp-install claude` writes user-scoped Claude config by default. This is intentional: local-scoped config only applies
to one repo/project, and the `threadnote` shim runs the implementation from the checkout that installed it.

Only use `--native-http` when you intentionally want the raw OpenViking HTTP endpoint instead of Threadnote's adapter.

## Worktree Was Deleted

Memories live in `~/.openviking/data`, so deleting a branch or worktree does not delete stored memories. The launcher
configuration can still point at scripts inside the deleted worktree, though.

From any fresh checkout, run:

```bash
threadnote repair
```

`repair` reinstalls the `threadnote` shim, repairs generated config files, starts OpenViking if needed, repairs stale
recall indexes, and rewrites Codex/Claude/Cursor/Copilot MCP configs to point at the current checkout.

## MCP Install Is Only Printing Commands

This is expected. Run with `--apply` after reviewing the command:

```bash
threadnote mcp-install codex --apply
```

For Cursor:

```bash
threadnote mcp-install cursor --apply
```

This updates the global `~/.cursor/mcp.json` file. Restart Cursor or open a fresh agent session after changing MCP
config.

For GitHub Copilot in VS Code:

```bash
threadnote mcp-install copilot --apply
```

This updates the VS Code user-profile `mcp.json` file. Restart VS Code or run `MCP: List Servers` from the Command
Palette after changing MCP config. If VS Code uses a custom profile path, set `THREADNOTE_COPILOT_MCP_CONFIG` to that
`mcp.json` path before running the command.

## Cursor MCP Tool Says Query Is Missing

If Cursor shows an error like `expected string, received undefined` for Threadnote `search`, the MCP server started but
Cursor called the tool without JSON arguments. Prefer the Threadnote-named tool and pass a query explicitly:

```json
{"query": "current repo latest handoff"}
```

Current Threadnote adapters expose `recall_context` for this flow. Older adapters expose `search`; both require the same
`query` argument. Run `threadnote repair` after upgrading if Cursor still lists only stale tools.

## Uninstall Without Losing Memories

Run:

```bash
threadnote uninstall --dry-run
threadnote uninstall
```

By default, uninstall removes Threadnote-managed shims, MCP config, launchd config, and user instruction blocks while
preserving `THREADNOTE_HOME`. To delete local OpenViking data too, pass `--erase-memories`.
