import {Database} from 'bun:sqlite';
import {Effect, Option} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CodeGraphStore,
  type CodeGraphPersistentSchemaMigrationPhase,
} from '../../src/code_graph/store.js';
import type {
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('code graph persistent schema migration', () => {
  it('preserves ready beta data and restarts an incomplete pre-fingerprint build before materializing', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-upgrade');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-upgrade');
    const preserved = graphSymbol('preserved-before-upgrade');
    const partial = graphSymbol('partial-before-upgrade');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
            yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
            yield* store.promote(
              fixture.databasePath,
              fixture.identity,
              ready.id,
              new Set([fixture.identity.worktreeId]),
            );
          }),
        );
        yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const ownerToken = yield* store.claimPersistentBuild(fixture.databasePath, fixture.identity, {
              ...interrupted,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], interrupted.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [partial], [], [], undefined, 0);
          }),
        );
      }),
    );

    downgradePersistentExtensionSchema(fixture.databasePath, interrupted.id, ready.id);

    const replacement = snapshot(fixture.identity, 'replacement-after-upgrade');
    const rebuilt = graphSymbol('rebuilt-after-upgrade');
    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          fixture.databasePath,
          Effect.gen(function* () {
            const preservedSnapshot = yield* store.readySnapshotById(fixture.databasePath, ready.id);
            const preservedGraph = yield* store.loadGraph(fixture.databasePath, ready.id);
            yield* store.ensureAnalysisSummary(fixture.databasePath, ready.id);
            const preservedSummary = yield* store.loadAnalysisSummary(fixture.databasePath, ready.id);

            const ownerToken = yield* store.claimPersistentBuild(fixture.databasePath, fixture.identity, {
              ...replacement,
              state: 'building',
            });
            yield* store.prepareActivation(fixture.databasePath, [fixture.file], replacement.id, 1, ownerToken);
            yield* store.stageActivationFacts(fixture.databasePath, [rebuilt], [], [], undefined, 0);
            yield* store.resolveStagedReferences(fixture.databasePath);
            yield* store.activateStaged(fixture.databasePath, fixture.identity, replacement);
            return {
              preservedGraph,
              preservedSnapshot,
              preservedSummary,
              replacementGraph: yield* store.loadGraph(fixture.databasePath, replacement.id),
            };
          }),
        );
      }),
    );

    expect(result.preservedSnapshot?.state).toBe('ready');
    expect(result.preservedGraph.symbols.map(symbol => symbol.id)).toEqual([preserved.id]);
    expect(Option.getOrThrow(result.preservedSummary)).toMatchObject({edgeCount: 0, symbolCount: 1, version: 1});
    expect(result.replacementGraph.symbols.map(symbol => symbol.id)).toEqual([rebuilt.id]);

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const interruptedState = database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id) as {
        readonly state: string;
      };
      const columns = database.query('PRAGMA table_info(building_materialization_batches)').all() as readonly {
        readonly name: string;
      }[];
      const extensionTableCount = database
        .query(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'snapshot_build_owners',
             'snapshot_analysis_symbol_counts',
             'snapshot_analysis_edge_histogram',
             'snapshot_analysis_edge_counts',
             'snapshot_analysis_summary_receipts',
             'building_analysis_batches',
             'building_references',
             'building_reference_candidates',
             'building_materialization_batches'
           )`,
        )
        .get() as {readonly count: number};
      const removedIndexCount = database
        .query(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'index' AND name IN ('terms_lookup', 'terms_symbol', 'snapshot_symbol_lookup_key')`,
        )
        .get() as {readonly count: number};
      const revision = database
        .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
        .get() as {readonly value: string};

      expect(interruptedState.state).toBe('retired');
      expect(columns.map(column => column.name)).toContain('batch_fingerprint');
      expect(extensionTableCount.count).toBe(9);
      expect(removedIndexCount.count).toBe(0);
      expect(revision.value).toBe(String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION));
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(database.query('PRAGMA quick_check').get()).toEqual({quick_check: 'ok'});
    } finally {
      database.close(false);
    }
  });

  it('adds the materialization plan column without dropping large interrupted-build staging tables', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-plan-column');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-plan-column');
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    downgradeBuildOwnerPlanColumnOnly(fixture.databasePath, interrupted.id);

    const preserved = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        return yield* store.loadGraph(fixture.databasePath, ready.id);
      }),
    );

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const ownerColumns = database.query('PRAGMA table_info(snapshot_build_owners)').all() as readonly {
        readonly name: string;
      }[];
      expect(ownerColumns.map(column => column.name)).toEqual([
        'snapshot_id',
        'owner_token',
        'claimed_at',
        'expected_batch_count',
      ]);
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
        state: 'retired',
      });
      expect(
        database
          .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        database.query('SELECT COUNT(*) AS count FROM building_references WHERE snapshot_id = ?').get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        database
          .query('SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        database.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      expect(preserved.symbols).toHaveLength(1);
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  it('atomically rolls back an interrupted additive materialization-plan migration', async () => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, 'ready-before-plan-fault');
    const interrupted = snapshot(fixture.identity, 'interrupted-before-plan-fault');
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    downgradeBuildOwnerPlanColumnOnly(fixture.databasePath, interrupted.id);

    await expect(
      runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
            onPersistentSchemaMigrationPhase: phase =>
              phase === 'added-materialization-plan'
                ? Effect.die(new Error('fault after additive materialization plan'))
                : Effect.void,
          });
        }),
      ),
    ).rejects.toThrow('fault after additive materialization plan');

    const interruptedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      const ownerColumns = interruptedDatabase.query('PRAGMA table_info(snapshot_build_owners)').all() as readonly {
        readonly name: string;
      }[];
      expect(ownerColumns.map(column => column.name)).toEqual(['snapshot_id', 'owner_token', 'claimed_at']);
      expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({
        state: 'building',
      });
      expect(
        interruptedDatabase
          .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
      expect(
        interruptedDatabase
          .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
          .get(),
      ).toEqual({value: '2'});
    } finally {
      interruptedDatabase.close(false);
    }

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );
    const healed = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(healed.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toEqual({state: 'retired'});
      expect(healed.query('PRAGMA table_info(snapshot_build_owners)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({name: 'expected_batch_count'})]),
      );
      expect(
        healed
          .query('SELECT COUNT(*) AS count FROM building_reference_candidates WHERE snapshot_id = ?')
          .get(interrupted.id),
      ).toEqual({count: 1});
    } finally {
      healed.close(false);
    }
  });

  it.each([
    {
      expectedPrimaryKey: ['snapshot_id', 'edge_id', 'tier', 'lookup_key'],
      name: 'primary-key order',
      sql: `
        DROP TABLE building_reference_candidates;
        CREATE TABLE building_reference_candidates (
          snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
          edge_id TEXT NOT NULL,
          tier INTEGER NOT NULL,
          lookup_key TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, tier, edge_id, lookup_key)
        ) WITHOUT ROWID;
      `,
      table: 'building_reference_candidates',
    },
    {
      expectedPrimaryKey: ['snapshot_id', 'edge_id'],
      name: 'foreign-key action',
      sql: `
        DROP TABLE building_references;
        CREATE TABLE building_references (
          snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
          edge_id TEXT NOT NULL,
          resolution_domain TEXT NOT NULL,
          exported_only INTEGER NOT NULL,
          alias_lookup_keys_json TEXT NOT NULL,
          PRIMARY KEY (snapshot_id, edge_id)
        ) WITHOUT ROWID;
      `,
      table: 'building_references',
    },
    {
      expectedPrimaryKey: ['snapshot_id'],
      name: 'rowid storage',
      sql: `
        DROP TABLE snapshot_build_owners;
        CREATE TABLE snapshot_build_owners (
          snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
          owner_token TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expected_batch_count INTEGER
        );
      `,
      table: 'snapshot_build_owners',
    },
    {
      expectedPrimaryKey: ['snapshot_id', 'edge_id'],
      name: 'missing table',
      sql: 'DROP TABLE building_references;',
      table: 'building_references',
    },
  ])('repairs $name drift even when the current revision receipt is present', async drift => {
    const fixture = await migrationFixture();
    const ready = snapshot(fixture.identity, `ready-before-${drift.name}`);
    const interrupted = snapshot(fixture.identity, `interrupted-before-${drift.name}`);
    await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
    corruptPersistentExtensionContract(fixture.databasePath, drift.sql);

    const preserved = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
        return yield* store.loadGraph(fixture.databasePath, ready.id);
      }),
    );

    expect(preserved.symbols.map(symbol => symbol.id)).toEqual([`preserved-${drift.name}`]);
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toMatchObject({state: 'ready'});
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toMatchObject({
        state: 'retired',
      });
      expectPersistentExtensionTableContract(database, drift.table, drift.expectedPrimaryKey);
      expect(
        database.query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'").get(),
      ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
    } finally {
      database.close(false);
    }
  });

  it('rolls back every persistent DDL phase and self-heals on the next ordinary open', async () => {
    const faultPhases: readonly CodeGraphPersistentSchemaMigrationPhase[] = [
      'retired-incomplete',
      'dropped-incompatible',
      'created-extensions',
      'dropped-obsolete-indexes',
      'validated',
      'recorded-revision',
    ];

    for (const faultPhase of faultPhases) {
      const fixture = await migrationFixture();
      const ready = snapshot(fixture.identity, `ready-before-${faultPhase}`);
      const interrupted = snapshot(fixture.identity, `interrupted-before-${faultPhase}`);
      await seedReadyAndInterruptedMigration(fixture, ready, interrupted);
      downgradePersistentExtensionSchema(fixture.databasePath, interrupted.id, ready.id);
      const beforeFailure = readMigrationState(fixture.databasePath);

      await expect(
        runEffect(
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.withSession(fixture.databasePath, store.initialize(fixture.databasePath), {
              onPersistentSchemaMigrationPhase: phase =>
                phase === faultPhase ? Effect.die(new Error(`fault after ${phase}`)) : Effect.void,
            });
          }),
        ),
      ).rejects.toThrow(`fault after ${faultPhase}`);

      const interruptedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(readMigrationState(fixture.databasePath)).toEqual(beforeFailure);
        expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(ready.id)).toMatchObject({
          state: 'ready',
        });
        expect(
          interruptedDatabase.query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?').get(ready.id),
        ).toEqual({count: 1});
        expect(interruptedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toMatchObject(
          {state: 'building'},
        );
        const oldColumns = interruptedDatabase
          .query('PRAGMA table_info(building_materialization_batches)')
          .all() as readonly {readonly name: string}[];
        expect(oldColumns.map(column => column.name)).not.toContain('batch_fingerprint');
        expect(
          interruptedDatabase
            .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
            .get(),
        ).toBeNull();
      } finally {
        interruptedDatabase.close(false);
      }

      const healed = await runEffect(
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(fixture.databasePath);
          return yield* store.loadGraph(fixture.databasePath, ready.id);
        }),
      );
      expect(healed.symbols.map(symbol => symbol.id)).toEqual([`preserved-${faultPhase}`]);

      const healedDatabase = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(healedDatabase.query('SELECT state FROM snapshots WHERE id = ?').get(interrupted.id)).toMatchObject({
          state: 'retired',
        });
        expect(
          healedDatabase
            .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
            .get(),
        ).toEqual({value: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION)});
      } finally {
        healedDatabase.close(false);
      }
    }
  });
});

