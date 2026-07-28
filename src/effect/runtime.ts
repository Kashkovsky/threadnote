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

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
const resourceStoreLayer = ResourceStore.layer.pipe(Layer.provide(systemLayer));
const localModelStoreLayer = LocalModelStore.layer.pipe(
  Layer.provideMerge(HttpService.layer),
  Layer.provide(systemLayer),
);
const localModelCatalogLayer = LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS);

const localModelRuntimeLayer = LocalModelRuntime.nativeLayer.pipe(Layer.provideMerge(systemLayer));

const ApplicationServicesLayer = Layer.mergeAll(
  commandLayer,
  localModelCatalogLayer,
  localModelRuntimeLayer,
  localModelStoreLayer,
  resourceStoreLayer,
  systemLayer,
);

export const ApplicationLayer = ApplicationServicesLayer.pipe(Layer.provideMerge(BunServices.layer));

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
