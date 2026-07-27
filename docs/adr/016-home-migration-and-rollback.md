# ADR 016: Owned home migration and rollback

Status: accepted for 4.0
Date: 2026-07-27

## Decision

The only 4.0 owned home is `~/.threadnote`. Upgrade imports the legacy 3.x home through an inventory/copy/verify/promote
state machine. It never starts an old runtime and never mutates or deletes the source.

The migrator rejects absolute or escaping links, excludes runtime-only artifacts, preflights free space with a bounded margin,
records source metadata and hashes, resumes a compatible sibling staging directory, detects source mutation, verifies
all staged hashes, writes a checksummed receipt, and atomically promotes the target. Legacy share Git worktrees are
copied into `~/.threadnote/share/worktrees/<team>`, their `.git` and gitdir paths are rewritten for the final home, and
the canonical shared Markdown copy has no Git metadata. An unrelated target is an error.

## Consequences

- The untouched source is the rollback source; cleanup is always a separate, explicitly confirmed operation.
- Re-running is safe after interruption or success.
- Derived vector indexes are rebuilt after cutover instead of treated as canonical migration input.
- Migration logic is the only production area allowed to recognize the legacy home name or legacy runtime filenames.
