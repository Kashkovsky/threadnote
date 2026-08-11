import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Context, Effect, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  createCodeGraphLanguagePackRegistry,
  type CodeGraphLanguagePackRegistryShape,
} from '../../src/code_graph/languages/registry.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphStore, type CodeGraphVisualizationCatalog} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type CodeGraphIndexSummary} from '../../src/code_graph/types.js';

describe('cross-session code graph increments', () => {
  it.effect(
    're-promotes a recent clean increment after a dirty-to-clean round trip',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(16);
        const home = join(root, '.threadnote-round-trip');
        const initial = yield* indexAndLoadEffect(root, home);
        expect(initial.summary.materialization?.mode).toBe('full');

        writeUseFile(root, 'committed clean revision');
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean increment']);
        const committed = yield* indexAndLoadEffect(root, home);
        expect(committed.summary.materialization).toEqual({
          mode: 'incremental-clean',
          stagedFiles: 1,
          totalFiles: 18,
        });

        writeUseFile(root, 'temporary dirty revision');
        const dirty = yield* indexAndLoadEffect(root, home);
        expect(dirty.summary.materialization?.mode).toBe('incremental-overlay');
        expect(persistedSnapshotState(committed.databasePath, committed.summary.snapshot.id)).toBe('ready');

        git(root, ['checkout', '--', 'src/use.ts']);
        const restored = yield* indexAndLoadEffect(root, home);
        expect(restored.summary.snapshot.id).toBe(committed.summary.snapshot.id);
        expect(restored.summary.materialization).toEqual({
          mode: 'reused-snapshot',
          stagedFiles: 0,
          totalFiles: 18,
        });
        expect(projectGraph(restored.graph)).toEqual(projectGraph(committed.graph));
        expect(restored.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
        ),
        Effect.provide(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  it.effect('reuses a persisted clean base for a body-only dirty overlay', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(32);
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-incremental-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-full-home-'));
      const indexer = yield* CodeGraphIndexer;
      const clean = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
      expect(clean.materialization?.mode).toBe('full');

      writeUseFile(root, 'second body-only revision');

      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const full = yield* indexer.index({
        cwd: root,
        incrementalOverlay: false,
        threadnoteHome: fullHome,
      });
      const rebuilt = yield* loadGraphEffect(root, fullHome, full);

      expect(incremental.summary.materialization).toEqual({
        mode: 'incremental-overlay',
        stagedFiles: 1,
        totalFiles: 34,
      });
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(rebuilt));
      expect(normalizeCatalog(incremental.catalog)).toEqual(
        normalizeCatalog(yield* loadVisualizationCatalogEffect(fullHome, full)),
      );
      expect(incremental.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      expect(
        incremental.graph.edges.some(
          edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
        ),
      ).toBe(true);
      const delta = persistedDeltaStats(incremental.databasePath, incremental.summary.snapshot.id);
      expect(delta).toEqual({
        activeLeases: 0,
        edgePaths: ['src/use.ts'],
        filePaths: ['src/use.ts'],
        symbolPaths: ['src/use.ts'],
      });
      expect(incremental.summary.diagnostics).toContain(
        'Dirty overlay reused persisted clean base for 1 modified file(s).',
      );
    }).pipe(
      Effect.provide(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('matches full rebuilds when changed-file relationships are added or deleted', () => {
    const temporaryPaths: string[] = [];
    return Effect.gen(function* () {
      const indexer = yield* CodeGraphIndexer;
      for (const operation of ['add', 'delete'] as const) {
        const root = createRepository();
        temporaryPaths.push(root);
        const incrementalHome = mkdtempSync(join(tmpdir(), `threadnote-${operation}-incremental-home-`));
        temporaryPaths.push(incrementalHome);
        const fullHome = mkdtempSync(join(tmpdir(), `threadnote-${operation}-full-home-`));
        temporaryPaths.push(fullHome);
        if (operation === 'add') writeUseFileWithoutCall(root, 'clean no-call revision');
        git(root, ['add', '.']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        yield* indexAndLoadEffect(root, incrementalHome);
        if (operation === 'add') writeUseFile(root, 'dirty call revision');
        else writeUseFileWithoutCall(root, 'dirty no-call revision');

        const incremental = yield* indexAndLoadEffect(root, incrementalHome);
        const fullSummary = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
        const full = yield* loadGraphEffect(root, fullHome, fullSummary);
        expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
        expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
        expect(
          incremental.graph.edges.some(
            edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
          ),
        ).toBe(operation === 'add');
      }
    }).pipe(
      Effect.provide(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => temporaryPaths)),
    );
  });

  it.effect('resolves changed consumers through persisted barrel aliases and declaration-only overloads', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createBarrelRepository();
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-barrel-incremental-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-barrel-full-home-'));
      const clean = yield* indexAndLoadEffect(root, incrementalHome);
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id)).toMatchObject({
        formatVersion: 2,
        reexports: 2,
      });
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id).aliases).toBeGreaterThan(0);
      writeBarrelConsumer(root, 'dirty');
      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const indexer = yield* CodeGraphIndexer;
      const fullSummary = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
      const full = yield* loadGraphEffect(root, fullHome, fullSummary);

      expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
      const implementation = incremental.graph.symbols.find(
        symbol => symbol.name === 'helper' && symbol.signature?.includes('string | number'),
      );
      const decodeDeclarations = incremental.graph.symbols.filter(symbol => symbol.name === 'decode');
      expect(implementation).toBeDefined();
      expect(
        incremental.graph.edges.some(
          edge => edge.relation === 'calls' && edge.sourceName === 'useHelper' && edge.targetId === implementation?.id,
        ),
      ).toBe(true);
      expect(
        new Set(
          incremental.graph.edges
            .filter(
              edge => edge.relation === 'calls' && edge.sourceName === 'useHelper' && edge.targetName === 'decode',
            )
            .map(edge => edge.targetId),
        ),
      ).toEqual(new Set(decodeDeclarations.map(symbol => symbol.id)));
    }).pipe(
      Effect.provide(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('falls back conservatively when the clean base predates reusable receipts', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-old-base-home-'));
      const clean = yield* indexAndLoadEffect(root, home);
      deleteReusableReceipt(clean.databasePath, clean.summary.snapshot.id);
      writeUseFile(root, 'dirty revision after upgrade');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(dirty.summary.materialization).toEqual({
        fallbackReason: 'staging-unavailable',
        mode: 'full',
        stagedFiles: 2,
        totalFiles: 2,
      });
    }).pipe(
      Effect.provide(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect(
    're-extracts only the changed language pack across a compatible extractor rollout',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(6);
        writeFileSync(join(root, 'README.md'), '# Mixed language fixture\n');
        git(root, ['add', 'README.md']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        const home = join(root, '.threadnote-pack-rollout');
        const referenceHome = join(root, '.threadnote-pack-rollout-reference');
        const initialRegistry = createCodeGraphLanguagePackRegistry(BUILTIN_LANGUAGE_PACK_REGISTRY.packs);
        const nextRegistry = createCodeGraphLanguagePackRegistry(
          BUILTIN_LANGUAGE_PACK_REGISTRY.packs.map(pack =>
            pack.id === 'typescript'
              ? {...pack, extractor: {...pack.extractor, version: `${pack.extractor.version}-compatible-next`}}
              : pack,
          ),
        );

        const initial = yield* indexWithRegistry(root, home, initialRegistry);
        expect(initial.materialization?.mode).toBe('full');
        const incremental = yield* indexWithRegistry(root, home, nextRegistry);
        const rebuilt = yield* indexWithRegistry(root, referenceHome, nextRegistry, true);
        expect(incremental.materialization).toEqual({
          mode: 'incremental-clean',
          stagedFiles: 8,
          totalFiles: 9,
        });
        expect(projectGraph(yield* loadGraphEffect(root, home, incremental))).toEqual(
          projectGraph(yield* loadGraphEffect(root, referenceHome, rebuilt)),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
        ),
        Effect.provide(ApplicationLayer),
      );
    },
    60_000,
  );

  it.effect('fails closed when a global extractor change is not explained by pack provenance', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(4);
      const home = join(root, '.threadnote-global-extractor');
      const initial = yield* indexAndLoadEffect(root, home);
      replaceSnapshotExtractorSet(initial.databasePath, initial.summary.snapshot.id, 'unexplained-global-change');
      writeUseFile(root, 'changed alongside a global extractor rollout');

      const next = yield* indexAndLoadEffect(root, home);
      expect(next.summary.materialization).toEqual({
        fallbackReason: 'extractor-context-changed',
        mode: 'full',
        stagedFiles: 6,
        totalFiles: 6,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      Effect.provide(ApplicationLayer),
    );
  });

  it.effect('does not let a stale peer failure poison an already-ready reusable base', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-peer-failure-home-'));
      yield* indexAndLoadEffect(root, home);
      writeUseFile(root, 'dirty peer-failure revision');
      const dirty = yield* indexAndLoadEffect(root, home);
      const baseSnapshotId = dirty.summary.snapshot.baseSnapshotId;
      expect(baseSnapshotId).toBeDefined();

      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, home, dirty.summary.identity.checkoutId, dirty.summary.identity.worktreeId);
      yield* store.markFailed(layout.databasePath, baseSnapshotId!, 'late failure from a peer builder');
      const state = {
        receipt: yield* store.reusableBaseReceipt(layout.databasePath, baseSnapshotId!),
        snapshot: yield* store.readySnapshotById(layout.databasePath, baseSnapshotId!),
      };

      expect(state.snapshot?.state).toBe('ready');
      expect(state.receipt?.snapshotId).toBe(baseSnapshotId);
    }).pipe(
      Effect.provide(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('prevents an overlapping older extractor generation from replacing the active graph', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-extractor-generation-home-'));
      const current = yield* indexAndLoadEffect(root, home);
      const legacySnapshotId = 'cgsn_legacy_generation_8';
      insertLegacyReadySnapshot(current.databasePath, current.summary, legacySnapshotId);
      expect(() =>
        promoteLegacySnapshot(current.databasePath, current.summary.identity.worktreeId, legacySnapshotId),
      ).toThrow('older extractor generation');

      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(
        path,
        home,
        current.summary.identity.checkoutId,
        current.summary.identity.worktreeId,
      );
      const promotionError = yield* store
        .promote(layout.databasePath, current.summary.identity, legacySnapshotId)
        .pipe(Effect.flip);
      expect(promotionError.message).toContain('incompatible extractor generation');

      const state = yield* store.readySnapshot(layout.databasePath, current.summary.identity.worktreeId);
      expect(state?.id).toBe(current.summary.snapshot.id);
      expect(extractorGenerationState(current.databasePath, current.summary.snapshot.id)).toEqual({
        generation: CODE_GRAPH_EXTRACTOR_GENERATION,
        minimum: CODE_GRAPH_EXTRACTOR_GENERATION,
      });
    }).pipe(
      Effect.provide(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });
});

