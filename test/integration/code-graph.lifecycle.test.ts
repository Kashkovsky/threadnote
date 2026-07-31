import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {runCodeGraphExport} from '../../src/code_graph/commands.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {
  inventoryRepository,
  readContainedStableRegularFile,
  worktreeOverlayState,
} from '../../src/code_graph/inventory.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {
  codeGraphDoctorCheck,
  purgeAllCodeGraphIndexes,
  repairCodeGraphIndexes,
} from '../../src/code_graph/maintenance.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore, type StoredCodeGraph} from '../../src/code_graph/store.js';
import {captureConsole} from '../../src/effect/console.js';
import {SystemInfo} from '../../src/effect/system.js';
import {runDoctor, runRepair} from '../../src/lifecycle.js';
import type {DoctorCheck, RuntimeConfig} from '../../src/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const FIXTURE_REPOSITORY = join(import.meta.dirname, '../evaluation/fixtures/code-graph-v1/repository');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('native code graph lifecycle', () => {
  it('atomically indexes, queries, traverses paths, traces impact, and preserves no-answer', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    expect(indexed.snapshot.state).toBe('ready');
    expect(indexed.snapshot.fileCount).toBeGreaterThanOrEqual(10);
    expect(indexed.snapshot.symbolCount).toBeGreaterThanOrEqual(7);

    const [definition, path, impact, missing] = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* Effect.all(
          [
            graph.inspect({
              cwd: root,
              operation: 'query',
              query: 'exclusive file lock',
              refresh: false,
              threadnoteHome: home,
            }),
            graph.inspect({
              cwd: root,
              from: 'runApplication',
              operation: 'path',
              refresh: false,
              threadnoteHome: home,
              to: 'withExclusiveFileLock',
            }),
            graph.inspect({
              cwd: root,
              operation: 'impact',
              query: 'withExclusiveFileLock',
              refresh: false,
              threadnoteHome: home,
            }),
            graph.inspect({
              cwd: root,
              operation: 'query',
              query: 'payment settlement gateway',
              refresh: false,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
      }),
    );
    expect(definition.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['withExclusiveFileLock', 'FileLock']),
    );
    expect(path.edges.map(edge => `${edge.sourceName}:${edge.targetName}`)).toEqual([
      'runApplication:ensureVectorIndex',
      'ensureVectorIndex:withExclusiveFileLock',
    ]);
    expect(impact.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['ensureVectorIndex', 'refreshRecallIndex', 'runApplication']),
    );
    expect(missing.nodes).toEqual([]);
  });

  it('synchronously refreshes stale lightweight reads when the caller requires freshness', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let observations = 0;
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    replaceFunction(root, 'ensureVectorIndex', 'ensureFreshVectorIndex');

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          interlock: {
            afterObservation: () => Effect.sync(() => (observations += 1)),
          },
          operation: 'query',
          query: 'ensureFreshVectorIndex',
          refresh: true,
          threadnoteHome: home,
        });
      }),
    );

    expect(result.freshness).toBe('current');
    expect(result.nodes.some(node => node.name === 'ensureFreshVectorIndex')).toBe(true);
    expect(observations).toBe(3);
  });

  it('retries a strict read when the worktree changes after its pre-read observation', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let observations = 0;

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        return yield* query.inspect({
          cwd: root,
          interlock: {
            afterObservation: () =>
              Effect.sync(() => {
                observations += 1;
                if (observations === 2) {
                  replaceFunction(root, 'ensureVectorIndex', 'ensureObservedVectorIndex');
                }
              }),
          },
          operation: 'query',
          query: 'ensureObservedVectorIndex',
          refresh: true,
          threadnoteHome: home,
        });
      }),
    );

    expect(result.freshness).toBe('current');
    expect(result.nodes.some(node => node.name === 'ensureObservedVectorIndex')).toBe(true);
    expect(observations).toBe(5);
  });

  it('keeps dirty overlays isolated between linked Git worktrees', async () => {
    const root = createFixtureRepository();
    git(root, ['branch', 'graph-a']);
    git(root, ['branch', 'graph-b']);
    const worktreeRoot = temporaryDirectory('threadnote-code-graph-worktrees-');
    const worktreeA = join(worktreeRoot, 'worktree-a');
    const worktreeB = join(worktreeRoot, 'worktree-b');
    git(root, ['worktree', 'add', worktreeA, 'graph-a']);
    git(root, ['worktree', 'add', worktreeB, 'graph-b']);
    replaceFunction(worktreeA, 'ensureVectorIndex', 'ensureBranchAVectorIndex');
    replaceFunction(worktreeB, 'ensureVectorIndex', 'ensureBranchBVectorIndex');
    const home = join(root, '.threadnote-test-home');

    const [resultA, resultB] = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* Effect.all(
          [
            graph.inspect({
              cwd: worktreeA,
              operation: 'query',
              query: 'ensureBranchAVectorIndex',
              threadnoteHome: home,
            }),
            graph.inspect({
              cwd: worktreeB,
              operation: 'query',
              query: 'ensureBranchBVectorIndex',
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
      }),
    );
    expect(resultA.nodes.some(node => node.name === 'ensureBranchAVectorIndex')).toBe(true);
    expect(resultA.nodes.some(node => node.name === 'ensureBranchBVectorIndex')).toBe(false);
    expect(resultB.nodes.some(node => node.name === 'ensureBranchBVectorIndex')).toBe(true);
    expect(resultB.nodes.some(node => node.name === 'ensureBranchAVectorIndex')).toBe(false);
    expect(resultA.snapshot.worktreeId).not.toBe(resultB.snapshot.worktreeId);

    git(root, ['worktree', 'remove', '--force', worktreeB]);
    const health = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
        const database = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          indexed.identity.checkoutId,
          'graph-v3.sqlite',
        );
        return yield* store.diagnose(database);
      }),
    );
    expect(health).toMatchObject({activeSnapshots: 1, readySnapshots: 2});
  });

  it('shares immutable clean snapshots without coupling worktree activation', async () => {
    const root = createFixtureRepository();
    git(root, ['branch', 'graph-clean-a']);
    git(root, ['branch', 'graph-clean-b']);
    const worktreeRoot = temporaryDirectory('threadnote-code-graph-clean-worktrees-');
    const worktreeA = join(worktreeRoot, 'worktree-a');
    const worktreeB = join(worktreeRoot, 'worktree-b');
    git(root, ['worktree', 'add', worktreeA, 'graph-clean-a']);
    git(root, ['worktree', 'add', worktreeB, 'graph-clean-b']);
    const home = join(root, '.threadnote-test-home');

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
        const second = yield* indexer.index({cwd: worktreeB, threadnoteHome: home});
        const forced = yield* indexer.index({cwd: worktreeA, force: true, threadnoteHome: home});
        const database = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          first.identity.checkoutId,
          'graph-v3.sqlite',
        );
        return {first, forced, health: yield* store.diagnose(database), second};
      }),
    );

    expect(result.first.snapshot.id).toBe(result.second.snapshot.id);
    expect(result.forced.reusedFiles).toBe(0);
    expect(result.forced.snapshot.id).not.toBe(result.first.snapshot.id);
    expect(result.health).toMatchObject({
      activeSnapshots: 2,
      buildingSnapshots: 0,
      failedSnapshots: 0,
      integrity: 'ok',
      readySnapshots: 2,
    });

    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      result.first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const audit = new Database(databasePath);
    try {
      audit.exec(`
        CREATE TABLE cache_write_audit (operation TEXT NOT NULL);
        CREATE TRIGGER cache_insert_audit AFTER INSERT ON file_blobs
        BEGIN INSERT INTO cache_write_audit VALUES ('insert'); END;
        CREATE TRIGGER cache_update_audit AFTER UPDATE ON file_blobs
        BEGIN INSERT INTO cache_write_audit VALUES ('update'); END;
      `);
    } finally {
      audit.close();
    }

    replaceFunction(worktreeA, 'ensureVectorIndex', 'ensureDirtyVectorIndex');
    const afterDirty = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        yield* indexer.index({cwd: worktreeA, threadnoteHome: home});
        const dirty = yield* graph.inspect({
          cwd: worktreeA,
          operation: 'query',
          query: 'ensureDirtyVectorIndex',
          threadnoteHome: home,
        });
        const clean = yield* graph.inspect({
          cwd: worktreeB,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        const database = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          result.first.identity.checkoutId,
          'graph-v3.sqlite',
        );
        return {clean, dirty, health: yield* store.diagnose(database)};
      }),
    );
    expect(afterDirty.dirty.nodes.some(node => node.name === 'ensureDirtyVectorIndex')).toBe(true);
    expect(afterDirty.clean.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
    expect(afterDirty.health).toMatchObject({
      activeSnapshots: 2,
      integrity: 'ok',
      readySnapshots: 2,
    });
    const database = new Database(databasePath, {readonly: true});
    try {
      const stored = database
        .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
        .get(afterDirty.dirty.snapshot.id);
      const changedFiles = database
        .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ?')
        .get(afterDirty.dirty.snapshot.id);
      const cacheWrites = database
        .query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM cache_write_audit')
        .get();
      expect(stored?.count).toBeLessThan(result.first.snapshot.symbolCount);
      expect(changedFiles?.count).toBe(1);
      expect(cacheWrites?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('reuses parsed file facts when repository resolution context changes', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const packagePath = join(root, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({...packageJson, description: 'changed context'}, null, 2)}\n`);

    const second = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(second.reusedFiles).toBe(first.snapshot.fileCount - 1);
  });

  it('refreshes package attribution when only a containing manifest changes', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const packagePath = join(root, 'packages/search/package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(packagePath, `${JSON.stringify({...packageJson, name: '@fixture/search-renamed'}, null, 2)}\n`);

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, inspected};
      }),
    );

    expect(result.indexed.reusedFiles).toBe(first.snapshot.fileCount - 1);
    expect(result.inspected.nodes.find(node => node.name === 'ensureVectorIndex')?.packageName).toBe(
      '@fixture/search-renamed',
    );
  });

  it('rehydrates cached package and TypeScript resolution context without reparsing manifests', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    mkdirSync(join(root, 'cmd', 'fixture'), {recursive: true});
    writeFileSync(
      join(root, 'go.mod'),
      ['module example.com/threadnote-fixture', '', 'require example.com/cache-dependency v1.2.3', ''].join('\n'),
    );
    writeFileSync(join(root, 'cmd', 'fixture', 'main.go'), 'package main\n\nfunc main() {}\n');
    git(root, ['add', 'go.mod', 'cmd/fixture/main.go']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'add go fixture',
    ]);
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const contextPaths = ['go.mod', 'package.json', 'packages/app/package.json', 'tsconfig.json'] as const;
    const firstContextHashes = Object.fromEntries(
      contextPaths.map(path => [path, effectiveSnapshotFileHash(databasePath, first.snapshot.id, path)]),
    );
    const appPath = join(root, 'packages/app/src/main.ts');
    writeFileSync(appPath, `${readFileSync(appPath, 'utf8')}\n// ordinary source revision\n`);

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const graph = yield* store.loadGraph(
          join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId, 'graph-v3.sqlite'),
          indexed.snapshot.id,
        );
        return {graph, indexed};
      }),
    );

    expect(result.indexed.reusedFiles).toBe(first.snapshot.fileCount - 1);
    expect(result.graph.symbols.find(symbol => symbol.name === 'runApplication')?.packageName).toBe('@fixture/app');
    expect(
      result.graph.edges.some(
        edge =>
          edge.sourceName === '@fixture/app' && edge.relation === 'depends_on' && edge.targetName === '@fixture/search',
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some(
        edge =>
          edge.sourceName === 'runApplication' &&
          edge.relation === 'calls' &&
          edge.targetName === 'ensureVectorIndex' &&
          edge.provenance === 'resolved',
      ),
    ).toBe(true);
    expect(result.graph.symbols.some(symbol => symbol.name === 'example.com/threadnote-fixture')).toBe(true);
    expect(
      result.graph.edges.some(
        edge =>
          edge.sourceName === 'example.com/threadnote-fixture' &&
          edge.relation === 'depends_on' &&
          edge.targetName === 'example.com/cache-dependency',
      ),
    ).toBe(true);
    expect(
      Object.fromEntries(
        contextPaths.map(path => [path, effectiveSnapshotFileHash(databasePath, result.indexed.snapshot.id, path)]),
      ),
    ).toEqual(firstContextHashes);
  });

  it('prunes parser-cache revisions no longer referenced by an active snapshot', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const sourcePath = 'packages/search/src/vector-index.ts';
    const committedHash = snapshotFileHash(databasePath, first.snapshot.id, sourcePath);
    replaceFunction(root, 'ensureVectorIndex', 'ensureFirstRevision');
    const intermediate = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const intermediateHash = snapshotFileHash(databasePath, intermediate.snapshot.id, sourcePath);
    replaceFunction(root, 'ensureFirstRevision', 'ensureSecondRevision');
    const latest = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const latestHash = snapshotFileHash(databasePath, latest.snapshot.id, sourcePath);
    const database = new Database(databasePath, {readonly: true});
    let cachedHashes: string[];
    try {
      cachedHashes = database
        .query<{readonly content_hash: string}, [string]>(
          'SELECT content_hash FROM file_blobs WHERE path_hint = ? ORDER BY content_hash',
        )
        .all(sourcePath)
        .map(row => row.content_hash);
    } finally {
      database.close();
    }
    const unchanged = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(cachedHashes).toEqual([committedHash, latestHash].sort());
    expect(cachedHashes).not.toContain(intermediateHash);
    expect(unchanged.reusedFiles).toBe(unchanged.snapshot.fileCount);
  });

  it('performs a true full rebuild without parser-cache reuse', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      first.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const database = new Database(databasePath);
    try {
      const row = database
        .query<{readonly facts_json: string}, [string]>('SELECT facts_json FROM file_blobs WHERE path_hint = ? LIMIT 1')
        .get('packages/search/src/vector-index.ts');
      const facts = JSON.parse(row!.facts_json) as {
        readonly diagnostics: readonly string[];
        readonly edges: readonly unknown[];
        readonly path: string;
        readonly symbols: ReadonlyArray<Record<string, unknown>>;
      };
      database.query('UPDATE file_blobs SET facts_json = ? WHERE path_hint = ?').run(
        JSON.stringify({
          ...facts,
          symbols: facts.symbols.map(symbol => ({
            ...symbol,
            name: 'corruptedVectorIndex',
            qualifiedName: 'corruptedVectorIndex',
          })),
        }),
        'packages/search/src/vector-index.ts',
      );
    } finally {
      database.close();
    }
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const rebuilt = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {inspected, rebuilt};
      }),
    );

    expect(result.rebuilt.snapshot.id).not.toBe(first.snapshot.id);
    expect(result.rebuilt.reusedFiles).toBe(0);
    expect(result.inspected.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(true);
    expect(result.inspected.nodes.some(node => node.name === 'corruptedVectorIndex')).toBe(false);
    const repairedDatabase = new Database(databasePath, {readonly: true});
    try {
      const repaired = repairedDatabase
        .query<{readonly facts_json: string}, [string]>('SELECT facts_json FROM file_blobs WHERE path_hint = ? LIMIT 1')
        .get('packages/search/src/vector-index.ts');
      expect(repaired?.facts_json).toContain('ensureVectorIndex');
      expect(repaired?.facts_json).not.toContain('corruptedVectorIndex');
    } finally {
      repairedDatabase.close();
    }
  });

  it('releases ordinary source content across the 128-entry batch boundary', async () => {
    const root = createManySourceRepository(129);
    const observedBatches: string[][] = [];

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files =>
            Effect.sync(() => {
              observedBatches.push(files.map(file => file.path));
            }),
        });
      }),
    );

    expect(observedBatches.map(batch => batch.length)).toEqual([128, 1]);
    expect(observedBatches[0]?.at(0)).toBe('src/file-000.ts');
    expect(observedBatches[1]).toEqual(['src/file-128.ts']);
    expect(inventory.parsedFiles).toBe(129);
    expect(inventory.files.every(file => file.content === undefined)).toBe(true);
  });

  it('indexes committed source above the former 128 MiB aggregate limit in bounded batches', async () => {
    const root = createLargeInventoryRepository(129);
    const observedBatches: Array<{readonly bytes: number; readonly files: number}> = [];

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files =>
            Effect.sync(() => {
              observedBatches.push({
                bytes: files.reduce((total, file) => total + file.size, 0),
                files: files.length,
              });
            }),
        });
      }),
    );

    expect(observedBatches.map(batch => batch.files)).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 1]);
    expect(observedBatches.every(batch => batch.bytes <= 16 * 1_048_576 && batch.files <= 128)).toBe(true);
    expect(observedBatches.reduce((total, batch) => total + batch.bytes, 0)).toBeGreaterThan(128 * 1_048_576);
    expect(inventory.parsedFiles).toBe(129);
    expect(inventory.files.every(file => file.content === undefined)).toBe(true);
  }, 30_000);

  it('indexes an eligible tracked file above the former per-file byte cap', async () => {
    const root = createLargeInventoryRepository(1, 2 * 1_048_576);

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );

    expect(inventory.files).toHaveLength(1);
    expect(inventory.files[0]?.size).toBe(2 * 1_048_576);
    expect(inventory.parsedFiles).toBe(1);
  });

  it('counts a forced dirty path once when the commit and worktree versions are both parsed', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    replaceFunction(root, 'ensureVectorIndex', 'ensureDirtyVectorIndex');

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      }),
    );

    expect(result.reusedFiles).toBe(0);
    expect(result.snapshot.fileCount).toBeGreaterThan(0);
  });

  it('reuses fresh clean staging for a modification-only dirty overlay without changing graph results', async () => {
    const incrementalRoot = createBodyModifiedRepository(24);
    const fullRoot = createBodyModifiedRepository(24);
    const incrementalHome = join(incrementalRoot, '.threadnote-test-home');
    const fullHome = join(fullRoot, '.threadnote-test-home');
    const materializingTotals: number[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const incremental = yield* indexer.index({
          cwd: incrementalRoot,
          onProgress: progress =>
            Effect.sync(() => {
              if (progress.phase === 'materializing' && progress.completed === progress.total) {
                materializingTotals.push(progress.total);
              }
            }),
          threadnoteHome: incrementalHome,
        });
        const full = yield* indexer.index({
          cwd: fullRoot,
          incrementalOverlay: false,
          threadnoteHome: fullHome,
        });
        const incrementalGraph = yield* store.loadGraph(
          codeGraphDatabasePath(incrementalHome, incremental),
          incremental.snapshot.id,
        );
        const fullGraph = yield* store.loadGraph(codeGraphDatabasePath(fullHome, full), full.snapshot.id);
        return {full, fullGraph, incremental, incrementalGraph};
      }),
    );

    expect(result.incremental.materialization).toEqual({
      mode: 'incremental-overlay',
      stagedFiles: 1,
      totalFiles: 24,
    });
    expect(result.incremental.diagnostics).toContain('Dirty overlay reused clean staging for 1 modified file(s).');
    expect(materializingTotals.at(-1)).toBe(1);
    expect(result.full.materialization).toEqual({
      fallbackReason: 'disabled',
      mode: 'full',
      stagedFiles: 24,
      totalFiles: 24,
    });
    expect(
      result.incrementalGraph.edges.some(
        edge =>
          edge.evidencePath === 'src/file-001.ts' &&
          edge.relation === 'calls' &&
          edge.targetId !== undefined &&
          edge.targetName === 'original0',
      ),
    ).toBe(true);
    expect(normalizeStoredGraph(result.incrementalGraph)).toEqual(normalizeStoredGraph(result.fullGraph));
  });

  it('preserves diagnostics from unchanged files when reusing clean staging', async () => {
    const root = createBodyModifiedRepositoryWithCommittedDiagnostic();
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});
      }),
    );

    expect(result.materialization?.mode).toBe('incremental-overlay');
    expect(result.diagnostics.some(diagnostic => diagnostic.includes('src/broken.ts'))).toBe(true);
  });

  it.each([
    ['a renamed declaration', createRenamedDeclarationRepository, 'resolution-surface-changed'],
    ['a changed lookup signature', createChangedSignatureRepository, 'resolution-surface-changed'],
    ['a changed export surface', createChangedExportRepository, 'resolution-surface-changed'],
    ['changed resolution context', createChangedResolutionContextRepository, 'extractor-context-changed'],
    ['dynamic re-export aliases', createDynamicAliasRepository, 'dynamic-aliases'],
    ['an added eligible file', createAddedFileRepository, 'file-set-changed'],
    ['a deleted eligible file', createDeletedFileRepository, 'file-set-changed'],
  ] as const)('fails closed to full materialization for %s', async (_label, createRepository, fallbackReason) => {
    const root = createRepository();
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});
      }),
    );

    expect(result.materialization).toMatchObject({fallbackReason, mode: 'full'});
    expect(result.materialization?.stagedFiles).toBe(result.materialization?.totalFiles);
    expect(result.diagnostics.some(message => message.startsWith('Dirty overlay used full materialization:'))).toBe(
      true,
    );
  });

  it('indexes aggregate symbols across parser batches without a repository-scale cap', async () => {
    const root = createManySourceRepository(129);
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    expect(first.snapshot.symbolCount).toBeGreaterThan(256);
    const database = new Database(
      join(home, 'indexes', 'code-graph', 'repositories', first.identity.checkoutId, 'graph-v3.sqlite'),
      {readonly: true},
    );
    try {
      const cached = database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM file_blobs').get();
      expect(Number(cached?.count)).toBe(first.snapshot.fileCount);
    } finally {
      database.close();
    }
  });

  it('batches and indexes more than 128 dirty overlay files', async () => {
    const root = createManySourceRepository(129);
    const home = join(root, '.threadnote-test-home');
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    for (let index = 0; index < 129; index += 1) {
      writeFileSync(
        join(root, `src/file-${String(index).padStart(3, '0')}.ts`),
        `export function changed${index}(): number { return ${index}; }\n`,
      );
    }

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'changed128',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, inspected};
      }),
    );

    expect(result.indexed.reusedFiles).toBe(0);
    expect(result.indexed.snapshot.fileCount).toBe(129);
    expect(result.inspected.nodes.some(node => node.name === 'changed128')).toBe(true);
  }, 30_000);

  it('retries when the worktree changes after activation but before pointer promotion', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let changed = false;

    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({
          cwd: root,
          onProgress: progress =>
            Effect.sync(() => {
              if (!changed && progress.phase === 'activating' && progress.subphase === 'promoting') {
                changed = true;
                replaceFunction(root, 'ensureVectorIndex', 'ensureRacedVectorIndex');
              }
            }),
          threadnoteHome: home,
        });
        return yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureRacedVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
      }),
    );

    expect(indexed.freshness).toBe('current');
    expect(indexed.nodes.some(node => node.name === 'ensureRacedVectorIndex')).toBe(true);
  });

  it('removes stale committed facts when a changed source becomes ineligible', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    writeFileSync(join(root, 'packages/search/src/vector-index.ts'), new Uint8Array([0, 1, 2, 3]));

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const inspected = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          refresh: false,
          threadnoteHome: home,
        });
        return {indexed, inspected};
      }),
    );

    expect(result.indexed.snapshot).toMatchObject({dirty: true, fileCount: first.snapshot.fileCount - 1});
    expect(result.inspected.nodes.some(node => node.name === 'ensureVectorIndex')).toBe(false);
  });

  it('does not follow a repository-controlled ignore-file symlink', async () => {
    const root = createFixtureRepository();
    const outside = temporaryDirectory('threadnote-code-graph-ignore-outside-');
    const outsideIgnore = join(outside, 'outside-ignore');
    writeFileSync(outsideIgnore, 'packages/**\n');
    symlinkSync(outsideIgnore, join(root, '.threadnoteignore'));

    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: join(root, '.threadnote-test-home')});
      }),
    );

    expect(indexed.snapshot.fileCount).toBeGreaterThanOrEqual(10);
  });

  it('does not follow a dirty-overlay symlink outside the repository', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-overlay-outside-');
    const outsideSource = join(outside, 'outside.ts');
    writeFileSync(outsideSource, 'export function outsideSecretSymbol(): string { return "private"; }\n');
    const tracked = join(root, 'packages', 'search', 'src', 'vector-index.ts');
    rmSync(tracked);
    symlinkSync(outsideSource, tracked);

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'outsideSecretSymbol',
          threadnoteHome: home,
        });
      }),
    );

    expect(result.nodes.some(node => node.name === 'outsideSecretSymbol')).toBe(false);
  });

  it('does not follow a dirty-overlay ancestor symlink outside the repository', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-overlay-ancestor-outside-');
    writeFileSync(
      join(outside, 'vector-index.ts'),
      'export function outsideAncestorSecret(): string { return "x"; }\n',
    );
    writeFileSync(join(outside, 'recall-index.ts'), 'export function outsideRecallSecret(): string { return "x"; }\n');
    const sourceRoot = join(root, 'packages', 'search', 'src');
    renameSync(sourceRoot, join(root, '.original-search-source'));
    symlinkSync(outside, sourceRoot, 'dir');

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'outsideAncestorSecret',
          threadnoteHome: home,
        });
      }),
    );

    expect(result.nodes.some(node => node.name === 'outsideAncestorSecret')).toBe(false);
  });

  it('rejects an external file opened through an ancestor swapped between validation and open', async () => {
    const root = createFixtureRepository();
    const outside = temporaryDirectory('threadnote-code-graph-overlay-coordinated-outside-');
    const relative = 'packages/search/src/vector-index.ts';
    const sourceRoot = join(root, 'packages', 'search', 'src');
    const originalSourceRoot = join(root, 'packages', 'search', 'original-src');
    writeFileSync(
      join(outside, 'vector-index.ts'),
      'export function coordinatedOutsideSecret(): string { return "outside"; }\n',
    );

    const result = runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repositoryRoot = yield* fs.realPath(root);
        return yield* readContainedStableRegularFile(fs, path, repositoryRoot, relative, {
          afterOpen: Effect.sync(() => {
            rmSync(sourceRoot);
            renameSync(originalSourceRoot, sourceRoot);
          }),
          beforeOpen: Effect.sync(() => {
            renameSync(sourceRoot, originalSourceRoot);
            symlinkSync(outside, sourceRoot, 'dir');
          }),
        });
      }),
    );

    await expect(result).rejects.toThrow(/Could not safely read repository path/);
    expect(readFileSync(join(sourceRoot, 'vector-index.ts'), 'utf8')).not.toContain('coordinatedOutsideSecret');
  });

  it('keeps hot queries incremental and returns stale query evidence without a blocking rebuild', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    let progressEvents = 0;
    let hotObservations = 0;
    let strictObservations = 0;
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        const hot = yield* query.inspect({
          cwd: root,
          interlock: {
            afterObservation: () => Effect.sync(() => (hotObservations += 1)),
          },
          onProgress: () => Effect.sync(() => (progressEvents += 1)),
          operation: 'query',
          query: 'exclusive file lock',
          refresh: false,
          threadnoteHome: home,
        });
        const strict = yield* query.inspect({
          cwd: root,
          from: 'runApplication',
          interlock: {
            afterObservation: () => Effect.sync(() => (strictObservations += 1)),
          },
          operation: 'path',
          refresh: false,
          threadnoteHome: home,
          to: 'withExclusiveFileLock',
        });
        replaceFunction(root, 'ensureVectorIndex', 'ensureStaleVectorIndex');
        const stale = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'ensureVectorIndex',
          threadnoteHome: home,
        });
        return {hot, stale, strict};
      }),
    );

    expect(progressEvents).toBe(0);
    expect(hotObservations).toBe(1);
    expect(strictObservations).toBe(3);
    expect(result.hot.freshness).toBe('current');
    expect(result.strict.freshness).toBe('current');
    expect(result.stale.freshness).toBe('stale');
  });

  it('changes the overlay fingerprint for successive edits to an already-modified file', async () => {
    const root = createFixtureRepository();
    const states = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        replaceFunction(root, 'ensureVectorIndex', 'ensureFirstVectorIndex');
        const first = yield* worktreeOverlayState(identity);
        replaceFunction(root, 'ensureFirstVectorIndex', 'ensureSecondVectorIndex');
        const second = yield* worktreeOverlayState(identity);
        return [first, second] as const;
      }),
    );

    expect(states[0].dirty).toBe(true);
    expect(states[1].dirty).toBe(true);
    expect(states[0].fingerprint).not.toBe(states[1].fingerprint);
  });

  it('indexes a manifest-declared Android module named pods while pruning generated CocoaPods output', async () => {
    const root = temporaryDirectory('threadnote-code-graph-declared-pods-');
    git(root, ['init', '-q']);
    mkdirSync(join(root, 'modules', 'pods', 'src', 'main', 'kotlin'), {recursive: true});
    mkdirSync(join(root, 'ios', 'Pods', 'Headers'), {recursive: true});
    writeFileSync(
      join(root, 'settings.gradle.kts'),
      [
        'rootProject.name = "mobile"',
        'include(":pods")',
        'project(":pods").projectDir = file("modules/pods")',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'modules', 'pods', 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
    writeFileSync(join(root, 'modules', 'pods', 'src', 'main', 'kotlin', 'PodsService.kt'), 'class PodsService\n');
    writeFileSync(join(root, 'ios', 'Pods', 'Headers', 'Generated.h'), 'void generated(void);\n');
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'fixture',
    ]);

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );
    const paths = inventory.files.map(file => file.path);

    expect(paths).toContain('modules/pods/src/main/kotlin/PodsService.kt');
    expect(paths).not.toContain('ios/Pods/Headers/Generated.h');

    writeFileSync(
      join(root, 'settings.gradle.kts'),
      [
        'rootProject.name = "mobile"',
        'include(":pods", ":out")',
        'project(":pods").projectDir = file("modules/pods")',
        'project(":out").projectDir = file("modules/out")',
        '',
      ].join('\n'),
    );
    mkdirSync(join(root, 'modules', 'out', 'src', 'main', 'kotlin'), {recursive: true});
    writeFileSync(join(root, 'modules', 'out', 'src', 'main', 'kotlin', 'NewModule.kt'), 'class NewModule\n');
    const dirtyInventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity);
      }),
    );
    expect(dirtyInventory.files.map(file => file.path)).toContain('modules/out/src/main/kotlin/NewModule.kt');
  });

  it('keeps oversized dirty corpus artifacts metadata-only while preserving an exact fingerprint', async () => {
    const root = temporaryDirectory('threadnote-code-graph-dirty-corpus-');
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'README.md'), '# fixture\n');
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'fixture',
    ]);
    mkdirSync(join(root, 'media'), {recursive: true});
    const artifact = join(root, 'media', 'architecture.pdf');
    writeFileSync(artifact, '%PDF-1.7\n');
    truncateSync(artifact, 64 * 1_048_576 + 1);
    const cachedBatches: Array<
      readonly {
        readonly bytes?: Uint8Array;
        readonly content?: string;
        readonly contentOmittedReason?: 'size-budget';
        readonly path: string;
      }[]
    > = [];

    const inventory = await runEffect(
      Effect.gen(function* () {
        const identity = yield* resolveRepositoryIdentity(root);
        return yield* inventoryRepository(identity, {
          onContentBatch: files => Effect.sync(() => cachedBatches.push(files)),
        });
      }),
    );
    const file = inventory.files.find(candidate => candidate.path === 'media/architecture.pdf');
    const cached = cachedBatches.flat().find(candidate => candidate.path === file?.path);

    expect(file).toMatchObject({size: 64 * 1_048_576 + 1});
    expect(file?.bytes).toBeUndefined();
    expect(file?.content).toBeUndefined();
    expect(file?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cached).toMatchObject({contentOmittedReason: 'size-budget'});
    expect(cached?.bytes).toBeUndefined();
    expect(cached?.content).toBeUndefined();
  });

  it('keeps the overlay stable when untracked files become intent-to-add entries', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    mkdirSync(join(root, '.codex'), {recursive: true});
    writeFileSync(join(root, '.codex', 'local.json'), '{"ignored":true}\n');
    writeFileSync(join(root, 'intent-source.ts'), 'export function intentSource(): string { return "ready"; }\n');

    const first = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    git(root, ['add', '--intent-to-add', '--all']);
    const second = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(second.snapshot.overlayFingerprint).toBe(first.snapshot.overlayFingerprint);
    expect(second.reusedFiles).toBe(second.snapshot.fileCount);
  });

  it('uses all supplied changed-path seeds for impact traversal', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const impact = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        return yield* query.inspect({
          cwd: root,
          operation: 'impact',
          query: 'changed paths',
          refresh: false,
          seedQueries: ['packages/search/src/vector-index.ts', 'packages/search/src/recall-index.ts'],
          threadnoteHome: home,
        });
      }),
    );

    expect(impact.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['ensureVectorIndex', 'refreshRecallIndex', 'runApplication']),
    );
  });

  it('recovers impact from symbols deleted since the base snapshot', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const clean = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    rmSync(join(root, 'packages/core/src/lock.ts'));

    const impact = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* query.inspect({
          baseCommit: clean.snapshot.commit,
          cwd: root,
          depth: 1,
          operation: 'impact',
          query: 'changed paths',
          refresh: true,
          seedQueries: ['packages/core/src/lock.ts'],
          threadnoteHome: home,
        });
      }),
    );

    expect(impact.nodes.map(node => node.name)).toEqual(
      expect.arrayContaining(['ensureVectorIndex', 'refreshRecallIndex']),
    );
    expect(impact.nodes.map(node => node.name)).not.toContain('runApplication');
    expect(impact.warnings.join('\n')).toContain('deleted path(s) from base snapshot');
    expect(impact.warnings.join('\n')).toContain('base-only relationships are omitted');
  });

  it('does not discover nodes through relationships omitted by the edge budget', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const [shallow, deep] = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        const first = yield* query.inspect({
          cwd: root,
          depth: 1,
          edgeLimit: 1,
          nodeLimit: 200,
          operation: 'explain',
          symbol: 'runApplication',
          threadnoteHome: home,
        });
        const second = yield* query.inspect({
          cwd: root,
          depth: 8,
          edgeLimit: 1,
          nodeLimit: 200,
          operation: 'explain',
          refresh: false,
          symbol: 'runApplication',
          threadnoteHome: home,
        });
        return [first, second] as const;
      }),
    );

    expect(deep.edges).toHaveLength(1);
    expect(deep.edges).toEqual(shallow.edges);
    expect(deep.nodes.map(node => node.id)).toEqual(shallow.nodes.map(node => node.id));
  });

  it('keeps heuristic and model relationship opt-ins independent', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const indexed = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        return yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      indexed.identity.checkoutId,
      'graph-v3.sqlite',
    );
    const database = new Database(databasePath);
    try {
      const source = database
        .query<{readonly id: string}, [string, string]>(
          'SELECT id FROM symbols WHERE snapshot_id = ? AND name = ? LIMIT 1',
        )
        .get(indexed.snapshot.id, 'runApplication');
      const target = database
        .query<{readonly id: string}, [string, string]>(
          'SELECT id FROM symbols WHERE snapshot_id = ? AND name = ? LIMIT 1',
        )
        .get(indexed.snapshot.id, 'withExclusiveFileLock');
      expect(source?.id).toBeDefined();
      expect(target?.id).toBeDefined();
      if (!source || !target) throw new Error('Fixture graph symbols were not indexed.');
      const insert = database.query(
        `INSERT INTO edges (
          snapshot_id, id, source_id, source_name, relation, target_id, target_name,
          provenance, confidence, evidence_path, evidence_span_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        indexed.snapshot.id,
        'test-heuristic-edge',
        source.id,
        'runApplication',
        'references',
        target.id,
        'withExclusiveFileLock',
        'heuristic',
        0.5,
        'packages/app/src/main.ts',
        '{"line":1,"column":1,"endLine":1,"endColumn":2}',
      );
      insert.run(
        indexed.snapshot.id,
        'test-model-edge',
        source.id,
        'runApplication',
        'semantic_association',
        target.id,
        'withExclusiveFileLock',
        'model',
        0.5,
        'packages/app/src/main.ts',
        '{"line":1,"column":1,"endLine":1,"endColumn":2}',
      );
    } finally {
      database.close();
    }

    const [plain, heuristic, model, both] = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        const inspect = (includeHeuristic: boolean, includeModelAssociations: boolean) =>
          query.inspect({
            cwd: root,
            depth: 1,
            edgeLimit: 200,
            includeHeuristic,
            includeModelAssociations,
            nodeLimit: 200,
            operation: 'explain',
            refresh: false,
            symbol: 'runApplication',
            threadnoteHome: home,
          });
        return yield* Effect.all(
          [inspect(false, false), inspect(true, false), inspect(false, true), inspect(true, true)],
          {concurrency: 1},
        );
      }),
    );
    const optionalEdgeIds = (result: typeof plain) =>
      result.edges.map(edge => edge.id).filter(id => id.startsWith('test-'));

    expect(optionalEdgeIds(plain)).toEqual([]);
    expect(optionalEdgeIds(heuristic)).toEqual(['test-heuristic-edge']);
    expect(optionalEdgeIds(model)).toEqual(['test-model-edge']);
    expect(new Set(optionalEdgeIds(both))).toEqual(new Set(['test-heuristic-edge', 'test-model-edge']));
  });

  it('reserves an impact seed for every changed path at the 200-path boundary', async () => {
    const root = temporaryDirectory('threadnote-code-graph-impact-boundary-');
    const home = join(root, '.threadnote-test-home');
    mkdirSync(join(root, 'src'), {recursive: true});
    const seedQueries = Array.from({length: 201}, (_, index) => {
      const relative = `src/changed-${String(index).padStart(3, '0')}.ts`;
      writeFileSync(
        join(root, relative),
        `export function changedSymbol${String(index).padStart(3, '0')}(): number { return ${index}; }\n`,
      );
      return relative;
    });
    writeFileSync(
      join(root, 'src/boundary-consumer.ts'),
      "import {changedSymbol199} from './changed-199.js';\n" +
        'export function boundaryConsumer(): number { return changedSymbol199(); }\n',
    );
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'impact boundary',
    ]);

    const [impact, defaultLimit, partial] = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* Effect.all(
          [
            query.inspect({
              cwd: root,
              depth: 0,
              edgeLimit: 1,
              nodeLimit: 200,
              operation: 'impact',
              query: 'changed paths',
              seedQueries: seedQueries.slice(0, 200),
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              depth: 1,
              edgeLimit: 500,
              operation: 'impact',
              query: 'changed paths',
              refresh: false,
              seedQueries: seedQueries.slice(0, 200),
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              depth: 0,
              edgeLimit: 1,
              nodeLimit: 200,
              operation: 'impact',
              query: 'changed paths',
              seedQueries,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
      }),
    );

    expect(impact.nodes).toHaveLength(200);
    expect(new Set(impact.nodes.map(node => node.path))).toEqual(new Set(seedQueries.slice(0, 200)));
    expect(impact.warnings.some(warning => warning.includes('changed paths; results are partial'))).toBe(false);
    expect(defaultLimit.nodes.some(node => node.name === 'boundaryConsumer')).toBe(true);
    expect(partial.warnings).toContain('Impact analysis evaluated 200 of 201 changed paths; results are partial.');
  });

  it('sanitizes repository-controlled fields and bounds query output', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    writeFileSync(
      join(root, 'docs/danger.md'),
      `# danger\u001b]8;;https://example.invalid\u0007${'x'.repeat(5_000)}\n`,
    );

    const result = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: 'danger',
          threadnoteHome: home,
        });
      }),
    );

    expect(JSON.stringify(result)).not.toContain('\u001b');
    expect(result.nodes.find(node => node.name.includes('danger'))?.name.length).toBeLessThanOrEqual(256);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(270_000);
  });

  it('purges every repository-scoped derived graph artifact', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const repositoryRoot = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const derivedRoot = join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId);
        mkdirSync(join(derivedRoot, 'vectors', 'test'), {recursive: true});
        writeFileSync(join(derivedRoot, 'vectors', 'test', 'orphan.bin'), 'derived');
        return yield* query.purge(home, root);
      }),
    );

    expect(existsSync(repositoryRoot)).toBe(false);
  });

  it('waits for in-flight repository registration before purging every graph', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const registered = yield* Deferred.make<void>();
        const continueRegistration = yield* Deferred.make<void>();
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'registering'
                ? Deferred.succeed(registered, undefined).pipe(
                    Effect.andThen(Deferred.await(continueRegistration)),
                    Effect.asVoid,
                  )
                : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(registered);
        const purge = yield* Effect.forkChild(purgeAllCodeGraphIndexes(home));
        yield* Effect.yieldNow;
        expect(existsSync(join(home, 'indexes', 'code-graph', 'repositories'))).toBe(true);
        yield* Deferred.succeed(continueRegistration, undefined);
        yield* Effect.exit(Fiber.join(indexing));
        yield* Fiber.join(purge);
      }),
    );

    expect(existsSync(join(home, 'indexes', 'code-graph'))).toBe(false);
  });

  it('reports repository lock contention and resumes after the active graph build releases it', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const lock = join(home, 'locks', 'indexes', 'code-graph', `${identity.checkoutId}.lock`);
    mkdirSync(join(home, 'locks', 'indexes', 'code-graph'), {recursive: true});
    writeFileSync(lock, `${process.pid}:active-code-graph-build\n`, {mode: 0o600});

    const summary = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const waiting = yield* Deferred.make<void>();
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'waiting' ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid) : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(waiting);
        rmSync(lock, {force: true});
        return yield* Fiber.join(indexing);
      }),
    );

    expect(summary.snapshot.state).toBe('ready');
  });

  it('rejects a derived repository symlink before opening SQLite', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-database-outside-');
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', identity.checkoutId);

    const exit = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const registered = yield* Deferred.make<void>();
        const continueRegistration = yield* Deferred.make<void>();
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'registering'
                ? Deferred.succeed(registered, undefined).pipe(
                    Effect.andThen(Deferred.await(continueRegistration)),
                    Effect.asVoid,
                  )
                : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Deferred.await(registered);
        rmSync(repositoryRoot, {force: true, recursive: true});
        symlinkSync(outside, repositoryRoot, 'dir');
        yield* Deferred.succeed(continueRegistration, undefined);
        return yield* Effect.exit(Fiber.join(indexing));
      }),
    );

    expect(exit._tag).toBe('Failure');
    expect(existsSync(join(outside, 'graph-v3.sqlite'))).toBe(false);
  });

  it('recovers a maintenance intent left by a crashed process', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const intent = join(home, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
    mkdirSync(join(home, 'locks', 'indexes', 'code-graph'), {recursive: true});
    writeFileSync(intent, '999999999:crashed-maintenance\n');

    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* purgeAllCodeGraphIndexes(home);
      }),
    );

    expect(existsSync(intent)).toBe(false);
    expect(existsSync(join(home, 'indexes', 'code-graph'))).toBe(false);
  });

  it('recovers a maintenance intent whose process id was reused', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const intent = join(home, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
    mkdirSync(join(home, 'locks', 'indexes', 'code-graph'), {recursive: true});

    await runEffect(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        writeFileSync(
          intent,
          `${JSON.stringify({
            processId: system.processId,
            processStartIdentity: 'different-process-instance',
            token: 'reused-process-id',
          })}\n`,
        );
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    expect(existsSync(intent)).toBe(false);
  });

  it('refuses ambiguous path endpoints and accepts explicit path#symbol selectors', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(
        join(root, `packages/app/src/duplicate-${String(index).padStart(2, '0')}.ts`),
        `export function runApplication(): string { return 'duplicate-${index}'; }\n`,
      );
    }

    const [ambiguous, explicit] = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        const first = yield* graph.inspect({
          cwd: root,
          from: 'runApplication',
          operation: 'path',
          threadnoteHome: home,
          to: 'withExclusiveFileLock',
        });
        const second = yield* graph.inspect({
          cwd: root,
          from: 'packages/app/src/main.ts#runApplication',
          operation: 'path',
          refresh: false,
          threadnoteHome: home,
          to: 'packages/core/src/lock.ts#withExclusiveFileLock',
        });
        return [first, second] as const;
      }),
    );

    expect(ambiguous.edges).toEqual([]);
    expect(ambiguous.warnings.join('\n')).toContain('is ambiguous; use path#symbol');
    expect(explicit.edges.map(edge => `${edge.sourceName}:${edge.targetName}`)).toEqual([
      'runApplication:ensureVectorIndex',
      'ensureVectorIndex:withExclusiveFileLock',
    ]);
  });

  it('does not remove an export path created by another process before exclusive open', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-export.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );

    await expect(
      runEffect(
        runCodeGraphExport(config, {
          cwd: root,
          format: 'json',
          interlock: {
            afterOutputCheck: () => Effect.sync(() => writeFileSync(output, 'other-process\n')),
          },
          output,
        }),
      ),
    ).rejects.toThrow();

    expect(readFileSync(output, 'utf8')).toBe('other-process\n');
    expect(
      readdirSync(root).filter(entry => entry.startsWith('.graph-export.json.') && entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('publishes exports atomically as private files without leaving a temporary sibling', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-export.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* runCodeGraphExport(config, {cwd: root, format: 'json', output});
      }),
    );

    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({type: 'threadnote-code-graph-export'});
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(root).filter(entry => entry.startsWith('.graph-export.json.') && entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('does not publish or unlink a temporary path replaced before atomic publication', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const output = join(root, 'graph-export.json');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
      }),
    );
    let replacement = '';

    await expect(
      runEffect(
        runCodeGraphExport(config, {
          cwd: root,
          format: 'json',
          interlock: {
            beforePublish: temporary =>
              Effect.sync(() => {
                replacement = temporary;
                rmSync(temporary);
                writeFileSync(temporary, 'replacement owned by another process\n');
              }),
          },
          output,
        }),
      ),
    ).rejects.toThrow('no longer identifies');

    expect(existsSync(output)).toBe(false);
    expect(readFileSync(replacement, 'utf8')).toBe('replacement owned by another process\n');
  });

  it('keeps status read-only and repairs only disposable incomplete graph state', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const progress: string[] = [];
    const before = await runEffect(
      Effect.gen(function* () {
        const query = yield* CodeGraphQueryService;
        return yield* query.status(home, root);
      }),
    );
    expect(before.readySnapshot).toBeUndefined();
    expect(existsSync(before.databasePath)).toBe(false);
    expect(before.languagePacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'typescript',
          languages: expect.arrayContaining(['javascript', 'typescript']),
          workspaceDetection: false,
        }),
        expect.objectContaining({id: 'manifests', workspaceDetection: true}),
        expect.objectContaining({assetCount: 1, id: 'java', languages: ['java']}),
        expect.objectContaining({assetCount: 1, id: 'kotlin', languages: ['kotlin']}),
        expect.objectContaining({assetCount: 1, id: 'swift', languages: ['swift']}),
      ]),
    );

    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const store = yield* CodeGraphStore;
        const query = yield* CodeGraphQueryService;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        replaceFunction(root, 'ensureVectorIndex', 'ensureDirtyVectorIndex');
        const stale = yield* query.status(home, root);
        yield* store.markBuilding(before.databasePath, indexed.identity, {
          ...indexed.snapshot,
          id: `${indexed.snapshot.id}-interrupted`,
          state: 'building',
        });
        yield* Effect.sync(() => {
          const database = new Database(before.databasePath);
          try {
            database
              .query(
                'INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                'orphaned-content',
                'orphaned-extractor',
                'orphaned.ts',
                '{"diagnostics":[],"edges":[],"path":"orphaned.ts","symbols":[]}',
                new Date().toISOString(),
              );
          } finally {
            database.close();
          }
        });
        const repair = yield* repairCodeGraphIndexes(home, false, state =>
          Effect.sync(() =>
            progress.push(
              `${state.phase}:${state.current}/${state.total}${state.snapshots ? `:${state.snapshots}` : ''}`,
            ),
          ),
        );
        return {
          health: yield* store.diagnose(before.databasePath),
          indexed,
          repair,
          stale,
        };
      }),
    );

    expect(result.repair).toMatchObject({
      databases: 1,
      discarded: 0,
      removedIncompleteSnapshots: 1,
    });
    expect(progress).toEqual(['checking:1/1', 'cleaning-snapshots:1/1:1', 'cleaning-vectors:1/1']);
    expect(result.stale.stale).toBe(true);
    expect(result.health).toMatchObject({
      buildingSnapshots: 0,
      cachedFileBlobs: result.indexed.snapshot.fileCount,
      integrity: 'ok',
      readySnapshots: 1,
    });
  });

  it('streams progress while doctor and repair inspect graph databases', async () => {
    const root = createFixtureRepository();
    const secondRoot = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const doctorProgress: string[] = [];
    const repairProgress: string[] = [];
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* indexer.index({cwd: secondRoot, threadnoteHome: home});
        const doctor = yield* codeGraphDoctorCheck(home, progress =>
          Effect.sync(() => doctorProgress.push(`${progress.phase}:${progress.current}/${progress.total}`)),
        );
        const repair = yield* repairCodeGraphIndexes(home, false, progress =>
          Effect.sync(() => repairProgress.push(`${progress.phase}:${progress.current}/${progress.total}`)),
        );
        return {doctor, repair};
      }),
    );

    expect(result.doctor).toMatchObject({status: 'ok'});
    expect(result.repair).toMatchObject({databases: 2, discarded: 0});
    expect(doctorProgress).toEqual(['checking:1/2', 'checking:2/2']);
    expect(repairProgress).toEqual(['checking:1/2', 'cleaning-vectors:1/2', 'checking:2/2', 'cleaning-vectors:2/2']);
  });

  it('streams progress before discarding an incompatible derived database', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const progress: string[] = [];
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        const status = yield* query.status(home, root);
        yield* Effect.sync(() => setGraphSchemaVersion(status.databasePath, '999'));
        const repair = yield* repairCodeGraphIndexes(home, false, state =>
          Effect.sync(() => progress.push(`${state.phase}:${state.current}/${state.total}`)),
        );
        return {databasePath: status.databasePath, repair};
      }),
    );

    expect(result.repair).toMatchObject({
      databases: 1,
      discarded: 1,
    });
    expect(progress).toEqual(['checking:1/1', 'discarding:1/1']);
    expect(existsSync(result.databasePath)).toBe(false);
  });

  it('keeps default lifecycle repair bounded and points deep maintenance to an explicit command', async () => {
    const root = createFixtureRepository();
    const secondRoot = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'seed-manifest.yaml'),
      user: 'tester',
    };
    const output = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const first = yield* indexer.index({cwd: root, threadnoteHome: home});
        yield* indexer.index({cwd: secondRoot, threadnoteHome: home});
        const firstStatus = yield* query.status(home, root);
        const secondStatus = yield* query.status(home, secondRoot);
        yield* store.markBuilding(firstStatus.databasePath, first.identity, {
          ...first.snapshot,
          id: `${first.snapshot.id}-interrupted`,
          state: 'building',
        });
        yield* Effect.sync(() => setGraphSchemaVersion(secondStatus.databasePath, '999'));
        const doctor = yield* captureConsole(runDoctor(config, {dryRun: true}));
        const repair = yield* captureConsole(runRepair(config, {dryRun: true, mcp: 'none', postUpdate: false}));
        return {doctor: doctor.output, repair: repair.output};
      }),
    );

    expect(output.doctor.match(/Checking native code graph database [12]\/2\./g)).toHaveLength(2);
    expect(output.doctor).toContain(
      'FAIL native code graph: 2 database(s); 1 ready snapshot(s); 1 incomplete snapshot(s); ' +
        '1 database(s) need a disposable rebuild',
    );
    expect(output.repair.match(/Checking native code graph database [12]\/2\./g)).toHaveLength(2);
    expect(
      output.repair.match(
        /Deferred native code graph database [12]\/2: run `threadnote repair --deep` when a full derived-store check is convenient\./g,
      ),
    ).toHaveLength(2);
    expect(output.repair).toContain(
      'Would repair 2 native code graph database(s): 2 deferred, 0 disposable rebuild(s), 0 incomplete snapshot(s), ' +
        '0 temporary vector file(s).',
    );
    expect(output.repair).toContain(
      'WARN native code graph: 2 database(s); 1 ready snapshot(s); 0 incomplete snapshot(s); ' +
        '2 database maintenance check(s) deferred',
    );
  });

  it('holds the maintenance gate while the repair diagnosis is consumed', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        yield* indexer.index({cwd: root, threadnoteHome: home});
        const diagnosed = yield* Deferred.make<DoctorCheck>();
        const releaseDiagnosis = yield* Deferred.make<void>();
        const registered = yield* Deferred.make<void>();
        const repairing = yield* Effect.forkChild(
          repairCodeGraphIndexes(home, false, undefined, completion =>
            Deferred.succeed(diagnosed, completion.doctorCheck).pipe(
              Effect.andThen(Deferred.await(releaseDiagnosis)),
              Effect.asVoid,
            ),
          ),
        );
        const check = yield* Deferred.await(diagnosed);
        replaceFunction(root, 'ensureVectorIndex', 'ensureAfterRepairVectorIndex');
        const indexing = yield* Effect.forkChild(
          indexer.index({
            cwd: root,
            onProgress: progress =>
              progress.phase === 'registering'
                ? Deferred.succeed(registered, undefined).pipe(Effect.asVoid)
                : Effect.void,
            threadnoteHome: home,
          }),
        );
        yield* Effect.yieldNow;
        const registeredBeforeRelease = yield* Deferred.isDone(registered);
        yield* Deferred.succeed(releaseDiagnosis, undefined);
        const repair = yield* Fiber.join(repairing);
        yield* Fiber.join(indexing);
        return {
          check,
          registeredAfterRelease: yield* Deferred.isDone(registered),
          registeredBeforeRelease,
          repair,
        };
      }),
    );

    expect(result.check.status).toBe('ok');
    expect(result.registeredBeforeRelease).toBe(false);
    expect(result.registeredAfterRelease).toBe(true);
    expect(result.repair).toMatchObject({databases: 1, discarded: 0});
  });

  it('does not follow vector cleanup symlinks outside the derived index root', async () => {
    const root = createFixtureRepository();
    const home = join(root, '.threadnote-test-home');
    const outside = temporaryDirectory('threadnote-code-graph-vector-outside-');
    const victim = join(outside, 'victim.tmp');
    writeFileSync(victim, 'must survive');
    const repositoryRoot = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        return join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId);
      }),
    );
    mkdirSync(join(repositoryRoot, 'vectors'), {recursive: true});
    symlinkSync(outside, join(repositoryRoot, 'vectors', 'outside-link'), 'dir');

    await runEffect(repairCodeGraphIndexes(home, false));

    expect(readFileSync(victim, 'utf8')).toBe('must survive');
  });

  it('indexes eligible files in a repository before its first commit', async () => {
    const root = temporaryDirectory('threadnote-code-graph-unborn-');
    git(root, ['init', '-q']);
    writeFileSync(join(root, 'unborn.ts'), 'export function unbornSymbol(): string { return "ready"; }\n');
    git(root, ['add', 'unborn.ts']);

    const result = await runEffect(
      Effect.gen(function* () {
        const graph = yield* CodeGraphQueryService;
        return yield* graph.inspect({
          cwd: root,
          operation: 'query',
          query: 'unbornSymbol',
          threadnoteHome: join(root, '.threadnote-test-home'),
        });
      }),
    );

    expect(result.snapshot.commit).toMatch(/^0{40}$/);
    expect(result.nodes.some(node => node.name === 'unbornSymbol')).toBe(true);
  });
});

function createFixtureRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-');
  cpSync(FIXTURE_REPOSITORY, root, {recursive: true});
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function createManySourceRepository(count: number): string {
  const root = temporaryDirectory('threadnote-code-graph-many-');
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(root, `src/file-${String(index).padStart(3, '0')}.ts`),
      `export function original${index}(): number { return ${index}; }\n`,
    );
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  return root;
}

function createBodyModifiedRepository(count = 4): string {
  const root = createManySourceRepository(count);
  if (count > 1) {
    writeFileSync(
      join(root, 'src/file-001.ts'),
      'import {original0} from "./file-000.js";\nexport function original1(): number { return original0(); }\n',
    );
    git(root, ['add', 'src/file-001.ts']);
    git(root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '-qm',
      'cross-file relation',
    ]);
  }
  const file = join(root, 'src/file-000.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('return 0;', 'return 1000;'));
  return root;
}

function createBodyModifiedRepositoryWithCommittedDiagnostic(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'src/broken.ts'), 'export function broken(): number {\n');
  git(root, ['add', 'src/broken.ts']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'broken committed source',
  ]);
  const modified = join(root, 'src/file-000.ts');
  writeFileSync(modified, readFileSync(modified, 'utf8').replace('return 0;', 'return 1000;'));
  return root;
}

