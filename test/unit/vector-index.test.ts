import {Effect, Layer, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import {InferenceInterrupted} from '../../src/effect/ai/errors.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {
  ensureVectorIndex,
  rebuildVectorIndex,
  selectedSemanticScores,
  vectorIndexStatus,
} from '../../src/search/vector-index.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(new Error('Unexpected install')),
    path: home => `${home}/models/fake.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(installation(home)),
    verify: home => Effect.succeed(installation(home)),
  } satisfies LocalModelStoreShape),
);

describe('vector index generations', () => {
  it('activates a complete fake-embedding generation and supports semantic query lookup', async () => {
    const home = await mkdtemp('threadnote-vector-index-');
    try {
      const runtimeLayer = fakeRuntimeLayer(input => (input.toLowerCase().includes('alpha') ? 0 : 1));
      const effect = Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
        const rebuilt = yield* rebuildVectorIndex({agentContextHome: home}, manifest, [
          {text: '# Alpha\n\nThe release semaphore controls deployment.', uri: 'threadnote://resources/repos/a.md'},
          {text: '# Beta\n\nThe orchard contains pear trees.', uri: 'threadnote://resources/repos/b.md'},
        ]);
        const scores = yield* selectedSemanticScores({agentContextHome: home}, 'alpha deployment');
        return {rebuilt, scores};
      }).pipe(Effect.provide(runtimeLayer), Effect.provide(modelStoreLayer));
      const {rebuilt, scores} = await runEffect(effect);
      expect(rebuilt.ready).toBe(true);
      expect(rebuilt.chunkCount).toBe(2);
      expect(scores?.get('threadnote://resources/repos/a.md')).toBeCloseTo(1);
      expect(scores?.get('threadnote://resources/repos/b.md')).toBeCloseTo(0);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps the active generation when a replacement embedding run is interrupted', async () => {
    const home = await mkdtemp('threadnote-vector-interrupt-');
    try {
      const candidates = [{text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'}];
      const first = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          Effect.provide(fakeRuntimeLayer(() => 0)),
          Effect.provide(modelStoreLayer),
        ),
      );
      const failed = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, [
          {text: '# Alpha\n\nChanged canonical content.', uri: 'threadnote://resources/repos/a.md'},
        ]).pipe(
          Effect.provide(
            Layer.succeed(
              LocalModelRuntime,
              LocalModelRuntime.of({
                embedMany: () =>
                  Effect.fail(
                    new InferenceInterrupted({
                      message: 'fixture interruption',
                      modelId: manifest.id,
                      operation: 'embed',
                    }),
                  ),
                generate: () => Effect.die(new Error('Unexpected generation')),
                rerank: () => Effect.die(new Error('Unexpected reranking')),
              }),
            ),
          ),
          Effect.provide(modelStoreLayer),
          Effect.result,
        ),
      );
      const status = await runEffect(vectorIndexStatus(home, manifest));
      expect(Result.isFailure(failed)).toBe(true);
      expect(status.ready).toBe(true);
      expect(status.generation).toBe(first.generation);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('reuses unchanged chunks and embeds only changed canonical content', async () => {
    const home = await mkdtemp('threadnote-vector-incremental-');
    try {
      const embeddedInputs: string[][] = [];
      const runtimeLayer = fakeRuntimeLayer(
        input => (input.toLowerCase().includes('alpha') ? 0 : 1),
        inputs => embeddedInputs.push([...inputs]),
      );
      const candidates = [
        {text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'},
        {text: '# Beta\n\nOriginal canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ];
      const rebuild = (documents: typeof candidates) =>
        runEffect(
          rebuildVectorIndex({agentContextHome: home}, manifest, documents).pipe(
            Effect.provide(runtimeLayer),
            Effect.provide(modelStoreLayer),
          ),
        );

      const first = await rebuild(candidates);
      const unchanged = await rebuild(candidates);
      const changed = await rebuild([
        candidates[0]!,
        {text: '# Beta\n\nChanged canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ]);

      expect(first.embeddedChunkCount).toBe(2);
      expect(first.reusedChunkCount).toBe(0);
      expect(unchanged.embeddedChunkCount).toBe(0);
      expect(unchanged.reusedChunkCount).toBe(2);
      expect(changed.embeddedChunkCount).toBe(1);
      expect(changed.reusedChunkCount).toBe(1);
      expect(embeddedInputs.map(inputs => inputs.length)).toEqual([2, 1]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('automatically refreshes a stale vector generation and leaves a current one untouched', async () => {
    const home = await mkdtemp('threadnote-vector-ensure-');
    try {
      const embeddedInputs: string[][] = [];
      const runtimeLayer = fakeRuntimeLayer(
        input => (input.toLowerCase().includes('alpha') ? 0 : 1),
        inputs => embeddedInputs.push([...inputs]),
      );
      const initial = [
        {text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'},
        {text: '# Beta\n\nOriginal canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ];
      const ensure = (documents: typeof initial, corpusGeneration: string) =>
        runEffect(
          ensureVectorIndex({agentContextHome: home}, manifest, documents, {corpusGeneration}).pipe(
            Effect.provide(runtimeLayer),
            Effect.provide(modelStoreLayer),
          ),
        );

      const first = await ensure(initial, 'lexical-generation-1');
      const current = await ensure(initial, 'lexical-generation-1');
      const changedDocuments = [
        initial[0]!,
        {text: '# Beta\n\nChanged canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ];
      const refreshed = await ensure(changedDocuments, 'lexical-generation-2');
      const status = await runEffect(vectorIndexStatus(home, manifest, changedDocuments));

      expect(first.embeddedChunkCount).toBe(2);
      expect(current.embeddedChunkCount).toBe(0);
      expect(current.reusedChunkCount).toBe(2);
      expect(refreshed.embeddedChunkCount).toBe(1);
      expect(refreshed.reusedChunkCount).toBe(1);
      expect(embeddedInputs.map(inputs => inputs.length)).toEqual([2, 1]);
      expect(status.ready).toBe(true);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('resumes an interrupted rebuild from its checksummed staging checkpoint', async () => {
    const home = await mkdtemp('threadnote-vector-resume-');
    const candidates = Array.from({length: 300}, (_, index) => ({
      text: `# Document ${index}\n\nCanonical content ${index}.`,
      uri: `threadnote://resources/repos/doc-${index}.md`,
    }));
    try {
      let call = 0;
      const interruptedLayer = Layer.succeed(
        LocalModelRuntime,
        LocalModelRuntime.of({
          embedMany: ({inputs, manifest: requested}) => {
            call += 1;
            if (call === 2) {
              return Effect.fail(
                new InferenceInterrupted({
                  message: 'fixture interruption',
                  modelId: manifest.id,
                  operation: 'embed',
                }),
              );
            }
            return Effect.succeed(inputs.map((_, index) => unitVector(requested.dimensions ?? 0, index % 2)));
          },
          generate: () => Effect.die(new Error('Unexpected generation')),
          rerank: () => Effect.die(new Error('Unexpected reranking')),
        }),
      );
      const interrupted = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          Effect.provide(interruptedLayer),
          Effect.provide(modelStoreLayer),
          Effect.result,
        ),
      );
      expect(Result.isFailure(interrupted)).toBe(true);

      const resumedBatches: number[] = [];
      const resumed = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          Effect.provide(
            fakeRuntimeLayer(
              () => 0,
              inputs => resumedBatches.push(inputs.length),
            ),
          ),
          Effect.provide(modelStoreLayer),
        ),
      );
      expect(resumed.chunkCount).toBe(300);
      expect(resumed.reusedChunkCount).toBe(256);
      expect(resumed.embeddedChunkCount).toBe(44);
      expect(resumedBatches).toEqual([44]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});

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

function fakeRuntimeLayer(
  vectorIndex: (input: string) => number,
  onInputs: (inputs: readonly string[]) => void = () => undefined,
) {
  return Layer.succeed(
    LocalModelRuntime,
    LocalModelRuntime.of({
      embedMany: ({inputs, manifest: requested}) =>
        Effect.sync(() => {
          onInputs(inputs);
          return inputs.map(input => unitVector(requested.dimensions ?? 0, vectorIndex(input)));
        }),
      generate: () => Effect.die(new Error('Unexpected generation')),
      rerank: () => Effect.die(new Error('Unexpected reranking')),
    }),
  );
}

function unitVector(dimensions: number, index: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[index] = 1;
  return vector;
}
