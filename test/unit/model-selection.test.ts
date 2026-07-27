import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {BUILTIN_MODEL_MANIFESTS} from '../../src/models/builtin.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {readModelSelection, selectLocalModel} from '../../src/models/selection.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('model selection', () => {
  it('atomically records role-aware selection and ignores a malformed receipt', async () => {
    const home = await mkdtemp('threadnote-model-selection-');
    try {
      await runEffect(
        Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          const selected = yield* selectLocalModel(home, catalog, 'embedding', 'bge-small-en-v1.5-q8');
          expect(selected.roles.embedding).toBe('bge-small-en-v1.5-q8');
          expect((yield* readModelSelection(home)).roles.embedding).toBe('bge-small-en-v1.5-q8');
        }).pipe(Effect.provide(LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS))),
      );
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });
});
