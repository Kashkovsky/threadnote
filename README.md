# Threadnote

`threadnote` is a safe local workflow for using OpenViking as shared, agent-neutral context for development work.
It is intentionally scoped to curated docs, memories, skills, and handoffs. It is not a source-navigation replacement,
and it does not index whole repositories by default.

## Real-World Uses

Want to continue work in a fresh agent session? `threadnote install` adds user-level Codex and Claude instructions so
new agents automatically recall recent handoffs and relevant memories before they start changing code.

Implemented a feature a while ago and need to pick it up again? Ask the agent to recall the feature, branch, or repo.
Threadnote returns auditable `viking://` pointers that the agent can read before deciding what still matters.

Switching between Codex and Claude? Install the MCP adapter for both. The user-level instructions tell agents to store a
handoff before they pause, so the next agent can search the same local memory layer instead of reconstructing context
from chat history.

Found a durable workflow fact, like how a repo runs tests or where release notes live? Ask the agent to remember it.
Threadnote keeps that memory local and searchable without editing unrelated repo files.

## Safety Model

- Machine writes stay **locally** under `THREADNOTE_HOME`, which defaults to `~/.openviking`.
- Curated manifests only: seed commands import only paths listed in `config/seed-manifest.example.yaml` or an explicit
  per-developer manifest.
- Ignore rules: `.threadnoteignore` excludes build output, binary artifacts, local auth files, env files, and logs.
- Redaction: known config files such as `.mcp.json`, `config.toml`, and settings JSON are copied through a redactor
  before import.
- Secret scanning: candidate files are skipped if common token or private-key patterns remain after redaction.
- User instructions: `install` upserts a managed Threadnote block in `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, and
  `~/.cursor/rules/threadnote.md` without replacing existing personal instructions.
- Agent config changes are explicit: `mcp-install` prints commands and snippets by default; use `--apply` to run them.

## Install

Install with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
```

This installs the published package from npmjs and runs `threadnote install`. It does not use npm `postinstall`,
because setup writes local machine config and should be an explicit action.

Start the local server and confirm it is healthy:

```bash
threadnote start
threadnote doctor --dry-run
```

If install or health checks fail, see `docs/troubleshooting.md`.

To force a runtime:

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | THREADNOTE_RUNTIME=bun sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | THREADNOTE_RUNTIME=deno sh
```

Or install manually:

```bash
npm install --global threadnote
threadnote install
threadnote start
threadnote doctor --dry-run
```

### MCP

Make the agents you use aware of Threadnote. Use only the MCP install lines for agents you actually use. Open a fresh
agent session after installing MCP so the new server registration is loaded.

Dry-run examples:

```bash
threadnote mcp-install codex
threadnote mcp-install claude
threadnote mcp-install cursor
```

Apply after review:

```bash
threadnote mcp-install codex --apply
threadnote mcp-install claude --apply
threadnote mcp-install cursor --apply
```

Claude installs at `user` scope by default so the same OpenViking MCP server is available from any repo or worktree.
Use `--scope local` or `--scope project` only when you intentionally want repo-scoped Claude MCP config.
Cursor installs by updating the global `~/.cursor/mcp.json` file.

If the package or checkout that originally installed `threadnote` has moved, run repair:

```bash
threadnote repair
```

This rewrites the `threadnote` shim and reinstalls the stdio MCP adapter for available agents so launcher paths point
at the current checkout.

The default install uses the bundled stdio MCP adapter, because OpenViking `0.3.12` does not expose the native `/mcp`
HTTP route:

```bash
codex mcp add threadnote -- threadnote-mcp-server
claude mcp add threadnote -- threadnote-mcp-server
```

Cursor uses the equivalent entry in `~/.cursor/mcp.json`.

If a future OpenViking build exposes a healthy native endpoint, install it explicitly:

```bash
threadnote mcp-install claude --native-http --apply
```

### Seed Local Repos

Memories and handoffs work before seeding. Seed local repos when you want agents to recall repo guidance, docs, and
skills without reopening the same files by hand.

Create or update the local manifest with the repos you care about:

```bash
threadnote init-manifest --repo ~/src/my-service --repo ~/work/mobile-app
```

Review what will be imported, then seed curated repo guidance:

```bash
threadnote seed --dry-run
threadnote seed
```

Optionally seed shared and repo-local skills:

```bash
threadnote seed-skills --dry-run
threadnote seed-skills
```

When you add another local repo later, rerun `init-manifest --repo <path>` and seed again.

This is it! Start working with your agents as usual. The agent will automatically recall relevant memories and store the new ones. If you want to force it to recall/handoff something, just ask explicitly.

## Commands

- `doctor`: checks prerequisites, the generated command shim, manifest shape, templates, and local OpenViking health.
- `install`: installs `openviking[local-embed]==0.3.12` if missing, creates `~/.openviking` config files if absent,
  writes the command shim, and upserts user-level agent instructions.
- `repair`: fixes install/config/shim/manifest/server health issues and rewrites Codex/Claude/Cursor MCP configs from the
  current checkout.
- `start`: starts `openviking-server` on `127.0.0.1:1933`.
- `stop`: stops the detached server pid or macOS LaunchAgent.
- `uninstall`: removes Threadnote shims, MCP config, launchd config, and managed user instructions. Memories are
  preserved by default; pass `--erase-memories` to delete `THREADNOTE_HOME`.
- `init-manifest`: creates or updates `~/.openviking/seed-manifest.yaml` from one or more developer repo roots.
- `seed`: imports curated repo guidance and docs from the manifest.
- `seed-skills`: imports global and repo-local `SKILL.md` files as a searchable resource catalog. Use
  `seed-skills --native` only after configuring a working VLM provider.
- `mcp-install codex|claude|cursor`: installs or prints OpenViking MCP configuration for Codex, Claude, or Cursor.
- `remember`: stores a durable memory.
- `recall`: searches shared OpenViking context. It infers repo or skill scope from queries like
  `skills for api service`; use `--uri` or `--no-infer-scope` to override.
- `read`: reads a `viking://` URI returned by `recall` or `list`.
- `list` / `ls`: lists a `viking://` directory.
- `handoff`: stores current git state and next-step notes as a durable handoff.
- `forget`: removes a `viking://` URI.
- `export-pack` / `import-pack`: moves local context through `.ovpack` files.

