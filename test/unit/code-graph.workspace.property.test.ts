import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import type {
  CodeGraphWorkspace,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceProject,
} from '../../src/code_graph/languages/types.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '../../src/code_graph/types.js';
import {
  createWorkspaceAttributor,
  discoverManifestWorkspace,
  mergeCodeGraphWorkspaces,
} from '../../src/code_graph/workspace.js';

const files = [
  workspaceFile(
    'settings.gradle.kts',
    `
      rootProject.name = "platform"
      include(":libs:shared", ":apps:app")
      project(":libs:shared").projectDir = file("libs/shared")
      project(":apps:app").projectDir = file("apps/app")
    `,
  ),
  workspaceFile('build.gradle.kts', 'plugins { kotlin("jvm") version "2.0.0" }'),
  workspaceFile('libs/shared/build.gradle.kts', 'plugins { kotlin("jvm") }'),
  workspaceFile('libs/shared/src/main/kotlin/Shared.kt', 'class Shared', 'kotlin'),
  workspaceFile('apps/app/settings.gradle.kts', 'rootProject.name = "nested-app"\ninclude(":feature")'),
  workspaceFile(
    'apps/app/build.gradle.kts',
    'plugins { kotlin("jvm") }\ndependencies { implementation(project(":libs:shared")) }',
  ),
  workspaceFile('apps/app/src/main/kotlin/App.kt', 'class App', 'kotlin'),
  workspaceFile('apps/app/feature/build.gradle.kts', 'plugins { kotlin("jvm") }'),
  workspaceFile('apps/app/feature/src/main/kotlin/Feature.kt', 'class Feature', 'kotlin'),
  workspaceFile(
    'services/orders/pom.xml',
    '<project><groupId>dev.threadnote</groupId><artifactId>orders</artifactId><modules><module>api</module></modules></project>',
    'xml',
  ),
  workspaceFile(
    'services/orders/api/pom.xml',
    '<project><parent><groupId>dev.threadnote</groupId><artifactId>orders</artifactId></parent><artifactId>api</artifactId></project>',
    'xml',
  ),
  workspaceFile('services/orders/api/src/main/java/dev/threadnote/Api.java', 'class Api {}', 'java'),
  workspaceFile(
    'ios/Package.swift',
    'let package = Package(name: "Mobile", targets: [.target(name: "MobileCore"), .testTarget(name: "MobileCoreTests", dependencies: ["MobileCore"])])',
    'swift',
  ),
  workspaceFile('ios/Sources/MobileCore/Client.swift', 'struct Client {}', 'swift'),
  workspaceFile('ios/Tests/MobileCoreTests/ClientTests.swift', 'struct ClientTests {}', 'swift'),
] as const;

const permutedFiles = FC.array(FC.integer({max: 10_000, min: -10_000}), {
  maxLength: files.length,
  minLength: files.length,
}).map(priorities =>
  files
    .map((file, index) => ({file, index, priority: priorities[index]}))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(item => item.file),
);

const shortText = FC.array(FC.constantFrom('a', 'Z', '0', '-', '_', 'é', '漢', '🙂'), {
  maxLength: 8,
  minLength: 1,
}).map(characters => characters.join(''));

const dependencyArbitrary = FC.record({
  evidence: FC.oneof(FC.constant(undefined), shortText),
  provenance: FC.constantFrom<'declared' | 'inferred'>('declared', 'inferred'),
  targetId: FC.constantFrom('cgp_shared', 'cgp_a', 'cgp_b'),
}).map(
  value =>
    ({
      ...(value.evidence === undefined ? {} : {evidence: value.evidence}),
      provenance: value.provenance,
      targetId: value.targetId,
    }) satisfies CodeGraphWorkspaceDependency,
);

