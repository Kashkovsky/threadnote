import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect, Path} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {inventoryRepository} from '../../src/code_graph/inventory.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {
  CodeGraphStore,
  materializedShardDerivationIdentity,
  type CodeGraphVisualizationCatalog,
  type StoredCodeGraph,
} from '../../src/code_graph/store.js';
import type {CodeGraphQueryResult} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('project-closure incremental indexing', () => {
  it.effect('reattributes the exact reverse-dependent project closure when a barrel redirects', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const incrementalHome = join(root, '.threadnote-incremental');
          const fullHome = join(root, '.threadnote-full');
          const base = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          expect(base.materialization?.mode).toBe('full');

          yield* Effect.sync(() => redirectBarrel(root));
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            base.identity.checkoutId,
            base.identity.worktreeId,
          );
          const currentIdentity = yield* resolveRepositoryIdentity(root);
          const currentInventory = yield* inventoryRepository(currentIdentity, {includeOverlay: true});
          const currentBarrel = currentInventory.files.find(file => file.path === 'packages/barrel/index.ts')!;
          const receipt = yield* store.reusableBaseReceipt(incrementalLayout.databasePath, base.snapshot.id);
          expect(receipt).toBeDefined();
          const poisonDerivation = materializedShardDerivationIdentity(
            base.snapshot.extractorSet,
            receipt!.workspaceFingerprint,
            receipt!.fileSetFingerprint,
          );
          yield* store.cacheMaterializedFileShards(
            incrementalLayout.databasePath,
            [currentBarrel],
            [
              {
                diagnostics: ['poisoned final shard'],
                edges: [],
                path: currentBarrel.path,
                references: [],
                symbols: [],
              },
            ],
            base.snapshot.extractorSet,
            poisonDerivation,
            (_boundary, transaction) => transaction,
          );
          expect(
            (yield* store.loadMaterializedFileShards(
              incrementalLayout.databasePath,
              [currentBarrel],
              base.snapshot.extractorSet,
              poisonDerivation,
            )).facts.get(currentBarrel.path)?.diagnostics,
          ).toEqual(['poisoned final shard']);
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            threadnoteHome: fullHome,
          });
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
          const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);
          const incrementalHealth = yield* store.diagnose(incrementalLayout.databasePath);
          const fullHealth = yield* store.diagnose(fullLayout.databasePath);
          const incrementalCatalog = yield* store.loadVisualizationCatalog(incrementalLayout.databasePath);
          const fullCatalog = yield* store.loadVisualizationCatalog(fullLayout.databasePath);

          expect(incremental.materialization).toEqual({
            closureProjects: 2,
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
            stagedFiles: 4,
            totalFiles: 11,
          });
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          expect(normalizeCatalog(incrementalCatalog)).toEqual(normalizeCatalog(fullCatalog));
          expect(incrementalHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(fullHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          const other = incrementalGraph.symbols.find(symbol => symbol.name === 'other');
          expect(other).toBeDefined();
          expect(
            incrementalGraph.edges.some(
              edge => edge.sourceName === 'consume' && edge.relation === 'calls' && edge.targetId === other?.id,
            ),
          ).toBe(true);
          expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/index.ts',
            'packages/barrel/package.json',
          ]);
          expect(
            (yield* store.loadMaterializedFileShards(
              incrementalLayout.databasePath,
              [currentBarrel],
              base.snapshot.extractorSet,
              poisonDerivation,
            )).facts.get(currentBarrel.path)?.diagnostics,
          ).toEqual(['poisoned final shard']);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('uses the same project closure from a nearby persisted clean base', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const path = yield* Path.Path;
          const incrementalHome = join(root, '.threadnote-clean-incremental');
          const fullHome = join(root, '.threadnote-clean-full');
          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          yield* Effect.sync(() => {
            redirectBarrel(root);
            git(root, ['add', 'packages/barrel/index.ts']);
            git(root, ['commit', '-qm', 'redirect barrel']);
          });

          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            threadnoteHome: fullHome,
          });
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            incremental.identity.checkoutId,
            incremental.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
          const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

          expect(incremental.materialization).toEqual({
            closureProjects: 2,
            mode: 'incremental-clean',
            resolutionClosure: 'project',
            stagedFiles: 4,
            totalFiles: 11,
          });
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual([
            'packages/app/index.ts',
            'packages/app/package.json',
            'packages/barrel/index.ts',
            'packages/barrel/package.json',
          ]);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('reparses and replaces a valid cache tuple whose payload names another path', () =>
    Effect.acquireUseRelease(
      Effect.sync(createProjectClosureRepository),
      root =>
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const home = join(root, '.threadnote-cache-path-healing');
          const base = yield* indexer.index({cwd: root, threadnoteHome: home});
          const layout = codeGraphLayout(path, home, base.identity.checkoutId, base.identity.worktreeId);
          const baseBarrelHash = snapshotFileContentHash(
            layout.databasePath,
            base.snapshot.id,
            'packages/barrel/index.ts',
          );
          yield* Effect.sync(() => {
            corruptCachedFactPath(layout.databasePath, baseBarrelHash);
            redirectBarrel(root);
          });
          const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});

          expect(indexed.materialization).toMatchObject({
            mode: 'incremental-overlay',
            resolutionClosure: 'project',
          });
          expect(cachedFactPayloadPaths(layout.databasePath, baseBarrelHash)).toEqual(['packages/barrel/index.ts']);
        }),
      root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('falls back through bounded full materialization for cache and receipt loss or oversized facts', () =>
    Effect.forEach(
      [
        {reason: 'cache-incomplete' as const, scenario: 'missing' as const},
        {reason: 'project-closure-unbounded' as const, scenario: 'oversized' as const},
        {reason: 'staging-unavailable' as const, scenario: 'receipt' as const},
      ],
      ({reason, scenario}) =>
        Effect.acquireUseRelease(
          Effect.sync(createProjectClosureRepository),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const home = join(root, `.threadnote-${scenario}-cache`);
              const base = yield* indexer.index({cwd: root, threadnoteHome: home});
              const layout = codeGraphLayout(path, home, base.identity.checkoutId, base.identity.worktreeId);
              const baseBarrelHash = snapshotFileContentHash(
                layout.databasePath,
                base.snapshot.id,
                'packages/barrel/index.ts',
              );
              let removedAfterPersistence = false;
              yield* Effect.sync(() => {
                mutateBarrelCache(layout.databasePath, scenario);
                redirectBarrel(root);
              });
              const indexed = yield* indexer.index({
                cwd: root,
                onProgress: progress =>
                  scenario === 'missing' &&
                  !removedAfterPersistence &&
                  progress.phase === 'scanning' &&
                  progress.activity?.stage === 'persisting' &&
                  progress.activity.batchCompleted === progress.activity.batchTotal
                    ? Effect.sync(() => {
                        deleteCachedContentHash(layout.databasePath, baseBarrelHash);
                        removedAfterPersistence = true;
                      })
                    : Effect.void,
                threadnoteHome: home,
              });

              expect(indexed.materialization).toMatchObject({fallbackReason: reason, mode: 'full'});
              expect(indexed.materialization?.stagedFiles).toBe(indexed.materialization?.totalFiles);
              if (scenario === 'missing') expect(removedAfterPersistence).toBe(true);
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('fails closed for file-set, global-surface, and unreconciled-workspace changes', () =>
    Effect.forEach(
      [
        {
          create: () => createProjectClosureRepository(),
          mutate: (root: string) => writeFile(root, 'packages/barrel/extra.ts', 'export const extra = true;\n'),
          reason: 'file-set-changed' as const,
        },
        {
          create: () => createProjectClosureRepository(),
          mutate: (root: string) =>
            writeFile(root, 'packages/core/index.ts', 'export function renamed() { return "renamed"; }\n'),
          reason: 'resolution-surface-changed' as const,
        },
        {
          create: () => createProjectClosureRepository({orphanProjectBoundary: true}),
          mutate: redirectBarrel,
          reason: 'project-closure-incomplete' as const,
        },
      ],
      scenario =>
        Effect.acquireUseRelease(
          Effect.sync(scenario.create),
          root =>
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const home = join(root, `.threadnote-${scenario.reason}`);
              yield* indexer.index({cwd: root, threadnoteHome: home});
              yield* Effect.sync(() => scenario.mutate(root));
              const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});

              expect(indexed.materialization).toMatchObject({fallbackReason: scenario.reason, mode: 'full'});
              expect(indexed.materialization?.stagedFiles).toBe(indexed.materialization?.totalFiles);
            }),
          root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
        ),
      {concurrency: 1},
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect(
    'reports an exact typed fallback when outside-closure base provenance exceeds 10,000 rows',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(createProjectClosureRepository),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const home = join(root, '.threadnote-reexport-overflow');
            const base = yield* indexer.index({cwd: root, threadnoteHome: home});
            const layout = codeGraphLayout(path, home, base.identity.checkoutId, base.identity.worktreeId);
            yield* Effect.sync(() => {
              insertOutsideReexportOverflow(layout.databasePath, base.snapshot.id);
              redirectBarrelWithOutsideCall(root);
            });
            const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});

            expect(indexed.materialization).toMatchObject({
              fallbackReason: 'reexport-closure-unbounded',
              mode: 'full',
            });
            expect(indexed.materialization?.stagedFiles).toBe(indexed.materialization?.totalFiles);
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(Effect.provide(ApplicationLayer)),
    {timeout: 30_000},
  );

  it.effect.prop(
    'matches forced-full graph, query, catalog, health, counts, and delta paths across randomized project chains',
    {
      projectCount: FC.integer({max: 8, min: 5}),
      salt: FC.integer({max: 10_000, min: 0}),
    },
    ({projectCount, salt}) =>
      Effect.acquireUseRelease(
        Effect.sync(() => createRandomProjectClosureRepository(projectCount, salt)),
        root =>
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            const path = yield* Path.Path;
            const query = yield* CodeGraphQueryService;
            const store = yield* CodeGraphStore;
            const incrementalHome = join(root, '.threadnote-random-incremental');
            const fullHome = join(root, '.threadnote-random-full');
            yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            yield* Effect.sync(() => redirectRandomBarrel(root, salt));
            const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            const full = yield* indexer.index({
              cwd: root,
              incrementalOverlay: false,
              threadnoteHome: fullHome,
            });
            const incrementalLayout = codeGraphLayout(
              path,
              incrementalHome,
              incremental.identity.checkoutId,
              incremental.identity.worktreeId,
            );
            const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
            const [incrementalQuery, fullQuery] = yield* Effect.all(
              [
                query.inspect({
                  cwd: root,
                  operation: 'query',
                  query: 'use3',
                  refresh: false,
                  threadnoteHome: incrementalHome,
                }),
                query.inspect({
                  cwd: root,
                  operation: 'query',
                  query: 'use3',
                  refresh: false,
                  threadnoteHome: fullHome,
                }),
              ],
              {concurrency: 1},
            );
            const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
            const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

            expect(incremental.materialization).toEqual({
              closureProjects: projectCount - 3,
              mode: 'incremental-overlay',
              resolutionClosure: 'project',
              stagedFiles: 2 * (projectCount - 3),
              totalFiles: 2 * projectCount - 1,
            });
            expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
            expect(normalizeQuery(incrementalQuery)).toEqual(normalizeQuery(fullQuery));
            expect(normalizeCatalog(yield* store.loadVisualizationCatalog(incrementalLayout.databasePath))).toEqual(
              normalizeCatalog(yield* store.loadVisualizationCatalog(fullLayout.databasePath)),
            );
            expect(yield* store.diagnose(incrementalLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
            expect(yield* store.diagnose(fullLayout.databasePath)).toMatchObject({
              foreignKeyViolations: 0,
              integrity: 'ok',
            });
            expect(deltaPaths(incrementalLayout.databasePath, incremental.snapshot.id)).toEqual(
              Array.from({length: projectCount - 3}, (_, offset) => offset + 2)
                .flatMap(index => [`packages/p${index}/index.ts`, `packages/p${index}/package.json`])
                .sort(),
            );
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(Effect.provide(ApplicationLayer)),
    {fastCheck: {interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true, numRuns: 4}, timeout: 70_000},
  );
});

function createProjectClosureRepository(options: {readonly orphanProjectBoundary?: boolean} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-project-closure-'));
  write(root, 'package.json', {name: '@fixture/root', private: true, workspaces: ['packages/*']});
  write(root, 'packages/app/package.json', {
    dependencies: {
      '@fixture/barrel': 'workspace:*',
      '@fixture/core': 'workspace:*',
      '@fixture/other': 'workspace:*',
      '@fixture/unrelated': 'workspace:*',
    },
    name: '@fixture/app',
  });
  writeFile(
    root,
    'packages/app/index.ts',
    'import {foo} from "../barrel/index.js";\nexport function consume() { return foo(); }\n',
  );
  write(root, 'packages/barrel/package.json', {
    dependencies: {'@fixture/core': 'workspace:*', '@fixture/other': 'workspace:*'},
    name: '@fixture/barrel',
  });
  writeFile(root, 'packages/barrel/index.ts', 'export {real as foo} from "../core/index.js";\n');
  write(root, 'packages/core/package.json', {name: '@fixture/core'});
  writeFile(root, 'packages/core/index.ts', 'export function real() { return "real"; }\n');
  write(root, 'packages/other/package.json', {name: '@fixture/other'});
  writeFile(root, 'packages/other/index.ts', 'export function other() { return "other"; }\n');
  write(root, 'packages/unrelated/package.json', {name: '@fixture/unrelated'});
  writeFile(root, 'packages/unrelated/index.ts', 'export function unrelated() { return "unrelated"; }\n');
  if (options.orphanProjectBoundary) {
    write(root, 'unmodeled/project.json', {name: 'unmodeled'});
    writeFile(root, 'unmodeled/index.ts', 'export const unmodeled = true;\n');
  }
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['config', 'user.email', 'test@threadnote.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function redirectBarrel(root: string): void {
  writeFile(root, 'packages/barrel/index.ts', 'export {other as foo} from "../other/index.js";\n');
}

function redirectBarrelWithOutsideCall(root: string): void {
  redirectBarrel(root);
  writeFile(
    root,
    'packages/app/index.ts',
    'import {foo} from "../barrel/index.js";\nimport {unrelated} from "../unrelated/index.js";\nexport function consume() { return foo() + unrelated(); }\n',
  );
}

function createRandomProjectClosureRepository(projectCount: number, salt: number): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-random-project-closure-'));
  const packageCount = projectCount - 1;
  write(root, 'package.json', {name: '@random/root', private: true, workspaces: ['packages/*']});
  write(root, 'packages/p0/package.json', {name: '@random/p0'});
  writeFile(root, 'packages/p0/index.ts', `export function old${salt}() { return "old"; }\n`);
  write(root, 'packages/p1/package.json', {name: '@random/p1'});
  writeFile(root, 'packages/p1/index.ts', `export function next${salt}() { return "next"; }\n`);
  write(root, 'packages/p2/package.json', {
    dependencies: {'@random/p0': 'workspace:*', '@random/p1': 'workspace:*'},
    name: '@random/p2',
  });
  writeFile(root, 'packages/p2/index.ts', `export {old${salt} as foo} from "../p0/index.js";\n`);
  for (let index = 3; index < packageCount; index += 1) {
    if (index === 3) {
      write(root, `packages/p${index}/package.json`, {
        dependencies: {
          '@random/p0': 'workspace:*',
          '@random/p1': 'workspace:*',
          '@random/p2': 'workspace:*',
        },
        name: `@random/p${index}`,
      });
      writeFile(
        root,
        `packages/p${index}/index.ts`,
        `import {foo} from "../p2/index.js";\nexport function use${index}() { return foo(); }\n`,
      );
      continue;
    }
    write(root, `packages/p${index}/package.json`, {
      dependencies: {[`@random/p${index - 1}`]: 'workspace:*'},
      name: `@random/p${index}`,
    });
    writeFile(
      root,
      `packages/p${index}/index.ts`,
      `import {use${index - 1}} from "../p${index - 1}/index.js";\nexport function use${index}() { return use${index - 1}(); }\n`,
    );
  }
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Threadnote Test']);
  git(root, ['config', 'user.email', 'test@threadnote.local']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function redirectRandomBarrel(root: string, salt: number): void {
  writeFile(root, 'packages/p2/index.ts', `export {next${salt} as foo} from "../p1/index.js";\n`);
}

function write(root: string, path: string, value: unknown): void {
  writeFile(root, path, `${JSON.stringify(value)}\n`);
}

function writeFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), {recursive: true});
  writeFileSync(target, content);
}

