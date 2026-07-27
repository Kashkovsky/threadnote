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
5. copies into a staging sibling of the final home;
6. records source size, modification time, and SHA-256;
7. verifies every staged hash and detects source changes during the copy;
8. isolates legacy Git share worktrees under `share/worktrees/`, rewrites their Git pointers, and retains a separate
   canonical Markdown copy;
9. records and verifies the transformed staging-tree hash;
10. writes a checksummed migration receipt;
11. atomically promotes the staging directory.

Interrupted staging is resumable. Re-running after success is idempotent. An unrelated existing target is never
overwritten. The source remains byte-for-byte untouched and is never automatically removed.

After promotion:

```sh
threadnote doctor
threadnote recall "latest handoff"
threadnote models list
threadnote index status
```

Lexical recall is immediately available. Optional vector indexes are derived data and should be rebuilt with an
explicitly installed and selected embedding model.
