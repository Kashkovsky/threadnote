import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {createRepositoryFactResolver} from '../../src/code_graph/extractor.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {TreeSitterRuntime} from '../../src/code_graph/tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {createWorkspaceAttributor} from '../../src/code_graph/workspace.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('Bazel/Starlark code graph language pack', () => {
  it('recognizes Bazel workspace, package, Starlark, and rc files without claiming ordinary Bazel-named files', () => {
    const expected = new Map([
      ['WORKSPACE', 'bazel-workspace'],
      ['nested/WORKSPACE.bazel', 'bazel-workspace'],
      ['MODULE.bazel', 'bazel-module'],
      ['app/BUILD', 'bazel-build'],
      ['app/BUILD.bazel', 'bazel-build'],
      ['tools/defs.bzl', 'starlark'],
      ['.aspect/format.axl', 'starlark'],
      ['config/ci.bazelrc', 'bazelrc'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({_tag: 'Some', value: {language}});
    }
    expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match('src/build.ts')).toMatchObject({
      _tag: 'Some',
      value: {language: 'typescript'},
    });
  });

  it('extracts typed AXL Starlark defs, loads, assignments, and calls like .bzl sources', async () => {
    const facts = await runExtraction(
      bazelFile(
        '.aspect/mycmd.axl',
        [
          'load("//tools:defs.bzl", "helper")',
          '',
          'def impl(ctx: TaskContext) -> int:',
          '    helper()',
          '    return 0',
          '',
          'mycmd = task(',
          '    implementation = impl,',
          '    args = {',
          '        "target_pattern": args.positional(default = ["..."]),',
          '    },',
          ')',
        ].join('\n'),
      ),
      [],
    );

    expect(facts.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['function', '//.aspect:mycmd.axl%impl'],
        ['constant', '//.aspect:mycmd.axl%mycmd'],
      ]),
    );
    expect(facts.edges.map(edge => [edge.relation, edge.targetName])).toEqual(
      expect.arrayContaining([
        ['imports', '//tools:defs.bzl'],
        ['calls', 'helper'],
        ['calls', 'task'],
        ['calls', 'args.positional'],
      ]),
    );
  });

  it('extracts and resolves Starlark loads, calls, targets, local deps, cross-package deps, and external labels', async () => {
    const files = [
      bazelFile('MODULE.bazel', 'module(name = "commerce")'),
      bazelFile('tools/BUILD.bazel', 'exports_files(["defs.bzl"])'),
      bazelFile(
        'tools/defs.bzl',
        `
          def app_rule(name, deps = []):
              native.ts_library(name = name, deps = deps)

          def helper():
              print("ready")
        `,
      ),
      bazelFile('libs/core/BUILD', 'ts_library(name = "core", srcs = ["core.ts"])'),
      bazelFile(
        'apps/api/BUILD.bazel',
        `
          load("//tools:defs.bzl", "app_rule")

          genrule(
              name = "generated",
              outs = ["generated.ts"],
              cmd = "touch $@",
          )

          app_rule(
              name = "api",
              deps = [
                  ":generated",
                  "//libs/core:core",
                  "@rules_ts//ts:toolchain",
              ],
          )
        `,
      ),
    ];
    const workspace = await Effect.runPromise(BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files));
    const extracted = await Promise.all(files.map(file => runExtraction(file, workspace.projects)));
    const attributed = createWorkspaceAttributor(workspace)(extracted);
    const resolved = createRepositoryFactResolver(attributed, files).resolve(attributed);
    const build = resolved.find(file => file.path === 'apps/api/BUILD.bazel')!;
    const definitions = resolved.find(file => file.path === 'tools/defs.bzl')!;
    const core = resolved
      .find(file => file.path === 'libs/core/BUILD')!
      .symbols.find(symbol => symbol.qualifiedName === '//libs/core:core')!;
    const generated = build.symbols.find(symbol => symbol.qualifiedName === '//apps/api:generated')!;
    const appRule = definitions.symbols.find(symbol => symbol.qualifiedName === '//tools:defs.bzl%app_rule')!;
    const api = build.symbols.find(symbol => symbol.qualifiedName === '//apps/api:api')!;

    expect(build.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['target', '//apps/api:generated'],
        ['target', '//apps/api:api'],
      ]),
    );
    expect(definitions.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['function', '//tools:defs.bzl%app_rule'],
        ['function', '//tools:defs.bzl%helper'],
      ]),
    );
    expect(build.edges).toContainEqual(
      expect.objectContaining({relation: 'depends_on', sourceId: api.id, targetId: generated.id}),
    );
    expect(build.edges).toContainEqual(
      expect.objectContaining({relation: 'depends_on', sourceId: api.id, targetId: core.id}),
    );
    expect(build.edges).toContainEqual(
      expect.objectContaining({relation: 'calls', sourceId: api.id, targetId: appRule.id}),
    );
    expect(build.edges).toContainEqual(
      expect.objectContaining({
        provenance: 'declared',
        relation: 'depends_on',
        sourceId: api.id,
        targetName: '@rules_ts//ts:toolchain',
      }),
    );
    expect(
      build.edges.find(
        edge =>
          edge.sourceId === api.id && edge.targetName === '@rules_ts//ts:toolchain' && edge.relation === 'depends_on',
      )?.targetId,
    ).toBeUndefined();
  });

  it('keeps integrated and isolated nested Bazel workspaces visible alongside the outer Node workspace', async () => {
    const files = [
      bazelFile(
        'package.json',
        JSON.stringify({name: '@acme/root', workspaces: ['apps/*', 'packages/*']}),
        'npm-manifest',
      ),
      bazelFile('apps/mobile/package.json', JSON.stringify({name: '@acme/mobile'}), 'npm-manifest'),
      bazelFile('apps/mobile/MODULE.bazel', 'module(name = "mobile")'),
      bazelFile('apps/mobile/BUILD.bazel', 'kt_jvm_library(name = "mobile", srcs = ["src/main/kotlin/App.kt"])'),
      bazelFile('apps/mobile/vendor/tool/MODULE.bazel', 'module(name = "vendor_tool")'),
      bazelFile('apps/mobile/vendor/tool/BUILD', 'java_library(name = "tool", srcs = ["Tool.java"])'),
      bazelFile('packages/shared/BUILD', 'ts_library(name = "shared", srcs = ["index.ts"])'),
    ];
    const workspace = await Effect.runPromise(BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files));
    const mobileNode = workspace.projects.find(
      project => project.root === 'apps/mobile' && project.resolutionDomain === 'typescript',
    )!;
    const mobileBazel = workspace.projects.find(
      project => project.root === 'apps/mobile' && project.resolutionDomain === 'bazel',
    )!;
    const nestedBazel = workspace.projects.find(
      project => project.root === 'apps/mobile/vendor/tool' && project.resolutionDomain === 'bazel',
    )!;
    const integratedBazel = workspace.projects.find(
      project => project.root === 'packages/shared' && project.resolutionDomain === 'bazel',
    )!;

    expect(mobileNode.workspaceRoots).toEqual(['']);
    expect(mobileBazel.workspaceRoots).toEqual(['apps/mobile']);
    expect(nestedBazel.workspaceRoots).toEqual(['apps/mobile/vendor/tool']);
    expect(integratedBazel.workspaceRoots).toEqual(['']);
    expect(new Set([mobileNode.id, mobileBazel.id, nestedBazel.id, integratedBazel.id]).size).toBe(4);
    expect(workspace.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({buildSystem: 'bazel', root: ''}),
        expect.objectContaining({buildSystem: 'bazel', root: 'apps/mobile'}),
        expect.objectContaining({buildSystem: 'bazel', root: 'apps/mobile/vendor/tool'}),
        expect.objectContaining({buildSystem: 'node', root: ''}),
      ]),
    );
  });

  it('indexes .bazelrc configuration inheritance and imports as declared relationships', async () => {
    const facts = await runExtraction(
      bazelFile(
        '.bazelrc',
        `
          import %workspace%/config/common.bazelrc
          build:ci --config=remote --remote_cache=https://cache.invalid
          build:remote --remote_executor=grpc://executor.invalid
        `,
      ),
      [],
    );

    expect(facts.symbols.map(symbol => [symbol.kind, symbol.name])).toEqual(
      expect.arrayContaining([
        ['config', 'build:ci'],
        ['config', 'build:remote'],
      ]),
    );
    expect(facts.edges.map(edge => [edge.relation, edge.targetName])).toEqual(
      expect.arrayContaining([
        ['imports', '%workspace%/config/common.bazelrc'],
        ['configures', 'remote'],
      ]),
    );
  });
});

function runExtraction(
  file: CodeGraphInventoryFile,
  projects: Parameters<typeof BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile>[1],
): Promise<CodeGraphFileFacts> {
  return Effect.runPromise(
    BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file, projects).pipe(
      Effect.provide(TreeSitterRuntime.layer),
      Effect.provide(SystemInfo.layer),
      Effect.provide(BunServices.layer),
    ),
  );
}

function bazelFile(path: string, content: string, language?: string): CodeGraphInventoryFile {
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