const indexAndLoadEffect = Effect.fn('test.indexAndLoad')(function* (root: string, home: string) {
  const indexer = yield* CodeGraphIndexer;
  const summary = yield* indexer.index({cwd: root, threadnoteHome: home});
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
  return {
    catalog: yield* store.loadVisualizationCatalog(layout.databasePath),
    databasePath: layout.databasePath,
    graph,
    health: yield* store.diagnose(layout.databasePath),
    summary,
  };
});

const loadGraphEffect = Effect.fn('test.loadGraph')(function* (
  root: string,
  home: string,
  summary: CodeGraphIndexSummary,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  return yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
});

const indexWithRegistry = Effect.fn('test.indexWithRegistry')(function* (
  root: string,
  home: string,
  registry: CodeGraphLanguagePackRegistryShape,
  force = false,
) {
  const layer = Layer.fresh(CodeGraphIndexer.layer).pipe(
    Layer.provide(Layer.succeed(CodeGraphLanguagePackRegistry, registry)),
    Layer.provide(ApplicationLayer),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const indexer = Context.get(context, CodeGraphIndexer);
      return yield* indexer.index({cwd: root, force, threadnoteHome: home});
    }),
  );
});

function projectGraph(graph: {readonly edges: readonly unknown[]; readonly symbols: readonly unknown[]}) {
  return JSON.parse(JSON.stringify({edges: graph.edges, symbols: graph.symbols})) as {
    readonly edges: readonly unknown[];
    readonly symbols: readonly unknown[];
  };
}

function persistedSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshotId) as {state?: string} | null)
      ?.state;
  } finally {
    database.close(false);
  }
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {baseSnapshotId: _baseSnapshotId, completedAt: _completedAt, id: _id, ...stableSnapshot} = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

const loadVisualizationCatalogEffect = Effect.fn('test.loadVisualizationCatalog')(function* (
  home: string,
  summary: CodeGraphIndexSummary,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  return yield* store.loadVisualizationCatalog(layout.databasePath);
});

function createRepository(passiveFiles = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-cross-session-incremental-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'helper.ts'), 'export function helper(): string { return "ok"; }\n');
  writeUseFile(root, 'first revision');
  for (let index = 0; index < passiveFiles; index += 1) {
    writeFileSync(
      join(root, 'src', `passive-${index}.ts`),
      `export function passive${index}(): number { return ${index}; }\n`,
    );
  }
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function createBarrelRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-cross-session-barrel-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(
    join(root, 'src', 'helper.ts'),
    [
      'export function helper(value: string): string;',
      'export function helper(value: number): number;',
      'export function helper(value: string | number): string | number { return value; }',
      'export declare function decode(): string;',
      'export declare function decode(left: string, right: string): string;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'src', 'index.ts'), 'export {decode, helper} from "./helper.js";\n');
  writeBarrelConsumer(root, 'clean');
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'barrel fixture']);
  return root;
}

