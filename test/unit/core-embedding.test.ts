import {Effect} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {CORE_EMBEDDING_MODEL_ID} from '../../src/models/builtin.js';
import {ModelChecksumMismatch} from '../../src/effect/ai/errors.js';
import {provisionCoreEmbedding} from '../../src/models/core-embedding.js';
import {LocalModelCatalog} from '../../src/models/catalog.js';
import {readModelSelection, selectLocalModel} from '../../src/models/selection.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('core embedding provisioning', () => {
  it('installs and selects BGE Small without requiring user action', async () => {
    const home = await makeHome();
    const installed: string[] = [];
    const result = await runEffect(
      provisionCoreEmbedding({agentContextHome: home}).pipe(
        Effect.provideService(LocalModelStore, fixtureStore(installed)),
      ),
    );

    expect(result.manifest.id).toBe(CORE_EMBEDDING_MODEL_ID);
    expect(installed).toEqual([CORE_EMBEDDING_MODEL_ID]);
    expect((await runEffect(readModelSelection(home))).roles.embedding).toBe(CORE_EMBEDDING_MODEL_ID);
  });

  it('preserves and provisions an existing valid embedding selection', async () => {
    const home = await makeHome();
    const selectedId = 'bge-m3-q8';
    await runEffect(
      Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', selectedId);
      }),
    );
    const installed: string[] = [];

    const result = await runEffect(
      provisionCoreEmbedding({agentContextHome: home}).pipe(
        Effect.provideService(LocalModelStore, fixtureStore(installed)),
      ),
    );

    expect(result.manifest.id).toBe(selectedId);
    expect(installed).toEqual([selectedId]);
    expect((await runEffect(readModelSelection(home))).roles.embedding).toBe(selectedId);
  });

  it('keeps dry-run provisioning read-only', async () => {
    const home = await makeHome();
    const installed: string[] = [];

    await runEffect(
      provisionCoreEmbedding({agentContextHome: home}, {dryRun: true}).pipe(
        Effect.provideService(LocalModelStore, fixtureStore(installed)),
      ),
    );

    expect(installed).toEqual([]);
    expect((await runEffect(readModelSelection(home))).roles.embedding).toBeUndefined();
  });

  it('replaces a corrupt installed core model automatically', async () => {
    const home = await makeHome();
    let corrupt = true;
    const operations: string[] = [];
    const store = fixtureStore([]);
    const result = await runEffect(
      provisionCoreEmbedding({agentContextHome: home}).pipe(
        Effect.provideService(
          LocalModelStore,
          LocalModelStore.of({
            ...store,
            install: (_home, manifest) =>
              corrupt
                ? Effect.fail(
                    new ModelChecksumMismatch({
                      actual: 'corrupt',
                      expected: manifest.sha256,
                      message: 'corrupt fixture',
                      modelId: manifest.id,
                    }),
                  )
                : Effect.sync(() => {
                    operations.push('install');
                    return {
                      bytes: manifest.size,
                      installed: true,
                      modelId: manifest.id,
                      partialBytes: 0,
                      path: `/fixture/${manifest.id}.gguf`,
                      resumed: false,
                      sourceUrl: `fixture://${manifest.id}`,
                      verified: true,
                    };
                  }),
            remove: () =>
              Effect.sync(() => {
                operations.push('remove');
                corrupt = false;
                return true;
              }),
            status: (_home, manifest) =>
              Effect.succeed({
                bytes: manifest.size,
                installed: true,
                modelId: manifest.id,
                partialBytes: 0,
                path: `/fixture/${manifest.id}.gguf`,
                verified: false,
              }),
          }),
        ),
      ),
    );

    expect(result.installed).toBe(true);
    expect(operations).toEqual(['remove', 'install']);
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp('threadnote-core-embedding-');
  homes.push(home);
  return home;
}

function fixtureStore(installed: string[]): LocalModelStoreShape {
  const installation = (modelId: string) => ({
    bytes: 0,
    installed: false,
    modelId,
    partialBytes: 0,
    path: `/fixture/${modelId}.gguf`,
    verified: false,
  });
  return LocalModelStore.of({
    install: (_home, manifest) =>
      Effect.sync(() => {
        installed.push(manifest.id);
        return {
          ...installation(manifest.id),
          bytes: manifest.size,
          installed: true,
          resumed: false,
          sourceUrl: `fixture://${manifest.id}`,
          verified: true,
        };
      }),
    path: (_home, manifest) => `/fixture/${manifest.id}.gguf`,
    remove: () => Effect.succeed(false),
    status: (_home, manifest) => Effect.succeed(installation(manifest.id)),
    verify: (_home, manifest) => Effect.succeed({...installation(manifest.id), installed: true, verified: true}),
  });
}
