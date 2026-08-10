import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {inspectCodeGraphStorage} from '../../src/code_graph/storage.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '../../src/code_graph/types.js';
import {join, mkdir, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('code graph semantic storage attribution', () => {
  it('separates exact B-tree groups from bounded logical active-snapshot payload', async () => {
    const home = await mkdtemp('threadnote-storage-attribution-');
    temporaryHomes.push(home);
    const checkoutId = 'a'.repeat(64);
    const repositoryId = 'b'.repeat(64);
    const worktreeId = 'c'.repeat(64);
    const snapshotId = `cgsn_${'d'.repeat(40)}`;
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, 'graph-v3.sqlite');
    await mkdir(repositoryRoot, {recursive: true});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const factsJson = JSON.stringify({diagnostics: [], edges: [], path: 'src/index.ts', symbols: []});
    const database = new Database(databasePath, {strict: true});
    try {
      const now = '2026-08-10T00:00:00.000Z';
      database
        .query(
          `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
           VALUES (?, 'storage fixture', 'sha1', ?, ?)`,
        )
        .run(repositoryId, now, now);
      database
        .query(
          `INSERT INTO snapshots (
             id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
             extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
             edge_count, started_at, completed_at, failure_summary
           ) VALUES (?, ?, ?, ?, ?, NULL, 'storage-fixture', 0, NULL, 'ready', 1, 1, 0, ?, ?, NULL)`,
        )
        .run(snapshotId, repositoryId, worktreeId, 'e'.repeat(40), `cgc_${'f'.repeat(40)}`, now, now);
      database
        .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
        .run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
      database
        .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
        .run(worktreeId, snapshotId, now);
      database
        .query(
          `INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
           VALUES (?, 'src/index.ts', ?, 'typescript', '100644', 32, 'commit')`,
        )
        .run(snapshotId, '1'.repeat(64));
      database
        .query(
          `INSERT INTO symbols (
             snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
             arity, lookup_keys_json, resolution_domain, package_name, exported,
             signature, documentation, span_json, resolution_scope_id
           ) VALUES (?, 'symbol', ?, 'module', 'index', 'index', 'src/index.ts', 'typescript',
             NULL, '[]', 'typescript', NULL, 1, NULL, NULL, '{"line":1}', NULL)`,
        )
        .run(snapshotId, '2'.repeat(64));
      database
        .query(
          `INSERT INTO materialized_file_shards (
             id, content_hash, extractor_set, derivation_identity, path_hint,
             facts_json, created_at, last_used_at
           ) VALUES ('shard', ?, 'storage-fixture', 'derivation', 'src/index.ts', ?, ?, ?)`,
        )
        .run('1'.repeat(64), factsJson, now, now);
      database
        .query(
          `INSERT INTO snapshot_file_shards (snapshot_id, path, shard_id)
           VALUES (?, 'src/index.ts', 'shard')`,
        )
        .run(snapshotId);
    } finally {
      database.close(false);
    }

    const storage = await runEffect(inspectCodeGraphStorage(home, checkoutId, {attributeObjects: true}));
    if (storage.state !== 'available' || storage.pageStorage.state !== 'available') throw new Error('missing storage');
    const attribution = storage.pageStorage.attribution;
    if (!attribution || attribution.state !== 'available') throw new Error('missing attribution');
    expect(attribution.semantic.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({name: 'facts-cache'}),
        expect.objectContaining({name: 'structural-graph'}),
      ]),
    );
    if (attribution.semantic.snapshots.state !== 'available') throw new Error('missing snapshot attribution');
    expect(attribution.semantic.snapshots.baseline).toMatchObject({activeSnapshotCount: 1, activeSymbolCount: 1});
    expect(attribution.semantic.snapshots.snapshots[0]).toMatchObject({
      active: true,
      associatedFactRawBytes: Buffer.byteLength(factsJson),
      associatedFactStoredBytes: Buffer.byteLength(factsJson),
      id: snapshotId,
      symbolCount: 1,
    });
  });
});
