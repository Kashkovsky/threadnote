import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {readModelSelection, selectLocalModel} from '../../src/models/selection.js';

describe('model selection', () => {
  effectIt.effect('atomically records role-aware selection and ignores a malformed receipt', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectory({prefix: 'threadnote-model-selection-'});
      yield* Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        const selected = yield* selectLocalModel(home, catalog, 'embedding', 'bge-small-en-v1.5-q8');
        expect(selected.roles.embedding).toBe('bge-small-en-v1.5-q8');
        expect((yield* readModelSelection(home)).roles.embedding).toBe('bge-small-en-v1.5-q8');
      }).pipe(Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.orDie)));
    }).pipe(provideTestLayer(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)), provideTestLayer(ApplicationLayer)),
  );
});
