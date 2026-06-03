# Sharing memories with teammates

`threadnote share` lets a small team keep a curated set of durable memories in a
git repository so every member's local agent can recall them. Personal handoffs,
preferences, and unpublished durable notes stay local; only memories you
explicitly publish leave your machine.

## Model in one screen

- A **team** is a configured shared repo. Each team has a name (default:
  `default`), a git remote, a local working tree, and a separate gitdir.
- The working tree lives inside the OpenViking data tree at
  `~/.openviking/data/viking/<account>/user/<you>/memories/shared/<team>/`. That
  means files appearing in the worktree are also addressable as
  `viking://user/<you>/memories/shared/<team>/...` and show up in normal
  `recall`.
- The gitdir lives outside the OV data tree at
  `~/.openviking/share/teams/<team>.gitdir/` so OpenViking never sees git
  internals.
- Team configuration is recorded in `~/.openviking/share/teams.json` (mode
  `0600`).

## Workflow

### One-time setup

```bash
# Create the repo first on GitHub/GitLab/etc. and copy its SSH URL.
threadnote share init git@github.com:org/team-memories.git
# Optional: add a second team
threadnote share init --team friends git@github.com:you/friends-memories.git
# Switch the default with init --set-default <name> or by running publish/sync
# with an explicit --team.
```

`share init` clones the remote into your local memory tree and ingests any
existing markdown memories into OpenViking.

### See what's configured

```bash
threadnote share list
threadnote share status                # default team
threadnote share status --team friends
```

### Share a memory

```bash
# 1. Identify the personal URI you want to publish (use recall/list as usual).
# 2. Preview the would-be-published bytes before committing:
threadnote share publish viking://user/you/memories/durable/projects/foo/bar.md --preview
# 3. Publish:
threadnote share publish viking://user/you/memories/durable/projects/foo/bar.md
# Optional flags:
#   --preview       Read + strip + scrub the memory and print the exact bytes
#                   that would land in git; no writes, no commits, no pushes.
#                   Use this before any publish to catch leaks by inspection.
#   --redact        Replace soft-leak matches (local home paths) with
#                   placeholders and continue. Credentials still block.
#   --team <name>, --message "...", --no-push, --dry-run.
```

`share publish` moves the memory from your personal namespace into the team's
shared subtree, commits with the message
`share: publish <relative-path>`, and pushes. The memory's recall path becomes
`viking://user/you/memories/shared/<team>/durable/projects/foo/bar.md`.

Before writing, `share publish` strips `supersedes:` and `archived_from:`
lines from the memory's header block. Those pointers only resolve on the
publisher's machine — teammates pull via git and cannot dereference them — so
keeping them would just leak local-only provenance into team git history.

To update an existing shared durable memory, replace the shared URI directly:

```bash
threadnote remember \
  --replace viking://user/you/memories/shared/default/durable/projects/foo/bar.md \
  --project foo \
  --topic bar \
  --text "Updated shared knowledge."
```

For MCP, pass the same shared URI as `replaceUri` to `remember_context`.
Threadnote rewrites the shared memory in place, strips local-only provenance
headers, commits, and pushes the shared repo. You do not need to store a
personal replacement and run `share publish` again.

### Keep teammates' updates current

Threadnote does a periodic background `git fetch` for configured share teams.
When an agent calls MCP `recall_context` / `read_context`, or the CLI
`threadnote recall` / `threadnote read`, Threadnote checks whether a shared
repo is behind. If it is, Threadnote rebases the clean worktree, reindexes the
pulled markdown files into OpenViking, and then returns the requested
recall/read result. Sync errors degrade to warnings so memory access still
works with the best local data available.

Manual sync remains useful when you want to publish local edits, clear a dirty
shared worktree, resolve git conflicts, or force a sync immediately:

```bash
threadnote share sync                  # default team
threadnote share sync --team friends   # other team
threadnote share sync --no-push        # pull only
```

`share sync` will auto-commit any uncommitted edits in the worktree, fetch and
rebase from the remote, reindex pulled markdown files into OpenViking (so
`recall` finds them immediately), and push. Pass `--no-auto-commit` to refuse
syncing when the worktree is dirty. Automatic recall/read sync never commits a
dirty shared worktree; it warns and leaves that case for explicit
`threadnote share sync`.

