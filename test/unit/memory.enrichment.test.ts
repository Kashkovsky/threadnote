import {Effect, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import {GenerationFailed} from '../../src/effect/ai/errors.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {runNativeMemoryEnrichment} from '../../src/effect/ai/enrichment.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'gemma-4-e4b-it-q4')!;

describe('native memory enrichment', () => {
  it('uses the selected in-process generation model and validates its structured output', async () => {
    const home = await mkdtemp('threadnote-native-enrichment-');
    try {
      const effect = Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', manifest.id);
        return yield* runNativeMemoryEnrichment(
          {agentContextHome: home},
          {
            body: 'Workers resume after a stalled heartbeat lease expires.',
            kind: 'durable',
            project: 'threadnote',
            topic: 'lease-recovery',
          },
        );
      }).pipe(Effect.provide(fakeRuntimeLayer), Effect.provide(fakeStoreLayer(home)));
      await expect(runEffect(effect)).resolves.toEqual([
        'resume jobs after heartbeat timeout',
        'recover worker after expired lease',
      ]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps the native generation failure actionable when enrichment is skipped', async () => {
    const home = await mkdtemp('threadnote-native-enrichment-');
    try {
      const effect = Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'generation', manifest.id);
        return yield* runNativeMemoryEnrichment(
          {agentContextHome: home},
          {
            body: 'A durable memory.',
            kind: 'durable',
            project: 'threadnote',
            topic: 'native-enrichment',
          },
        );
      }).pipe(Effect.provide(failingRuntimeLayer), Effect.provide(fakeStoreLayer(home)));
      await expect(runEffect(effect)).rejects.toThrow(
        'Native memory enrichment failed: Could not create a generation context for gemma-4-e4b-it-q4: native context detail',
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});

const fakeRuntimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    embedMany: () => Effect.die(new Error('Unexpected embedding')),
    generate: () =>
      Effect.succeed({
        searchPhrases: ['resume jobs after heartbeat timeout', 'recover worker after expired lease', 'lease recovery'],
      }),
    rerank: () => Effect.die(new Error('Unexpected reranking')),
  }),
);

const failingRuntimeLayer = Layer.succeed(
  LocalModelRuntime,
  LocalModelRuntime.of({
    embedMany: () => Effect.die(new Error('Unexpected embedding')),
    generate: request =>
      Effect.fail(
        new GenerationFailed({
          cause: new TypeError("Cannot read properties of undefined (reading '_vocabOnly')"),
          message: `Could not create a generation context for ${request.manifest.id}: native context detail`,
          modelId: request.manifest.id,
        }),
      ),
    rerank: () => Effect.die(new Error('Unexpected reranking')),
  }),
);

function fakeStoreLayer(home: string) {
  const installation = {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/gemma.gguf`,
    verified: true,
  };
  return Layer.succeed(
    LocalModelStore,
    LocalModelStore.of({
      install: () => Effect.die(new Error('Unexpected install')),
      path: () => installation.path,
      remove: () => Effect.succeed(false),
      status: () => Effect.succeed(installation),
      verify: () => Effect.succeed(installation),
    } satisfies LocalModelStoreShape),
  );
}
