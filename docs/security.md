# Security

`threadnote` treats OpenViking as durable local memory, so the default workflow is conservative.

## Do Not Ingest

- Credentials, access tokens, API keys, certificates, private keys, or shell history.
- Customer data, production data, HIPAA data, or production logs without explicit approval and scrubbing.
- Local auth files such as `~/.codex/auth.json`, `~/.claude/.credentials.json`, Cursor account/session files, or VS Code
  Copilot account/session files.
- Local settings files that may contain secrets unless they go through redaction.

## Built-In Controls

- `.threadnoteignore` excludes common secret and build-output paths.
- `.mcp.json`, `config.toml`, and settings JSON are redacted before import.
- Files are skipped if common secret patterns remain after redaction.
- `mcp-install` requires `--apply` before it changes Codex, Claude, Cursor, or Copilot config.
- `install` updates user-level Codex, Claude, Cursor, and Copilot instruction files through managed Threadnote content.
  Existing personal instructions outside managed blocks are preserved.
- `uninstall` preserves local memories by default. `--erase-memories` is required before deleting `THREADNOTE_HOME`.
- Config files created under `THREADNOTE_HOME` are written with user-only permissions.

## Rollout Requirements

Before team-wide use, get explicit legal and security review for:

- OpenViking licensing and operational use.
- Approved embedding and summary model providers.
- At-rest encryption settings.
- Local API key requirements.
- Forget/removal expectations for stale or sensitive context.
