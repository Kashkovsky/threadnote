# Obsidian bridge

Threadnote can use Obsidian as an optional human-facing surface without an
Obsidian plugin. The bridge is local-only and experimental:

- allowlisted vault notes can become untrusted external recall sources;
- selected Threadnote memories can appear as generated, read-only Obsidian
  notes and Bases;
- a projected `threadnote://` memory can be opened in Obsidian;
- explicitly marked notes in one configured Inbox can form memory candidates
  for the normal agent review workflow.

Threadnote remains authoritative for memory identity, lifecycle, trust,
provenance, recall, and sharing. Source indexing does not create memories, and
editing a projected note does not update Threadnote.

## Configure a read-only source

Choose the smallest useful allowlist. Threadnote always excludes `.obsidian/**`
and `.trash/**`; a configured Inbox and a managed projection in the same vault
are also excluded automatically.

```bash
threadnote source add --type obsidian --id engineering \
  --vault "/path/to/Engineering Vault" \
  --include "Engineering/**" \
  --exclude "Engineering/Private/**" \
  --inbox "Threadnote Inbox"

# Inspect the normalized configuration, then persist it.
threadnote source add --type obsidian --id engineering \
  --vault "/path/to/Engineering Vault" \
  --include "Engineering/**" \
  --exclude "Engineering/Private/**" \
  --inbox "Threadnote Inbox" \
  --apply
```

Inventory and sync are explicit:

```bash
threadnote source inventory engineering
threadnote source sync engineering
threadnote source sync engineering --apply
threadnote source status engineering
```

The default sync is a dry run. Apply reads Markdown files only, rejects boundary
escapes and symlinks, blocks likely credentials, redacts local path leaks in a
sanitized copy, and atomically commits that copy to Threadnote's native store
under:

```text
threadnote://resources/external/obsidian/<source-id>/<vault-relative-path>
```

The vault itself is never modified. Recall derives `authority: external` and
`trust: untrusted` from this URI boundary, regardless of source frontmatter, and
warns that the result is not authoritative guidance.

Watched refresh is intentionally not part of the initial bridge. Run sync
explicitly so every refresh goes through the same inventory and reviewable
safety boundary.

## Project Threadnote memories into Obsidian

```bash
threadnote projection add --type obsidian --id engineering-memory \
  --vault "/path/to/Engineering Vault" \
  --folder Threadnote
threadnote projection add --type obsidian --id engineering-memory \
  --vault "/path/to/Engineering Vault" \
  --folder Threadnote \
  --apply

threadnote projection sync engineering-memory
threadnote projection sync engineering-memory --apply
threadnote projection status engineering-memory
```

By default, the projection includes active durable memories and handoffs,
including shared memories. Repeat `--kind` or `--status` to choose another
filter, and pass `--no-shared` to keep shared memories out.

The managed folder contains:

```text
Threadnote/
  Memories/<project>/<kind>/<topic>--<stable-id>.md
  Views/*.base
  README.md
  .threadnote-projection-v1.json
```

Generated notes contain a managed marker, stable memory ID, canonical
`threadnote://` URI, lifecycle metadata, source hash, evidence, and relation links.
Threadnote secret-scans rendered output before writing it.

Sync never overwrites an unmanaged file. If a previously generated file was
edited, status reports drift and preserves it. `--force` can regenerate or
remove only paths already recorded as managed by that projection.

## Open a recalled memory

```bash
threadnote open \
  threadnote://user/example/memories/durable/projects/threadnote/obsidian.md
```

If the memory appears in multiple projections, choose one:

```bash
threadnote open <viking-uri> --projection engineering-memory
```

Threadnote prefers the official Obsidian CLI and falls back to the registered
`obsidian://open` URI handler. See Obsidian's
[CLI](https://obsidian.md/help/cli) and
[URI](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI)
documentation for the underlying application contracts.

## Form candidates from an Inbox

Inbox scanning is the only vault-to-memory writeback path. It scans only direct
Markdown children of the configured Inbox. An eligible note has:

```yaml
---
threadnote_candidate: true
kind: durable
project: threadnote
topic: example
---
The candidate memory body.
```

Supported kinds are `durable`, `handoff`, and `preference`. Durable notes may
set `category: decision` or `category: invariant`; `evidence` may be a list of
pointers. Content cannot claim trusted authority, approved status, or an actor.

```bash
threadnote inbox scan --source engineering
threadnote inbox scan --source engineering --apply
```

The first command previews comparison results. `--apply` creates candidate
reviews; it does not create or replace a durable memory. The agent presents
those reviews in its normal closeout workflow, and they are also visible in the
Manager Candidate Inbox. The user still approves, edits, defers, or rejects each
operation. Repeated scans of unchanged notes are idempotent.

## Removal and troubleshooting

```bash
threadnote projection remove engineering-memory
threadnote projection remove engineering-memory --apply
threadnote source remove engineering
threadnote source remove engineering --apply
```

Projection removal deletes only unchanged managed files. Source removal deletes
only its external index and private connector state. Both preserve the vault
and authoritative Threadnote memories.

If a sync reports drift, inspect the changed projected note before choosing
`--force`. If Obsidian Sync is also active, let it settle before refreshing the
projection to avoid observing a partially synchronized managed folder. If a
source note is skipped, remove the reported credential category or narrow the
allowlist; diagnostics never print the matching secret or note body.
