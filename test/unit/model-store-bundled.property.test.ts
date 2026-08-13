import {createHash} from 'node:crypto';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Result} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {LocalModelManifest} from '../../src/models/catalog.js';
import {BUNDLED_CORE_EMBEDDING_MANIFEST, bundledCoreEmbeddingSource} from '../../src/models/core-embedding-asset.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelStore} from '../../src/models/store.js';

describe('bundled model installation', () => {
  it('routes only the exact pinned core embedding manifest to the executable asset', () => {
    expect(bundledCoreEmbeddingSource(BUNDLED_CORE_EMBEDDING_MANIFEST)).toMatchObject({
      sourceUrl: `embedded://threadnote/${BUNDLED_CORE_EMBEDDING_MANIFEST.id}/${BUNDLED_CORE_EMBEDDING_MANIFEST.sha256}.gguf`,
    });
    for (const manifest of BUILTIN_MODEL_MANIFESTS.filter(
      candidate => candidate.id !== BUNDLED_CORE_EMBEDDING_MANIFEST.id,
    )) {
      expect(bundledCoreEmbeddingSource(manifest)).toBeUndefined();
    }
    expect(bundledCoreEmbeddingSource({...BUNDLED_CORE_EMBEDDING_MANIFEST, sha256: '0'.repeat(64)})).toBeUndefined();
  });

  effectIt.layer(ApplicationLayer)(layerIt => {
    layerIt.effect.prop(
      'atomically promotes exactly the verified bundled bytes and rejects same-size mutations',
      {bytes: fc.uint8Array({maxLength: 128, minLength: 1})},
      ({bytes}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const store = yield* LocalModelStore;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-bundled-model-property-'});
            const source = path.join(root, 'source.gguf');
            const validHome = path.join(root, 'valid-home');
            const invalidHome = path.join(root, 'invalid-home');
            const truncatedHome = path.join(root, 'truncated-home');
            const manifest = fixtureManifest(bytes);

            yield* fs.writeFile(source, bytes);
            const installed = yield* store.install(validHome, manifest, {
              sourcePath: source,
              sourceUrl: 'embedded://threadnote/fixture.gguf',
            });
            expect(installed).toMatchObject({
              bytes: bytes.length,
              installed: true,
              resumed: false,
              sourceUrl: 'embedded://threadnote/fixture.gguf',
              verified: true,
            });
            expect(Uint8Array.from(yield* fs.readFile(installed.path))).toEqual(bytes);
            expect(yield* fs.exists(`${installed.path}.partial`)).toBe(false);

            const mutated = Uint8Array.from(bytes);
            mutated[0] = mutated[0]! ^ 0xff;
            yield* fs.writeFile(source, mutated);
            const rejected = yield* store
              .install(invalidHome, manifest, {sourcePath: source, sourceUrl: 'embedded://threadnote/fixture.gguf'})
              .pipe(Effect.result);
            expect(Result.isFailure(rejected)).toBe(true);
            if (Result.isFailure(rejected)) expect(rejected.failure._tag).toBe('ModelChecksumMismatch');
            const invalidPath = store.path(invalidHome, manifest);
            expect(yield* fs.exists(invalidPath)).toBe(false);
            expect(yield* fs.exists(`${invalidPath}.partial`)).toBe(false);

            yield* fs.writeFile(source, bytes.subarray(1));
            const truncated = yield* store
              .install(truncatedHome, manifest, {sourcePath: source, sourceUrl: 'embedded://threadnote/fixture.gguf'})
              .pipe(Effect.result);
            expect(Result.isFailure(truncated)).toBe(true);
            if (Result.isFailure(truncated)) expect(truncated.failure._tag).toBe('ModelDownloadFailed');
            const truncatedPath = store.path(truncatedHome, manifest);
            expect(yield* fs.exists(truncatedPath)).toBe(false);
            expect(yield* fs.exists(`${truncatedPath}.partial`)).toBe(false);
          }),
        ),
      {fastCheck: {numRuns: 50}},
    );
  });
});

function fixtureManifest(bytes: Uint8Array): LocalModelManifest {
  return {
    architecture: 'bert',
    contextLimit: 512,
    dimensions: 384,
    file: 'fixture.gguf',
    id: 'fixture-embedding',
    license: 'test-only',
    minimumRamBytes: 1,
    normalization: 'l2',
    promptPrefixes: {document: '', query: ''},
    quantization: 'F32',
    repository: 'threadnote/fixtures',
    revision: 'a'.repeat(40),
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.19.1'},
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    task: 'retrieval',
    version: 1,
  };
}
