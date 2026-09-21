<p align="center">
  <img src="./assets/brand/threadnote-logo.svg" alt="Threadnote logo" width="112">
</p>

# Threadnote

[![release](https://img.shields.io/github/v/release/Kashkovsky/threadnote?include_prereleases&label=release)](https://github.com/Kashkovsky/threadnote/releases) [![CI](https://img.shields.io/github/actions/workflow/status/Kashkovsky/threadnote/ci.yml?branch=main&label=CI)](https://github.com/Kashkovsky/threadnote/actions/workflows/ci.yml) [![downloads](https://img.shields.io/github/downloads/Kashkovsky/threadnote/total?label=downloads)](https://github.com/Kashkovsky/threadnote/releases) [![license](https://img.shields.io/github/license/Kashkovsky/threadnote)](./LICENSE)

> Source-verifiable engineering context across coding-agent vendors.

Threadnote 5 helps coding agents start with the right decisions and current code evidence, then leave a reviewed
Knowledge Delta for the next engineer. It works across [catalog-supported agent
surfaces](https://threadnote.io/agents/) without making one chat history or vendor memory the source of truth.

Personal work stays local. Exact files in the current worktree remain authoritative. Only durable knowledge or
reusable artifacts—including verified procedures—that you explicitly review and publish cross into a Git-backed team
store.

**Website:** https://threadnote.io/

**Documentation:** https://threadnote.io/docs/

**Supported agents:** https://threadnote.io/agents/

**What’s new:** https://threadnote.io/whats-new/

## The Threadnote 5 workflow

1. **Start with a Context Brief.** The installed agent guidance automatically loads a bounded set of relevant
   decisions, active handoffs, compatible procedures, and current-code evidence with provenance, freshness, and
   visible gaps.
2. **Verify the live code.** Use exact local files and Threadnote’s code graph for current relationships; historical
   context never overrides the worktree.
3. **Review the Knowledge Delta.** At meaningful closeout, the agent writes a private handoff and proposes decisions,
   constraints, verification, invalidated knowledge, and unresolved risks. Approve, edit, defer, or reject each
   candidate.
4. **Share deliberately.** Publish approved knowledge directly or materialize a provider-neutral Git proposal for the
   team’s normal review policy. Private handoffs and preferences stay local.
5. **Keep context healthy.** Review ownership and expiry, changed citations, contradictions, guidance drift, Context
   Check findings, and local content-free value reports without silent deletion or publication.

Threadnote is a self-contained executable. The local and Git-team workflow needs no separately installed runtime,
Python service, database server, hosted organization account, or background daemon.

## Quick start

Install on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Kashkovsky/threadnote/main/scripts/install.ps1 | iex
```

Then open the repository you want Threadnote to understand, choose a managed surface from the catalog, preview setup,
and apply the same plan:

```sh
cd /path/to/repository
threadnote agents list
threadnote setup <surface>
threadnote setup <surface> --apply
```

Setup initializes the local core, repository seed, selected catalog integration and declared hooks, current code graph,
doctor checks, and a real source-backed Context Brief using its built-in repository-orientation task. Preview does not
write; interrupted apply is resumable; undo is also preview-first and removes only unchanged setup-owned artifacts.

Once your agent restarts, give it a normal engineering task. The installed instructions and skills make Context Brief
and closeout part of the agent's normal lifecycle, so you do not need a special Threadnote prompt. Ask “What can I do
with Threadnote?” only when you want the optional state-aware guided tour.

For the complete cross-agent path, see [Threadnote 5 context workflows](./docs/context-workflows.md) and [guided
two-agent activation](./docs/guided-activation.md). Team setup is covered by the [sharing guide](./docs/share.md).
Existing users can follow the website guides for [upgrading from Threadnote
4](https://threadnote.io/docs/upgrade-from-4/) or [migrating from Threadnote
3](https://threadnote.io/docs/upgrade-from-3/).

## Contributing

Contributions to the CLI, MCP server, Manager, website, documentation, tests, and agent workflows are welcome. Use the
Bun version pinned by `packageManager` in [`package.json`](./package.json), install dependencies, and run the narrowest
checks that cover your change:

```sh
bun install --frozen-lockfile
bun run typecheck
bun --bun vitest run <focused-test-file>
```

Read [CONTRIBUTION.md](./CONTRIBUTION.md) before a substantial change. It covers Effect conventions, focused testing,
security boundaries, generated files, pull requests, and the exact-HEAD development runtime.

## License

Threadnote is licensed under [AGPL-3.0-or-later](./LICENSE). Model licenses are recorded separately in their manifests
and third-party notices.
