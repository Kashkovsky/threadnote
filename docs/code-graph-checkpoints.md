# Portable code graph checkpoints

Threadnote can move one verified native code graph between local installations as a file. Checkpoints are a manual,
offline transport: they do not require a Threadnote account, a Workset, or a hosted artifact service.

## Export

Index the repository at a clean commit, then export to a new path:

```sh
threadnote graph index
threadnote graph checkpoint export --output ./threadnote-graph.cgcp
```

Export accepts only the exact ready, clean root snapshot for the current `HEAD`. The repository must have a
credential-free remote identity such as `github.com/org/repository`; absolute local paths, configured remote credential
material, dirty source state, worktree identifiers, and raw source-file bytes are not embedded. Checkpoints do contain
source-derived names, signatures, and documentation, so a secret embedded in source can be carried into the artifact.
Existing output files are never overwritten.

The v1 artifact uses canonical JSON metadata, independently compressed deterministic chunks, and SHA-256 identities
for the artifact, every chunk, the logical record stream, and its runtime ABI. Export reads SQLite through one
transaction in bounded pages, verifies committed file identities against Git, and fences the repository before and
after projection. Re-exporting the same compatible graph produces the same bytes and digest.

## Inspect and verify

`inspect` authenticates the exact artifact bytes against an expected digest and validates its bounded framing without
inflating graph records:

```sh
threadnote graph checkpoint inspect \
  --input ./threadnote-graph.cgcp \
  --expected-digest sha256:<digest>
```

Omitting `--expected-digest` computes the artifact digest but does not establish trust in who supplied it. Use
`verify` when the compressed records must also be inflated and checked for chunk digests, gzip integrity, canonical
schema, global ordering, counts, coverage, and logical digest:

```sh
threadnote graph checkpoint verify \
  --input ./threadnote-graph.cgcp \
  --expected-digest sha256:<digest>
```

Both commands reject direct symbolic-link inputs and fail if the opened pathname identity or metadata changes.

## Import

Run import from a checkout of the same repository:

```sh
threadnote graph checkpoint import \
  --input ./threadnote-graph.cgcp \
  --expected-digest sha256:<digest>
```

Import never fetches source or executes repository code. The source commit must already exist in the receiver's local
Git object database. Before any graph row is staged, Threadnote checks the repository identity, object format,
case-sensitivity policy, runtime ABI, artifact and logical integrity, and every declared file against the exact local
Git tree. A second decoding pass stages only already-verified bounded chunks, and one transaction publishes the ready
snapshot and immutable import receipt. Interrupted or rejected imports remain unreachable.

Publication depends on receiver state:

| Receiver state                                 | Result                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Exact source commit and clean worktree         | Activate the imported snapshot directly                                  |
| Exact source commit with local changes         | Build the current dirty graph, reusing the imported base when compatible |
| Current commit descends from the source commit | Build the current graph, reusing the imported base when compatible       |
| Divergent history                              | Keep the verified snapshot inactive for later compatible reuse           |

Repeated imports reuse the same logical snapshot instead of duplicating it. An explicitly supplied digest records
`expected-descriptor-verified` trust; a locally inspected artifact without one records `local-unverified` trust.

## Compatibility and existing memories

Checkpoint compatibility is explicit. The ABI binds the graph schema, checkpoint semantics, lexical format, inventory
policy, workspace model, reference-resolution surface, and exact language-pack derivation identities. An incompatible
runtime fails before staging rather than guessing that its rows are equivalent.

Portable checkpoints affect only Threadnote's disposable native code-graph store. Existing schema-v1 memories,
uncited legacy memories, canonical `threadnote://` URIs, recall indexing, and team memory files are neither migrated nor
filtered by checkpoint operations. Recall continues to read those memories at coarse or unknown citation freshness.
A Workset remains optional and is used only for explicitly prepared multi-repository evidence.

## Operational boundaries

- Treat the expected artifact digest like a release checksum and obtain it independently from the checkpoint file.
- Keep the source commit locally available; import deliberately disables lazy Git fetching.
- Checkpoints contain derived source structure, names, signatures, and documentation. Review their destination as you
  would any potentially sensitive internal architecture artifact. Absolute local paths, configured remote credential
  material, and raw source-file bytes are omitted, but source-embedded secrets can still appear in derived fields.
- Use `--json` on every checkpoint command for a versioned machine-readable receipt.

## Organization graph sharing

Companies can enroll a repository so developer clones download a verified portable checkpoint instead of rebuilding the
clean graph from scratch. Graph packs are not memory Git: they live in a digest-addressed CAS next to a checked-in
enrollment pointer. After join, a publisher can advance a signed generation chain; clients select the newest published
ancestor of `HEAD`. Worker results land in a separate CAS namespace from canonical frontiers. The coordinator API
accepts only bounded metadata: no source text or graph records. `graph publisher serve` freezes a descendant HEAD using
profile thresholds, verifies receipts, hydrates the publisher parse cache, recomputes missing parse, then exports a
signed compaction checkpoint (`deltas: []`). Failed verification and unrelated HEAD keep the last signed frontier;
`/v1/status.phase` walks frozen→assembling→verifying→published. `graph publisher serve --listen 127.0.0.1:port` exposes
that API and a digest CAS on loopback so additional homes can join with `--coordinator` instead of a shared CAS
directory. HTTP CAS stays 32 MiB per blob. The assembled `.cgcp` digest remains `checkpoint.manifestDigest`; HTTP
transfers independently digest-addressed cgcp prefix and TCG1 frames listed by checkpoint metadata
(`application/vnd.threadnote.graph.checkpoint.v1+json`), never the assembled artifact. Contributing joins enqueue
parse-result artifacts after local parser batches commit and upload them after the
graph writer lock is released.

```sh
threadnote graph share init --write-config --organization acme --coordinator http://127.0.0.1:18765
git add .threadnote/graph-share.json && git commit -m "Enroll graph sharing"
threadnote graph index --full
threadnote graph publisher bootstrap
threadnote graph publisher serve --listen 127.0.0.1:18765 --json
threadnote graph share join --coordinator http://127.0.0.1:18765
threadnote graph index
threadnote graph contribute status
threadnote graph worker --json
threadnote graph share status
threadnote graph share leave
```

Export publishes only an exact clean root at HEAD. After committing the enrollment pointer, rebuild with `graph index --full` so the publisher does not try to export an incremental overlay.

`.threadnote/graph-share.json` records only `schemaVersion`, credential-free `repositoryId`, the publisher key
fingerprint, and a digest-pinned profile pointer. It contains no frontier tag, credential, private key, or local path.
Threadnote rejects the pointer when `repositoryId` does not match the checkout identity. Repository content cannot
authorize a new host.

`join` writes a mode-0600 trust receipt under `~/.threadnote/graph-sharing/`. Until that receipt exists, Threadnote
makes no CAS or registry request from the enrollment file and keeps the existing local graph. `join` records trust only;
the next `graph index` or committed-base `ensureCommit` downloads and imports a verified ancestor checkpoint. `join --read-only` never uploads. Invalid enrollment,
digest mismatch, and signature failure fail closed for the candidate and keep the last ready local graph. `leave` revokes
the receipt and clears shared-base provenance so inspect no longer reports a shared source. Missing enrollment is ordinary
local indexing. Transfer misses stay fail-open: `graph share status` reports `lastImport` without replacing last-good
provenance. When inspect returns a graph built from a shared base, MCP includes `source.kind: "shared-base-plus-local-overlay"`
with the profile digest, frontier commit, and local commit. Recall does not start this work.
