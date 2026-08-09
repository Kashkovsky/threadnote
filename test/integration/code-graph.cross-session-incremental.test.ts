import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect, Path} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphStore, type CodeGraphVisualizationCatalog} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type CodeGraphIndexSummary} from '../../src/code_graph/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('cross-session code graph increments', () => {
  it('reuses a persisted clean base for a body-only dirty overlay', async () => {
    const root = createRepository(32);
    const incrementalHome = join(root, '.threadnote-incremental');
    const fullHome = join(root, '.threadnote-full');
    try {
      const clean = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
        }),
      );
      expect(clean.materialization?.mode).toBe('full');

      writeUseFile(root, 'second body-only revision');

      const incremental = await indexAndLoad(root, incrementalHome);
      const full = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            threadnoteHome: fullHome,
          });
        }),
      );
      const rebuilt = await loadGraph(root, fullHome, full);

      expect(incremental.summary.materialization).toEqual({
        mode: 'incremental-overlay',
        stagedFiles: 1,
        totalFiles: 34,
      });
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(rebuilt));
      expect(normalizeCatalog(incremental.catalog)).toEqual(normalizeCatalog(await yieldCatalog(root, fullHome, full)));
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
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('matches full rebuilds when changed-file relationships are added or deleted', async () => {
    for (const operation of ['add', 'delete'] as const) {
      const root = createRepository();
      const incrementalHome = join(root, `.threadnote-${operation}-incremental`);
      const fullHome = join(root, `.threadnote-${operation}-full`);
      try {
        if (operation === 'add') writeUseFileWithoutCall(root, 'clean no-call revision');
        git(root, ['add', '.']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        await indexAndLoad(root, incrementalHome);
        if (operation === 'add') writeUseFile(root, 'dirty call revision');
        else writeUseFileWithoutCall(root, 'dirty no-call revision');

        const incremental = await indexAndLoad(root, incrementalHome);
        const fullSummary = await runEffect(
          Effect.gen(function* () {
            const indexer = yield* CodeGraphIndexer;
            return yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          }),
        );
        const full = await loadGraph(root, fullHome, fullSummary);
        expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
        expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
        expect(
          incremental.graph.edges.some(
            edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
          ),
        ).toBe(operation === 'add');
      } finally {
        rmSync(root, {force: true, recursive: true});
      }
    }
  });

  it('resolves changed consumers through persisted barrel aliases and declaration-only overloads', async () => {
    const root = createBarrelRepository();
    const incrementalHome = join(root, '.threadnote-barrel-incremental');
    const fullHome = join(root, '.threadnote-barrel-full');
    try {
      const clean = await indexAndLoad(root, incrementalHome);
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id)).toMatchObject({
        formatVersion: 2,
        reexports: 2,
      });
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id).aliases).toBeGreaterThan(0);
      writeBarrelConsumer(root, 'dirty');
      const incremental = await indexAndLoad(root, incrementalHome);
      const fullSummary = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
        }),
      );
      const full = await loadGraph(root, fullHome, fullSummary);

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
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('falls back conservatively when the clean base predates reusable receipts', async () => {
    const root = createRepository();
    const home = join(root, '.threadnote-old-base');
    try {
      const clean = await indexAndLoad(root, home);
      deleteReusableReceipt(clean.databasePath, clean.summary.snapshot.id);
      writeUseFile(root, 'dirty revision after upgrade');

      const dirty = await indexAndLoad(root, home);
      expect(dirty.summary.materialization).toEqual({
        fallbackReason: 'staging-unavailable',
        mode: 'full',
        stagedFiles: 2,
        totalFiles: 2,
      });
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('does not let a stale peer failure poison an already-ready reusable base', async () => {
    const root = createRepository();
    const home = join(root, '.threadnote-peer-failure');
    try {
      await indexAndLoad(root, home);
      writeUseFile(root, 'dirty peer-failure revision');
      const dirty = await indexAndLoad(root, home);
      const baseSnapshotId = dirty.summary.snapshot.baseSnapshotId;
      expect(baseSnapshotId).toBeDefined();

      const state = await runEffect(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const layout = codeGraphLayout(
            path,
            home,
            dirty.summary.identity.checkoutId,
            dirty.summary.identity.worktreeId,
          );
          yield* store.markFailed(layout.databasePath, baseSnapshotId!, 'late failure from a peer builder');
          return {
            receipt: yield* store.reusableBaseReceipt(layout.databasePath, baseSnapshotId!),
            snapshot: yield* store.readySnapshotById(layout.databasePath, baseSnapshotId!),
          };
        }),
      );

      expect(state.snapshot?.state).toBe('ready');
      expect(state.receipt?.snapshotId).toBe(baseSnapshotId);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('prevents an overlapping older extractor generation from replacing the active graph', async () => {
    const root = createRepository();
    const home = join(root, '.threadnote-extractor-generation');
    try {
      const current = await indexAndLoad(root, home);
      const legacySnapshotId = 'cgsn_legacy_generation_8';
      insertLegacyReadySnapshot(current.databasePath, current.summary, legacySnapshotId);
      expect(() =>
        promoteLegacySnapshot(current.databasePath, current.summary.identity.worktreeId, legacySnapshotId),
      ).toThrow('older extractor generation');

      await expect(
        runEffect(
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const store = yield* CodeGraphStore;
            const layout = codeGraphLayout(
              path,
              home,
              current.summary.identity.checkoutId,
              current.summary.identity.worktreeId,
            );
            yield* store.promote(layout.databasePath, current.summary.identity, legacySnapshotId);
          }),
        ),
      ).rejects.toThrow('incompatible extractor generation');

      const state = await runEffect(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const layout = codeGraphLayout(
            path,
            home,
            current.summary.identity.checkoutId,
            current.summary.identity.worktreeId,
          );
          return yield* store.readySnapshot(layout.databasePath, current.summary.identity.worktreeId);
        }),
      );
      expect(state?.id).toBe(current.summary.snapshot.id);
      expect(extractorGenerationState(current.databasePath, current.summary.snapshot.id)).toEqual({
        generation: CODE_GRAPH_EXTRACTOR_GENERATION,
        minimum: CODE_GRAPH_EXTRACTOR_GENERATION,
      });
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });
});

async function indexAndLoad(root: string, home: string) {
  return runEffect(
    Effect.gen(function* () {
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
    }),
  );
}

async function loadGraph(root: string, home: string, summary: CodeGraphIndexSummary) {
  return runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
      return yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
    }),
  );
}

function projectGraph(graph: {readonly edges: readonly unknown[]; readonly symbols: readonly unknown[]}) {
  return JSON.parse(JSON.stringify({edges: graph.edges, symbols: graph.symbols})) as {
    readonly edges: readonly unknown[];
    readonly symbols: readonly unknown[];
  };
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {baseSnapshotId: _baseSnapshotId, completedAt: _completedAt, id: _id, ...stableSnapshot} = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

async function yieldCatalog(root: string, home: string, summary: CodeGraphIndexSummary) {
  return runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
      return yield* store.loadVisualizationCatalog(layout.databasePath);
    }),
  );
}

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
