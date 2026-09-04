import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Crypto, Effect, Layer} from 'effect';
import {succeedUndefined} from './optional.js';
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
import {resolveTelemetryConfiguration} from '../telemetry/config.js';
import {
  resolveAgentSession,
  retainCurrentAgentSessionEnvironment,
  takeTelemetrySessionEnvironment,
} from '../telemetry/session.js';
import {getThreadnoteVersion} from '../release/runtime_version.js';
import {anonymousTelemetryLayer} from './telemetry.js';

const systemLayer = SystemInfo.layer;
const commandLayer = CommandExecutor.layer.pipe(Layer.provide(systemLayer));
export const StandaloneBrokerLayer = Layer.mergeAll(
  systemLayer,
  BunServices.layer,
  commandLayer.pipe(Layer.provide(BunServices.layer)),
);
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

export const ApplicationLayer = ApplicationServicesLayer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

/**
 * Runtime application layer with explicit-consent anonymous telemetry. The
 * static ApplicationLayer remains telemetry-free for focused tests.
 */
export function applicationLayerForHome(home: string, entrypoint: 'cli' | 'mcp') {
  return telemetryLayerForHome(home, entrypoint === 'cli' ? 'invocation' : 'broker').pipe(
    Layer.provideMerge(ApplicationLayer),
  );
}

export function standaloneBrokerLayerForHome(home: string) {
  return telemetryLayerForHome(home, 'broker', true).pipe(Layer.provideMerge(StandaloneBrokerLayer));
}

function telemetryLayerForHome(home: string, fallbackScope: 'broker' | 'invocation', bridgeToBrokerProgram = false) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const environment = system.environment();
      const sessionEnvironment = takeTelemetrySessionEnvironment(environment);
      if (fallbackScope === 'broker' && !bridgeToBrokerProgram) {
        environment.THREADNOTE_MCP_BROKER_CHILD = '1';
      }
      const crypto = yield* Crypto.Crypto;
      const configuration = yield* boundedTelemetryConfiguration(home);
      if (configuration === undefined) return anonymousTelemetryLayer();
      const randomBytes = yield* crypto.randomBytes(16).pipe(
        Effect.map(bytes => bytes as Uint8Array | undefined),
        Effect.catchCause(() => succeedUndefined),
      );
      if (randomBytes === undefined) return anonymousTelemetryLayer();
      const session = resolveAgentSession({
        configuration,
        environment: sessionEnvironment,
        fallbackScope,
        randomBytes,
      });
      // Provider inputs and inherited child markers were consumed above even
      // when consent is absent. Retain only an opaque current-process alias;
      // generic subprocess launchers scrub it, while declared Threadnote child
      // plans attach a fresh child-kind marker explicitly.
      retainCurrentAgentSessionEnvironment(
        environment,
        session,
        bridgeToBrokerProgram && configuration !== undefined ? 'mcp-broker-runtime' : undefined,
      );
      const serviceVersion = yield* getThreadnoteVersion().pipe(Effect.orElseSucceed(() => 'unknown'));
      const consentIdentity = `${configuration.endpoint}\0${configuration.sessionSalt}`;
      const runtimeContext = yield* Effect.context<Layer.Success<typeof StandaloneBrokerLayer>>();
      const isEnabled = boundedTelemetryConfiguration(home).pipe(
        Effect.map(current =>
          current === undefined ? false : `${current.endpoint}\0${current.sessionSalt}` === consentIdentity,
        ),
        Effect.provideContext(runtimeContext),
      );
      return anonymousTelemetryLayer({
        correlationScope: session.correlationScope,
        endpoint: configuration.endpoint,
        isEnabled,
        serviceVersion,
        sessionId: session.id,
        // A fresh public TLS connection routinely needs more than 250ms. Keep
        // the opt-in CLI budget below the MCP-oriented three-second window,
        // while allowing short invocations to finish one anonymous export.
        shutdownTimeout: fallbackScope === 'invocation' ? '2 seconds' : '3 seconds',
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(anonymousTelemetryLayer()))),
  ).pipe(Layer.catchCause(() => anonymousTelemetryLayer()));
}

const TELEMETRY_CONFIGURATION_READ_TIMEOUT = '250 millis';

function boundedTelemetryConfiguration(home: string) {
  return resolveTelemetryConfiguration({agentContextHome: home}).pipe(
    Effect.timeoutOrElse({
      duration: TELEMETRY_CONFIGURATION_READ_TIMEOUT,
      orElse: () => succeedUndefined,
    }),
    Effect.catchCause(() => succeedUndefined),
  );
}

/** @internal Runtime-boundary regression coverage. */
export const telemetryLayerForHomeForTest = telemetryLayerForHome;

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