const sharedProjectArbitrary = FC.record({
  buildSystem: FC.constantFrom<CodeGraphWorkspaceProject['buildSystem']>(
    'gradle',
    'inferred',
    'maven',
    'node',
    'nx',
    'pnpm',
    'swiftpm',
    'typescript',
    'xcode',
  ),
  dependencies: FC.array(FC.constantFrom('cgp_shared', 'cgp_a', 'cgp_b'), {maxLength: 5}),
  dependencyDetails: FC.array(dependencyArbitrary, {maxLength: 5}),
  diagnostics: FC.array(shortText, {maxLength: 4}),
  kind: FC.constantFrom<CodeGraphWorkspaceProject['kind']>('module', 'package', 'project', 'target'),
  languages: FC.array(FC.constantFrom('java', 'kotlin', 'swift'), {maxLength: 5}),
  name: shortText,
  provenance: FC.constantFrom<CodeGraphWorkspaceProject['provenance']>('declared', 'inferred'),
  sourceRoots: FC.array(FC.constantFrom('apps/shared/src', 'apps/shared/Sources', 'apps/shared'), {maxLength: 5}),
  workspaceId: FC.constantFrom('cgw_gradle', 'cgw_maven', 'cgw_swift', 'cgw_xcode'),
  workspaceRoots: FC.array(FC.constantFrom('apps', 'apps/shared'), {maxLength: 4}),
}).map(
  value =>
    ({
      ...value,
      id: 'cgp_shared',
      resolutionDomain: 'shared-domain',
      root: 'apps/shared',
    }) satisfies CodeGraphWorkspaceProject,
);

const workspaceFragmentArbitrary = FC.record({
  diagnostics: FC.array(shortText, {maxLength: 4}),
  fingerprint: shortText,
  project: sharedProjectArbitrary,
}).map(
  ({diagnostics, fingerprint, project}) =>
    ({diagnostics, fingerprint, projects: [project], workspaces: []}) satisfies CodeGraphWorkspace,
);

