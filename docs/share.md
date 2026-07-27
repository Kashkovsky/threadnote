# Team sharing

Threadnote shares reviewed durable memories and agent artifacts through a user-provided Git repository. Canonical
shared resources remain under `~/.threadnote/data/.../memories/shared/<team>/`; git metadata and checked-out files are
isolated under `~/.threadnote/share/teams/` and `~/.threadnote/share/worktrees/`. Their exact paths are recorded in
`~/.threadnote/share/teams.json`.

```sh
threadnote share init git@github.com:org/team-memories.git
threadnote share status
threadnote share sync
threadnote share publish viking://user/me/memories/durable/projects/app/cache.md
```

Only active durable memories are publishable. The scrubber blocks credentials, customer-like secrets, and residual
machine-local paths; `--redact` applies only to supported soft patterns. Handoffs and preferences stay local.

Publish is transactional:

1. re-read and scrub the personal source;
2. create and verify the shared canonical resource;
3. stage, commit, and optionally push the shared file;
4. verify the personal source did not change;
5. remove the personal copy.

A failed canonical write, verification, commit, or push preserves the personal source. Artifact and pack publishing
uses an undo journal so partial companion trees are removed and replaced content is restored.

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