## Source Checkout

TypeScript sources live under `src/`; `src/threadnote.ts` is the CLI entrypoint and `src/mcp_server.ts` is the stdio MCP
adapter entrypoint.

For local development from this repo:

```bash
npm install
npm run build
npm run doctor -- --dry-run
npm run threadnote -- install
```

`install` writes a small command shim to `~/.local/bin/threadnote` by default and upserts user-level agent guidance in
`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, and `~/.cursor/rules/threadnote.md`. After that, use the short command from
any repo or working directory:

```bash
threadnote doctor --dry-run
threadnote init-manifest --repo ~/src/my-service --repo ~/work/mobile-app
threadnote start
threadnote seed --dry-run
threadnote seed-skills --dry-run
```

If `~/.local/bin` is not on your `PATH`, either add it or set `THREADNOTE_BIN_DIR` before running `install`.
After reviewing dry-run output, remove `--dry-run` for the operation you want to perform.

The bundled `config/seed-manifest.example.yaml` is only an example. Each developer should create a local manifest at
`~/.openviking/seed-manifest.yaml` with `threadnote init-manifest`; repo paths can be anywhere.

## Configuration

Environment variables:

- `THREADNOTE_HOME`: local state directory, default `~/.openviking`.
- `THREADNOTE_MANIFEST`: seed manifest path. Defaults to `~/.openviking/seed-manifest.yaml` if present, otherwise
  the bundled example manifest.
- `THREADNOTE_ACCOUNT`: OpenViking account header/config value, default `local`.
- `THREADNOTE_USER`: OpenViking user value, default local username.
- `THREADNOTE_AGENT_ID`: shared agent identity, default `threadnote`.
- `THREADNOTE_OPENVIKING_VERSION`: package version to install, default `0.3.12`.
- `THREADNOTE_BIN_DIR`: directory for the `threadnote` shim, default `~/.local/bin`.
- `THREADNOTE_HOST`: local bind host, default `127.0.0.1`.
- `THREADNOTE_PORT`: local bind port, default `1933`.

Local projects using `localhost:80` or `localhost:443` do not conflict with OpenViking on `127.0.0.1:1933`. A conflict
only occurs when another process already owns the same host and port. If that happens, choose a different
`THREADNOTE_PORT`.

## Misc

See `docs/migration.md` for switching an existing repo workflow to `threadnote` without deleting canonical
`AGENTS.md`, `CLAUDE.md`, `.claude/`, or `.agents/` files.

See `docs/agent-instructions.md` for the user-level agent guidance installed by `threadnote install`.

## Recall And Read

Recall is a search step. It returns candidate `viking://` URIs plus abstracts. Agents should then read or list the
selected URI:

```bash
threadnote recall --query "agent context"
threadnote read viking://agent/threadnote/memories/.abstract.md
threadnote list viking://agent/threadnote/memories --all --recursive
```

When MCP is installed, the agent should use Threadnote MCP `recall_context`, then `read_context` or `list_context`.
Agents must pass JSON arguments, for example `recall_context({"query":"agent context"})`. Older adapters expose
`search`, `read`, and `list` aliases. The CLI commands are the fallback path.