function corruptPersistentExtensionContract(databasePath: string, sql: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    database.exec(sql);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function expectPersistentExtensionTableContract(
  database: Database,
  table: string,
  expectedPrimaryKey: readonly string[],
) {
  const definition = database.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
    readonly sql: string;
  };
  const columns = database.query(`PRAGMA table_info("${table}")`).all() as readonly {
    readonly name: string;
    readonly pk: number;
  }[];
  const foreignKeys = database.query(`PRAGMA foreign_key_list("${table}")`).all() as readonly {
    readonly from: string;
    readonly on_delete: string;
    readonly table: string;
    readonly to: string;
  }[];

  expect(definition.sql).toMatch(/\bWITHOUT\s+ROWID\b/i);
  expect(
    columns
      .filter(column => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(column => column.name),
  ).toEqual(expectedPrimaryKey);
  expect(foreignKeys).toEqual([
    expect.objectContaining({from: 'snapshot_id', on_delete: 'CASCADE', table: 'snapshots', to: 'id'}),
  ]);
}

function readMigrationState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      buildReceipts: database
        .query('SELECT * FROM building_materialization_batches ORDER BY snapshot_id, batch_index')
        .all(),
      extensionSchema: database
        .query(
          `SELECT type, name, sql
           FROM sqlite_master
           WHERE name IN (
             'snapshot_build_owners',
             'snapshot_analysis_symbol_counts',
             'snapshot_analysis_edge_histogram',
             'snapshot_analysis_edge_counts',
             'snapshot_analysis_summary_receipts',
             'building_analysis_batches',
             'building_references',
             'building_reference_candidates',
             'building_materialization_batches',
             'terms_lookup',
             'terms_symbol',
             'snapshot_symbol_lookup_key'
           )
           ORDER BY type, name`,
        )
        .all(),
      revision: database
        .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
        .get(),
      snapshots: database.query('SELECT id, state, completed_at, failure_summary FROM snapshots ORDER BY id').all(),
      summaryReceipts: database.query('SELECT * FROM snapshot_analysis_summary_receipts ORDER BY snapshot_id').all(),
      symbols: database.query('SELECT snapshot_id, id FROM symbols ORDER BY snapshot_id, id').all(),
    };
  } finally {
    database.close(false);
  }
}

