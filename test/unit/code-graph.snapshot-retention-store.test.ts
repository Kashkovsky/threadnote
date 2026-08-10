import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {join, mkdir, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('code graph snapshot retention store', () => {
  it('finds and retires a repository beyond the cap after many already-bounded repositories', async () => {
    const home = await mkdtemp('threadnote-snapshot-retention-store-');
    temporaryHomes.push(home);
    const checkoutId = 'a'.repeat(64);
    const repositoryId = 'f'.repeat(64);
    const root = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(root, 'graph-v3.sqlite');
    const writerLockPath = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
    await mkdir(root, {recursive: true});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const database = new Database(databasePath, {strict: true});
    try {
      const insertRepository = database.query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'retention fixture', 'sha1', ?, ?)`,
      );
      const createdAt = '2026-08-01T00:00:00.000Z';
      for (let index = 0; index < 9; index += 1) {
        insertRepository.run(index.toString(16).repeat(64), createdAt, createdAt);
      }
      insertRepository.run(repositoryId, createdAt, createdAt);
      const insert = database.query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
           extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
           edge_count, started_at, completed_at, failure_summary
         ) VALUES (?, ?, ?, ?, ?, NULL, 'retention-fixture', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      );
      let ordinal = 0;
      for (let repository = 0; repository < 9; repository += 1) {
        for (let index = 0; index < 2; index += 1) {
          const timestamp = `2026-08-0${index + 1}T00:00:00.000Z`;
          insert.run(
            `cgsn_${ordinal.toString(16).padStart(40, '0')}`,
            repository.toString(16).repeat(64),
            ordinal.toString(16).padStart(64, '0'),
            ordinal.toString(16).padStart(40, '0'),
            `cgc_${ordinal.toString(16).padStart(40, '0')}`,
            timestamp,
            timestamp,
          );
          ordinal += 1;
        }
      }
      for (let index = 0; index < 5; index += 1) {
        const timestamp = `2026-08-0${index + 1}T00:00:00.000Z`;
        insert.run(
          `cgsn_${ordinal.toString(16).padStart(40, '0')}`,
          repositoryId,
          ordinal.toString(16).padStart(64, '0'),
          ordinal.toString(16).padStart(40, '0'),
          `cgc_${ordinal.toString(16).padStart(40, '0')}`,
          timestamp,
          timestamp,
        );
        ordinal += 1;
      }
      database
        .query(
          `INSERT INTO building_lexical_counters
            (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
           VALUES (?, 1, 1, 1, 1)`,
        )
        .run(`cgsn_${(ordinal - 1).toString(16).padStart(40, '0')}`);
    } finally {
      database.close(false);
    }

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(databasePath, {writerLockPath});
      }),
    );
    expect(result).toMatchObject({remaining: true, retiredSnapshots: 3, state: 'completed'});

    const completedBuildCleanup = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(databasePath, {writerLockPath});
      }),
    );
    expect(completedBuildCleanup).toMatchObject({cleanup: 'completed-build', rowsDeleted: 1, state: 'completed'});

    const check = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(check.query('SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state ORDER BY state').all()).toEqual(
        [
          {count: 20, state: 'ready'},
          {count: 3, state: 'retired'},
        ],
      );
    } finally {
      check.close(false);
    }
  });
});
