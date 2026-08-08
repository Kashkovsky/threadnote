import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {CodeGraphEmbeddingIndex, selectGraphEmbeddingSymbols} from '../../src/code_graph/embedding.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import type {CodeGraphSnapshot, CodeGraphSymbol} from '../../src/code_graph/types.js';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '../../src/effect/ai/local-model-runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;

describe('native code graph vector generations', () => {
  it('keeps every eligible symbol instead of truncating vectors at the former 20k cap', () => {
    const symbols = Array.from({length: 20_001}, (_, index) =>
      symbol(`symbol-${index}`, `Symbol${index}`, `Documents symbol ${index}.`),
    );

    expect(selectGraphEmbeddingSymbols(symbols)).toHaveLength(20_001);
  });

  it('reuses unchanged vectors, preserves sibling pointers, and serves semantic scores', async () => {
    const home = await mkdtemp('threadnote-code-graph-vectors-');
    const embeddedBatches: number[] = [];
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const vectors = yield* CodeGraphEmbeddingIndex;
          const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
          const otherWorktreeLayout = codeGraphLayout(path, home, 'a'.repeat(64), 'd'.repeat(64));
          const first = yield* vectors.ensure(home, layout, snapshot('snapshot-one'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores beta records.'),
          ]);
          const modelRoot = path.join(layout.vectorRoot, manifest.id);
          const unchanged = yield* vectors.ensure(home, layout, snapshot('snapshot-one'), []);
          const scores = yield* vectors.search(home, layout, 'snapshot-one', 'alpha deployment', 2);
          const shared = yield* vectors.ensure(home, otherWorktreeLayout, snapshot('snapshot-one'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores beta records.'),
          ]);
          const changed = yield* vectors.ensure(home, layout, snapshot('snapshot-two'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores changed beta records.'),
          ]);
          const duplicate = symbol('gamma', 'GammaService', 'Serves gamma records.');
          const deduplicated = yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate, duplicate]);
          const forced = yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate, duplicate], {
            force: true,
          });
          const checked = yield* vectors.check(home, layout, 'snapshot-three');
          const preservedScores = yield* vectors.search(
            home,
            otherWorktreeLayout,
            'snapshot-one',
            'alpha deployment',
            2,
          );
          yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate]);
          const preservedUnavailablePointer = yield* vectors.check(home, otherWorktreeLayout, 'snapshot-one');
          return {
            changed,
            checked,
            databaseReady: yield* fs.exists(path.join(modelRoot, 'vectors-v2.sqlite')),
            deduplicated,
            first,
            forced,
            preservedScores,
            preservedUnavailablePointer,
            scores,
            shared,
            unchanged,
          };
        }).pipe(
          Effect.provide(
            Layer.merge(testEmbeddingLayer(embeddedBatches), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)),
          ),
          Effect.provide(BunServices.layer),
        ),
      );

      expect(result.first).toMatchObject({embedded: 2, ready: true, reused: 0});
      expect(result.unchanged).toMatchObject({embedded: 0, ready: true, reused: 2});
      expect(result.changed).toMatchObject({embedded: 1, ready: true, reused: 1});
      expect(result.shared).toMatchObject({embedded: 0, ready: true, reused: 2});
      expect(result.deduplicated).toMatchObject({embedded: 1, ready: true, reused: 0});
      expect(result.forced).toMatchObject({embedded: 1, ready: true, reused: 0});
      expect(result.checked).toEqual({modelId: manifest.id, reused: 1, state: 'ready'});
      expect(result.databaseReady).toBe(true);
      expect(result.scores.get('alpha')).toBeCloseTo(1);
      expect(result.preservedScores.get('alpha')).toBeCloseTo(1);
      expect(result.preservedUnavailablePointer).toMatchObject({state: 'ready'});
      expect(result.scores.has('beta')).toBe(false);
      expect(embeddedBatches).toEqual([2, 1, 1, 1, 1, 1]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('migrates the generation lookup index and prunes many generations without scanning every pointer', async () => {
    const home = await mkdtemp('threadnote-code-graph-vector-pointer-index-');
    const pointerCount = 4_096;
    const orphanCount = 512;
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const vectors = yield* CodeGraphEmbeddingIndex;
          const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
          const target = snapshot('snapshot-pointer-load');
          yield* vectors.ensure(home, layout, target, [
            symbol('pointer-load', 'PointerLoad', 'Exercises pointer pruning.'),
          ]);
          const databasePath = path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite');
          yield* Effect.sync(() => seedVectorPointerLoad(databasePath, pointerCount, orphanCount));
          const refreshed = yield* vectors.ensure(home, layout, target, []);
          return {databasePath, refreshed};
        }).pipe(
          Effect.provide(Layer.merge(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS))),
          Effect.provide(BunServices.layer),
        ),
      );

      const database = new Database(result.databasePath, {readonly: true, strict: true});
      try {
        const indexes = database.query("PRAGMA index_list('vector_pointers')").all() as readonly {
          readonly name: string;
        }[];
        const plan = database
          .query(
            `EXPLAIN QUERY PLAN
             DELETE FROM vector_generations
             WHERE state <> 'ready'
                OR NOT EXISTS (
                  SELECT 1 FROM vector_pointers
                  WHERE vector_pointers.generation = vector_generations.generation
                )`,
          )
          .all() as readonly {readonly detail: string}[];
        const details = plan.map(row => row.detail);

        expect(result.refreshed).toMatchObject({embedded: 0, ready: true, reused: 1});
        expect(indexes.map(index => index.name)).toContain('vector_pointer_generation_lookup');
        expect(details).toContainEqual(
          expect.stringContaining(
            'SEARCH vector_pointers USING COVERING INDEX vector_pointer_generation_lookup (generation=?)',
          ),
        );
        expect(details.some(detail => detail.includes('SCAN vector_pointers'))).toBe(false);
        expect(database.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({
          count: pointerCount + 1,
        });
        expect(database.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({
          count: pointerCount + 1,
        });
        expect(
          database.query("SELECT COUNT(*) AS count FROM vector_generations WHERE generation LIKE 'orphan-%'").get(),
        ).toEqual({count: 0});
      } finally {
        database.close(false);
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('builds and searches a paged SQLite vector generation without materializing a repository symbol array', async () => {
    const home = await mkdtemp('threadnote-code-graph-vector-pages-');
    const embeddedBatches: number[] = [];
    const pageLimits: number[] = [];
    try {
      const symbols = Array.from({length: 901}, (_, index) =>
        symbol(`paged-${index.toString().padStart(4, '0')}`, `Paged${index}`, `Paged symbol ${index}.`),
      );
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const vectors = yield* CodeGraphEmbeddingIndex;
          const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
          const source = {
            count: Effect.succeed(symbols.length),
            loadPage: (cursor: {readonly id: string} | undefined, limit: number) => {
              pageLimits.push(limit);
              const start = cursor ? symbols.findIndex(candidate => candidate.id === cursor.id) + 1 : 0;
              return Effect.succeed(symbols.slice(start, start + limit));
            },
          };
          const built = yield* vectors.ensure(
            home,
            layout,
            {...snapshot('snapshot-paged'), symbolCount: symbols.length},
            source,
          );
          const scores = yield* vectors.search(home, layout, 'snapshot-paged', 'paged symbol', 5);
          return {built, scores};
        }).pipe(
          Effect.provide(
            Layer.merge(testEmbeddingLayer(embeddedBatches), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)),
          ),
          Effect.provide(BunServices.layer),
        ),
      );

      expect(result.built).toMatchObject({embedded: 901, ready: true, reused: 0});
      expect(result.scores.size).toBe(5);
      expect(pageLimits).toEqual([400, 400, 400]);
      expect(Math.max(...embeddedBatches)).toBeLessThanOrEqual(128);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('serializes linked-worktree vector writers without deleting a live generation', async () => {
    const home = await mkdtemp('threadnote-code-graph-vector-concurrency-');
    let activeEmbeddings = 0;
    let embedCalls = 0;
    let maximumActiveEmbeddings = 0;
    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstRelease = new Promise<void>(resolve => (releaseFirst = resolve));
    const firstStarted = new Promise<void>(resolve => (reportFirstStarted = resolve));
    const runtime = LocalModelRuntime.of({
      diagnostics: () => Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: ({inputs, manifest: requested}) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            activeEmbeddings += 1;
            maximumActiveEmbeddings = Math.max(maximumActiveEmbeddings, activeEmbeddings);
            embedCalls += 1;
            if (embedCalls === 1) reportFirstStarted();
            return embedCalls;
          }),
          call =>
            (call === 1 ? Effect.promise(() => firstRelease) : Effect.void).pipe(
              Effect.as(inputs.map(input => unitVector(requested.dimensions ?? 0, input.includes('alpha') ? 0 : 1))),
            ),
          () =>
            Effect.sync(() => {
              activeEmbeddings -= 1;
            }),
        ),
      generate: () => Effect.die(new Error('Unexpected generation')),
      rerank: () => Effect.die(new Error('Unexpected reranking')),
    });
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const vectors = yield* CodeGraphEmbeddingIndex;
            const firstLayout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
            const secondLayout = codeGraphLayout(path, home, 'a'.repeat(64), 'd'.repeat(64));
            const first = yield* Effect.forkScoped(
              vectors.ensure(home, firstLayout, snapshot('snapshot-concurrent-one'), [
                symbol('alpha-concurrent', 'AlphaConcurrent', 'alpha concurrent symbol'),
              ]),
            );
            yield* Effect.promise(() => firstStarted);
            const second = yield* Effect.forkScoped(
              vectors.ensure(home, secondLayout, snapshot('snapshot-concurrent-two'), [
                symbol('beta-concurrent', 'BetaConcurrent', 'beta concurrent symbol'),
              ]),
            );
            yield* Effect.sleep(100);
            const callsWhileFirstWasBlocked = embedCalls;
            yield* Effect.sync(releaseFirst);
            const summaries = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
            return {callsWhileFirstWasBlocked, summaries};
          }),
        ).pipe(
          Effect.provide(
            Layer.merge(testEmbeddingLayer([], runtime), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)),
          ),
          Effect.provide(BunServices.layer),
        ),
      );

      expect(result.callsWhileFirstWasBlocked).toBe(1);
      expect(maximumActiveEmbeddings).toBe(1);
      expect(result.summaries).toEqual([
        expect.objectContaining({embedded: 1, ready: true}),
        expect.objectContaining({embedded: 1, ready: true}),
      ]);
    } finally {
      releaseFirst?.();
      await rm(home, {force: true, recursive: true});
    }
  });
});