function createRenamedDeclarationRepository(): string {
  const root = createManySourceRepository(4);
  const file = join(root, 'src/file-000.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('original0', 'renamed0'));
  return root;
}

function createChangedSignatureRepository(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'src/file-000.ts'), 'export function original0(value: number): number { return value; }\n');
  return root;
}

function createChangedExportRepository(): string {
  const root = createManySourceRepository(4);
  const file = join(root, 'src/file-000.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('export function', 'function'));
  return root;
}

function createChangedResolutionContextRepository(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: false}}));
  git(root, ['add', 'tsconfig.json']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'resolution context',
  ]);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: true}}));
  return root;
}

function createDynamicAliasRepository(): string {
  const root = temporaryDirectory('threadnote-code-graph-dynamic-alias-');
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'src/source.ts'), 'export function value(): number { return 1; }\n');
  writeFileSync(join(root, 'src/index.ts'), '// committed\nexport {value} from "./source.js";\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  writeFileSync(join(root, 'src/index.ts'), '// dirty\nexport {value} from "./source.js";\n');
  return root;
}

function createAddedFileRepository(): string {
  const root = createManySourceRepository(4);
  writeFileSync(join(root, 'src/added.ts'), 'export function added(): number { return 5; }\n');
  return root;
}

function createDeletedFileRepository(): string {
  const root = createManySourceRepository(4);
  rmSync(join(root, 'src/file-000.ts'));
  return root;
}

