import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Option} from 'effect';
import {describe, expect} from 'vitest';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {TreeSitterRuntime} from '../../src/code_graph/tree_sitter/runtime.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {createWorkspaceAttributor} from '../../src/code_graph/workspace.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('code graph workspace attribution', () => {
  effectIt.effect('attributes extracted Bazel facts to merged Node and Bazel components', () =>
    Effect.gen(function* () {
      const files = [
        workspaceFile('package.json', JSON.stringify({name: '@acme/app'}), 'npm-manifest'),
        workspaceFile('BUILD', 'ts_project(name = "app", deps = ["//packages/core:core"])'),
        workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
        workspaceFile('packages/core/BUILD', 'ts_project(name = "core")'),
      ];
      const workspace = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
      const extracted = yield* Effect.forEach(
        files.filter(file => file.language === 'bazel-build'),
        file =>
          BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file, workspace.projects).pipe(
            provideTestLayer(TreeSitterRuntime.layer),
            provideTestLayer(SystemInfo.layer),
            provideTestLayer(BunServices.layer),
          ),
        {concurrency: 'unbounded'},
      );
      const attributed = createWorkspaceAttributor(workspace)(extracted);
      const app = workspace.projects.find(project => project.root === '')!;
      const core = workspace.projects.find(project => project.root === 'packages/core')!;
      const appFacts = attributed.find(file => file.path === 'BUILD')!;
      const coreFacts = attributed.find(file => file.path === 'packages/core/BUILD')!;

      expect(app).toMatchObject({buildSystem: 'node', resolutionDomain: 'typescript'});
      expect(core).toMatchObject({buildSystem: 'node', resolutionDomain: 'typescript'});
      expect(appFacts.symbols.find(symbol => symbol.qualifiedName === '//:app')).toMatchObject({
        packageName: '@acme/app',
        resolutionScopeId: app.id,
      });
      expect(coreFacts.symbols.find(symbol => symbol.qualifiedName === '//packages/core:core')).toMatchObject({
        packageName: '@acme/core',
        resolutionScopeId: core.id,
      });
      expect(appFacts.references?.flatMap(reference => reference.lookupTiers).flat()).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`bazel:${app.id}:`),
          expect.stringContaining(`bazel:${core.id}:`),
        ]),
      );
    }),
  );
});

function workspaceFile(path: string, content: string, language?: string): CodeGraphInventoryFile {
  const matched = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}:${content.length}`,
    language: language ?? Option.getOrThrow(matched).language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