function git(root: string, arguments_: readonly string[]): void {
  execFileSync('git', arguments_, {cwd: root, stdio: 'ignore'});
}

function normalizeGraph(graph: StoredCodeGraph): unknown {
  return {
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...graph.symbols].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (!catalog) return catalog;
  const {activatedAt: _activatedAt, snapshot, ...rest} = catalog;
  const {baseSnapshotId: _baseSnapshotId, completedAt: _completedAt, id: _id, ...stableSnapshot} = snapshot;
  return {...rest, snapshot: stableSnapshot};
}

function normalizeQuery(result: CodeGraphQueryResult): unknown {
  return {
    edges: [...result.edges].sort((left, right) => left.id.localeCompare(right.id)),
    nodes: result.nodes,
    operation: result.operation,
    warnings: result.warnings,
  };
}

function deltaPaths(databasePath: string, snapshotId: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly path: string}, [string]>('SELECT path FROM snapshot_files WHERE snapshot_id = ? ORDER BY path')
      .all(snapshotId)
      .map(row => row.path);
  } finally {
    database.close(false);
  }
}

function mutateBarrelCache(databasePath: string, scenario: 'missing' | 'oversized' | 'receipt'): void {
  const database = new Database(databasePath);
  try {
    if (scenario === 'missing') {
      database.run(`DELETE FROM file_blobs WHERE path_hint = 'packages/barrel/index.ts'`);
    } else if (scenario === 'oversized') {
      database.run(`UPDATE file_blobs SET facts_json = ? WHERE path_hint = 'packages/barrel/index.ts'`, [
        JSON.stringify({
          diagnostics: ['x'.repeat(8 * 1_048_576)],
          edges: [],
          path: 'packages/barrel/index.ts',
          references: [],
          symbols: [],
        }),
      ]);
    } else {
      database.run('DELETE FROM snapshot_reuse_receipts');
    }
  } finally {
    database.close(false);
  }
}

