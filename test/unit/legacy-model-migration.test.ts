import {createHash} from 'node:crypto';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {isLegacyLocalModelMigrationPending, migrateLegacyLocalModels} from '../../src/migration/models.js';
import type {LocalModelManifest} from '../../src/models/catalog.js';
import {readModelSelection} from '../../src/models/selection.js';

const modelBytes = new TextEncoder().encode('small deterministic legacy GGUF');
const manifest: LocalModelManifest = {
  architecture: 'fixture',
  contextLimit: 128,
  file: 'fixture.gguf',
  id: 'fixture-generation',
  license: 'MIT',
  minimumRamBytes: 1,
  quantization: 'fixture',
  repository: 'example/fixture',
  revision: '0123456789abcdef0123456789abcdef01234567',
  role: 'generation',
  runtime: {nodeLlamaCpp: '3.19.1'},
  sha256: createHash('sha256').update(modelBytes).digest('hex'),
  size: modelBytes.byteLength,
  task: 'test',
  version: 1,
};

describe('legacy local model migration', () => {
  it.effect('adopts, verifies, and selects an already-installed generation model without downloading it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-migration-'});
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFile(source, modelBytes);

        expect(yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]})).toBe(true);
        expect(yield* migrateLegacyLocalModels({home, manifests: [manifest]})).toEqual({
          action: 'dry_run',
          models: [manifest.id],
        });
        expect(yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]})).toEqual({
          action: 'migrated',
          models: [manifest.id],
        });

        const target = path.join(home, 'models', 'generation', manifest.id, `${manifest.sha256}.gguf`);
        expect(Array.from(yield* fs.readFile(target))).toEqual(Array.from(modelBytes));
        expect(yield* fs.exists(source)).toBe(false);
        expect(yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]})).toBe(false);
        expect((yield* readModelSelection(home)).roles.generation).toBe(manifest.id);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('leaves a checksum-mismatched legacy file in place', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-mismatch-'});
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFile(source, new TextEncoder().encode('same-size-but-different-contents!'));

        yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
        expect(yield* fs.exists(source)).toBe(true);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
