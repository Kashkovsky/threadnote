import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runDevelopmentInstallRepair, runRepair} from '../../src/lifecycle.js';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '../../src/models/builtin.js';
import {LocalModelStore} from '../../src/models/store.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '../helpers/test-error.js';

const embeddingManifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === CORE_EMBEDDING_MODEL_ID)!;
const version = '4.6.7-local.g' + 'a'.repeat(40);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-development-repair-'});
  const user = path.join(root, 'user');
  const home = path.join(user, '.threadnote');
  const installRoot = path.join(root, 'install');
  const releaseRoot = path.join(installRoot, 'versions', version);
  const instruction = path.join(user, '.copilot', 'instructions', 'threadnote.instructions.md');
  const registry = path.join(home, 'integrations', 'agents.json');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  const testSystem = SystemInfo.of({
    ...system,
    homeDirectory: user,
    environment: () => ({
      ...system.environment(),
      THREADNOTE_INSTALL_ROOT: installRoot,
      THREADNOTE_BIN_DIR: path.join(root, 'bin'),
      NVM_DIR: undefined,
      NVM_HOME: undefined,
    }),
  });
  yield* fs.makeDirectory(releaseRoot, {recursive: true});
  yield* fs.writeFileString(path.join(releaseRoot, 'release.json'), JSON.stringify({version}));
  const pointer = JSON.stringify({releaseRoot, version});
  yield* fs.writeFileString(path.join(installRoot, 'active-release.json'), pointer);
  yield* fs.makeDirectory(path.dirname(instruction), {recursive: true});
  yield* fs.writeFileString(instruction, 'Operator-owned instructions. Preserve verbatim.\n');
  yield* fs.makeDirectory(path.dirname(registry), {recursive: true});
  const registryContent = JSON.stringify({
    version: 1,
    legacyInstructionsMigrated: true,
    hosts: {
      copilot: {
        artifactVersion: 1,
        artifacts: {},
        installedVersion: version,
        status: 'pending',
        mcp: {name: 'threadnote', repair: true, toolset: 'core'},
      },
    },
  });
  yield* fs.writeFileString(registry, registryContent);
  const installation = {
    bytes: embeddingManifest.size,
    installed: true,
    modelId: embeddingManifest.id,
    partialBytes: 0,
    path: path.join(home, 'fixture.gguf'),
    verified: true,
  };
  const store = LocalModelStore.of({
    install: () => Effect.succeed({...installation, resumed: false, sourceUrl: 'fixture://embedding'}),
    path: () => installation.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installation),
    verify: () => Effect.succeed(installation),
  });
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
    embedMany: ({inputs, manifest}) =>
      Effect.succeed(inputs.map(() => [1, ...new Array<number>((manifest.dimensions ?? 1) - 1).fill(0)])),
    generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
    rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
  });
  const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(
      Effect.provideService(SystemInfo, testSystem),
      Effect.provideService(LocalModelStore, store),
      Effect.provideService(LocalModelRuntime, runtime),
    );
  return {config, fs, home, instruction, installRoot, path, pointer, provide, registry, registryContent};
});

describe('development installer repair isolation', () => {
  effectIt.effect('repairs core indexes while preserving unmanaged host instructions and integration receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const instruction = yield* f.fs.readFileString(f.instruction);
        const result = yield* f.provide(captureConsole(runDevelopmentInstallRepair(f.config, version)));
        expect(result.output).toContain('Rebuilt recall indexes for 0 document(s)');
        expect(yield* f.fs.readFileString(f.instruction)).toBe(instruction);
        expect(yield* f.fs.readFileString(f.registry)).toBe(f.registryContent);
        expect(yield* f.fs.readFileString(f.path.join(f.installRoot, 'active-release.json'))).toBe(f.pointer);
        const explicitRepair = yield* f
          .provide(
            runRepair(f.config, {
              mcp: 'none',
              postUpdate: false,
              skipReleaseLifecycle: true,
            }),
          )
          .pipe(Effect.flip);
        expect(explicitRepair).toMatchObject({message: expect.stringContaining('is not managed by Threadnote')});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('still fails when required graph maintenance cannot inspect its derived root', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const repositories = f.path.join(f.home, 'indexes', 'code-graph', 'repositories');
        yield* f.fs.makeDirectory(f.path.dirname(repositories), {recursive: true});
        yield* f.fs.writeFileString(repositories, 'not a directory');
        const error = yield* f.provide(runDevelopmentInstallRepair(f.config, version)).pipe(Effect.flip);
        expect(error).toMatchObject({message: expect.stringContaining('Native code graph repair failed')});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a changed active version before repair', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const error = yield* f.provide(runDevelopmentInstallRepair(f.config, '4.6.7')).pipe(Effect.flip);
        expect(error).toMatchObject({message: 'The active release changed during development installer repair.'});
        expect(yield* f.fs.exists(f.path.join(f.home, 'indexes'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
