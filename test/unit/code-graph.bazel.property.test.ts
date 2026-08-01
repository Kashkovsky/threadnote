import {describe, expect, it} from '@effect/vitest';
import {Effect, Option} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {extractBazelFacts} from '../../src/code_graph/languages/bazel/extractor.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';

const files = [
  bazelFile('MODULE.bazel', 'module(name = "root")'),
  bazelFile('libs/core/BUILD', 'java_library(name = "core")'),
  bazelFile('libs/ui/BUILD.bazel', 'kt_jvm_library(name = "ui", deps = ["//libs/core:core"])'),
  bazelFile('apps/web/BUILD', 'ts_library(name = "web", deps = ["//libs/ui:ui"])'),
  bazelFile('apps/isolated/MODULE.bazel', 'module(name = "isolated")'),
  bazelFile('apps/isolated/BUILD', 'py_library(name = "isolated", deps = ["//lib:helper"])'),
  bazelFile('apps/isolated/lib/BUILD', 'py_library(name = "helper")'),
  bazelFile('tools/BUILD', 'exports_files(["defs.bzl"])'),
  bazelFile('tools/defs.bzl', 'def project(name, deps = []):\n    native.filegroup(name = name, srcs = deps)'),
  bazelFile('.bazelrc', 'build:ci --config=remote'),
] as const;

const permutedFiles = FC.array(FC.integer({max: 10_000, min: -10_000}), {
  maxLength: files.length,
  minLength: files.length,
}).map(priorities =>
  files
    .map((file, index) => ({file, index, priority: priorities[index]!}))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(item => item.file),
);

describe('Bazel workspace properties', () => {
  it.effect.prop(
    'keeps nested workspace ownership and target dependencies deterministic across inventory permutations',
    {permuted: permutedFiles},
    ({permuted}) =>
      Effect.gen(function* () {
        const expected = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(files);
        const actual = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.discoverWorkspace(permuted);

        expect(actual).toEqual(expected);
        expect(actual.projects.find(project => project.name === '//libs/ui')?.dependencies).toContain(
          actual.projects.find(project => project.name === '//libs/core')?.id,
        );
        expect(actual.projects.find(project => project.name === '//')?.workspaceRoots).toEqual(
          expect.arrayContaining(['apps/isolated']),
        );
      }),
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'recognizes canonical Bazel labels without accepting arbitrary source strings as graph dependencies',
    {
      packagePath: FC.constantFrom('', 'apps/web', 'libs/core/deep'),
      target: FC.stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,20}$/),
    },
    ({packagePath, target}) => {
      const local = `:${target}`;
      const absolute = `//${packagePath}:${target}`;
      const build = bazelFile(
        'BUILD',
        `filegroup(name = "owner", deps = ["${local}", "${absolute}", "plain.txt", "//../escape:target"])`,
      );

      const facts = extractBazelFacts(build, {packageName: Option.none(), project: Option.none()});
      const dependencies = facts.edges.filter(edge => edge.relation === 'depends_on').map(edge => edge.targetName);
      expect(dependencies).toContain(`//:${target}`);
      expect(dependencies).toContain(absolute);
      expect(dependencies).not.toContain('plain.txt');
      expect(dependencies).not.toContain('//../escape:target');
    },
    {fastCheck: {numRuns: 100}},
  );
});

function bazelFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}:${content.length}`,
    language: Option.getOrThrow(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path)).language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
