import * as BunServices from '@effect/platform-bun/BunServices';
import {Layer} from 'effect';
import {CommandExecutor} from './command.js';
import {CliOutput} from './cli_output.js';
import {HttpService} from './http.js';
import {ResourceStore} from './resource-store.js';
import {SystemInfo} from './system.js';
import {LocalModelStore} from '../models/store.js';
import {LocalModelCatalog} from '../models/catalog.js';
import {BUILTIN_MODEL_MANIFESTS} from '../models/builtin.js';
import {isolatedLocalModelRuntimeLayer} from './ai/isolated-local-model-runtime.js';
import {CodeGraphStore} from '../code_graph/store.js';
import {CodeGraphIndexer} from '../code_graph/indexer.js';
import {CodeGraphQueryService} from '../code_graph/query.js';
import {CodeGraphEmbeddingIndex} from '../code_graph/embedding.js';
import {CodeGraphWatcher} from '../code_graph/watcher.js';
import {CodeGraphMaintenanceCoordinator} from '../code_graph/maintenance_coordinator.js';
import {CodeGraphLanguagePackRegistry} from '../code_graph/languages/registry.js';
import {TreeSitterRuntime} from '../code_graph/tree_sitter/runtime.js';
import {CodeGraphAnalysis} from '../code_graph/analysis.js';
import {CodeGraphParserPool} from '../code_graph/parser_worker.js';

const systemLayer = SystemInfo.layer;
export const StandaloneBrokerLayer = Layer.merge(systemLayer, BunServices.layer);
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const resourceStoreLayer = ResourceStore.layer.pipe(Layer.provide(systemLayer));
const localModelStoreLayer = LocalModelStore.layer.pipe(
  Layer.provideMerge(HttpService.layer),
  Layer.provide(systemLayer),
);
const localModelCatalogLayer = LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS);

// Keep native inference outside the application process in every runtime,
// including `bun src/standalone.ts` during development. A fatal native crash
// must only terminate the worker so optional enrichment can fail closed while
// the CLI or MCP process still stores the canonical memory.
const localModelRuntimeLayer = isolatedLocalModelRuntimeLayer().pipe(Layer.provideMerge(systemLayer));
const codeGraphStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(systemLayer));
const codeGraphMaintenanceCoordinatorLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
  Layer.provideMerge(Layer.merge(codeGraphStoreLayer, commandLayer)),
);
const codeGraphAnalysisLayer = CodeGraphAnalysis.layer.pipe(Layer.provideMerge(codeGraphStoreLayer));
const treeSitterRuntimeLayer = TreeSitterRuntime.layer.pipe(Layer.provide(systemLayer));
const codeGraphParserPoolLayer = CodeGraphParserPool.layer.pipe(Layer.provideMerge(systemLayer));
const codeGraphLanguagePackLayer = CodeGraphLanguagePackRegistry.layer;
const codeGraphEmbeddingLayer = CodeGraphEmbeddingIndex.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(localModelCatalogLayer, localModelRuntimeLayer, localModelStoreLayer)),
);
const codeGraphIndexerLayer = CodeGraphIndexer.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      codeGraphStoreLayer,
      codeGraphMaintenanceCoordinatorLayer,
      codeGraphEmbeddingLayer,
      codeGraphLanguagePackLayer,
      codeGraphParserPoolLayer,
      commandLayer,
      systemLayer,
      treeSitterRuntimeLayer,
    ),
  ),
);
const codeGraphQueryLayer = CodeGraphQueryService.layer.pipe(Layer.provideMerge(codeGraphIndexerLayer));
// MCP hosts detect themselves inside CodeGraphWatcher and spawn CLI `graph index`
// children so multi-hour builds cannot starve recall_context on the stdio process.
const codeGraphWatcherLayer = CodeGraphWatcher.layer.pipe(Layer.provideMerge(codeGraphIndexerLayer));

const ApplicationServicesLayer = Layer.mergeAll(
  CliOutput.layer,
  codeGraphQueryLayer,
  codeGraphAnalysisLayer,
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
