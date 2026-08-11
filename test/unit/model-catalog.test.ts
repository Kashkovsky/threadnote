import {provideTestLayer} from '../helpers/effect-layer.js';
import {expect, it} from '@effect/vitest';
import {Effect, Exit} from 'effect';
import {describe} from 'vitest';
import {LOCAL_MODEL_MANIFEST_VERSION, LocalModelCatalog, parseLocalModelManifest} from '../../src/models/catalog.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';

const embedding = {
  architecture: 'bert',
  contextLimit: 512,
  dimensions: 384,
  file: 'embedding.Q8_0.gguf',
  id: 'embedding-fixture',
  license: 'Apache-2.0',
  minimumRamBytes: 400_000_000,
  normalization: 'l2',
  promptPrefixes: {document: 'passage: ', query: 'query: '},
  quantization: 'Q8_0',
  repository: 'threadnote/fixture',
  revision: '1'.repeat(40),
  role: 'embedding',
  runtime: {nodeLlamaCpp: '3.19.1'},
  sha256: 'a'.repeat(64),
  size: 200_000_000,
  task: 'retrieval',
  version: LOCAL_MODEL_MANIFEST_VERSION,
} as const;

describe('local model catalog', () => {
  it('requires immutable supply-chain and embedding-space metadata', () => {
    expect(parseLocalModelManifest(embedding)).toEqual(embedding);
    expect(
      parseLocalModelManifest({
        ...embedding,
        runtime: {...embedding.runtime, darwinArm64EmbeddingGpuLayers: 0},
      }).runtime.darwinArm64EmbeddingGpuLayers,
    ).toBe(0);
    expect(() => parseLocalModelManifest({...embedding, sha256: 'latest'})).toThrow('SHA-256');
    expect(() => parseLocalModelManifest({...embedding, normalization: 'none'})).toThrow('l2 normalization');
    expect(() => parseLocalModelManifest({...embedding, promptPrefixes: {query: 'query: '}})).toThrow(
      'query and document prefixes',
    );
    expect(() =>
      parseLocalModelManifest({
        ...embedding,
        runtime: {...embedding.runtime, darwinArm64EmbeddingGpuLayers: -1},
      }),
    ).toThrow('invalid macOS arm64 embedding GPU-layer policy');

    const reranker = BUILTIN_MODEL_MANIFESTS.find(candidate => candidate.role === 'reranker')!;
    expect(() =>
      parseLocalModelManifest({
        ...reranker,
        runtime: {...reranker.runtime, darwinArm64EmbeddingGpuLayers: 0},
      }),
    ).toThrow('embedding-only metadata or runtime policy');
  });

  it('keeps every measured candidate pinned and valid without selecting a default', () => {
    expect(BUILTIN_MODEL_MANIFESTS.map(parseLocalModelManifest)).toEqual(BUILTIN_MODEL_MANIFESTS);
    expect(BUILTIN_MODEL_MANIFESTS.some(model => model.role === 'embedding')).toBe(true);
    expect(BUILTIN_MODEL_MANIFESTS.some(model => model.role === 'reranker')).toBe(true);
  });

  it.effect('resolves role-aware selections and keeps unmeasured defaults explicit', () =>
    Effect.gen(function* () {
      const catalog = yield* LocalModelCatalog;
      expect((yield* catalog.selected('embedding')).id).toBe(embedding.id);
      expect(yield* catalog.list('reranker')).toEqual([]);
      const generation = yield* catalog.selected('generation').pipe(Effect.exit);
      expect(Exit.isFailure(generation)).toBe(true);
      if (Exit.isFailure(generation)) {
        expect(generation.cause.toString()).toContain('measured model bake-off');
      }
    }).pipe(provideTestLayer(LocalModelCatalog.layer([embedding], {embedding: embedding.id}))),
  );
});
