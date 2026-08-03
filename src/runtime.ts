import {Effect, FileSystem, Path} from 'effect';
import {DEFAULT_ACCOUNT, DEFAULT_AGENT_ID, USER_MANIFEST_NAME} from './constants.js';
import {expandPath, toolRoot} from './utils.js';
import {SystemInfo} from './effect/system.js';

export interface RuntimeOptions {
  readonly home?: string;
  readonly manifest?: string;
}

export const getRuntimeConfig = Effect.fn('runtime.getRuntimeConfig')(function* (
  options: RuntimeOptions = {},
  manifestOverride?: string,
) {
  const system = yield* SystemInfo;
  const environment = system.environment();
  const threadnoteHome = yield* expandPath(options.home ?? environment.THREADNOTE_HOME ?? '~/.threadnote');
  const configuredManifest = manifestOverride ?? options.manifest ?? environment.THREADNOTE_MANIFEST;
  const manifestPath = yield* expandPath(configuredManifest ?? (yield* defaultManifestPath(threadnoteHome)));
  return {
    account: environment.THREADNOTE_ACCOUNT ?? DEFAULT_ACCOUNT,
    agentContextHome: threadnoteHome,
    agentId: environment.THREADNOTE_AGENT_ID ?? DEFAULT_AGENT_ID,
    manifestPath,
    user: environment.THREADNOTE_USER ?? system.userName,
  };
});

export const defaultManifestPath = Effect.fn('runtime.defaultManifestPath')(function* (agentContextHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const userManifest = pathService.join(agentContextHome, USER_MANIFEST_NAME);
  return (yield* fs.exists(userManifest)) ? userManifest : yield* builtInExampleManifestPath();
});

export const builtInExampleManifestPath = Effect.fn('runtime.builtInExampleManifestPath')(function* () {
  const pathService = yield* Path.Path;
  return pathService.join(yield* toolRoot(), 'config', 'seed-manifest.example.yaml');
});