describe('code graph workspace properties', () => {
  it.prop(
    'discovers identical nested and integrated workspace models regardless of inventory order',
    {permuted: permutedFiles},
    ({permuted}) => {
      expect(discoverManifestWorkspace(permuted)).toEqual(discoverManifestWorkspace(files));
    },
    {fastCheck: {numRuns: 150}},
  );

  it('uses the declared project name for a repository-root workspace', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'package.json',
        JSON.stringify({name: 'threadnote-root', private: true, workspaces: ['packages/*']}),
        'npm-manifest',
      ),
    ]);

    expect(workspace.workspaces).toContainEqual(expect.objectContaining({name: 'threadnote-root', root: ''}));
  });

  it.prop(
    'never derives an empty repository-root workspace name from a non-empty declared project name',
    {name: shortText},
    ({name}) => {
      const workspace = discoverManifestWorkspace([
        workspaceFile(
          'package.json',
          JSON.stringify({name, private: true, workspaces: ['packages/*']}),
          'npm-manifest',
        ),
      ]);

      const rootProject = workspace.projects.find(project => project.root === '');
      const rootWorkspace = workspace.workspaces.find(candidate => candidate.root === '');
      expect(rootProject).toBeDefined();
      expect(rootWorkspace).toBeDefined();
      expect(rootProject!.name).not.toBe('');
      expect(rootWorkspace!.name).toBe(rootProject!.name);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('discovers npm, Bun, pnpm, and TypeScript-reference package hierarchy without hiding nested polyglot workspaces', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'package.json',
        JSON.stringify({
          name: 'threadnote-root',
          packageManager: 'bun@1.3.0',
          workspaces: ['packages/*', 'apps/*'],
        }),
        'npm-manifest',
      ),
      workspaceFile('pnpm-workspace.yaml', "packages:\n  - 'tools/*'\n", 'pnpm-workspace'),
      workspaceFile(
        'tsconfig.json',
        `{
          // TypeScript project references are JSONC in real monorepos.
          "references": [
            {"path": "./packages/core",},
            {"path": "./apps/web",},
          ],
        }`,
        'typescript-config',
      ),
      workspaceFile('src/index.ts', 'export const root = true', 'typescript'),
      workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
      workspaceFile('packages/core/src/index.ts', 'export const core = true', 'typescript'),
      workspaceFile(
        'apps/web/package.json',
        JSON.stringify({dependencies: {'@acme/core': 'workspace:*'}, name: '@acme/web'}),
        'npm-manifest',
      ),
      workspaceFile('apps/web/src/index.ts', 'export const web = true', 'typescript'),
      workspaceFile('tools/release/package.json', JSON.stringify({name: '@acme/release'}), 'npm-manifest'),
      workspaceFile('tools/release/src/index.ts', 'export const release = true', 'typescript'),
      workspaceFile('apps/web/settings.gradle.kts', 'rootProject.name = "mobile"'),
      workspaceFile('apps/web/src/main/kotlin/App.kt', 'class App', 'kotlin'),
    ]);
    const packageProjects = workspace.projects.filter(
      project => project.kind === 'package' && (project.buildSystem === 'node' || project.buildSystem === 'pnpm'),
    );
    const root = packageProjects.find(project => project.root === '')!;
    const core = packageProjects.find(project => project.root === 'packages/core')!;
    const web = packageProjects.find(project => project.root === 'apps/web')!;
    const release = packageProjects.find(project => project.root === 'tools/release')!;

    expect(packageProjects.map(project => project.name)).toEqual([
      'threadnote-root',
      '@acme/web',
      '@acme/core',
      '@acme/release',
    ]);
    expect([root.buildSystem, core.buildSystem, web.buildSystem, release.buildSystem]).toEqual([
      'pnpm',
      'node',
      'node',
      'pnpm',
    ]);
    expect(root.workspaceId).toBe(release.workspaceId);
    expect(core.workspaceId).toBe(web.workspaceId);
    expect(root.workspaceId).not.toBe(core.workspaceId);
    expect(root.dependencies).toEqual(expect.arrayContaining([core.id, web.id]));
    expect(web.dependencies).toContain(core.id);
    expect(workspace.projects).toContainEqual(expect.objectContaining({buildSystem: 'gradle', root: 'apps/web'}));

    const attributed = createWorkspaceAttributor(workspace)([
      facts('package.json', [
        {
          ...workspaceSymbol('root-package', 'package.json', 'threadnote-root', 'workspace', 'npm-manifest'),
          kind: 'package',
        },
      ]),
      facts('apps/web/package.json', [
        {
          ...workspaceSymbol('web-package', 'apps/web/package.json', '@acme/web', 'workspace', 'npm-manifest'),
          kind: 'package',
        },
      ]),
      facts('src/index.ts', [workspaceSymbol('root-ts', 'src/index.ts', 'root', 'typescript', 'typescript')]),
      facts('apps/web/src/index.ts', [
        workspaceSymbol('web-ts', 'apps/web/src/index.ts', 'web', 'typescript', 'typescript'),
      ]),
      facts('apps/web/src/main/kotlin/App.kt', [
        workspaceSymbol('web-jvm', 'apps/web/src/main/kotlin/App.kt', 'App', 'jvm', 'kotlin'),
      ]),
    ]);
    const attributedSymbols = attributed.flatMap(file => file.symbols);
    expect(attributedSymbols.find(symbol => symbol.id === 'root-package')?.packageName).toBe('threadnote-root');
    expect(attributedSymbols.find(symbol => symbol.id === 'web-package')?.packageName).toBe('@acme/web');
    expect(attributedSymbols.find(symbol => symbol.id === 'root-ts')?.resolutionScopeId).toBe(root.id);
    expect(attributedSymbols.find(symbol => symbol.id === 'web-ts')?.resolutionScopeId).toBe(web.id);
    expect(attributedSymbols.find(symbol => symbol.id === 'web-jvm')?.resolutionScopeId).toBe(
      workspace.projects.find(project => project.buildSystem === 'gradle' && project.root === 'apps/web')?.id,
    );
  });

  it('uses a pnpm workspace without a root package and never lets a later positive override an exclusion', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'pnpm-workspace.yaml',
        "packages:\n  - 'packages/*'\n  - '!packages/private-*'\n  - 'packages/private-tools'\n",
        'pnpm-workspace',
      ),
      workspaceFile('packages/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
      workspaceFile('packages/core/src/index.ts', 'export const core = true', 'typescript'),
      workspaceFile(
        'packages/private-tools/package.json',
        JSON.stringify({name: '@acme/private-tools'}),
        'npm-manifest',
      ),
      workspaceFile('packages/private-tools/src/index.ts', 'export const internal = true', 'typescript'),
    ]);
    const core = workspace.projects.find(project => project.name === '@acme/core')!;
    const privateTools = workspace.projects.find(project => project.name === '@acme/private-tools')!;

    expect(core.workspaceRoots).toEqual(['']);
    expect(privateTools.workspaceRoots).toEqual(['packages/private-tools']);
    expect(core.workspaceId).not.toBe(privateTools.workspaceId);
  });

  it.prop(
    'reports ambiguous local dependency aliases independently of inventory order instead of silently dropping them',
    {priorities: FC.array(FC.integer(), {maxLength: 7, minLength: 7})},
    ({priorities}) => {
      const ambiguous = [
        workspaceFile(
          'package.json',
          JSON.stringify({name: 'root', private: true, workspaces: ['packages/*']}),
          'npm-manifest',
        ),
        workspaceFile('packages/first/package.json', JSON.stringify({name: '@acme/shared'}), 'npm-manifest'),
        workspaceFile('packages/first/index.ts', 'export const first = true', 'typescript'),
        workspaceFile('packages/second/package.json', JSON.stringify({name: '@acme/shared'}), 'npm-manifest'),
        workspaceFile('packages/second/index.ts', 'export const second = true', 'typescript'),
        workspaceFile(
          'packages/app/package.json',
          JSON.stringify({dependencies: {'@acme/shared': 'workspace:*'}, name: '@acme/app'}),
          'npm-manifest',
        ),
        workspaceFile('packages/app/index.ts', 'export const app = true', 'typescript'),
      ];
      const forward = discoverManifestWorkspace(ambiguous);
      const permuted = discoverManifestWorkspace(
        ambiguous
          .map((file, index) => ({file, index, priority: priorities[index]}))
          .sort((left, right) => left.priority - right.priority || left.index - right.index)
          .map(value => value.file),
      );

      expect(permuted).toEqual(forward);
      expect(forward.diagnostics).toContain(
        'packages/app/package.json: local dependency alias @acme/shared matched multiple declared projects',
      );
      expect(forward.projects.find(project => project.name === '@acme/app')?.dependencies).toEqual([]);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'persists stable typed Nx projects, targets, pnpm packages, and tsconfig references regardless of inventory order',
    {priorities: FC.array(FC.integer(), {maxLength: 13, minLength: 13})},
    ({priorities}) => {
      const nxFiles = [
        workspaceFile('nx.json', JSON.stringify({targetDefaults: {build: {dependsOn: ['^build']}}}), 'json'),
        workspaceFile('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n", 'pnpm-workspace'),
        workspaceFile('package.json', JSON.stringify({name: 'root', private: true}), 'npm-manifest'),
        workspaceFile('apps/core/package.json', JSON.stringify({name: '@acme/core'}), 'npm-manifest'),
        workspaceFile(
          'apps/core/project.json',
          JSON.stringify({name: 'core', sourceRoot: 'apps/core/src', targets: {build: {executor: '@nx/js:tsc'}}}),
          'json',
        ),
        workspaceFile('apps/core/tsconfig.json', JSON.stringify({include: ['src/**/*.ts']}), 'typescript-config'),
        workspaceFile('apps/core/src/index.ts', 'export const core = true', 'typescript'),
        workspaceFile('apps/web/package.json', JSON.stringify({name: '@acme/web'}), 'npm-manifest'),
        workspaceFile(
          'apps/web/project.json',
          JSON.stringify({
            implicitDependencies: ['core'],
            name: 'web',
            sourceRoot: 'apps/web/src',
            targets: {build: {dependsOn: ['^build']}, test: {dependsOn: ['build']}},
          }),
          'json',
        ),
        workspaceFile(
          'apps/web/tsconfig.json',
          JSON.stringify({include: ['src/**/*.ts'], references: [{path: '../core'}]}),
          'typescript-config',
        ),
        workspaceFile('apps/web/src/index.ts', 'export const web = true', 'typescript'),
        workspaceFile('README.md', '# workspace', 'markdown'),
        workspaceFile('docs/architecture.md', '# architecture', 'markdown'),
      ];
      const workspace = discoverManifestWorkspace(nxFiles);
      const permuted = discoverManifestWorkspace(
        nxFiles
          .map((file, index) => ({file, index, priority: priorities[index]}))
          .sort((left, right) => left.priority - right.priority || left.index - right.index)
          .map(value => value.file),
      );
      const nxProject = (name: string) =>
        workspace.projects.find(
          project => project.buildSystem === 'nx' && project.kind === 'project' && project.name === name,
        )!;
      const nxTarget = (name: string) =>
        workspace.projects.find(
          project => project.buildSystem === 'nx' && project.kind === 'target' && project.name === name,
        )!;
      const core = nxProject('core');
      const web = nxProject('web');
      const coreBuild = nxTarget('core:build');
      const webBuild = nxTarget('web:build');
      const webTest = nxTarget('web:test');
      const coreConfig = workspace.projects.find(
        project => project.buildSystem === 'typescript' && project.root === 'apps/core',
      )!;
      const webConfig = workspace.projects.find(
        project => project.buildSystem === 'typescript' && project.root === 'apps/web',
      )!;

      expect(permuted).toEqual(workspace);
      expect(core.sourceRoots).toEqual(['apps/core/src']);
      expect(web.workspaceId).toBe(core.workspaceId);
      expect(web.dependencies).toContain(core.id);
      expect(webBuild.dependencies).toEqual(expect.arrayContaining([web.id, coreBuild.id]));
      expect(webTest.dependencies).toEqual(expect.arrayContaining([web.id, webBuild.id]));
      expect(webConfig.dependencies).toContain(coreConfig.id);
      expect(workspace.projects.filter(project => project.buildSystem === 'pnpm').map(project => project.name)).toEqual(
        ['root', '@acme/core', '@acme/web'],
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps standalone Nx project boundaries as typed components instead of diagnostic-only records', () => {
    const workspace = discoverManifestWorkspace([
      workspaceFile(
        'package.json',
        JSON.stringify({name: 'root', private: true, workspaces: ['apps/*']}),
        'npm-manifest',
      ),
      workspaceFile('apps/web/project.json', JSON.stringify({name: 'web'}), 'json'),
      workspaceFile('apps/web/package.json', JSON.stringify({name: '@acme/web'}), 'npm-manifest'),
      workspaceFile('apps/web/index.ts', 'export const web = true', 'typescript'),
      workspaceFile('orphan/project.json', JSON.stringify({name: 'orphan'}), 'json'),
      workspaceFile('orphan/index.ts', 'export const orphan = true', 'typescript'),
    ]);

    expect(workspace.projects).toContainEqual(
      expect.objectContaining({buildSystem: 'nx', kind: 'project', name: 'web', root: 'apps/web'}),
    );
    expect(workspace.projects).toContainEqual(
      expect.objectContaining({buildSystem: 'nx', kind: 'project', name: 'orphan', root: 'orphan'}),
    );
    expect(workspace.diagnostics).not.toContainEqual(expect.stringContaining('not reconciled'));
  });

  it.prop(
    'merges duplicate detector projects commutatively, associatively, and idempotently',
    {fragments: FC.array(workspaceFragmentArbitrary, {maxLength: 8, minLength: 2})},
    ({fragments}) => {
      const expected = mergeCodeGraphWorkspaces(fragments);
      const midpoint = Math.floor(fragments.length / 2);
      const regrouped = mergeCodeGraphWorkspaces([
        mergeCodeGraphWorkspaces(fragments.slice(0, midpoint)),
        mergeCodeGraphWorkspaces(fragments.slice(midpoint)),
      ]);

      expect(mergeCodeGraphWorkspaces([...fragments].reverse())).toEqual(expected);
      expect(regrouped).toEqual(expected);
      expect(mergeCodeGraphWorkspaces([...fragments, ...fragments])).toEqual(expected);
      expect(mergeCodeGraphWorkspaces([expected])).toEqual(expected);
    },
    {fastCheck: {numRuns: 250}},
  );
});

function workspaceFile(path: string, content: string, language = 'text'): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}`,
    language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}

function facts(path: string, symbols: readonly CodeGraphSymbol[]): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, symbols};
}

function workspaceSymbol(
  id: string,
  path: string,
  name: string,
  resolutionDomain: string,
  language: string,
): CodeGraphSymbol {
  return {
    contentHash: `hash:${path}`,
    exported: true,
    id,
    kind: 'function',
    language,
    lookupKeys: [`${resolutionDomain}:path:${path}:name:${name}`],
    name,
    path,
    qualifiedName: name,
    resolutionDomain,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
}
