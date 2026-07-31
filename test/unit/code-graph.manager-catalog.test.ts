import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {Effect, Layer} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {groupManagerGraphRepositories, managerGraphCatalog} from '../../src/code_graph/visualization.js';
import {CodeGraphStore, type CodeGraphVisualizationCatalog} from '../../src/code_graph/store.js';
import {SystemInfo} from '../../src/effect/system.js';
import type {CodeGraphWorkspace} from '../../src/code_graph/languages/types.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '../../src/code_graph/types.js';

const temporaryRoots: string[] = [];
const storeLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('Manager logical repository and workspace catalogs', () => {
  it('upgrades an existing v3 store additively without replacing its data', async () => {
    const root = temporaryRoot('threadnote-workspace-migration-');
    const databasePath = join(root, 'graph-v3.sqlite');
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }).pipe(Effect.provide(storeLayer)),
    );
    const legacy = new Database(databasePath);
    legacy.run("INSERT INTO schema_metadata (key, value) VALUES ('legacy_marker', 'preserve-me')");
    legacy.run('DROP INDEX symbols_resolution_scope');
    legacy.run('DROP TABLE workspace_component_dependencies');
    legacy.run('DROP TABLE workspace_components');
    legacy.run('DROP TABLE workspace_scopes');
    legacy.run('ALTER TABLE symbols DROP COLUMN resolution_scope_id');
    legacy.close();

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }).pipe(Effect.provide(storeLayer)),
    );
    const migrated = new Database(databasePath, {readonly: true});
    expect(migrated.query("SELECT value FROM schema_metadata WHERE key = 'legacy_marker'").get()).toEqual({
      value: 'preserve-me',
    });
    expect(
      migrated.query("SELECT name FROM pragma_table_info('symbols') WHERE name = 'resolution_scope_id'").get(),
    ).toEqual({name: 'resolution_scope_id'});
    expect(
      migrated.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_components'").get(),
    ).toEqual({name: 'workspace_components'});
    migrated.close();
  });

  it('preserves the original build start and records completion only after activation', async () => {
    const root = temporaryRoot('threadnote-activation-timestamps-');
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, '1'.repeat(64));
    const requested = readySnapshot(identity, 0, 0, 0, '2000-01-01T00:00:00.000Z');

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.markBuilding(databasePath, identity, {...requested, completedAt: undefined, state: 'building'});
      }).pipe(Effect.provide(storeLayer)),
    );
    const before = new Database(databasePath, {readonly: true});
    const startedAt = (
      before.query('SELECT started_at FROM snapshots WHERE id = ?').get(requested.id) as {started_at: string}
    ).started_at;
    before.close();
    await new Promise(resolve => setTimeout(resolve, 10));

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(databasePath, []);
            yield* store.stageActivationFacts(databasePath, [], []);
            yield* store.activateStaged(databasePath, identity, requested);
          }),
        );
      }).pipe(Effect.provide(storeLayer)),
    );

    const after = new Database(databasePath, {readonly: true});
    const activated = after
      .query('SELECT state, started_at, completed_at FROM snapshots WHERE id = ?')
      .get(requested.id) as {completed_at: string; started_at: string; state: string};
    after.close();
    expect(activated).toMatchObject({started_at: startedAt, state: 'ready'});
    expect(activated.completed_at).not.toBe(requested.completedAt);
    expect(Date.parse(activated.completed_at)).toBeGreaterThanOrEqual(Date.parse(startedAt));
  });

  it('rejects an incremental staging identity mismatch without mutating staged facts', async () => {
    const root = temporaryRoot('threadnote-incremental-staging-');
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, '1'.repeat(64));
    const originalSymbol = symbol('symbol-original', 'src/value.ts', 'value', 'typescript');
    const originalFiles = fileFixtures([originalSymbol]);
    const base = readySnapshot(identity, 1, 1, 0, '2026-07-31T10:00:00.000Z');
    const overlay: CodeGraphSnapshot = {
      ...readySnapshot(identity, 1, 1, 0, '2026-07-31T10:01:00.000Z'),
      baseSnapshotId: base.id,
      dirty: true,
      overlayFingerprint: 'dirty-overlay',
    };
    const modifiedFile = {...originalFiles[0]!, contentHash: 'modified-file-hash'};
    const modifiedSymbol = {...originalSymbol, contentHash: 'modified-symbol-hash', documentation: 'must not stage'};
    const modifiedFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: modifiedFile.path,
      symbols: [modifiedSymbol],
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(databasePath, originalFiles);
            yield* store.stageActivationFacts(databasePath, [originalSymbol], []);
            yield* store.activateStaged(databasePath, identity, base);
            const replaced = yield* store.replaceStagedModifiedFiles(
              databasePath,
              'not-the-active-staging-id',
              [modifiedFile],
              [modifiedFacts],
            );
            yield* store.activateStaged(databasePath, identity, overlay);
            return {graph: yield* store.loadGraph(databasePath, overlay.id), replaced};
          }),
        );
      }).pipe(Effect.provide(storeLayer)),
    );

    expect(result.replaced).toBe(false);
    expect(result.graph.symbols).toEqual([originalSymbol]);
  });

  it('loads every active worktree view from one checkout without collapsing them', async () => {
    const root = temporaryRoot('threadnote-worktree-views-');
    const databasePath = join(root, 'graph-v3.sqlite');
    const firstIdentity = repositoryIdentity(root, '2'.repeat(64));
    const secondIdentity: RepositoryIdentity = {
      ...firstIdentity,
      headCommit: '1234567890abcdef1234567890abcdef12345678',
      worktreeId: 'a'.repeat(64),
    };
    const first = readySnapshot(firstIdentity, 0, 0, 0, '2026-07-30T10:00:00.000Z');
    const second = readySnapshot(secondIdentity, 0, 0, 0, '2026-07-31T10:00:00.000Z');

    const catalogs = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, firstIdentity, first, [], [], []);
        yield* store.promote(databasePath, firstIdentity, first.id, new Set([firstIdentity.worktreeId]));
        yield* store.activate(databasePath, secondIdentity, second, [], [], []);
        yield* store.promote(
          databasePath,
          secondIdentity,
          second.id,
          new Set([firstIdentity.worktreeId, secondIdentity.worktreeId]),
        );
        return yield* store.loadVisualizationCatalogs(databasePath);
      }).pipe(Effect.provide(storeLayer)),
    );

    expect(catalogs.map(catalog => catalog.viewWorktreeId)).toEqual([
      secondIdentity.worktreeId,
      firstIdentity.worktreeId,
    ]);
    expect(new Set(catalogs.map(catalog => catalog.snapshot.id))).toEqual(new Set([first.id, second.id]));
  });

  it('persists same-name components, keeps unscoped documentation as a facet, and aggregates edges beyond row 1200', async () => {
    const root = temporaryRoot('threadnote-workspace-catalog-');
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, '1'.repeat(64));
    const workspace = workspaceFixture();
    const symbols = symbolFixtures();
    const edges = edgeFixtures();
    const files = fileFixtures(symbols);
    const snapshot = readySnapshot(identity, files.length, symbols.length, edges.length, '2026-07-31T10:00:00.000Z');

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            yield* store.prepareActivation(databasePath, files);
            yield* store.stageWorkspaceCatalog(databasePath, workspace);
            yield* store.stageActivationFacts(databasePath, symbols, edges);
            yield* store.activateStaged(databasePath, identity, snapshot);
            yield* store.promote(databasePath, identity, snapshot.id, new Set([identity.worktreeId]));
          }),
        );
        return {
          catalog: yield* store.loadVisualizationCatalog(databasePath),
          scopeEdges: yield* store.loadVisualizationScopeEdges(databasePath, snapshot.id),
          unscoped: yield* store.loadVisualizationSymbols(databasePath, snapshot.id, {type: 'documentation-facet'}, 20),
        };
      }).pipe(Effect.provide(storeLayer)),
    );

    expect(result.catalog?.model).toBe('workspace');
    expect(result.catalog?.projects.filter(project => project.label === 'core').map(project => project.id)).toEqual([
      'cgp_component_a',
      'cgp_component_b',
    ]);
    expect(result.catalog?.projects).toContainEqual(
      expect.objectContaining({id: 'facet:unscoped-documentation', kind: 'documentation', model: 'facet'}),
    );
    expect(result.catalog?.projects).toContainEqual(
      expect.objectContaining({id: 'package:threadnote', label: 'threadnote', symbolCount: 1}),
    );
    expect(result.catalog?.projects).toContainEqual(
      expect.objectContaining({id: 'path:scripts', label: 'scripts', symbolCount: 1}),
    );
    expect(result.catalog?.accounting).toEqual({
      attributedSymbols: symbols.length,
      componentSymbols: 3,
      fallbackSymbols: 3,
      omittedSymbols: 0,
      totalSymbols: symbols.length,
    });
    expect(result.unscoped.map(symbol => symbol.id)).toEqual(['symbol-doc']);
    expect(result.scopeEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'cgp_component_a',
          targetId: 'cgp_component_b',
          type: 'declared-build-dependency',
        }),
        expect.objectContaining({
          count: 1,
          sourceId: 'cgp_component_a',
          targetId: 'cgp_component_b',
          type: 'source-relationship',
        }),
        expect.objectContaining({
          sourceId: 'package:threadnote',
          targetId: 'cgp_component_a',
          type: 'source-relationship',
        }),
        expect.objectContaining({
          sourceId: 'path:scripts',
          targetId: 'package:threadnote',
          type: 'source-relationship',
        }),
      ]),
    );
  });

  it('groups checkouts only by logical repository identity and defaults to the newest activation', () => {
    const older = catalogFixture('logical-a', 'Same display', '2026-07-30T10:00:00.000Z', 90_000, '1'.repeat(64));
    const newer = catalogFixture('logical-a', 'Same display', '2026-07-31T10:00:00.000Z', 10, '2'.repeat(64));
    const collision = catalogFixture('logical-b', 'Same display', '2026-07-29T10:00:00.000Z', 100_000, '3'.repeat(64));
    const groups = groupManagerGraphRepositories([
      {catalog: older, checkoutId: 'a'.repeat(64)},
      {catalog: newer, checkoutId: 'b'.repeat(64)},
      {catalog: collision, checkoutId: 'c'.repeat(64)},
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.repositoryId)).toEqual(['logical-a', 'logical-b']);
    expect(groups[0]).toMatchObject({
      defaultViewId: `${'b'.repeat(64)}.${'2'.repeat(64)}`,
      displayName: 'Same display',
    });
    expect(groups[0]?.views.map(view => view.id)).toEqual([
      `${'b'.repeat(64)}.${'2'.repeat(64)}`,
      `${'a'.repeat(64)}.${'1'.repeat(64)}`,
    ]);
    expect(groups[0]?.views[0]?.label).toMatch(/abcdef01 · clean · 2026-07-31 10:00Z · checkout b{8} · worktree 2{8}/);
  });

  it('surfaces an unreadable database without exposing its local path', async () => {
    const home = temporaryRoot('threadnote-manager-unreadable-');
    const checkoutId = 'd'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    mkdirSync(repositoryRoot, {recursive: true});
    writeFileSync(join(repositoryRoot, 'graph-v3.sqlite'), 'not a sqlite database');

    const catalog = await Effect.runPromise(managerGraphCatalog(home).pipe(Effect.provide(storeLayer)));

    expect(catalog.repositories).toEqual([]);
    expect(catalog.diagnostics).toEqual([expect.objectContaining({checkoutId, code: 'unreadable-database'})]);
    expect(catalog.diagnostics[0]?.message).not.toContain(home);
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function repositoryIdentity(root: string, repositoryId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'e'.repeat(64),
    displayName: 'acme/mobile',
    gitCommonDirectory: join(root, '.git'),
    headCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId,
    worktreeId: 'f'.repeat(64),
  };
}

function workspaceFixture(): CodeGraphWorkspace {
  return {
    diagnostics: [],
    fingerprint: 'workspace-fixture',
    projects: [
      {
        buildSystem: 'gradle',
        dependencies: ['cgp_component_b'],
        dependencyDetails: [{evidence: 'settings.gradle.kts', provenance: 'declared', targetId: 'cgp_component_b'}],
        diagnostics: [],
        id: 'cgp_component_a',
        kind: 'module',
        languages: ['kotlin'],
        name: 'core',
        provenance: 'declared',
        resolutionDomain: 'jvm',
        root: 'apps/a',
        sourceRoots: ['apps/a/src/main/kotlin'],
        workspaceId: 'cgw_workspace',
        workspaceRoots: ['.'],
      },
      {
        buildSystem: 'gradle',
        dependencies: [],
        dependencyDetails: [],
        diagnostics: [],
        id: 'cgp_component_b',
        kind: 'module',
        languages: ['kotlin'],
        name: 'core',
        provenance: 'declared',
        resolutionDomain: 'jvm',
        root: 'apps/b',
        sourceRoots: ['apps/b/src/main/kotlin'],
        workspaceId: 'cgw_workspace',
        workspaceRoots: ['.'],
      },
    ],
    workspaces: [
      {
        buildSystem: 'gradle',
        diagnostics: [],
        id: 'cgw_workspace',
        name: 'mobile',
        provenance: 'declared',
        root: '.',
      },
    ],
  };
}

function symbolFixtures(): readonly CodeGraphSymbol[] {
  return [
    symbol('symbol-a-1', 'apps/a/src/main/kotlin/A.kt', 'A', 'kotlin', 'cgp_component_a'),
    symbol('symbol-a-2', 'apps/a/src/main/kotlin/A2.kt', 'A2', 'kotlin', 'cgp_component_a'),
    symbol('symbol-b', 'apps/b/src/main/kotlin/B.kt', 'B', 'kotlin', 'cgp_component_b'),
    symbol('symbol-doc', 'notes/design.md', 'Design', 'markdown'),
    {
      ...symbol('symbol-root-ts', 'src/index.ts', 'index', 'typescript'),
      packageName: 'threadnote',
      resolutionDomain: 'typescript',
    },
    {...symbol('symbol-script', 'scripts/release.ts', 'release', 'typescript'), resolutionDomain: 'typescript'},
  ];
}

function symbol(id: string, path: string, name: string, language: string, resolutionScopeId?: string): CodeGraphSymbol {
  return {
    contentHash: `${id}-hash`,
    exported: true,
    id,
    kind: language === 'markdown' ? 'document' : 'class',
    language,
    lookupKeys: [`global:name:${name}`],
    name,
    path,
    qualifiedName: name,
    resolutionDomain: language === 'kotlin' ? 'jvm' : 'documentation',
    ...(resolutionScopeId ? {resolutionScopeId} : {}),
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function edgeFixtures(): readonly CodeGraphEdge[] {
  const intra = Array.from({length: 1_201}, (_, index) =>
    edge(`edge-${index.toString().padStart(4, '0')}`, 'symbol-a-1', 'symbol-a-2'),
  );
  return [
    ...intra,
    edge('edge-zzzz-cross', 'symbol-a-1', 'symbol-b'),
    edge('edge-zzzz-root-component', 'symbol-root-ts', 'symbol-a-1'),
    edge('edge-zzzz-script-root', 'symbol-script', 'symbol-root-ts'),
  ];
}

function edge(id: string, sourceId: string, targetId: string): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: 'apps/a/src/main/kotlin/A.kt',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance: 'resolved',
    relation: 'calls',
    sourceId,
    sourceName: sourceId,
    targetId,
    targetName: targetId,
  };
}

function fileFixtures(symbols: readonly CodeGraphSymbol[]): readonly CodeGraphInventoryFile[] {
  return [...new Set(symbols.map(symbol => symbol.path))].map(path => ({
    blobId: `blob-${path}`,
    contentHash: `hash-${path}`,
    language: path.endsWith('.md') ? 'markdown' : 'kotlin',
    mode: '100644',
    path,
    size: 10,
    source: 'commit',
  }));
}

function readySnapshot(
  identity: RepositoryIdentity,
  files: number,
  symbols: number,
  edges: number,
  completedAt: string,
): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt,
    dirty: false,
    edgeCount: edges,
    extractorSet: 'workspace-test',
    fileCount: files,
    id: `cgsn_${completedAt.replaceAll(/\D/g, '')}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: symbols,
    worktreeId: identity.worktreeId,
  };
}

function catalogFixture(
  repositoryId: string,
  displayName: string,
  activatedAt: string,
  symbolCount: number,
  viewWorktreeId: string,
): CodeGraphVisualizationCatalog {
  return {
    accounting: {
      attributedSymbols: symbolCount,
      componentSymbols: symbolCount,
      fallbackSymbols: 0,
      omittedSymbols: 0,
      totalSymbols: symbolCount,
    },
    activatedAt,
    model: 'workspace',
    projects: [],
    repository: {displayName, repositoryId},
    snapshot: {
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      completedAt: activatedAt,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'fixture',
      fileCount: 0,
      id: `snapshot-${activatedAt}`,
      repositoryId,
      state: 'ready',
      symbolCount,
      worktreeId: 'worktree',
    },
    viewWorktreeId,
    workspaces: [],
  };
}