function testEmbeddingLayer(embeddedBatches: number[], runtimeOverride?: LocalModelRuntimeShape) {
  const modelStoreLayer = Layer.succeed(
    LocalModelStore,
    LocalModelStore.of({
      install: () => Effect.die(new Error('Unexpected install')),
      path: root => `${root}/models/fake.gguf`,
      remove: () => Effect.succeed(false),
      status: root => Effect.succeed(installation(root)),
      verify: root => Effect.succeed(installation(root)),
    } satisfies LocalModelStoreShape),
  );
  const runtimeLayer = Layer.succeed(
    LocalModelRuntime,
    runtimeOverride ??
      LocalModelRuntime.of({
        diagnostics: () => Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
        embedMany: ({inputs, manifest: requested}) => {
          embeddedBatches.push(inputs.length);
          return Effect.succeed(
            inputs.map(input => unitVector(requested.dimensions ?? 0, input.toLowerCase().includes('alpha') ? 0 : 1)),
          );
        },
        generate: () => Effect.die(new Error('Unexpected generation')),
        rerank: () => Effect.die(new Error('Unexpected reranking')),
      }),
  );
  return CodeGraphEmbeddingIndex.layer.pipe(
    Layer.provide(
      Layer.mergeAll(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), modelStoreLayer, runtimeLayer, SystemInfo.layer),
    ),
  );
}

