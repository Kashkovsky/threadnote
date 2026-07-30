import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {extractRepositoryFacts} from '../../src/code_graph/extractor.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';

const REPOSITORY = join(import.meta.dirname, '../evaluation/fixtures/code-graph-v1/repository');

describe('native code graph extraction', () => {
  const files = fixtureFiles(REPOSITORY);
  const facts = extractRepositoryFacts(files);
  const symbols = facts.flatMap(file => file.symbols);
  const edges = facts.flatMap(file => file.edges);

  it('extracts the reviewed symbol contract with repository-relative evidence', () => {
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({kind: 'function', name: 'withExclusiveFileLock', path: 'packages/core/src/lock.ts'}),
        expect.objectContaining({kind: 'class', name: 'FileLock', path: 'packages/core/src/lock.ts'}),
        expect.objectContaining({kind: 'interface', name: 'LockLease', path: 'packages/core/src/lock.ts'}),
        expect.objectContaining({kind: 'function', name: 'ensureVectorIndex'}),
        expect.objectContaining({kind: 'function', name: 'refreshRecallIndex'}),
        expect.objectContaining({kind: 'function', name: 'runApplication', packageName: '@fixture/app'}),
      ]),
    );
    expect(symbols.every(symbol => !symbol.path.startsWith('/') && !symbol.path.includes('\\'))).toBe(true);
  });

  it('resolves only grounded cross-file relationships and keeps provenance explicit', () => {
    const keys = edges.map(edge => `${edge.sourceName}:${edge.relation}:${edge.targetName}:${edge.provenance}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'ensureVectorIndex:calls:withExclusiveFileLock:resolved',
        'refreshRecallIndex:calls:withExclusiveFileLock:resolved',
        'VectorIndexCoordinator:extends:FileLock:resolved',
        'runApplication:calls:ensureVectorIndex:resolved',
        '@fixture/app:depends_on:@fixture/search:declared',
        '@fixture/search:depends_on:@fixture/core:declared',
      ]),
    );
    expect(edges.filter(edge => edge.provenance === 'resolved').every(edge => edge.sourceId && edge.targetId)).toBe(
      true,
    );
    expect(edges.some(edge => edge.targetName === 'Error' && edge.provenance === 'resolved')).toBe(false);
  });

  it('indexes documentation without promoting prose similarity to a source dependency', () => {
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'heading',
          name: 'Fixture architecture',
          path: 'docs/architecture.md',
        }),
      ]),
    );
    expect(edges.some(edge => edge.provenance === 'model' || edge.relation === 'semantic_association')).toBe(false);
  });

  it('proves imported targets through their module instead of globally unique names', () => {
    const resolved = extractRepositoryFacts([
      sourceFile('src/a.ts', 'export function collision(): string { return "a"; }\n'),
      sourceFile('src/b.ts', 'export function collision(): string { return "b"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {collision} from "./b.js";\nexport function useCollision(): string { return collision(); }\n',
      ),
      sourceFile('src/unrelated.ts', 'export function phantom(): string { return "unrelated"; }\n'),
      sourceFile(
        'src/missing.ts',
        'import {phantom} from "./does-not-exist.js";\nexport function usePhantom(): string { return phantom(); }\n',
      ),
    ]);
    const resolvedSymbols = resolved.flatMap(file => file.symbols);
    const resolvedEdges = resolved.flatMap(file => file.edges);
    const collisionCall = resolvedEdges.find(
      edge => edge.sourceName === 'useCollision' && edge.relation === 'calls' && edge.targetName === 'collision',
    );
    const collisionTarget = resolvedSymbols.find(symbol => symbol.id === collisionCall?.targetId);
    const missingCall = resolvedEdges.find(
      edge => edge.sourceName === 'usePhantom' && edge.relation === 'calls' && edge.targetName === 'phantom',
    );

    expect(collisionCall).toMatchObject({provenance: 'resolved'});
    expect(collisionTarget?.path).toBe('src/b.ts');
    expect(missingCall).toMatchObject({provenance: 'syntactic'});
    expect(missingCall?.targetId).toBeUndefined();
  });

  it('scopes repeated TypeScript path aliases to the importing package', () => {
    const scoped = extractRepositoryFacts([
      sourceFile(
        'packages/a/tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}}),
      ),
      sourceFile(
        'packages/b/tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}}),
      ),
      sourceFile('packages/a/src/shared.ts', 'export function shared(): string { return "a"; }\n'),
      sourceFile('packages/b/src/shared.ts', 'export function shared(): string { return "b"; }\n'),
      sourceFile(
        'packages/a/src/use.ts',
        'import {shared} from "@/shared";\nexport function useA(): string { return shared(); }\n',
      ),
      sourceFile(
        'packages/b/src/use.ts',
        'import {shared} from "@/shared";\nexport function useB(): string { return shared(); }\n',
      ),
    ]);
    const scopedSymbols = scoped.flatMap(file => file.symbols);
    const scopedEdges = scoped.flatMap(file => file.edges);
    const targetPath = (source: string) => {
      const call = scopedEdges.find(
        edge => edge.sourceName === source && edge.relation === 'calls' && edge.targetName === 'shared',
      );
      return scopedSymbols.find(symbol => symbol.id === call?.targetId)?.path;
    };

    expect(targetPath('useA')).toBe('packages/a/src/shared.ts');
    expect(targetPath('useB')).toBe('packages/b/src/shared.ts');
  });

  it('uses the deepest package and TypeScript scopes inside a nested monorepo', () => {
    const nested = extractRepositoryFacts([
      sourceFile(
        'package.json',
        JSON.stringify({name: '@fixture/root', workspaces: ['apps/*', 'apps/app/modules/*', 'libs/*']}),
      ),
      sourceFile(
        'tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@shared/*': ['libs/shared/*']}}}),
      ),
      sourceFile('libs/shared/package.json', JSON.stringify({exports: './value.ts', name: '@fixture/outer-shared'})),
      sourceFile('libs/shared/value.ts', 'export function sharedValue(): string { return "outer"; }\n'),
      sourceFile(
        'apps/sibling/src/use.ts',
        'import {sharedValue} from "@shared/value";\nexport function useOuter(): string { return sharedValue(); }\n',
      ),
      sourceFile(
        'apps/app/package.json',
        JSON.stringify({
          dependencies: {'@fixture/outer-shared': 'workspace:*'},
          name: '@fixture/nested-app',
          workspaces: ['modules/*'],
        }),
      ),
      sourceFile(
        'apps/app/tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@shared/*': ['modules/shared/*']}}}),
      ),
      sourceFile('apps/app/modules/shared/package.json', JSON.stringify({name: '@fixture/nested-shared'})),
      sourceFile('apps/app/modules/shared/value.ts', 'export function sharedValue(): string { return "nested"; }\n'),
      sourceFile(
        'apps/app/src/use.ts',
        [
          'import {sharedValue as nestedValue} from "@shared/value";',
          'import {sharedValue as outerValue} from "@fixture/outer-shared";',
          'export function useNested(): string { return nestedValue(); }',
          'export function useIntegrated(): string { return outerValue(); }',
        ].join('\n'),
      ),
    ]);
    const nestedSymbols = nested.flatMap(file => file.symbols);
    const nestedEdges = nested.flatMap(file => file.edges);
    const target = (sourceName: string) => {
      const edge = nestedEdges.find(
        candidate =>
          candidate.sourceName === sourceName &&
          candidate.relation === 'calls' &&
          candidate.targetName === 'sharedValue',
      );
      return nestedSymbols.find(symbol => symbol.id === edge?.targetId);
    };

    expect(target('useOuter')).toMatchObject({
      packageName: '@fixture/outer-shared',
      path: 'libs/shared/value.ts',
    });
    expect(target('useNested')).toMatchObject({
      packageName: '@fixture/nested-shared',
      path: 'apps/app/modules/shared/value.ts',
    });
    expect(target('useIntegrated')).toMatchObject({
      packageName: '@fixture/outer-shared',
      path: 'libs/shared/value.ts',
    });
    expect(
      nestedEdges.find(
        edge =>
          edge.sourceName === '@fixture/nested-app' &&
          edge.relation === 'depends_on' &&
          edge.targetName === '@fixture/outer-shared',
      ),
    ).toMatchObject({provenance: 'declared'});
    expect(nestedSymbols.find(symbol => symbol.name === 'useNested')?.packageName).toBe('@fixture/nested-app');
  });

  it('selects each alias project scope once per importing source', () => {
    let scopeScans = 0;
    const projectFiles = Array.from({length: 20}, (_, index) => {
      const root = `packages/p${String(index).padStart(2, '0')}`;
      return [
        sourceFile(
          `${root}/tsconfig.json`,
          JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}}),
        ),
        sourceFile(`${root}/src/shared.ts`, `export function shared${index}(): number { return ${index}; }\n`),
      ];
    }).flat();
    const calls = Array.from({length: 50}, () => 'shared0();').join('\n');
    const files = [
      ...projectFiles,
      sourceFile(
        'packages/p00/src/use.ts',
        `import {shared0} from "@/shared";\nexport function useAliases(): void {\n${calls}\n}\n`,
      ),
    ];

    extractRepositoryFacts(files, {onAliasScopeScan: () => (scopeScans += 1)});

    expect(scopeScans).toBe(1);
  });

  it('does not resolve relative imports that escape above the repository root', () => {
    const escaped = extractRepositoryFacts([
      sourceFile('src/foo.ts', 'export function phantom(): string { return "inside"; }\n'),
      sourceFile(
        'src/deep/use.ts',
        'import {phantom} from "../../../src/foo";\nexport function usePhantom(): string { return phantom(); }\n',
      ),
    ]);
    const call = escaped
      .flatMap(file => file.edges)
      .find(edge => edge.sourceName === 'usePhantom' && edge.relation === 'calls');

    expect(call).toMatchObject({provenance: 'syntactic'});
    expect(call?.targetId).toBeUndefined();
  });

  it('fails closed for ambiguous package export conditions', () => {
    const ambiguous = extractRepositoryFacts([
      sourceFile(
        'packages/library/package.json',
        JSON.stringify({
          exports: {'.': {import: './src/import.ts', require: './src/require.ts'}},
          name: '@fixture/library',
        }),
      ),
      sourceFile('packages/library/src/import.ts', 'export function value(): string { return "import"; }\n'),
      sourceFile('packages/library/src/require.ts', 'export function value(): string { return "require"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {value} from "@fixture/library";\nexport function useValue(): string { return value(); }\n',
      ),
    ]);
    const call = ambiguous
      .flatMap(file => file.edges)
      .find(edge => edge.sourceName === 'useValue' && edge.relation === 'calls');

    expect(call).toMatchObject({provenance: 'syntactic'});
    expect(call?.targetId).toBeUndefined();
  });

  it('leaves duplicate workspace package names unresolved', () => {
    const duplicate = extractRepositoryFacts([
      sourceFile('packages/a/package.json', JSON.stringify({exports: './src/index.ts', name: '@fixture/duplicate'})),
      sourceFile('packages/b/package.json', JSON.stringify({exports: './src/index.ts', name: '@fixture/duplicate'})),
      sourceFile('packages/a/src/index.ts', 'export function duplicateValue(): string { return "a"; }\n'),
      sourceFile('packages/b/src/index.ts', 'export function duplicateValue(): string { return "b"; }\n'),
      sourceFile(
        'package.json',
        JSON.stringify({dependencies: {'@fixture/duplicate': 'workspace:*'}, name: '@fixture/root'}),
      ),
      sourceFile(
        'src/use.ts',
        'import {duplicateValue} from "@fixture/duplicate";\nexport function useDuplicate(): string { return duplicateValue(); }\n',
      ),
    ]);
    const edges = duplicate.flatMap(file => file.edges);

    const dependency = edges.find(
      edge => edge.sourceName === '@fixture/root' && edge.targetName === '@fixture/duplicate',
    );
    expect(dependency).toMatchObject({provenance: 'declared'});
    expect(dependency?.targetId).toBeUndefined();
    const call = edges.find(edge => edge.sourceName === 'useDuplicate' && edge.targetName === 'duplicateValue');
    expect(call).toMatchObject({provenance: 'syntactic'});
    expect(call?.targetId).toBeUndefined();
    expect(
      duplicate.flatMap(file => file.diagnostics).filter(value => value.includes('duplicate workspace')),
    ).toHaveLength(2);
  });

  it('applies TypeScript aliases only to files included by that project', () => {
    const scoped = extractRepositoryFacts([
      sourceFile(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}},
          exclude: ['src/generated/**'],
          include: ['src/**/*.ts'],
        }),
      ),
      sourceFile('src/shared.ts', 'export function shared(): string { return "shared"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {shared} from "@/shared";\nexport function includedUse(): string { return shared(); }\n',
      ),
      sourceFile(
        'tests/use.ts',
        'import {shared} from "@/shared";\nexport function excludedUse(): string { return shared(); }\n',
      ),
      sourceFile(
        'src/generated/use.ts',
        'import {shared} from "@/shared";\nexport function generatedUse(): string { return shared(); }\n',
      ),
    ]);
    const edges = scoped.flatMap(file => file.edges);
    const call = (name: string) =>
      edges.find(edge => edge.sourceName === name && edge.relation === 'calls' && edge.targetName === 'shared');

    expect(call('includedUse')).toMatchObject({provenance: 'resolved'});
    expect(call('excludedUse')).toMatchObject({provenance: 'syntactic'});
    expect(call('generatedUse')).toMatchObject({provenance: 'syntactic'});
  });

  it('fails closed for empty projects, undeclared package entries, and cross-class this members', () => {
    const scoped = extractRepositoryFacts([
      sourceFile(
        'tsconfig.json',
        JSON.stringify({compilerOptions: {baseUrl: '.', paths: {'@/*': ['src/*']}}, files: []}),
      ),
      sourceFile('src/shared.ts', 'export function shared(): string { return "shared"; }\n'),
      sourceFile(
        'src/use.ts',
        'import {shared} from "@/shared";\nexport function useShared(): string { return shared(); }\n',
      ),
      sourceFile('packages/library/package.json', JSON.stringify({name: '@fixture/library'})),
      sourceFile('packages/library/src/index.ts', 'export function value(): string { return "value"; }\n'),
      sourceFile(
        'src/package-use.ts',
        'import {value} from "@fixture/library";\nexport function useValue(): string { return value(); }\n',
      ),
      sourceFile(
        'src/classes.ts',
        [
          'export class First { invoke(): void { this.missing(); } }',
          'export class Second { missing(): void {} }',
        ].join('\n'),
      ),
    ]);
    const edges = scoped.flatMap(file => file.edges);
    const call = (source: string, target: string) =>
      edges.find(edge => edge.sourceName === source && edge.relation === 'calls' && edge.targetName === target);

    expect(call('useShared', 'shared')).toMatchObject({provenance: 'syntactic'});
    expect(call('useValue', 'value')).toMatchObject({provenance: 'syntactic'});
    expect(call('invoke', 'this.missing')).toMatchObject({provenance: 'syntactic'});
    expect(call('invoke', 'this.missing')?.targetId).toBeUndefined();
  });

  it('keeps shadowed parameters, locals, and nested declarations syntactic', () => {
    const scoped = extractRepositoryFacts([
      sourceFile('src/helper.ts', 'export function helper(): string { return "module"; }\n'),
      sourceFile(
        'src/use.ts',
        [
          'import {helper} from "./helper.js";',
          'export function parameterUse(helper: () => string): string { return helper(); }',
          'export function localUse(): string {',
          '  const helper = (): string => "local";',
          '  return helper();',
          '}',
          'export function nestedUse(): string {',
          '  function nested(): string { return "nested"; }',
          '  return nested();',
          '}',
          'export function importedUse(): string { return helper(); }',
        ].join('\n'),
      ),
    ]);
    const calls = scoped.flatMap(file => file.edges).filter(edge => edge.relation === 'calls');
    const call = (source: string, target: string) =>
      calls.find(edge => edge.sourceName === source && edge.targetName === target);

    expect(call('parameterUse', 'helper')).toMatchObject({provenance: 'syntactic'});
    expect(call('parameterUse', 'helper')?.targetId).toBeUndefined();
    expect(call('localUse', 'helper')).toMatchObject({provenance: 'syntactic'});
    expect(call('localUse', 'helper')?.targetId).toBeUndefined();
    expect(call('nestedUse', 'nested')).toMatchObject({provenance: 'syntactic'});
    expect(call('nestedUse', 'nested')?.targetId).toBeUndefined();
    expect(call('importedUse', 'helper')).toMatchObject({provenance: 'resolved'});
  });

  it('keeps named function and class expression self-references syntactic', () => {
    const scoped = extractRepositoryFacts([
      sourceFile('src/helper.ts', 'export function helper(): string { return "module"; }\n'),
      sourceFile(
        'src/use.ts',
        [
          'import {helper} from "./helper.js";',
          'export const namedFunction = function helper(): unknown { return helper(); };',
          'export const namedClass = class helper { method(): unknown { return helper(); } };',
        ].join('\n'),
      ),
    ]);
    const selfReferences = scoped
      .flatMap(file => file.edges)
      .filter(edge => edge.evidencePath === 'src/use.ts' && edge.relation === 'calls' && edge.targetName === 'helper');

    expect(selfReferences).toHaveLength(2);
    expect(selfReferences.every(edge => edge.provenance === 'syntactic' && edge.targetId === undefined)).toBe(true);
  });
});

function fixtureFiles(root: string): readonly CodeGraphInventoryFile[] {
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const target = join(directory, name);
      if (statSync(target).isDirectory()) visit(target);
      else paths.push(target);
    }
  };
  visit(root);
  return paths.sort().map(path => {
    const content = readFileSync(path, 'utf8');
    const repositoryPath = relative(root, path).replaceAll('\\', '/');
    return {
      blobId: `fixture:${sha256HexSync(content)}`,
      content,
      contentHash: sha256HexSync(content),
      language: language(repositoryPath),
      mode: '100644',
      path: repositoryPath,
      size: new TextEncoder().encode(content).byteLength,
      source: 'commit',
    };
  });
}

function language(path: string): string {
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.md$/.test(path)) return 'markdown';
  if (path.endsWith('package.json')) return 'npm-manifest';
  return 'text';
}

function sourceFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: `fixture:${sha256HexSync(content)}`,
    content,
    contentHash: sha256HexSync(content),
    language: language(path),
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