### Take a memory back

```bash
threadnote share unpublish viking://user/you/memories/shared/default/durable/projects/foo/bar.md
```

The memory is rewritten back into your personal namespace and removed from the
shared repo.

### Stop sharing for a team

```bash
threadnote share remove --team friends             # deletes worktree + gitdir
threadnote share remove --team friends --keep-files
```

`share remove` without `--keep-files` deletes the local checkout. Push any
unpushed commits first (`threadnote share sync` or `git -C <worktree> push`),
otherwise unpublished work is lost.

## Privacy & safety rules

- Only memories you actively publish leave your machine. `share init` will
  refuse to clone over a non-empty worktree.
- `share publish` runs a best-effort scrubber over the memory text. It refuses
  to publish if it matches any of:
  - PEM private key headers (`-----BEGIN ... PRIVATE KEY-----`)
  - OpenAI / Anthropic-style `sk-...` keys (16+ chars). Note: this also matches
    any URL slug or random string starting with `sk-`; if you hit a false
    positive on legitimate content, edit the memory to break the pattern.
  - GitHub classic tokens (`gh[pousr]_...`)
  - GitHub fine-grained PATs (`github_pat_...`)
  - GitLab PATs (`glpat-...`)
  - HTTP `Bearer ...` tokens (20+ chars)
  - Bare JWTs (three base64url segments starting `eyJ...`) — catches a leaked
    token even when the surrounding `Authorization: Bearer ` prefix has been
    stripped. JWE tokens in legitimate documentation can collide; edit the
    memory if the false positive is unavoidable.
  - AWS access keys (`AKIA...`)
  - Slack tokens (`xoxa`, `xoxb`, `xoxc`, `xoxd`, `xoxe`, `xoxp`, `xoxr`,
    `xoxs`, with optional `-N-` segment markers — covers bot, user,
    configuration, legacy cookie, refresh, app, and similar shapes)
- `share publish` also blocks on soft-leak patterns that show up routinely in
  curated memories. These are redactable: pass `--redact` to replace each
  match with a generic placeholder and continue. Credentials always block
  regardless of `--redact`.
  - macOS home paths (`/Users/<you>/...`) → `<local-path>`
  - linux home paths (`/home/<you>/...`) → `<local-path>`
- The scrubber complements but does not replace human review. Strip the value,
  preview with `--preview`, and then publish.
- Only the `durable/` kind is shareable. `handoffs/`, `preferences/`,
  `incidents/`, and other lifecycle kinds stay local by construction — both
  the initial ingest (`share init`) and the sync-pull reindex (`share sync`)
  skip any file outside `durable/`.
- `share publish` deletes the personal copy after publishing. If you want to
  keep both, copy the memory to a new URI first (`ov read` then
  `threadnote remember`).
- `share publish` refuses to overwrite an existing shared memory at the same
  URI; use `threadnote remember --replace <shared-uri>` or
  `remember_context({replaceUri:"<shared-uri>"})` for updates, or pick a
  different topic name.

## Conflict resolution

`share sync` uses `git pull --rebase` against the remote. When git can't merge
cleanly:

1. The pull command reports the conflict and leaves the worktree in a
   rebase-in-progress state.
2. Resolve the conflicts manually in the worktree (it's a normal git checkout).
3. Run `git rebase --continue` (or `--abort`) yourself.
4. Re-run `threadnote share sync` to finish the reindex and push.

Two publishes touching the same `<topic>.md` from different machines will
collide; coordinate ownership per-topic, or use distinct topics.

## Cross-machine identity notes

Each user clones into their own user-namespaced path. A memory authored on
machine A as `viking://user/alice/memories/shared/team/durable/projects/foo/bar.md`
shows up on machine B as
`viking://user/bob/memories/shared/team/durable/projects/foo/bar.md`. The file
content is identical. `supersedes:` / `archived_from:` lines are stripped at
the publish boundary so cross-machine URI references don't pollute team git
history; explicit `viking://` references inside the body will point at the
author's
namespace. For now, prefer narrative references ("see the foo memory under
shared/team") over URI links in shared content.