function writeUseFile(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {helper} from "./helper.js";',
      'export function useHelper(): string {',
      `  const revision = ${JSON.stringify(revision)};`,
      '  return `${revision}:${helper()}`;',
      '}',
      '',
    ].join('\n'),
  );
}

function writeUseFileWithoutCall(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {helper} from "./helper.js";',
      'export function useHelper(): string {',
      `  const revision = ${JSON.stringify(revision)};`,
      '  void helper;',
      '  return revision;',
      '}',
      '',
    ].join('\n'),
  );
}

function writeBarrelConsumer(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {decode, helper} from "./index.js";',
      'export function useHelper(): string {',
      `  return helper(${JSON.stringify(revision)}) + decode() + decode("a", "b");`,
      '}',
      '',
    ].join('\n'),
  );
}

function persistedDeltaStats(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true});
  try {
    const paths = (table: 'edges' | 'snapshot_files' | 'symbols', column: 'evidence_path' | 'path') =>
      database
        .query<{readonly path: string}, [string]>(
          `SELECT DISTINCT ${column} AS path FROM ${table} WHERE snapshot_id = ? ORDER BY path`,
        )
        .all(snapshotId)
        .map(row => row.path);
    return {
      activeLeases: Number(
        database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_leases').get()?.count ?? 0,
      ),
      edgePaths: paths('edges', 'evidence_path'),
      filePaths: paths('snapshot_files', 'path'),
      symbolPaths: paths('symbols', 'path'),
    };
  } finally {
    database.close();
  }
}

function reusableReceiptStats(
  databasePath: string,
  snapshotId: string,
): {readonly aliases: number; readonly formatVersion: number; readonly reexports: number} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const aliases = database
      .query<{readonly aliases: number}, [string]>(
        "SELECT COUNT(*) AS aliases FROM snapshot_symbol_lookup WHERE snapshot_id = ? AND provenance = 'alias'",
      )
      .get(snapshotId);
    const receipt = database
      .query<{readonly formatVersion: number}, [string]>(
        'SELECT format_version AS formatVersion FROM snapshot_reuse_receipts WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    const reexports = database
      .query<{readonly reexports: number}, [string]>(
        'SELECT COUNT(*) AS reexports FROM snapshot_reexport_provenance WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    return {
      aliases: Number(aliases?.aliases ?? 0),
      formatVersion: Number(receipt?.formatVersion ?? 0),
      reexports: Number(reexports?.reexports ?? 0),
    };
  } finally {
    database.close();
  }
}

function deleteReusableReceipt(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database.query('DELETE FROM snapshot_reuse_receipts WHERE snapshot_id = ?').run(snapshotId);
  } finally {
    database.close();
  }
}

function replaceSnapshotExtractorSet(databasePath: string, snapshotId: string, extractorSet: string): void {
  const database = new Database(databasePath);
  try {
    database.query('UPDATE snapshots SET extractor_set = ? WHERE id = ?').run(extractorSet, snapshotId);
  } finally {
    database.close();
  }
}

function insertLegacyReadySnapshot(databasePath: string, summary: CodeGraphIndexSummary, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query(
        `INSERT INTO snapshots (
          id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
          dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, 'ready', 0, 0, 0, ?, ?)`,
      )
      .run(
        snapshotId,
        summary.identity.repositoryId,
        summary.identity.worktreeId,
        summary.identity.headCommit,
        'native-code-graph-8-fixture',
        '2026-07-31T00:00:00.000Z',
        '2026-07-31T00:00:01.000Z',
      );
  } finally {
    database.close();
  }
}

function extractorGenerationState(
  databasePath: string,
  snapshotId: string,
): {readonly generation: number; readonly minimum: number} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const generation = database
      .query<{readonly generation: number}, [string]>(
        'SELECT generation FROM snapshot_extractor_generations WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    const minimum = database
      .query<{readonly minimum: string}, []>(
        "SELECT value AS minimum FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
      )
      .get();
    return {generation: Number(generation?.generation ?? 0), minimum: Number(minimum?.minimum ?? 0)};
  } finally {
    database.close();
  }
}

function promoteLegacySnapshot(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, '2026-07-31T00:00:02.000Z');
  } finally {
    database.close();
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function configureTestGitIdentity(cwd: string): void {
  git(cwd, ['config', 'user.name', 'Threadnote Test']);
  git(cwd, ['config', 'user.email', 'test@threadnote.local']);
}

function removeTemporaryPaths(paths: () => readonly (string | undefined)[]) {
  return Effect.sync(() => {
    for (const path of paths()) {
      if (path !== undefined) rmSync(path, {force: true, recursive: true});
    }
  });
}