async function seedReadyAndInterruptedMigration(
  fixture: Awaited<ReturnType<typeof migrationFixture>>,
  ready: CodeGraphSnapshot,
  interrupted: CodeGraphSnapshot,
) {
  const preserved = graphSymbol(`preserved-${ready.id.slice('ready-before-'.length)}`);
  const partial = graphSymbol(`partial-${interrupted.id.slice('interrupted-before-'.length)}`);
  await runEffect(
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          yield* store.prepareActivation(fixture.databasePath, [fixture.file]);
          yield* store.stageActivationFacts(fixture.databasePath, [preserved], []);
          yield* store.activateStaged(fixture.databasePath, fixture.identity, ready);
        }),
      );
      yield* store.withSession(
        fixture.databasePath,
        Effect.gen(function* () {
          const ownerToken = yield* store.claimPersistentBuild(fixture.databasePath, fixture.identity, {
            ...interrupted,
            state: 'building',
          });
          yield* store.prepareActivation(fixture.databasePath, [fixture.file], interrupted.id, 1, ownerToken);
          yield* store.stageActivationFacts(fixture.databasePath, [partial], [], [], undefined, 0);
        }),
      );
    }),
  );
}

function downgradePersistentExtensionSchema(
  databasePath: string,
  interruptedSnapshotId: string,
  readySnapshotId: string,
) {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    database.exec("DELETE FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'");
    for (const table of [
      'building_materialization_batches',
      'building_reference_candidates',
      'building_references',
      'building_analysis_batches',
      'snapshot_analysis_summary_receipts',
      'snapshot_analysis_edge_counts',
      'snapshot_analysis_edge_histogram',
      'snapshot_analysis_symbol_counts',
      'snapshot_build_owners',
    ]) {
      database.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    database.exec(`
      CREATE TABLE building_materialization_batches (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        batch_index INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        term_count INTEGER NOT NULL,
        lookup_count INTEGER NOT NULL,
        reference_count INTEGER NOT NULL,
        candidate_count INTEGER NOT NULL,
        reexport_count INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, batch_index)
      ) WITHOUT ROWID;
      CREATE TABLE snapshot_analysis_summary_receipts (
        snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        edge_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX terms_lookup ON symbol_terms(snapshot_id, term, weight DESC);
      CREATE INDEX terms_symbol ON symbol_terms(snapshot_id, symbol_id);
      CREATE INDEX snapshot_symbol_lookup_key
        ON snapshot_symbol_lookup(snapshot_id, lookup_key, resolution_domain, exported);
    `);
    database
      .query(
        `INSERT INTO building_materialization_batches (
           snapshot_id, batch_index, symbol_count, edge_count, term_count, lookup_count,
           reference_count, candidate_count, reexport_count, completed_at
         ) VALUES (?, 0, 1, 0, 1, 1, 0, 0, 0, ?)`,
      )
      .run(interruptedSnapshotId, new Date().toISOString());
    database
      .query(
        `INSERT INTO snapshot_analysis_summary_receipts (
           snapshot_id, version, symbol_count, edge_count, created_at
         ) VALUES (?, 1, 1, 0, ?)`,
      )
      .run(readySnapshotId, new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function downgradeBuildOwnerPlanColumnOnly(databasePath: string, interruptedSnapshotId: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    const owner = database
      .query('SELECT owner_token, claimed_at FROM snapshot_build_owners WHERE snapshot_id = ?')
      .get(interruptedSnapshotId) as {readonly claimed_at: string; readonly owner_token: string};
    database.exec('PRAGMA foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    database.exec(`
      DROP TABLE snapshot_build_owners;
      CREATE TABLE snapshot_build_owners (
        snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    database
      .query('INSERT INTO snapshot_build_owners (snapshot_id, owner_token, claimed_at) VALUES (?, ?, ?)')
      .run(interruptedSnapshotId, owner.owner_token, owner.claimed_at);
    database.query("UPDATE schema_metadata SET value = '2' WHERE key = 'persistent_extension_schema_revision'").run();
    database
      .query(
        `INSERT INTO building_references (
           snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json
         ) VALUES (?, 'retained-edge', 'typescript', 0, '[]')`,
      )
      .run(interruptedSnapshotId);
    database
      .query(
        `INSERT INTO building_reference_candidates (snapshot_id, edge_id, tier, lookup_key)
         VALUES (?, 'retained-edge', 0, 'typescript:name:retained')`,
      )
      .run(interruptedSnapshotId);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

async function migrationFixture() {
  const root = await mkdtemp('threadnote-code-graph-schema-migration-');
  temporaryRoots.push(root);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'schema-migration-fixture',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
  const file: CodeGraphInventoryFile = {
    blobId: 'b'.repeat(40),
    contentHash: 'h'.repeat(64),
    language: 'typescript',
    mode: '100644',
    path: 'src/schema-migration.ts',
    size: 128,
    source: 'commit',
  };
  return {databasePath: join(root, 'graph-v3.sqlite'), file, identity};
}

function graphSymbol(id: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${id}`],
    name: id,
    path: 'src/schema-migration.ts',
    qualifiedName: id,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function snapshot(identity: RepositoryIdentity, id: string): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'schema-migration-test',
    fileCount: 1,
    id,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 1,
    worktreeId: identity.worktreeId,
  };
}
