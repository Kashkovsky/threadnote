import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {CodeGraphEmbeddingIndex} from '../../src/code_graph/embedding.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import type {CodeGraphSnapshot, CodeGraphSymbol} from '../../src/code_graph/types.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;

describe('native code graph vector generations', () => {
  it('reuses unchanged symbol vectors, embeds changed symbols, and serves semantic scores', async () => {
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
          yield* fs.rename(
            path.join(modelRoot, 'pointers', `${layout.worktreeId}.json`),
            path.join(modelRoot, 'active.json'),
          );
          const unchanged = yield* vectors.ensure(home, layout, snapshot('snapshot-one'), []);
          const scores = yield* vectors.search(home, layout, 'snapshot-one', 'alpha deployment', 2);
          const shared = yield* vectors.ensure(home, otherWorktreeLayout, snapshot('snapshot-one'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores beta records.'),
          ]);
          const corruptPointer = path.join(modelRoot, 'pointers', `${'e'.repeat(64)}.json`);
          yield* fs.writeFileString(corruptPointer, '{"generation":"../../outside"}\n');
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
          yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate], {
            activeWorktreeIds: new Set([layout.worktreeId]),
          });
          const removedInactivePointer = !(yield* fs.exists(
            path.join(modelRoot, 'pointers', `${otherWorktreeLayout.worktreeId}.json`),
          ));
          return {
            changed,
            checked,
            corruptPointerRemoved: !(yield* fs.exists(corruptPointer)),
            deduplicated,
            first,
            forced,
            preservedScores,
            removedInactivePointer,
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
      expect(result.corruptPointerRemoved).toBe(true);
      expect(result.scores.get('alpha')).toBeCloseTo(1);
      expect(result.preservedScores.get('alpha')).toBeCloseTo(1);
      expect(result.removedInactivePointer).toBe(true);
      expect(result.scores.has('beta')).toBe(false);
      expect(embeddedBatches).toEqual([2, 1, 1, 1, 1, 1]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});

function testEmbeddingLayer(embeddedBatches: number[]) {
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
    LocalModelRuntime.of({
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
    Layer.provide(Layer.mergeAll(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), modelStoreLayer, runtimeLayer)),
  );
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