function seedVectorPointerLoad(databasePath: string, pointerCount: number, orphanCount: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('DROP INDEX IF EXISTS vector_pointer_generation_lookup');
    const template = database
      .query<
        {
          readonly created_at: string;
          readonly dimensions: number;
          readonly model_id: string;
          readonly model_sha256: string;
          readonly template_version: number;
        },
        []
      >(
        `SELECT created_at, dimensions, model_id, model_sha256, template_version
         FROM vector_generations
         LIMIT 1`,
      )
      .get();
    if (!template) throw new Error('Vector pointer load fixture has no generation template.');
    const insertGeneration = database.prepare(
      `INSERT INTO vector_generations (
         generation, snapshot_id, model_id, model_sha256, dimensions,
         template_version, count, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 'ready', ?)`,
    );
    const insertPointer = database.prepare('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)');
    database.transaction(() => {
      for (let index = 0; index < pointerCount; index += 1) {
        const generation = `referenced-${index.toString().padStart(4, '0')}`;
        insertGeneration.run(
          generation,
          `snapshot-${index}`,
          template.model_id,
          template.model_sha256,
          template.dimensions,
          template.template_version,
          template.created_at,
        );
        insertPointer.run(index.toString(16).padStart(64, '0'), generation);
      }
      for (let index = 0; index < orphanCount; index += 1) {
        insertGeneration.run(
          `orphan-${index.toString().padStart(4, '0')}`,
          `orphan-snapshot-${index}`,
          template.model_id,
          template.model_sha256,
          template.dimensions,
          template.template_version,
          template.created_at,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function symbol(id: string, name: string, documentation: string): CodeGraphSymbol {
  return {
    contentHash: id.repeat(64).slice(0, 64),
    documentation,
    exported: true,
    id,
    kind: 'class',
    language: 'typescript',
    name,
    path: `src/${id}.ts`,
    qualifiedName: name,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function snapshot(id: string): CodeGraphSnapshot {
  return {
    commit: 'c'.repeat(40),
    dirty: false,
    edgeCount: 0,
    extractorSet: 'test',
    fileCount: 2,
    id,
    repositoryId: 'a'.repeat(64),
    state: 'ready',
    symbolCount: 2,
    worktreeId: 'b'.repeat(64),
  };
}

function installation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/fake.gguf`,
    verified: true,
  };
}

function unitVector(dimensions: number, axis: number): readonly number[] {
  return Array.from({length: dimensions}, (_, index) => (index === axis ? 1 : 0));
}
