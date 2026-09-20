import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {fcProp} from '../helpers/fast-check-property.js';
import {
  CodeGraphIndexScopeResolutionError,
  CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
  forwardDependencyClosure,
  previewCodeGraphIndexScope,
  resolveCodeGraphIndexScope,
  type CodeGraphWorkspaceCatalog,
} from '../../src/code_graph/index_scope.js';
import type {CodeGraphWorkspaceProject} from '../../src/code_graph/languages/types.js';

const project = (id: string, root: string, dependencies: readonly string[] = []) =>
  ({
    buildSystem: 'typescript',
    dependencies,
    dependencyDetails: dependencies.map(targetId => ({
      evidence: `${root}/tsconfig.json`,
      provenance: 'declared' as const,
      targetId,
    })),
    diagnostics: [],
    id,
    kind: 'project',
    languages: ['typescript'],
    name: id,
    provenance: 'declared',
    resolutionDomain: 'typescript',
    root,
    sourceRoots: [`${root}/src`],
    workspaceId: 'workspace',
    workspaceRoots: [''],
  }) satisfies CodeGraphWorkspaceProject;

const catalog = (projects: readonly CodeGraphWorkspaceProject[]): CodeGraphWorkspaceCatalog => ({
  fingerprint: 'catalog',
  resolutionContextPaths: ['tsconfig.json', ...projects.map(value => `${value.root}/tsconfig.json`)],
  workspace: {diagnostics: [], fingerprint: 'workspace', projects, workspaces: []},
});

