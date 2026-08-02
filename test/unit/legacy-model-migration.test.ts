import {createHash} from 'node:crypto';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
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

  it.effect('rejects a pending legacy-model symlink during eligibility and apply without touching its target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-link-'});
        const externalRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-link-target-'});
        const outside = path.join(externalRoot, 'outside-model.gguf');
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.writeFile(outside, modelBytes);
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.symlink(outside, source);
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', 'legacy-local-model-v1.json'),
          `${JSON.stringify({id: 'legacy-local-model-v1', models: [manifest.id], status: 'pending', version: 1})}\n`,
        );

        const eligibility = yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]}).pipe(Effect.flip);
        const apply = yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
        expect(String(eligibility)).toContain('must not be a symbolic link');
        expect(String(apply)).toContain('must not be a symbolic link');
        expect(Array.from(yield* fs.readFile(outside))).toEqual(Array.from(modelBytes));
        expect(yield* fs.exists(path.join(home, 'models', manifest.role, manifest.id))).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('rejects a directory at a legacy model path during eligibility and apply', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-model-directory-'});
        const source = path.join(home, 'threadnote', 'models', manifest.file);
        yield* fs.makeDirectory(source, {recursive: true});

        const eligibility = yield* isLegacyLocalModelMigrationPending({home, manifests: [manifest]}).pipe(Effect.flip);
        const apply = yield* migrateLegacyLocalModels({apply: true, home, manifests: [manifest]}).pipe(Effect.flip);
        expect(String(eligibility)).toContain('must be a regular file');
        expect(String(apply)).toContain('must be a regular file');
        expect((yield* fs.stat(source)).type).toBe('Directory');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
