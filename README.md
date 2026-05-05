# Threadnote

`threadnote` is a safe local workflow for using OpenViking as shared, agent-neutral context for development work.
It is intentionally scoped to curated docs, memories, skills, and handoffs. It is not a source-navigation replacement,
and it does not index whole repositories by default.

## Safety Model

- Curated manifests only: seed commands import only paths listed in `config/seed-manifest.example.yaml` or an explicit
  per-developer manifest.
- Ignore rules: `.threadnoteignore` excludes build output, binary artifacts, local auth files, env files, and logs.
- Redaction: known config files such as `.mcp.json`, `config.toml`, and settings JSON are copied through a redactor
  before import.
- Secret scanning: candidate files are skipped if common token or private-key patterns remain after redaction.
- User instructions: `install` upserts a managed Threadnote block in `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`
  without replacing existing personal instructions.
- Agent config changes are explicit: `mcp-install` prints commands and snippets by default; use `--apply` to run them.
- Machine writes stay under `THREADNOTE_HOME`, which defaults to `~/.openviking`.

## Install

Install with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
```

This installs the published package from npmjs and runs `threadnote install`. It does not use npm `postinstall`,
because setup writes local machine config and should be an explicit action.

To force a runtime:

```bash
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | THREADNOTE_RUNTIME=bun sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | THREADNOTE_RUNTIME=deno sh
```

Or install manually:

```bash
npm install --global threadnote
threadnote install
```

For a one-off check before installing globally:

```bash
npm exec --yes threadnote@latest -- doctor --dry-run
bunx threadnote@latest doctor --dry-run
deno run --allow-read --allow-env --allow-run --allow-net npm:threadnote@latest doctor --dry-run
```

Avoid using `npm exec` for `threadnote install`; durable shims and MCP launchers should point at a stable global installation, not npm's temporary package cache.

## Source Checkout

For local development from this repo:

```bash
npm install
npm run build
npm run doctor -- --dry-run
npm run threadnote -- install
```

`install` writes a small command shim to `~/.local/bin/threadnote` by default and upserts user-level agent guidance in
`~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. After that, use the short command from any repo or working directory:

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

## Commands

- `doctor`: checks prerequisites, the generated command shim, manifest shape, templates, and local OpenViking health.
- `install`: installs `openviking[local-embed]==0.3.12` if missing, creates `~/.openviking` config files if absent,
  writes the command shim, and upserts user-level agent instructions.
- `repair`: fixes install/config/shim/manifest/server health issues and rewrites Codex/Claude MCP configs from the
  current checkout.
- `start`: starts `openviking-server` on `127.0.0.1:1933`.
- `stop`: stops the detached server pid or macOS LaunchAgent.
- `uninstall`: removes Threadnote shims, MCP config, launchd config, and managed user instructions. Memories are
  preserved by default; pass `--erase-memories` to delete `THREADNOTE_HOME`.
- `init-manifest`: creates or updates `~/.openviking/seed-manifest.yaml` from one or more developer repo roots.
- `seed`: imports curated repo guidance and docs from the manifest.
- `seed-skills`: imports global and repo-local `SKILL.md` files as a searchable resource catalog. Use
  `seed-skills --native` only after configuring a working VLM provider.
- `mcp-install codex|claude`: installs or prints OpenViking MCP configuration for Codex or Claude.
- `remember`: stores a durable memory.
- `recall`: searches shared OpenViking context. It infers repo or skill scope from queries like
  `skills for api service`; use `--uri` or `--no-infer-scope` to override.
- `read`: reads a `viking://` URI returned by `recall` or `list`.
- `list` / `ls`: lists a `viking://` directory.
- `handoff`: stores current git state and next-step notes as a durable handoff.
- `forget`: removes a `viking://` URI.
- `export-pack` / `import-pack`: moves local context through `.ovpack` files.

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

## MCP

Dry-run examples:

```bash
threadnote mcp-install codex
threadnote mcp-install claude
```

Apply after review:

```bash
threadnote mcp-install codex --apply
threadnote mcp-install claude --apply
```

Claude installs at `user` scope by default so the same OpenViking MCP server is available from any repo or worktree.
Use `--scope local` or `--scope project` only when you intentionally want repo-scoped Claude MCP config.

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

If a future OpenViking build exposes a healthy native endpoint, install it explicitly:

```bash
threadnote mcp-install claude --native-http --apply
```

## Uninstall

Preview removal:

```bash
threadnote uninstall --dry-run
```

Remove Threadnote setup while keeping local OpenViking memories:

```bash
threadnote uninstall
```

Erase local memories too:

```bash
threadnote uninstall --erase-memories
```

`uninstall` removes only Threadnote-managed files and agent config. The npm, Bun, or Deno package remains installed;
remove that with the package manager you used to install it.

## Notes

OpenViking itself is not vendored here. This prototype installs and controls a local service and should get legal and
security review before broader rollout.

## Publishing

The npm package ships bundled CommonJS `.cjs` entrypoints in `dist/`; `tsx` is only used by `npm run dev` for
source-checkout development. There is no published TypeScript runner and no runtime npm dependency tree. The generated
user shim tries Node, Bun, then Deno.

```bash
npm run typecheck
npm run build
npm pack --dry-run
npm publish
```

See `docs/migration.md` for switching an existing repo workflow to `threadnote` without deleting canonical
`AGENTS.md`, `CLAUDE.md`, `.claude/`, or `.agents/` files.

See `docs/demo.md` for an engineer-facing demo script that shows recall, read, remember, handoff, and repair across
agents or worktrees.

See `docs/agent-instructions.md` for the user-level agent guidance installed by `threadnote install`.

## Recall And Read

Recall is a search step. It returns candidate `viking://` URIs plus abstracts. Agents should then read or list the
selected URI:

```bash
threadnote recall --query "agent context"
threadnote read viking://agent/threadnote/memories/.abstract.md
threadnote list viking://agent/threadnote/memories --all --recursive
```

When MCP is installed, the agent should use OpenViking MCP `search`, then `read` or `list` directly. The CLI commands
are the fallback path.
