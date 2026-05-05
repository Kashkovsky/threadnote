# Troubleshooting

## `openviking-server` Missing

Run:

```bash
threadnote install
```

The installer prefers `pipx`, then `uv`, then `python3 -m pip install --user`.

## Local Embedding Extra Missing

The default OpenViking config uses the local embedding backend. If the server log says `llama-cpp-python` is missing,
rerun:

```bash
threadnote install
```

The installer repairs this by installing `openviking[local-embed]`.

## Server Health Fails

Check whether the server is running:

```bash
curl http://127.0.0.1:1933/health
```

For detached starts, logs are written to:

```text
~/.openviking/logs/server.log
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

## Claude MCP Fails While Health Is OK

OpenViking `0.3.12` can be healthy at `/health` while returning `404` at `/mcp`. That means the stable server does not
expose the native HTTP MCP endpoint.

Use the default stdio adapter:

```bash
threadnote mcp-install claude --apply
claude mcp list
```

`mcp-install claude` writes user-scoped Claude config by default. This is intentional: local-scoped config only applies
to one repo/project, and the `threadnote` shim runs the implementation from the checkout that installed it.

Only use `--native-http` with an OpenViking build that actually exposes `/mcp`.

## Worktree Was Deleted

Memories live in `~/.openviking/data`, so deleting a branch or worktree does not delete stored memories. The launcher
configuration can still point at scripts inside the deleted worktree, though.

From any fresh checkout, run:

```bash
threadnote repair
```

`repair` reinstalls the `threadnote` shim, repairs generated config files, starts OpenViking if needed, and rewrites
Codex/Claude MCP configs to point at the current checkout.

## MCP Install Is Only Printing Commands

This is expected. Run with `--apply` after reviewing the command:

```bash
threadnote mcp-install codex --apply
```

## Uninstall Without Losing Memories

Run:

```bash
threadnote uninstall --dry-run
threadnote uninstall
```

By default, uninstall removes Threadnote-managed shims, MCP config, launchd config, and user instruction blocks while
preserving `THREADNOTE_HOME`. To delete local OpenViking data too, pass `--erase-memories`.
