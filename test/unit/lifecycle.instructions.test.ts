import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {captureConsole} from '../../src/effect/console.js';
import {LocalModelRuntime} from '../../src/effect/ai/local-model-runtime.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runInstall, userAgentInstructionsChecks} from '../../src/lifecycle.js';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '../../src/models/builtin.js';
import {LocalModelStore, type LocalModelStoreShape} from '../../src/models/store.js';
import type {RuntimeConfig} from '../../src/types.js';

const embeddingManifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === CORE_EMBEDDING_MODEL_ID)!;

describe('agent instruction lifecycle', () => {
  it.effect('install and repair paths upsert managed instructions and report every target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-instructions-'});
        const userHome = path.join(root, 'user');
        const threadnoteHome = path.join(userHome, '.threadnote');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: threadnoteHome,
          agentId: 'threadnote',
          manifestPath: path.join(threadnoteHome, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const testSystem = SystemInfo.of({...system, homeDirectory: userHome});
        const modelPath = path.join(threadnoteHome, 'models', 'embedding', embeddingManifest.id, 'fixture.gguf');
        const installation = {
          bytes: embeddingManifest.size,
          installed: true,
          modelId: embeddingManifest.id,
          partialBytes: 0,
          path: modelPath,
          verified: true,
        };
        const modelStore = LocalModelStore.of({
          install: () => Effect.succeed({...installation, resumed: false, sourceUrl: 'fixture://embedding'}),
          path: () => modelPath,
          remove: () => Effect.succeed(false),
          status: () => Effect.succeed(installation),
          verify: () => Effect.succeed(installation),
        } satisfies LocalModelStoreShape);
        const modelRuntime = LocalModelRuntime.of({
          embedMany: ({inputs, manifest}) =>
            Effect.succeed(inputs.map(() => [1, ...new Array<number>((manifest.dimensions ?? 1) - 1).fill(0)])),
          generate: () => Effect.die(new Error('Unexpected generation')),
          rerank: () => Effect.die(new Error('Unexpected reranking')),
        });
        const installed = yield* captureConsole(runInstall(config, {printNextSteps: false, start: false})).pipe(
          Effect.provideService(SystemInfo, testSystem),
          Effect.provideService(LocalModelStore, modelStore),
          Effect.provideService(LocalModelRuntime, modelRuntime),
        );

        expect(installed.output).toContain(`Wrote agent instructions: ${path.join(userHome, '.codex', 'AGENTS.md')}`);
        expect(yield* fs.readFileString(path.join(userHome, '.codex', 'AGENTS.md'))).toContain(
          '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
        );
        const generatedInstructions = yield* Effect.all([
          fs.readFileString(path.join(userHome, '.codex', 'AGENTS.md')),
          fs.readFileString(path.join(userHome, '.claude', 'CLAUDE.md')),
          fs.readFileString(path.join(userHome, '.cursor', 'rules', 'threadnote.md')),
          fs.readFileString(path.join(userHome, '.copilot', 'instructions', 'threadnote.instructions.md')),
        ]);
        expect(generatedInstructions[1]).toContain('<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->');
        expect(generatedInstructions[2]).toContain('threadnote://');
        expect(generatedInstructions[3]).toContain('applyTo: "**"');
        expect(
          generatedInstructions.every(content =>
            /offer to open a GitHub issue in `Kashkovsky\/threadnote` without sensitive\s+information/.test(content),
          ),
        ).toBe(true);

        const checks = yield* userAgentInstructionsChecks().pipe(Effect.provideService(SystemInfo, testSystem));
        expect(checks).toHaveLength(4);
        expect(checks.every(check => check.status === 'ok')).toBe(true);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