function codeGraphDatabasePath(home: string, indexed: {readonly identity: {readonly checkoutId: string}}): string {
  return join(home, 'indexes', 'code-graph', 'repositories', indexed.identity.checkoutId, 'graph-v3.sqlite');
}

function normalizeStoredGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...graph.symbols].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function createLargeInventoryRepository(count: number, bytes = 1_048_576): string {
  const root = temporaryDirectory('threadnote-code-graph-large-inventory-');
  git(root, ['init', '-q']);
  const prefix = '# large inventory fixture\n';
  const content = `${prefix}${' '.repeat(bytes - Buffer.byteLength(prefix))}`;
  const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], {
    encoding: 'utf8',
    input: content,
  }).trim();
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const relative = `docs/file-${String(index).padStart(3, '0')}.md`;
    paths.push(relative);
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${relative}`]);
  }
  git(root, ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  for (const relative of paths) git(root, ['update-index', '--skip-worktree', relative]);
  return root;
}

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function replaceFunction(root: string, from: string, to: string): void {
  const path = join(root, 'packages/search/src/vector-index.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll(from, to));
}

function snapshotFileHash(databasePath: string, snapshotId: string, sourcePath: string): string {
  const database = new Database(databasePath, {readonly: true});
  try {
    const row = database
      .query<{readonly content_hash: string}, [string, string]>(
        'SELECT content_hash FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
      )
      .get(snapshotId, sourcePath);
    if (!row) throw new Error(`Snapshot ${snapshotId} has no row for ${sourcePath}.`);
    return row.content_hash;
  } finally {
    database.close();
  }
}

function effectiveSnapshotFileHash(databasePath: string, snapshotId: string, sourcePath: string): string {
  const database = new Database(databasePath, {readonly: true});
  try {
    let current: string | undefined = snapshotId;
    while (current !== undefined) {
      const deleted = database
        .query<{readonly present: number}, [string, string]>(
          'SELECT 1 AS present FROM snapshot_file_deletions WHERE snapshot_id = ? AND path = ? LIMIT 1',
        )
        .get(current, sourcePath);
      if (deleted) break;
      const row = database
        .query<{readonly content_hash: string}, [string, string]>(
          'SELECT content_hash FROM snapshot_files WHERE snapshot_id = ? AND path = ?',
        )
        .get(current, sourcePath);
      if (row) return row.content_hash;
      const baseSnapshotId: unknown = database
        .query<{readonly base_snapshot_id: unknown}, [string]>(
          'SELECT base_snapshot_id FROM snapshots WHERE id = ? LIMIT 1',
        )
        .get(current)?.base_snapshot_id;
      current = typeof baseSnapshotId === 'string' ? baseSnapshotId : undefined;
    }
    throw new Error(`Snapshot ${snapshotId} has no effective row for ${sourcePath}.`);
  } finally {
    database.close();
  }
}

function setGraphSchemaVersion(databasePath: string, version: string): void {
  const database = new Database(databasePath);
  try {
    database.query("UPDATE schema_metadata SET value = ? WHERE key = 'schema_version'").run(version);
  } finally {
    database.close();
  }
}
