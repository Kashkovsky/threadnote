# 4.0 home migration

Threadnote 4 owns `~/.threadnote`. The legacy 3.x home is input to a one-time, non-destructive migration and is not a
runtime dependency.

```sh
threadnote migrate
threadnote migrate --apply
```

The migration:

1. inventories canonical resources, memories, seed state, share metadata, and applicable settings;
2. rejects absolute symlinks and relative symlinks or paths that escape the source;
3. excludes server, interpreter-environment, PID, socket, cache, and transient files;
4. checks target free space for source bytes plus a bounded safety margin;
5. copies into a staging sibling of the final home, or performs a no-overwrite resumable recovery when beta.1 already
   created `~/.threadnote`;
6. records source size, modification time, and SHA-256;
7. verifies every staged hash and detects source changes during the copy;
8. isolates legacy Git share worktrees under `share/worktrees/`, rewrites their Git pointers, and retains a separate
   canonical Markdown copy;
9. records and verifies the transformed staging-tree hash;
10. writes a checksummed migration receipt;
11. atomically promotes the staging directory;
12. flattens canonical content to `~/.threadnote/data/<account>`;
13. adopts any verified 3.x managed GGUF generation model into the role-aware model store and preserves its selection;
14. installs and selects the core BGE embedding model if no valid embedding selection already exists;
15. rebuilds the derived lexical SQLite and vector indexes from the migrated canonical content.

Interrupted staging and beta-home recovery are resumable. Re-running after success is idempotent. If beta.1 already
wrote a resource at the same logical path, that current Threadnote copy wins while the older copy remains available in
the untouched legacy home. Disjoint account trees are merged, identical overlaps are verified, and any other different
canonical destination stops the migration instead of being overwritten. The source remains byte-for-byte untouched
and is never automatically removed.

The standalone installer separately retires verified executable dependencies after activating the new release. It can
stop and uninstall a detected npm-distributed Threadnote package, including an early Node-based 4.0 beta, remove a
Threadnote-owned OpenViking uv/pipx/user-local pip tool, and unload the `io.threadnote.openviking` LaunchAgent. This
cleanup does not remove `~/.openviking`, its models, canonical resources, memories, or migration receipts. A rollback
that needs the old executable runtime must reinstall Threadnote 3/OpenViking and point it at the preserved home.

After promotion:

```sh
threadnote doctor
threadnote recall "latest handoff"
threadnote models list
threadnote index status
```

Lexical and vector recall are immediately available after install or repair completes. Both indexes are derived data
under `~/.threadnote/indexes/`; canonical memories and resources remain ordinary files under
`~/.threadnote/data/<account>`.
