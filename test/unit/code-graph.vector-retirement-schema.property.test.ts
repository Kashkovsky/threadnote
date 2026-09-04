import {TestError} from '../helpers/test-error.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  type CodeGraphVectorRetirementCapacityProtector,
  deleteCodeGraphVectorPointerWithRetirement,
  prepareCodeGraphVectorRetirement,
  retireCodeGraphVectorGenerationPage,
} from '../../src/code_graph/vector_maintenance.js';
import {SystemInfo} from '../../src/effect/system.js';

const VectorRetirementPropertyLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer);
const identityCapacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => transaction;
const capacityOptions = {capacityProtector: identityCapacityProtector} as const;

describe('code graph vector retirement schema properties', () => {
  effectIt.layer(VectorRetirementPropertyLayer)(layerIt => {
    layerIt.effect.prop(
      'matches a bounded page model and keeps rejected old-writer deletes non-mutating',
      {
        oldDelete: FC.constantFrom(
          'DELETE FROM vector_generations',
          "DELETE FROM vector_generations WHERE state = 'building'",
          `DELETE FROM vector_generations
           WHERE NOT EXISTS (
             SELECT 1 FROM vector_pointers
             WHERE vector_pointers.generation = vector_generations.generation
           )`,
        ),
        pageCalls: FC.integer({max: 4, min: 1}),
        requestedLimit: FC.integer({max: 1_500, min: 1}),
        vectorCount: FC.integer({max: 2_100, min: 0}),
      },
      ({oldDelete, pageCalls, requestedLimit, vectorCount}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-property-'});
            const databasePath = path.join(root, 'vectors-v2.sqlite');
            const generation = 'generation-property';
            const worktreeId = 'a'.repeat(64);
            yield* Effect.sync(() => seedVectorDatabase(databasePath, generation, worktreeId, vectorCount));
            yield* prepareUntilReady(databasePath);
            yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
              expectedSnapshotId: 'snapshot-property',
              worktreeId,
            });
            const epoch = yield* Effect.sync(() => readRetirementEpoch(databasePath));
            const beforeOldDelete = yield* Effect.sync(() => readCounts(databasePath, generation));

            yield* Effect.sync(() =>
              withWritableDatabase(databasePath, database => {
                expect(() => database.exec(oldDelete)).toThrow();
              }),
            );
            expect(yield* Effect.sync(() => readCounts(databasePath, generation))).toEqual(beforeOldDelete);

            let remaining = vectorCount;
            let current = true;
            for (let page = 0; page < pageCalls; page += 1) {
              const before = yield* Effect.sync(() => readCounts(databasePath, generation));
              const result = yield* retireCodeGraphVectorGenerationPage(
                databasePath,
                {
                  epoch,
                  generation,
                  requestedLimit,
                },
                capacityOptions,
              );
              if (!current) {
                expect(result).toMatchObject({rowsDeleted: 0, state: 'stale'});
                expect(yield* Effect.sync(() => readCounts(databasePath, generation))).toEqual(before);
                continue;
              }

              const rowsDeleted = Math.min(remaining, requestedLimit, 1_000);
              remaining -= rowsDeleted;
              current = remaining > 0;
              expect(result).toMatchObject({
                remaining: current,
                rowsDeleted,
                state: current ? 'progress' : 'complete',
              });
              expect(yield* Effect.sync(() => readCounts(databasePath, generation))).toEqual({
                generations: current ? 1 : 0,
                retirements: current ? 1 : 0,
                vectors: remaining,
              });
            }
          }),
        ),
      {fastCheck: {numRuns: 24}},
    );
  });
});

function prepareUntilReady(databasePath: string) {
  return Effect.gen(function* () {
    for (let step = 0; step < 16; step += 1) {
      const result = yield* prepareCodeGraphVectorRetirement(databasePath, capacityOptions);
      if (result.state === 'ready') return;
    }
    return yield* Effect.die(
      TestError.make({message: 'Vector retirement schema did not become ready within sixteen steps.'}),
    );
  });
}

function seedVectorDatabase(databasePath: string, generation: string, worktreeId: string, vectorCount: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = 2;
      CREATE TABLE vector_generations (
        generation TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_sha256 TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        template_version INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE vector_pointers (
        worktree_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
      );
      CREATE INDEX vector_pointer_generation_lookup ON vector_pointers (generation);
      CREATE TABLE vectors (
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
        symbol_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (generation, symbol_id)
      ) WITHOUT ROWID;
      CREATE INDEX vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint);
    `);
    const insertGeneration = database.prepare(
      `INSERT INTO vector_generations
       (generation, snapshot_id, model_id, model_sha256, dimensions, template_version, count, state, created_at)
       VALUES (?, 'snapshot-property', 'model-test', ?, 384, 1, ?, 'building', ?)`,
    );
    const insertVector = database.prepare(
      'INSERT INTO vectors (generation, symbol_id, fingerprint, vector) VALUES (?, ?, ?, ?)',
    );
    database.transaction(() => {
      insertGeneration.run(generation, 'f'.repeat(64), vectorCount, '1970-01-01T00:00:00.000Z');
      const payload = new Uint8Array(16);
      for (let index = 0; index < vectorCount; index += 1) {
        const symbolId = `symbol-${index.toString().padStart(6, '0')}`;
        insertVector.run(generation, symbolId, `fingerprint-${symbolId}`, payload);
      }
      database.query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)').run(worktreeId, generation);
    })();
  } finally {
    database.close(false);
  }
}

function readRetirementEpoch(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const marker = database.query('SELECT * FROM vector_generation_retirements').get() as Record<string, unknown>;
    const candidates = Object.entries(marker).filter(
      ([key, value]) =>
        /epoch|retirement.*id/i.test(key) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    );
    expect(candidates).toHaveLength(1);
    return candidates[0][1] as number;
  } finally {
    database.close(false);
  }
}

function readCounts(databasePath: string, generation: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const count = (table: string) =>
      Number(
        (
          database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE generation = ?`).get(generation) as {
            readonly count: number;
          }
        ).count,
      );
    return {
      generations: count('vector_generations'),
      retirements: count('vector_generation_retirements'),
      vectors: count('vectors'),
    };
  } finally {
    database.close(false);
  }
}

function withWritableDatabase<A>(databasePath: string, use: (database: Database) => A): A {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = ON');
    return use(database);
  } finally {
    database.close(false);
  }
}
