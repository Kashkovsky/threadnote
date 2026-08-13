# Git beta migration and exit portability

Migration is a one-way import followed by an explicit environment transport switch. It is not synchronization. The
operator never deletes the Git source and the client never dual-writes Git and remote memory.

## Prerequisites

- provision the target tenant/share/principal and project/repository mappings;
- enable `remote_memory_read` and `git_beta_import` on the target share;
- select and record an alias compatibility end timestamp;
- freeze Git-beta writes for the migration window or repeat planning after the last write;
- use the dedicated `NOSUPERUSER NOBYPASSRLS` migrator/operator database role and an untracked working directory;
- back up the source Git share and target database;
- ensure the source path is the checked-out team root containing `durable/projects`.

Git-beta import currently accepts durable project memories in this canonical layout:

```text
threadnote://user/<user>/memories/shared/<team>/durable/projects/<project>/<topic>.md
```

Handoffs were VM-local in the beta and are not silently promoted. Importing another kind or layout is classified
invalid. Source-user/team/project policy must be explicit. Symlinks, oversize inputs, invalid canonical Markdown,
metadata/URI mismatches, credentials, and machine-local paths are blocked.

## Dry-run

Run the checkout-local operator. The output file must not already exist:

```sh
THREADNOTE_REMOTE_DATABASE_URL='postgresql://...' \
  bun src/standalone.ts remote-memory-operator import-plan \
  --source /path/to/team-share \
  --user cursor-cloud \
  --team engineering \
  --share sh_example \
  --projects threadnote,api \
  --alias-compatibility-ends-at 2027-12-31T23:59:59.000Z \
  --output ./import-dry-run.v1.json
```

Review counts and every non-importable classification:

- `would_import`: target does not exist and content is valid;
- `unchanged`: target hash matches;
- `duplicate`: multiple identical sources resolve to one target;
- `conflict`: sources disagree or an existing target has different content;
- `blocked`: scrubber or source-policy violation, including unmapped user/team/project;
- `invalid`: unsupported layout/version/URI/Markdown/metadata.

The plan digest covers the ordered entries, policy, share, dry-run/apply mode, alias end, counts, and no-source-mutation
contract. No raw matched credential is included in a reason.

## Apply and verification

Resolve every block/conflict/invalid record, repeat planning with `--for-apply`, then apply that exact plan:

```sh
THREADNOTE_REMOTE_DATABASE_URL='postgresql://...' \
  bun src/standalone.ts remote-memory-operator import-plan \
  --source /path/to/team-share \
  --user cursor-cloud \
  --team engineering \
  --share sh_example \
  --projects threadnote,api \
  --alias-compatibility-ends-at 2027-12-31T23:59:59.000Z \
  --output ./import-apply.v1.json \
  --for-apply

THREADNOTE_REMOTE_DATABASE_URL='postgresql://...' \
  bun src/standalone.ts remote-memory-operator import-apply \
  --source /path/to/team-share \
  --user cursor-cloud \
  --team engineering \
  --plan ./import-apply.v1.json \
  --receipt ./import-receipt.v1.json
```

The PostgreSQL adapter applies revisions, aliases, outbox, bounded audit metadata, and immutable import receipt in one
transaction. Replaying the same plan returns its stored result. Existing content divergence fails. The operator
re-reads target hashes and aliases after apply; cutover is `ready` only when they match. The receipt states:

```text
dualWrite: disabled
sourceDeletion: not_performed
switch: explicit_required
verification: matched
```

Store the plan and receipt in an access-controlled migration record—not a public repository. Verify the imported count,
canonical hashes, aliases, committed/indexed generations, bounded recall/read fixtures, and tenant isolation. Wait for
index convergence or explicitly accept the recent-write overlay evidence.

## Cutover

Only after a ready receipt:

1. keep the Git share frozen and retained as rollback evidence;
2. render/verify the two-entry remote-hybrid Dashboard configuration;
3. explicitly replace the Git-beta MCP entry in the Cursor team environment;
4. start a clean VM with no memory checkout and verify only the authorized remote share is recalled;
5. write a fixture durable memory and handoff, then recall both from a fresh VM;
6. observe errors, index lag, conflicts, and authorization metrics through the canary window.

Do not run the two memory modes concurrently. Do not make the old checkout writable. Do not use a personal memory
fallback if remote verification fails.

## Migration rollback

Before the explicit Dashboard switch, rollback is simply: keep the Git beta authoritative, disable `git_beta_import`,
retain the remote records for investigation, and fix/replan. Import never modified the source.

After the switch, rollback requires exit export:

```sh
THREADNOTE_REMOTE_DATABASE_URL='postgresql://...' \
  bun src/standalone.ts remote-memory-operator export \
  --share sh_example \
  --output ./threadnote-remote-export
```

The output directory must not exist. The operator writes canonical Markdown plus `threadnote-export.v1.json`, validates
content hashes and path containment, and renames the staged directory atomically. Copy it to a new restricted Git
checkout, verify the manifest and every hash, review lifecycle/status semantics, commit/push intentionally, freeze
remote writes, then explicitly change the Dashboard back to Git-beta mode. Never replay into the old pre-cutover
checkout or enable service-side dual-write.

## Alias window

Imported Git URIs are aliases only inside the authenticated target share and resolve to the immutable remote URI. The
plan records the exact compatibility end; lookups stop using an expired alias. Before expiry, update durable references
and agent instructions to canonical remote URIs, measure alias use, notify operators, export a final mapping, and test
that old aliases fail without affecting canonical reads. Extending the window requires a reviewed migration operation,
not an undocumented database edit.

## Data deletion

Neither import nor rollback deletes data. Any later source or remote deletion requires owner approval, verified export,
audit record, index cleanup, replica/backup expiry tracking, and the tenant's documented deletion SLA.