function snapshotFileContentHash(databasePath: string, snapshotId: string, path: string): string {
  const database = new Database(databasePath, {readonly: true});
  try {
    const row = database
      .query<{readonly contentHash: string}, [string, string]>(
        'SELECT content_hash AS contentHash FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
      )
      .get(snapshotId, path);
    if (!row) throw new Error(`Missing snapshot file ${path}.`);
    return row.contentHash;
  } finally {
    database.close(false);
  }
}

function deleteCachedContentHash(databasePath: string, contentHash: string): void {
  const database = new Database(databasePath);
  try {
    database.run('DELETE FROM file_blobs WHERE content_hash = ?', [contentHash]);
  } finally {
    database.close(false);
  }
}

function corruptCachedFactPath(databasePath: string, contentHash: string): void {
  const database = new Database(databasePath);
  try {
    database.run('UPDATE file_blobs SET facts_json = ? WHERE content_hash = ?', [
      JSON.stringify({
        diagnostics: [],
        edges: [],
        path: 'packages/other/index.ts',
        references: [],
        symbols: [],
      }),
      contentHash,
    ]);
  } finally {
    database.close(false);
  }
}

function cachedFactPayloadPaths(databasePath: string, contentHash: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly path: string}, [string]>(
        `SELECT json_extract(facts_json, '$.path') AS path
         FROM file_blobs
         WHERE content_hash = ?
         ORDER BY extractor_set`,
      )
      .all(contentHash)
      .map(row => row.path);
  } finally {
    database.close(false);
  }
}

function insertOutsideReexportOverflow(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO snapshot_reexport_provenance (
        snapshot_id, source_path, local_name, target_path, imported_name
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 10_001; index += 1) {
        insert.run(
          snapshotId,
          'packages/unrelated/index.ts',
          'unrelated',
          `packages/outside-${String(index).padStart(5, '0')}.ts`,
          `outside${index}`,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}
