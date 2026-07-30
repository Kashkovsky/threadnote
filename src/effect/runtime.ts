import * as BunServices from '@effect/platform-bun/BunServices';
import {Layer} from 'effect';
import {CommandExecutor} from './command.js';
import {HttpService} from './http.js';
import {ResourceStore} from './resource-store.js';
import {SystemInfo} from './system.js';
import {LocalModelStore} from '../models/store.js';
import {LocalModelCatalog} from '../models/catalog.js';
import {BUILTIN_MODEL_MANIFESTS} from '../models/builtin.js';
import {LocalModelRuntime} from './ai/local-model-runtime.js';
import {isolatedLocalModelRuntimeLayer} from './ai/isolated-local-model-runtime.js';
import {CodeGraphStore} from '../code_graph/store.js';
import {CodeGraphIndexer} from '../code_graph/indexer.js';
import {CodeGraphQueryService} from '../code_graph/query.js';
import {CodeGraphEmbeddingIndex} from '../code_graph/embedding.js';
import {CodeGraphWatcher} from '../code_graph/watcher.js';
import {CodeGraphLanguagePackRegistry} from '../code_graph/languages/registry.js';
import {TreeSitterRuntime} from '../code_graph/tree_sitter/runtime.js';

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const resourceStoreLayer = ResourceStore.layer.pipe(Layer.provide(systemLayer));
const localModelStoreLayer = LocalModelStore.layer.pipe(
  Layer.provideMerge(HttpService.layer),
  Layer.provide(systemLayer),
);
const localModelCatalogLayer = LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS);

const localModelRuntimeLayer = (
  typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE
    ? isolatedLocalModelRuntimeLayer()
    : LocalModelRuntime.nativeLayer
).pipe(Layer.provideMerge(systemLayer));
const codeGraphStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(systemLayer));
const treeSitterRuntimeLayer = TreeSitterRuntime.layer.pipe(Layer.provide(systemLayer));
const codeGraphLanguagePackLayer = CodeGraphLanguagePackRegistry.layer;
const codeGraphEmbeddingLayer = CodeGraphEmbeddingIndex.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(localModelCatalogLayer, localModelRuntimeLayer, localModelStoreLayer)),
);
const codeGraphIndexerLayer = CodeGraphIndexer.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      codeGraphStoreLayer,
      codeGraphEmbeddingLayer,
      codeGraphLanguagePackLayer,
      commandLayer,
      systemLayer,
      treeSitterRuntimeLayer,
    ),
  ),
);
const codeGraphQueryLayer = CodeGraphQueryService.layer.pipe(Layer.provideMerge(codeGraphIndexerLayer));
const codeGraphWatcherLayer = CodeGraphWatcher.layer.pipe(Layer.provideMerge(codeGraphIndexerLayer));

const ApplicationServicesLayer = Layer.mergeAll(
  codeGraphQueryLayer,
  codeGraphWatcherLayer,
  commandLayer,
  localModelCatalogLayer,
  localModelRuntimeLayer,
  localModelStoreLayer,
  resourceStoreLayer,
  systemLayer,
);

export const ApplicationLayer = ApplicationServicesLayer.pipe(Layer.provideMerge(BunServices.layer));

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
