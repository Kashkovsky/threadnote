import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '../helpers/node-fs.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  enrichRecallQueryWithWorkspaceContext,
  enrichRecallQueryWithWorkspaceProjectContext,
  recallQueryRequestsBranchContext,
  resolveWorkspaceBranch,
  resolveWorkspaceComponentContext,
  runCommand,
} from '../../src/utils.js';

describe('nested workspace recall enrichment', () => {
  effectIt.effect(
    'adds package identity only for explicit workspace language without changing repository inference context',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = mkdtempSync(join(tmpdir(), 'threadnote-monorepo-recall-'));
        const packageRoot = join(root, 'packages', 'search-service');
        const nestedCwd = join(packageRoot, 'src', 'handlers');
        mkdirSync(nestedCwd, {recursive: true});
        writeFileSync(join(root, 'package.json'), '{"name":"monorepo","private":true}\n');
        writeFileSync(join(packageRoot, 'package.json'), '{"name":"@acme/search-service"}\n');
        yield* runCommand('git', ['init'], {cwd: root});
        yield* runCommand('git', ['remote', 'add', 'origin', 'git@github.com:acme/platform.git'], {cwd: root});
        yield* runCommand('git', ['symbolic-ref', 'HEAD', 'refs/heads/search-ranking'], {cwd: root});

        const implicit = yield* enrichRecallQueryWithWorkspaceContext('latest handoff', {
          cwd: nestedCwd,
          includeProcessCwd: false,
        });
        const explicit = yield* enrichRecallQueryWithWorkspaceContext('current package latest handoff', {
          cwd: nestedCwd,
          includeProcessCwd: false,
        });
        const projectQuery = yield* enrichRecallQueryWithWorkspaceProjectContext('current package latest handoff', {
          cwd: nestedCwd,
          includeProcessCwd: false,
        });
        const rootQuery = yield* enrichRecallQueryWithWorkspaceContext('latest handoff', {
          cwd: root,
          includeProcessCwd: false,
        });
        const component = yield* resolveWorkspaceComponentContext({cwd: nestedCwd, includeProcessCwd: false});
        const branch = yield* resolveWorkspaceBranch({cwd: nestedCwd, includeProcessCwd: false});

        expect(implicit).toBe('latest handoff');
        expect(explicit).toContain('search-ranking');
        expect(projectQuery).toContain('platform');
        expect(projectQuery).not.toContain('search-service');
        expect(rootQuery).toBe('latest handoff');
        expect(component).toMatchObject({scope: 'packages/search-service'});
        expect(branch).toBe('search-ranking');
        expect(recallQueryRequestsBranchContext('current branch latest handoff')).toBe(true);
        expect(recallQueryRequestsBranchContext('latest handoff')).toBe(false);
      }).pipe(
        Effect.ensuring(Effect.sync(() => (root ? rmSync(root, {force: true, recursive: true}) : undefined))),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    30_000,
  );

  effectIt.effect(
    'recognizes Go, Bazel, and .NET package markers below the repository root',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = mkdtempSync(join(tmpdir(), 'threadnote-polyglot-recall-'));
        const goRoot = join(root, 'services', 'gateway');
        const bazelRoot = join(root, 'libraries', 'routing');
        const dotnetRoot = join(root, 'apps', 'console');
        for (const directory of [goRoot, bazelRoot, dotnetRoot]) mkdirSync(join(directory, 'src'), {recursive: true});
        writeFileSync(join(root, 'package.json'), '{"name":"polyglot-root","private":true}\n');
        writeFileSync(join(goRoot, 'go.mod'), 'module example.com/gateway\n');
        writeFileSync(join(bazelRoot, 'BUILD.bazel'), 'filegroup(name = "routing")\n');
        writeFileSync(join(dotnetRoot, 'Console.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
        yield* runCommand('git', ['init'], {cwd: root});

        const [goComponent, bazelComponent, dotnetComponent] = yield* Effect.all([
          resolveWorkspaceComponentContext({cwd: join(goRoot, 'src'), includeProcessCwd: false}),
          resolveWorkspaceComponentContext({cwd: join(bazelRoot, 'src'), includeProcessCwd: false}),
          resolveWorkspaceComponentContext({cwd: join(dotnetRoot, 'src'), includeProcessCwd: false}),
        ]);

        expect(goComponent?.scope).toBe('services/gateway');
        expect(bazelComponent?.scope).toBe('libraries/routing');
        expect(dotnetComponent).toMatchObject({scope: 'apps/console', terms: expect.arrayContaining(['Console'])});
      }).pipe(
        Effect.ensuring(Effect.sync(() => (root ? rmSync(root, {force: true, recursive: true}) : undefined))),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    30_000,
  );
});