describe('code graph index scope', () => {
  it('retains every component at a configured root and only follows forward dependencies', () => {
    const appNode = project('app-node', 'apps/web', ['core']);
    const appTypeScript = project('app-typescript', 'apps/web', ['core']);
    const core = project('core', 'packages/core');
    const reverseDependent = project('reverse-dependent', 'apps/other', ['app-node']);
    const scope = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/web']}, uri: 'threadnote://resources/repos/web'},
      catalog([reverseDependent, appTypeScript, core, appNode]),
    );

    expect(scope.rootProjectIds).toEqual(['app-node', 'app-typescript']);
    expect(scope.includedProjectIds).toEqual(['app-node', 'app-typescript', 'core']);
    expect(scope.admittedPrefixes).toEqual(['apps/web', 'apps/web/src', 'packages/core', 'packages/core/src']);
    expect(scope.controlPaths).toEqual(['apps/web/tsconfig.json', 'packages/core/tsconfig.json', 'tsconfig.json']);
  });

  it('keeps scope identity stable across configured root order and emits a preview model', () => {
    const workspace = catalog([project('app', 'apps/app', ['core']), project('core', 'packages/core')]);
    const first = previewCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app', 'packages/core']}, uri: 'threadnote://resources/repos/app'},
      workspace,
    );
    const second = previewCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['packages/core', 'apps/app']}, uri: 'threadnote://resources/repos/app'},
      workspace,
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({type: 'code-graph-index-scope-preview', version: 1});
  });

  it('uses the canonical full-repository identity independent of project URI', () => {
    const workspace = catalog([project('app', 'apps/app')]);
    expect(resolveCodeGraphIndexScope({uri: 'threadnote://resources/repos/one'}, workspace).scopeKey).toBe(
      CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    );
    expect(resolveCodeGraphIndexScope({uri: 'threadnote://resources/repos/two'}, workspace).scopeKey).toBe(
      CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    );
  });

  it('fails unresolved roots with bounded candidates and marks incomplete evidence partial', () => {
    const incomplete = {...project('app', 'apps/app'), provenance: 'inferred' as const};
    const workspace = catalog([incomplete, project('core', 'packages/core')]);
    expect(
      resolveCodeGraphIndexScope({graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'x'}, workspace),
    ).toMatchObject({
      completeness: 'partial',
    });
    expect(() =>
      resolveCodeGraphIndexScope({graph: {closure: 'dependencies', roots: ['missing']}, uri: 'x'}, workspace),
    ).toThrow(CodeGraphIndexScopeResolutionError);
  });

  it('binds effective control paths and completeness evidence into the closure digest', () => {
    const app = project('app', 'apps/app');
    const complete = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      catalog([app]),
    );
    const changedControls = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {...catalog([app]), resolutionContextPaths: ['apps/app/alternate.config']},
    );
    const partial = resolveCodeGraphIndexScope(
      {graph: {closure: 'dependencies', roots: ['apps/app']}, uri: 'threadnote://resources/repos/app'},
      {...catalog([app]), workspace: {...catalog([app]).workspace, diagnostics: ['detector incomplete']}},
    );

    expect(complete.completeness).toBe('complete');
    expect(partial.completeness).toBe('partial');
    expect(changedControls.closureDigest).not.toBe(complete.closureDigest);
    expect(partial.closureDigest).not.toBe(complete.closureDigest);
  });

  fcProp(
    it,
    'matches only path boundaries and leaves unreachable additions outside the forward closure',
    {suffix: FC.stringMatching(/^[a-z]{1,8}$/)},
    ({suffix}) => {
      const root = `apps/${suffix}`;
      const adjacent = `${root}bar`;
      const selected = project('selected', root, ['dependency']);
      const dependency = project('dependency', `packages/${suffix}`);
      const unreachable = project('unreachable', adjacent);
      const scope = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: [root]}, uri: 'threadnote://resources/repos/property'},
        catalog([selected, dependency, unreachable]),
      );
      expect(scope.includedProjectIds).toEqual(['selected', 'dependency']);
      expect(forwardDependencyClosure([selected], [unreachable, dependency, selected]).map(value => value.id)).toEqual([
        'selected',
        'dependency',
      ]);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'normalizes root order and duplicate inputs without changing scope identity',
    {reverse: FC.boolean(), repeat: FC.boolean()},
    ({reverse, repeat}) => {
      const workspace = catalog([project('app', 'apps/app', ['core']), project('core', 'packages/core')]);
      const roots = reverse ? ['packages/core', 'apps/app'] : ['apps/app', 'packages/core'];
      const scoped = resolveCodeGraphIndexScope(
        {
          graph: {closure: 'dependencies', roots: repeat ? [...roots, roots[0]] : roots},
          uri: 'threadnote://resources/repos/property',
        },
        workspace,
      );
      const canonical = resolveCodeGraphIndexScope(
        {
          graph: {closure: 'dependencies', roots: ['apps/app', 'packages/core']},
          uri: 'threadnote://resources/repos/property',
        },
        workspace,
      );
      expect(scoped).toEqual(canonical);
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    it,
    'expands monotonically for added forward dependencies while excluding reverse dependents',
    {suffix: FC.stringMatching(/^[a-z]{1,8}$/)},
    ({suffix}) => {
      const app = project('app', `apps/${suffix}`, ['core']);
      const core = project('core', `packages/${suffix}/core`);
      const utility = project('utility', `packages/${suffix}/utility`);
      const reverse = project('reverse', `apps/${suffix}-reverse`, ['app']);
      const before = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: [app.root]}, uri: 'threadnote://resources/repos/property'},
        catalog([app, core, utility, reverse]),
      );
      const expandedCore = project('core', core.root, ['utility']);
      const after = resolveCodeGraphIndexScope(
        {graph: {closure: 'dependencies', roots: [app.root]}, uri: 'threadnote://resources/repos/property'},
        catalog([app, expandedCore, utility, reverse]),
      );

      expect(before.includedProjectIds.every(id => after.includedProjectIds.includes(id))).toBe(true);
      expect(after.includedProjectIds).toEqual(['app', 'core', 'utility']);
      expect(after.includedProjectIds).not.toContain('reverse');
    },
    {fastCheck: {numRuns: 60}},
  );
});
