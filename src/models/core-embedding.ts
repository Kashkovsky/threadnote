import {Console, Effect, Result} from 'effect';
import type {RuntimeConfig} from '../types.js';
import {CORE_EMBEDDING_MODEL_ID} from './builtin.js';
import {LocalModelCatalog, type LocalModelManifest} from './catalog.js';
import {bundledCoreEmbeddingSource} from './core-embedding-asset.js';
import {readModelSelection, selectLocalModel} from './selection.js';
import {LocalModelStore, modelDownloadUrl} from './store.js';

export interface CoreEmbeddingProvisionResult {
  readonly installed: boolean;
  readonly manifest: LocalModelManifest;
  readonly selected: boolean;
}

export const provisionCoreEmbedding = Effect.fn('models.provisionCoreEmbedding')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  options: {readonly dryRun?: boolean} = {},
) {
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  const selection = yield* readModelSelection(config.agentContextHome);
  const selected = selection.roles.embedding
    ? yield* catalog.get(selection.roles.embedding).pipe(Effect.result)
    : undefined;
  const manifest =
    selected && Result.isSuccess(selected) && selected.success.role === 'embedding'
      ? selected.success
      : yield* catalog.get(CORE_EMBEDDING_MODEL_ID);
  const status = yield* store.status(config.agentContextHome, manifest);
  const needsSelection = selection.roles.embedding !== manifest.id;
  const bundledSource = bundledCoreEmbeddingSource(manifest);

  if (options.dryRun === true) {
    if (!status.installed) {
      yield* Console.log(
        bundledSource
          ? `Would install bundled core embedding model ${manifest.id}.`
          : `Would download core embedding model ${manifest.id} from ${modelDownloadUrl(manifest)}.`,
      );
      yield* Console.log(`Would verify ${manifest.size} bytes and SHA-256 ${manifest.sha256}.`);
    } else {
      yield* Console.log(`Would verify installed core embedding model ${manifest.id}.`);
    }
    if (needsSelection) yield* Console.log(`Would select ${manifest.id} for embedding.`);
    return {
      installed: status.installed,
      manifest,
      selected: !needsSelection,
    } satisfies CoreEmbeddingProvisionResult;
  }

  if (!status.installed) {
    yield* Console.log(
      bundledSource
        ? `Installing bundled core embedding model ${manifest.id}.`
        : `Downloading core embedding model ${manifest.id}; interrupted downloads are resumable.`,
    );
  }
  const install = store.install(config.agentContextHome, manifest, bundledSource);
  if (status.installed) {
    yield* install.pipe(
      Effect.catchTag('ModelChecksumMismatch', () =>
        Effect.gen(function* () {
          yield* Console.warn(`Installed ${manifest.id} failed verification; installing a verified replacement.`);
          yield* store.remove(config.agentContextHome, manifest);
          yield* store.install(config.agentContextHome, manifest, bundledSource);
        }),
      ),
    );
  } else {
    yield* install;
  }
  if (needsSelection) {
    yield* selectLocalModel(config.agentContextHome, catalog, 'embedding', manifest.id);
  }
  yield* Console.log(`${manifest.id}: core embedding model verified${needsSelection ? ' and selected' : ''}.`);
  return {
    installed: true,
    manifest,
    selected: true,
  } satisfies CoreEmbeddingProvisionResult;
});
