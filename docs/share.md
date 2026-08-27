# Team sharing

Threadnote shares reviewed durable memories and agent artifacts through a user-provided Git repository. Canonical
shared resources remain under `~/.threadnote/data/.../memories/shared/<team>/`; git metadata and checked-out files are
isolated under `~/.threadnote/share/teams/` and `~/.threadnote/share/worktrees/`. Their exact paths are recorded in
`~/.threadnote/share/teams.json`.

```sh
threadnote share init git@github.com:org/team-memories.git
threadnote share status
threadnote share sync
threadnote share publish threadnote://user/me/memories/durable/projects/app/cache.md
```

Only active durable memories are publishable. The scrubber blocks credentials, customer-like secrets, and residual
machine-local paths; `--redact` applies only to supported soft patterns. Handoffs and preferences stay local.

A memory with [code citations](memory-code-citations.md) is publishable only when every citation was captured from
clean committed source, has a portable remote repository identity, and contains valid canonical metadata. A dirty,
local-only, or malformed citation blocks preview and publication. Commit the cited source and recapture it; Threadnote
never strips code evidence to make a memory shareable.

Publish is transactional:

1. re-read and scrub the personal source;
2. create and verify the shared canonical resource;
3. stage, commit, and optionally push the shared file;
4. verify the personal source did not change;
5. remove the personal copy.

A failed canonical write, verification, commit, or push preserves the personal source. Artifact and pack publishing
uses an undo journal so partial companion trees are removed and replaced content is restored.

## Read-only shared teams

Use a persistent read-only team when Threadnote should fetch, ingest, recall, report status, and install artifacts but
must never publish or push into that repository:

```sh
threadnote share init git@github.com:org/team-memories.git --team reference --read-only
threadnote share set-access --team reference --mode read-only
threadnote share sync --team reference
```

`share list` and `share status` display the persisted access mode. Read-only sync fetches, rebases, and ingests remote
changes, disables housekeeping commits and pushes, and refuses dirty worktrees or local commits instead of
auto-committing them. Memory publication, unpublish, local/merged conflict publication, and artifact or pack
publication fail before mutation. `--take shared`, recall, status, artifact installation, rename, and removal remain
available. Switch back explicitly with `share set-access --team <name> --mode read-write`.

## Unpublish a shared memory

`share unpublish --dry-run` performs the same destination and Git/worktree preflight as apply. It reports `--mode
create` when the personal destination is absent and `--mode resume` when the expected personal copy is already present
byte-for-byte. A different personal memory is a conflict in both modes and is never overwritten. Apply rechecks the
shared source and personal destination before deleting the shared canonical resource, so an interrupted unpublish can
be retried without losing either version.

## Rename or retire a team

For `share rename`, moving the worktree and gitdir and updating `teams.json` is the commit point. A later reindex or old
namespace cleanup problem is reported as a warning after the rename succeeds. Follow the warning using the new team
name: run `threadnote share sync --team <new-name>` before removing a retained old namespace with `threadnote forget
<old-shared-uri>`. Do not retry the original rename after `share list` shows the new name.

`share remove` disconnects the team and recursively removes its canonical shared namespace. `--keep-files` retains
only the checkout worktree and gitdir; it does not retain the canonical namespace. `--preserve-local` first plans every
durable memory as a personal `create` or byte-identical `resume`, converts shared visibility to personal, and refuses
the entire removal before changing team configuration if any different personal destination exists. Cleanup failures
after the configuration commit are bounded warnings with an explicit recovery action.

`share sync` is remote-authoritative for clean tracked files and records pending canonical-store replays when one item
fails. Dirty state, divergent local content, or conflicting edits are surfaced for explicit resolution:

```sh
threadnote share conflicts
threadnote share conflict-show <id>
threadnote share conflict-resolve <id> --take shared
```

Use `--take local` only after reviewing the scrubbed content, or provide an explicit merged file. Backups are written
before conflict mutation.

Skills, commands, and constellation packs are namespaced by agent and kind. Bundle manifests list every member and
path rewrite. Unsafe traversal, binary content without explicit permission, embedded credentials, reserved tokens,
and locally modified installs are blocked.
