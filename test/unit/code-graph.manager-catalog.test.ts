import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {Effect, Layer, Option} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  groupManagerGraphRepositories,
  managerGraphCatalog,
  releaseManagerGraphSnapshotLeases,
} from '../../src/code_graph/visualization.js';
import {
  CodeGraphStore,
  codeGraphVisualizationCatalogComponentStatement,
  codeGraphVisualizationScopeEdgeSampleStatements,
  codeGraphVisualizationScopeEndpointStatement,
  codeGraphVisualizationScopeSummaryStatementCount,
  codeGraphVisualizationScopeSymbolSampleStatements,
  codeGraphVisualizationSymbolsQueryStatement,
  type CodeGraphVisualizationCatalog,
} from '../../src/code_graph/store.js';
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
    legacy.run('DROP INDEX symbols_visualization_scope_v2');
    legacy.run('DROP INDEX symbols_visualization_package_v2');
    legacy.run('DROP INDEX symbols_visualization_path_v2');
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
        const highFanStartedAt = performance.now();
        const highFanSummary = yield* store.relationshipSummaryForNode(
          databasePath,
          snapshot.id,
          'symbol-a-1',
          ['resolved'],
          128,
        );
        const highFanElapsedMilliseconds = performance.now() - highFanStartedAt;
        const representativeStartedAt = performance.now();
        const representativeEdges = yield* store.representativeEdgesForNodes(
          databasePath,
          snapshot.id,
          ['symbol-a-1', 'symbol-a-2', 'symbol-b'],
          'both',
          20,
          ['resolved'],
        );
        const representativeElapsedMilliseconds = performance.now() - representativeStartedAt;
        return {
          boundedScopeEdges: yield* store.loadVisualizationScopeEdgeSummary(
            databasePath,
            snapshot.id,
            ['cgp_component_a', 'cgp_component_b', 'facet:unscoped'],
            20,
          ),
          catalog: yield* store.loadVisualizationCatalog(databasePath),
          deferredCatalog: yield* store.loadVisualizationCatalog(databasePath, 'deferred'),
          highFanElapsedMilliseconds,
          highFanSummary,
          representativeElapsedMilliseconds,
          representativeEdges,
          scopeEdges: yield* store.loadVisualizationScopeEdges(databasePath, snapshot.id),
          unscoped: yield* store.loadVisualizationSymbols(databasePath, snapshot.id, {type: 'documentation-facet'}, 20),
          unscopedCatalog: yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
            projectId: Option.some('facet:unscoped'),
            projectLimit: 1,
            snapshotId: Option.some(snapshot.id),
          }),
        };
      }).pipe(Effect.provide(storeLayer)),
    );

    expect(result.catalog?.model).toBe('workspace');
    expect(result.catalog?.metrics).toBe('complete');
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
    expect(result.deferredCatalog).toMatchObject({
      accounting: {omittedSymbols: symbols.length, totalSymbols: symbols.length},
      metrics: 'deferred',
      model: 'workspace',
    });
    expect(result.deferredCatalog?.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: 'cgp_component_a', symbolCount: 0}),
        expect.objectContaining({id: 'cgp_component_b', symbolCount: 0}),
        expect.objectContaining({id: 'facet:unscoped', symbolCount: 0}),
      ]),
    );
    expect(result.unscoped.map(symbol => symbol.id)).toEqual(['symbol-doc']);
    expect(result.unscopedCatalog?.projects.map(project => project.id)).toEqual(['facet:unscoped']);
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
    expect(result.boundedScopeEdges.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({sourceId: 'cgp_component_a', targetId: 'cgp_component_b'})]),
    );
    expect(result.highFanSummary).toMatchObject({sampledEdges: 128, truncated: true});
    expect(result.highFanElapsedMilliseconds).toBeLessThan(1_000);
    expect(result.representativeEdges.truncated).toBe(true);
    const representativeEndpoints = new Set(
      result.representativeEdges.edges.flatMap(item => [item.sourceId, item.targetId]),
    );
    expect([...representativeEndpoints]).toEqual(expect.arrayContaining(['symbol-a-1', 'symbol-a-2', 'symbol-b']));
    expect(result.representativeElapsedMilliseconds).toBeLessThan(1_000);
    const queryPlanDatabase = new Database(databasePath, {readonly: true});
    const componentStatement = codeGraphVisualizationSymbolsQueryStatement(
      snapshot.id,
      undefined,
      {type: 'component', value: 'cgp_component_a'},
      157,
    );
    const queryPlan = queryPlanDatabase
      .query(`EXPLAIN QUERY PLAN ${componentStatement.text}`)
      .all(...componentStatement.parameters) as readonly {readonly detail: string}[];
    expect(queryPlan.some(row => row.detail.includes('symbols_visualization_scope_v2'))).toBe(true);
    const unscopedStatement = codeGraphVisualizationSymbolsQueryStatement(
      snapshot.id,
      undefined,
      {type: 'unscoped'},
      20,
    );
    const unscopedPlan = queryPlanDatabase
      .query(`EXPLAIN QUERY PLAN ${unscopedStatement.text}`)
      .all(...unscopedStatement.parameters) as readonly {readonly detail: string}[];
    expect(unscopedPlan.some(row => row.detail.includes('symbols_visualization_scope_v2'))).toBe(true);
    const packageStatement = codeGraphVisualizationSymbolsQueryStatement(
      snapshot.id,
      undefined,
      {type: 'package', value: 'threadnote'},
      20,
    );
    const packagePlan = queryPlanDatabase
      .query(`EXPLAIN QUERY PLAN ${packageStatement.text}`)
      .all(...packageStatement.parameters) as readonly {readonly detail: string}[];
    expect(packagePlan.some(row => row.detail.includes('symbols_visualization_package_v2'))).toBe(true);
    const pathStatement = codeGraphVisualizationSymbolsQueryStatement(
      snapshot.id,
      undefined,
      {type: 'path', value: 'scripts'},
      20,
    );
    const pathPlan = queryPlanDatabase
      .query(`EXPLAIN QUERY PLAN ${pathStatement.text}`)
      .all(...pathStatement.parameters) as readonly {readonly detail: string}[];
    expect(pathPlan.some(row => row.detail.includes('symbols_visualization_path_v2'))).toBe(true);
    const repositoryStatement = codeGraphVisualizationSymbolsQueryStatement(snapshot.id, undefined, {type: 'all'}, 157);
    const repositoryPlan = queryPlanDatabase
      .query(`EXPLAIN QUERY PLAN ${repositoryStatement.text}`)
      .all(...repositoryStatement.parameters) as readonly {readonly detail: string}[];
    queryPlanDatabase.close();
    expect(repositoryPlan.some(row => row.detail.includes('symbols_export_order (snapshot_id=?)'))).toBe(true);

    const previousBetaDatabase = new Database(databasePath);
    previousBetaDatabase.run('DROP INDEX symbols_visualization_scope_v2');
    previousBetaDatabase.run('DROP INDEX symbols_visualization_package_v2');
    previousBetaDatabase.run('DROP INDEX symbols_visualization_path_v2');
    previousBetaDatabase.close();
    const previousBetaReads = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* Effect.all({
          component: store.loadVisualizationSymbols(
            databasePath,
            snapshot.id,
            {type: 'component', value: 'cgp_component_a'},
            20,
          ),
          package: store.loadVisualizationSymbols(
            databasePath,
            snapshot.id,
            {type: 'package', value: 'threadnote'},
            20,
          ),
          path: store.loadVisualizationSymbols(databasePath, snapshot.id, {type: 'path', value: 'scripts'}, 20),
          unscoped: store.loadVisualizationSymbols(databasePath, snapshot.id, {type: 'unscoped'}, 20),
        });
      }).pipe(Effect.provide(storeLayer)),
    );
    expect(previousBetaReads.component.map(item => item.id)).toEqual(['symbol-a-1', 'symbol-a-2']);
    expect(previousBetaReads.package.map(item => item.id)).toEqual(['symbol-root-ts']);
    expect(previousBetaReads.path.map(item => item.id)).toEqual(['symbol-script']);
    expect(previousBetaReads.unscoped.map(item => item.id)).toEqual(
      expect.arrayContaining(['symbol-doc', 'symbol-root-ts', 'symbol-script']),
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

  it('bounds a production-shaped Bazel catalog without loading dependency evidence', async () => {
    const root = temporaryRoot('threadnote-bazel-catalog-');
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root, '9'.repeat(64));
    const snapshot = readySnapshot(identity, 5_000, 5_000, 4_999, '2026-08-01T12:00:00.000Z');
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(
          databasePath,
          identity,
          {...snapshot, edgeCount: 0, fileCount: 0, symbolCount: 0},
          [],
          [],
          [],
        );
        yield* store.promote(databasePath, identity, snapshot.id, new Set([identity.worktreeId]));
      }).pipe(Effect.provide(storeLayer)),
    );
    const database = new Database(databasePath);
    database.run(
      `INSERT INTO workspace_scopes
       (snapshot_id, id, build_system, name, root, provenance, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [snapshot.id, 'cgw_bazel', 'bazel', 'public-monorepo', '.', 'declared', '[]'],
    );
    const insertComponent = database.prepare(
      `INSERT INTO workspace_components
       (snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
        languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertWorkspace = database.prepare(
      `INSERT INTO workspace_scopes
       (snapshot_id, id, build_system, name, root, provenance, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertDependency = database.prepare(
      `INSERT INTO workspace_component_dependencies
       (snapshot_id, source_component_id, target_component_id, provenance, evidence)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertSymbol = database.prepare(
      `INSERT INTO symbols
       (snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = database.prepare(
      `INSERT INTO edges
       (snapshot_id, id, source_id, source_name, relation, target_id, target_name, provenance,
        confidence, evidence_path, evidence_span_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 1; index < 130; index += 1) {
        const suffix = index.toString().padStart(3, '0');
        insertWorkspace.run(
          snapshot.id,
          `cgw_bazel_${suffix}`,
          'bazel',
          `nested-workspace-${suffix}`,
          `apps/nested-${suffix}`,
          'declared',
          '[]',
        );
      }
      for (let index = 0; index < 5_000; index += 1) {
        const suffix = index.toString().padStart(5, '0');
        insertComponent.run(
          snapshot.id,
          `cgp_bazel_${suffix}`,
          index === 129 ? 'cgw_bazel_129' : 'cgw_bazel',
          'bazel',
          'target',
          `//apps/service-${suffix}:library`,
          `apps/service-${suffix}`,
          'jvm',
          '["java","kotlin"]',
          `["apps/service-${suffix}/src"]`,
          '["."]',
          'declared',
          '[]',
        );
        // The catalog endpoint intentionally never reads this potentially large evidence payload.
        if (index > 0) {
          insertDependency.run(
            snapshot.id,
            `cgp_bazel_${suffix}`,
            `cgp_bazel_${(index - 1).toString().padStart(5, '0')}`,
            'declared',
            `discarded-evidence-${'x'.repeat(2_048)}`,
          );
        }
        if (index < 500) {
          const symbolId = `symbol-bazel-${suffix}`;
          insertSymbol.run(
            snapshot.id,
            symbolId,
            `hash-${suffix}`,
            'class',
            `Service${suffix}`,
            `Service${suffix}`,
            `apps/service-${suffix}/src/Service.kt`,
            'kotlin',
            null,
            '[]',
            'jvm',
            `cgp_bazel_${suffix}`,
            null,
            1,
            null,
            null,
            '{"column":1,"endColumn":2,"endLine":1,"line":1}',
          );
          if (index > 0) {
            const previousSuffix = (index - 1).toString().padStart(5, '0');
            insertEdge.run(
              snapshot.id,
              `edge-bazel-${suffix}`,
              symbolId,
              `Service${suffix}`,
              'calls',
              `symbol-bazel-${previousSuffix}`,
              `Service${previousSuffix}`,
              'resolved',
              1,
              `apps/service-${suffix}/src/Service.kt`,
              '{"column":1,"endColumn":2,"endLine":1,"line":1}',
            );
          }
        }
      }
    })();
    database.close();

    const startedAt = performance.now();
    const catalog = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          includeDependencies: false,
          projectLimit: 160,
          workspaceLimit: 64,
        });
      }).pipe(Effect.provide(storeLayer)),
    );
    const elapsedMilliseconds = performance.now() - startedAt;
    const payload = JSON.stringify(catalog);
    const catalogContinuation = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          projectLimit: 160,
          projectOffset: 159,
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
          workspaceOffset: 64,
        });
      }).pipe(Effect.provide(storeLayer)),
    );
    const catalogSearchStartedAt = performance.now();
    const catalogSearch = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          projectLimit: 160,
          projectQuery: Option.some('service-04999'),
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
          workspaceQuery: Option.some('nested-workspace-129'),
        });
      }).pipe(Effect.provide(storeLayer)),
    );
    const catalogSearchElapsedMilliseconds = performance.now() - catalogSearchStartedAt;
    const catalogWorkspaceSearchStartedAt = performance.now();
    const catalogWorkspaceSearch = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          projectLimit: 160,
          projectQuery: Option.some('nested-workspace-129'),
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
          workspaceQuery: Option.some('nested-workspace-129'),
        });
      }).pipe(Effect.provide(storeLayer)),
    );
    const catalogWorkspaceSearchElapsedMilliseconds = performance.now() - catalogWorkspaceSearchStartedAt;
    const detailStartedAt = performance.now();
    const detailCatalog = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationCatalog(databasePath, 'deferred', {
          includeDependencies: false,
          projectId: Option.some('cgp_bazel_04999'),
          projectLimit: 1,
          snapshotId: Option.some(snapshot.id),
          workspaceLimit: 64,
        });
      }).pipe(Effect.provide(storeLayer)),
    );
    const detailElapsedMilliseconds = performance.now() - detailStartedAt;
    const sourceSummaryStartedAt = performance.now();
    const sourceSummary = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.loadVisualizationScopeEdgeSummary(
          databasePath,
          snapshot.id,
          Array.from({length: 5_000}, (_, index) => `cgp_bazel_${index.toString().padStart(5, '0')}`),
          1_500,
        );
      }).pipe(Effect.provide(storeLayer)),
    );
    const sourceSummaryElapsedMilliseconds = performance.now() - sourceSummaryStartedAt;
    expect(catalog).toMatchObject({projectCount: 5_001, projectsTruncated: true, workspaceCount: 130});
    expect(catalog?.projects).toHaveLength(160);
    expect(catalog?.workspaces).toHaveLength(64);
    expect(catalog?.workspacesTruncated).toBe(true);
    expect(catalog?.projects.every(project => project.dependencies.length === 0)).toBe(true);
    expect(payload).not.toContain('discarded-evidence');
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThan(100_000);
    expect(elapsedMilliseconds).toBeLessThan(1_500);
    expect(detailCatalog?.projects.map(project => project.id)).toEqual(['cgp_bazel_04999']);
    expect(detailElapsedMilliseconds).toBeLessThan(500);
    expect(catalogContinuation?.projects).toHaveLength(160);
    expect(catalogContinuation?.projects[0]?.id).not.toBe(catalog?.projects[0]?.id);
    expect(catalogContinuation?.workspaces).toHaveLength(64);
    expect(catalogContinuation?.workspaces[0]?.id).toBe('cgw_bazel_064');
    expect(catalogSearch?.projects.map(project => project.id)).toEqual(['cgp_bazel_04999']);
    expect(catalogSearch?.workspaces.map(workspace => workspace.id)).toEqual(['cgw_bazel_129']);
    expect(catalogWorkspaceSearch?.projects.map(project => project.id)).toEqual(['cgp_bazel_00129']);
    expect(catalogWorkspaceSearch?.workspaces.map(workspace => workspace.id)).toEqual(['cgw_bazel_129']);
    expect(sourceSummary).toMatchObject({sampledScopes: 500, truncated: true});
    expect(sourceSummary.edges.length).toBeGreaterThan(0);
    expect(sourceSummaryElapsedMilliseconds).toBeLessThan(1_500);

    const sampledScopeIds = Array.from({length: 500}, (_, index) => `cgp_bazel_${index.toString().padStart(5, '0')}`);
    const symbolStatements = codeGraphVisualizationScopeSymbolSampleStatements(
      snapshot.id,
      undefined,
      sampledScopeIds,
      7,
    );
    const edgeStatements = codeGraphVisualizationScopeEdgeSampleStatements(
      snapshot.id,
      undefined,
      sampledScopeIds.map((scopeId, index) => ({
        scopeId,
        symbolIds: [`symbol-bazel-${index.toString().padStart(5, '0')}`],
      })),
      8,
      ['resolved'],
    );
    const endpointStatement = codeGraphVisualizationScopeEndpointStatement(snapshot.id, undefined, [
      'symbol-bazel-00000',
      'symbol-bazel-00499',
    ]);
    const catalogComponentStatement = codeGraphVisualizationCatalogComponentStatement(
      snapshot.id,
      'service-04999',
      160,
      0,
    );
    expect(codeGraphVisualizationScopeSummaryStatementCount(500)).toBe(17);
    expect(symbolStatements).toHaveLength(8);
    expect(edgeStatements).toHaveLength(8);
    const planDatabase = new Database(databasePath, {readonly: true});
    const symbolPlan = planDatabase
      .query(`EXPLAIN QUERY PLAN ${symbolStatements[0]!.text}`)
      .all(...symbolStatements[0]!.parameters) as readonly {readonly detail: string}[];
    const edgePlan = planDatabase
      .query(`EXPLAIN QUERY PLAN ${edgeStatements[0]!.text}`)
      .all(...edgeStatements[0]!.parameters) as readonly {readonly detail: string}[];
    const endpointPlan = planDatabase
      .query(`EXPLAIN QUERY PLAN ${endpointStatement.text}`)
      .all(...endpointStatement.parameters) as readonly {readonly detail: string}[];
    const catalogComponentPlan = planDatabase
      .query(`EXPLAIN QUERY PLAN ${catalogComponentStatement.text}`)
      .all(...catalogComponentStatement.parameters) as readonly {readonly detail: string}[];
    planDatabase.close();
    expect(symbolPlan.some(row => row.detail.includes('symbols_visualization_scope_v2'))).toBe(true);
    expect(edgePlan.some(row => row.detail.includes('edges_source'))).toBe(true);
    expect(edgePlan.some(row => row.detail.includes('edges_target'))).toBe(true);
    expect(
      endpointPlan.some(
        row =>
          row.detail.includes('SEARCH current_symbols USING PRIMARY KEY') &&
          row.detail.includes('snapshot_id=? AND id=?'),
      ),
    ).toBe(true);
    expect(catalogComponentStatement.text).toContain('candidate_components AS MATERIALIZED');
    expect(catalogComponentStatement.text).toContain('FROM candidate_components AS candidate');
    expect(catalogComponentStatement.text).toContain(
      'JOIN candidate_components AS candidate ON candidate.id = incoming.target_component_id',
    );
    expect(catalogComponentPlan.some(row => row.detail.includes('MATERIALIZE candidate_components'))).toBe(true);
    expect(catalogComponentPlan.map(row => row.detail)).toEqual(
      expect.arrayContaining([expect.stringContaining('outgoing USING PRIMARY KEY')]),
    );
    expect(catalogComponentPlan.some(row => row.detail.includes('candidate_dependency_endpoints'))).toBe(true);
    expect(catalogSearchElapsedMilliseconds).toBeLessThan(500);
    expect(catalogWorkspaceSearchElapsedMilliseconds).toBeLessThan(500);

    const viewDatabase = new Database(databasePath);
    const insertSnapshot = viewDatabase.prepare(
      `INSERT INTO snapshots
       (id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set, dirty,
        overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at, failure_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    viewDatabase.transaction(() => {
      for (let index = 0; index < 40; index += 1) {
        const suffix = index.toString(16).padStart(64, '0');
        insertSnapshot.run(
          `cgsn_view_${index}`,
          identity.repositoryId,
          suffix,
          suffix.slice(0, 40),
          null,
          'workspace-test',
          0,
          null,
          'ready',
          0,
          0,
          0,
          '2026-08-01T13:00:00.000Z',
          index === 39 ? '2026-08-02T13:00:01.000Z' : '2026-08-01T13:00:01.000Z',
          null,
        );
      }
      insertSnapshot.run(
        'cgsn_historical_view',
        identity.repositoryId,
        '0'.repeat(62) + '26',
        'deadbeef'.repeat(5),
        null,
        'workspace-test',
        0,
        null,
        'ready',
        0,
        0,
        0,
        '2020-08-01T13:00:00.000Z',
        '2020-08-01T13:00:01.000Z',
        null,
      );
      viewDatabase
        .query(
          "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
        )
        .run('cgsn_view_39');
      viewDatabase
        .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
        .run('0'.repeat(62) + '27', 'cgsn_view_39', '2099-08-02T13:00:02.000Z');
    })();
    viewDatabase.close();
    const [firstViews, continuedViews, searchedViews, historicalViews] = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* Effect.all(
          [
            store.loadVisualizationCatalogs(databasePath, 'deferred', {viewLimit: 33}),
            store.loadVisualizationCatalogs(databasePath, 'deferred', {viewLimit: 33, viewOffset: 33}),
            store.loadVisualizationCatalogs(databasePath, 'deferred', {
              viewLimit: 33,
              viewQuery: Option.some('0000000000000000000000000000000000000027'),
            }),
            store.loadVisualizationCatalogs(databasePath, 'deferred', {
              viewLimit: 33,
              viewQuery: Option.some('deadbeef'),
            }),
          ],
          {concurrency: 1},
        );
      }).pipe(Effect.provide(storeLayer)),
    );
    expect(firstViews).toHaveLength(33);
    expect(firstViews[0]?.viewWorktreeId).toBe('0'.repeat(62) + '27');
    expect(continuedViews.length).toBeGreaterThan(0);
    expect(new Set([...firstViews, ...continuedViews].map(view => view.viewWorktreeId)).size).toBeGreaterThan(33);
    expect(searchedViews.map(view => view.viewWorktreeId)).toEqual(['0'.repeat(62) + '27']);
    expect(historicalViews).toEqual([]);
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

  it('releases catalog snapshot leases when the Manager lifecycle ends', async () => {
    const home = temporaryRoot('threadnote-manager-lease-lifecycle-');
    const identity = repositoryIdentity(home, '9'.repeat(64));
    const databasePath = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId, 'graph-v3.sqlite');
    const snapshot = readySnapshot(identity, 0, 0, 0, '2026-08-05T12:00:00.000Z');

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, [], [], []);
        yield* managerGraphCatalog(home);
      }).pipe(Effect.provide(storeLayer)),
    );
    const leased = new Database(databasePath, {readonly: true});
    expect(leased.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 1});
    leased.close();

    await Effect.runPromise(releaseManagerGraphSnapshotLeases().pipe(Effect.provide(storeLayer)));

    const released = new Database(databasePath, {readonly: true});
    expect(released.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    released.close();
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
  const intra = Array.from({length: 12_001}, (_, index) =>
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
    metrics: 'complete',
    model: 'workspace',
    projectCount: 0,
    projects: [],
    projectsTruncated: false,
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
    workspaceCount: 0,
    workspaces: [],
    workspacesTruncated: false,
  };
}
