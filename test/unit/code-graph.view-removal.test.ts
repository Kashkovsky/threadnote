import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, FileSystem, Option, Ref} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {withCodeGraphTargetWorktreeLock} from '../../src/code_graph/maintenance_gate.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CodeGraphStoreBusyError,
  CodeGraphStoreError,
} from '../../src/code_graph/types.js';
import type {RepositoryIdentity} from '../../src/code_graph/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph view removal core', () => {
  it('returns not-found without recreating a missing checkout database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-view-missing-'));
    temporaryRoots.push(root);
    const databasePath = join(root, 'indexes', 'code-graph', 'repositories', 'a'.repeat(64), 'graph-v3.sqlite');

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.removeView(databasePath, '1'.repeat(64), 'snapshot-missing');
      }),
    );

    expect(result).toEqual({expectedSnapshotId: 'snapshot-missing', state: 'not-found'});
    await expect(Bun.file(databasePath).exists()).resolves.toBe(false);
  });

  it('adds durable non-cascading removal evidence without replacing v3 data', async () => {
    const fixture = await viewFixture('threadnote-view-schema-');
    const before = new Database(fixture.databasePath);
    before.run('DROP TABLE removed_views');
    before.run("INSERT INTO schema_metadata (key, value) VALUES ('view_fixture_marker', 'preserve-me')");
    before.close(false);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(fixture.databasePath);
      }),
    );

    const after = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(after.query("SELECT value FROM schema_metadata WHERE key = 'view_fixture_marker'").get()).toEqual({
        value: 'preserve-me',
      });
      expect(
        after.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'removed_views'").get(),
      ).toEqual({name: 'removed_views'});
      expect(after.query("SELECT COUNT(*) AS count FROM pragma_foreign_key_list('removed_views')").get()).toEqual({
        count: 0,
      });
    } finally {
      after.close(false);
    }
  });

  it('performs an exact idempotent CAS and preserves stale or missing targets without mutation', async () => {
    const fixture = await viewFixture('threadnote-view-cas-');
    seedGraph(
      fixture,
      [{id: 'snapshot-current', worktreeId: fixture.worktrees[0]!}],
      [{snapshotId: 'snapshot-current', worktreeId: fixture.worktrees[0]!}],
    );

    const observed = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const staleActive = yield* store.removeView(fixture.databasePath, fixture.worktrees[0]!, 'snapshot-other');
        const removed = yield* store.removeView(fixture.databasePath, fixture.worktrees[0]!, 'snapshot-current');
        const retry = yield* store.removeView(fixture.databasePath, fixture.worktrees[0]!, 'snapshot-current');
        const staleRemoved = yield* store.removeView(fixture.databasePath, fixture.worktrees[0]!, 'snapshot-other');
        const missing = yield* store.removeView(fixture.databasePath, fixture.worktrees[1]!, 'snapshot-current');
        return {missing, removed, retry, staleActive, staleRemoved};
      }),
    );

    expect(observed.staleActive).toEqual({
      expectedSnapshotId: 'snapshot-other',
      observedSnapshotId: 'snapshot-current',
      observedState: 'active',
      state: 'stale-target',
    });
    expect(observed.removed).toEqual({
      expectedSnapshotId: 'snapshot-current',
      retiredSnapshots: 1,
      state: 'removed',
    });
    expect(observed.retry).toEqual({
      expectedSnapshotId: 'snapshot-current',
      retiredSnapshots: 0,
      state: 'already-removed',
    });
    expect(observed.staleRemoved).toEqual({
      expectedSnapshotId: 'snapshot-other',
      observedSnapshotId: 'snapshot-current',
      observedState: 'removed',
      state: 'stale-target',
    });
    expect(observed.missing).toEqual({expectedSnapshotId: 'snapshot-current', state: 'not-found'});

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT * FROM active_snapshots').all()).toEqual([]);
      expect(database.query('SELECT worktree_id, expected_snapshot_id FROM removed_views').all()).toEqual([
        {expected_snapshot_id: 'snapshot-current', worktree_id: fixture.worktrees[0]},
      ]);
    } finally {
      database.close(false);
    }
  });

  it('preserves shared views, readers, and every recursively required base while retiring unrelated dirty history', async () => {
    const fixture = await viewFixture('threadnote-view-protection-');
    const [sharedA, dependent, sharedB, target] = fixture.worktrees;
    seedGraph(
      fixture,
      [
        {id: 'snapshot-base-root', worktreeId: target!},
        {baseSnapshotId: 'snapshot-base-root', dirty: true, id: 'snapshot-base-middle', worktreeId: target!},
        {baseSnapshotId: 'snapshot-base-middle', dirty: true, id: 'snapshot-target', worktreeId: target!},
        {baseSnapshotId: 'snapshot-target', dirty: true, id: 'snapshot-dependent', worktreeId: dependent!},
        {id: 'snapshot-shared', worktreeId: sharedA!},
        {dirty: true, id: 'snapshot-unrelated-dirty', worktreeId: 'e'.repeat(64)},
      ],
      [
        {snapshotId: 'snapshot-shared', worktreeId: sharedA!},
        {snapshotId: 'snapshot-dependent', worktreeId: dependent!},
        {snapshotId: 'snapshot-shared', worktreeId: sharedB!},
        {snapshotId: 'snapshot-target', worktreeId: target!},
      ],
    );

    const observed = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const targetLease = yield* store.acquireSnapshotLease(fixture.databasePath, 'snapshot-target', 60_000);
        const sharedRemoval = yield* store.removeView(fixture.databasePath, sharedA!, 'snapshot-shared');
        const targetRemoval = yield* store.removeView(fixture.databasePath, target!, 'snapshot-target');
        const leaseFlag = yield* Effect.sync(() => {
          const database = new Database(fixture.databasePath, {readonly: true, strict: true});
          try {
            return database
              .query<{readonly retire_when_inactive: number}, [string]>(
                'SELECT retire_when_inactive FROM snapshot_leases WHERE token = ?',
              )
              .get(targetLease)?.retire_when_inactive;
          } finally {
            database.close(false);
          }
        });
        yield* store.releaseSnapshotLease(fixture.databasePath, targetLease);
        const protectedSnapshots = yield* Effect.all(
          [
            'snapshot-shared',
            'snapshot-dependent',
            'snapshot-target',
            'snapshot-base-middle',
            'snapshot-base-root',
          ].map(snapshotId => store.readySnapshotById(fixture.databasePath, snapshotId)),
          {concurrency: 1},
        );
        return {leaseFlag, protectedSnapshots, sharedRemoval, targetRemoval};
      }),
    );

    expect(observed.sharedRemoval).toEqual({
      expectedSnapshotId: 'snapshot-shared',
      retiredSnapshots: 1,
      state: 'removed',
    });
    expect(observed.targetRemoval).toEqual({
      expectedSnapshotId: 'snapshot-target',
      retiredSnapshots: 0,
      state: 'removed',
    });
    expect(observed.leaseFlag).toBe(1);
    expect(observed.protectedSnapshots.map(snapshot => snapshot?.id)).toEqual([
      'snapshot-shared',
      'snapshot-dependent',
      'snapshot-target',
      'snapshot-base-middle',
      'snapshot-base-root',
    ]);
  });

  it('never resurrects builder history and suppresses only the same mixed-version pointer', async () => {
    const fixture = await viewFixture('threadnote-view-catalog-');
    const worktreeId = fixture.worktrees[0]!;
    seedGraph(
      fixture,
      [
        {id: 'snapshot-original', worktreeId},
        {id: 'snapshot-new', worktreeId: fixture.worktrees[1]!},
        {id: 'snapshot-builder-cache', worktreeId: fixture.worktrees[2]!},
      ],
      [{snapshotId: 'snapshot-original', worktreeId}],
    );

    const observed = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const lease = yield* store.acquireSnapshotLease(fixture.databasePath, 'snapshot-original', 60_000);
        const newLease = yield* store.acquireSnapshotLease(fixture.databasePath, 'snapshot-new', 60_000);
        yield* store.removeView(fixture.databasePath, worktreeId, 'snapshot-original');
        legacyPromote(fixture.databasePath, worktreeId, 'snapshot-original');
        const sameReady = yield* store.readySnapshot(fixture.databasePath, worktreeId);
        const sameCatalogs = yield* store.loadVisualizationCatalogs(fixture.databasePath, 'deferred');
        const sameCatalog = yield* store.loadVisualizationCatalog(fixture.databasePath, 'deferred');
        const builderCatalog = yield* store.loadVisualizationCatalog(fixture.databasePath, 'deferred', {
          snapshotId: Option.some('snapshot-builder-cache'),
        });
        const reconciledRetry = yield* store.removeView(fixture.databasePath, worktreeId, 'snapshot-original');

        legacyPromote(fixture.databasePath, worktreeId, 'snapshot-new');
        const differentReady = yield* store.readySnapshot(fixture.databasePath, worktreeId);
        const differentCatalogs = yield* store.loadVisualizationCatalogs(fixture.databasePath, 'deferred');
        const tombstoneBeforeCurrentPromotion = removedView(fixture.databasePath, worktreeId);
        yield* store.promote(fixture.databasePath, identityFor(fixture, worktreeId), 'snapshot-new');
        const tombstoneAfterCurrentPromotion = removedView(fixture.databasePath, worktreeId);
        yield* store.releaseSnapshotLease(fixture.databasePath, lease);
        yield* store.releaseSnapshotLease(fixture.databasePath, newLease);
        return {
          builderCatalog,
          differentCatalogs,
          differentReady,
          reconciledRetry,
          sameCatalog,
          sameCatalogs,
          sameReady,
          tombstoneAfterCurrentPromotion,
          tombstoneBeforeCurrentPromotion,
        };
      }),
    );

    expect(observed.sameReady).toBeUndefined();
    expect(observed.sameCatalogs).toEqual([]);
    expect(observed.sameCatalog).toBeUndefined();
    expect(observed.builderCatalog).toBeUndefined();
    expect(observed.reconciledRetry).toEqual({
      expectedSnapshotId: 'snapshot-original',
      retiredSnapshots: 0,
      state: 'already-removed',
    });
    expect(observed.differentReady?.id).toBe('snapshot-new');
    expect(observed.differentCatalogs.map(catalog => [catalog.viewWorktreeId, catalog.snapshot.id])).toEqual([
      [worktreeId, 'snapshot-new'],
    ]);
    expect(observed.tombstoneBeforeCurrentPromotion).toBe('snapshot-original');
    expect(observed.tombstoneAfterCurrentPromotion).toBeUndefined();
  });

  it('serializes bounded concurrent retries without losing removal evidence', async () => {
    const fixture = await viewFixture('threadnote-view-load-');
    const worktreeId = fixture.worktrees[0]!;
    seedGraph(fixture, [{id: 'snapshot-load', worktreeId}], [{snapshotId: 'snapshot-load', worktreeId}]);

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.acquireSnapshotLease(fixture.databasePath, 'snapshot-load', 60_000);
        return yield* Effect.all(
          Array.from({length: 16}, () =>
            store.removeView(fixture.databasePath, worktreeId, 'snapshot-load', {waitTimeoutMilliseconds: 5_000}),
          ),
          {concurrency: 'unbounded'},
        );
      }),
    );

    expect(results.filter(result => result.state === 'removed')).toHaveLength(1);
    expect(results.filter(result => result.state === 'already-removed')).toHaveLength(15);
    expect(removedView(fixture.databasePath, worktreeId)).toBe('snapshot-load');
  });

  it('fails fast and path-free on held writer or target-worktree locks without running the mutation', async () => {
    const fixture = await viewFixture('threadnote-view-busy-');
    const worktreeId = fixture.worktrees[0]!;
    seedGraph(fixture, [{id: 'snapshot-busy', worktreeId}], [{snapshotId: 'snapshot-busy', worktreeId}]);

    const observed = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writerOwner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            fixture.writerLockPath,
            lockOptions(() => Deferred.succeed(writerAcquired, undefined).pipe(Effect.asVoid)),
            Deferred.await(releaseWriter),
          ),
        );
        yield* Deferred.await(writerAcquired);
        const writerStartedAt = performance.now();
        const writerResult = yield* store.removeView(fixture.databasePath, worktreeId, 'snapshot-busy').pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: result => ({result, success: true as const}),
          }),
        );
        const writerElapsedMilliseconds = performance.now() - writerStartedAt;
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Fiber.join(writerOwner);

        const targetAcquired = yield* Deferred.make<void>();
        const releaseTarget = yield* Deferred.make<void>();
        const targetOwner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            fixture.worktreeLockPath,
            lockOptions(() => Deferred.succeed(targetAcquired, undefined).pipe(Effect.asVoid)),
            Deferred.await(releaseTarget),
          ),
        );
        yield* Deferred.await(targetAcquired);
        const calls = yield* Ref.make(0);
        const targetStartedAt = performance.now();
        const targetResult = yield* withCodeGraphTargetWorktreeLock(
          fixture.root,
          fixture.checkoutId,
          worktreeId,
          Ref.update(calls, count => count + 1),
        ).pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: result => ({result, success: true as const}),
          }),
        );
        const targetElapsedMilliseconds = performance.now() - targetStartedAt;
        yield* Deferred.succeed(releaseTarget, undefined);
        yield* Fiber.join(targetOwner);
        return {
          calls: yield* Ref.get(calls),
          targetElapsedMilliseconds,
          targetResult,
          writerElapsedMilliseconds,
          writerResult,
        };
      }),
    );

    expect(observed.writerResult.success).toBe(false);
    expect(observed.targetResult.success).toBe(false);
    if (!observed.writerResult.success) {
      expect(observed.writerResult.error).toBeInstanceOf(CodeGraphStoreBusyError);
      expect(observed.writerResult.error.message).not.toContain(fixture.root);
    }
    if (!observed.targetResult.success) {
      expect(observed.targetResult.error).toBeInstanceOf(CodeGraphStoreBusyError);
      expect(String(observed.targetResult.error)).not.toContain(fixture.root);
    }
    expect(observed.writerElapsedMilliseconds).toBeLessThan(500);
    expect(observed.targetElapsedMilliseconds).toBeLessThan(500);
    expect(observed.calls).toBe(0);
    expect(activeView(fixture.databasePath, worktreeId)).toBe('snapshot-busy');
    expect(removedView(fixture.databasePath, worktreeId)).toBeUndefined();
  });

  it('classifies target-lock filesystem failures without exposing the lock root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'threadnote-view-lock-error-'));
    temporaryRoots.push(root);
    writeFileSync(join(root, 'locks'), 'not-a-directory\n');

    const observed = await runEffect(
      withCodeGraphTargetWorktreeLock(root, 'a'.repeat(64), '1'.repeat(64), Effect.void).pipe(
        Effect.match({
          onFailure: error => ({error, success: false as const}),
          onSuccess: () => ({success: true as const}),
        }),
      ),
    );

    expect(observed.success).toBe(false);
    if (!observed.success) {
      expect(observed.error).toBeInstanceOf(CodeGraphStoreError);
      expect(observed.error).not.toBeInstanceOf(CodeGraphStoreBusyError);
      expect(observed.error.operation).toBe('mutate graph view');
      expect(observed.error.message).not.toContain(root);
      expect(String(observed.error)).not.toContain(root);
    }
  });
});

interface SeedSnapshot {
  readonly baseSnapshotId?: string;
  readonly dirty?: boolean;
  readonly id: string;
  readonly worktreeId: string;
}

interface SeedView {
  readonly snapshotId: string;
  readonly worktreeId: string;
}

interface ViewFixture {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly repositoryId: string;
  readonly root: string;
  readonly worktreeLockPath: string;
  readonly worktrees: readonly string[];
  readonly writerLockPath: string;
}

async function viewFixture(prefix: string): Promise<ViewFixture> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const checkoutId = 'a'.repeat(64);
  const worktrees = ['1', '2', '3', '4'].map(digit => digit.repeat(64));
  const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
  await runEffect(
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath);
    }),
  );
  return {
    checkoutId,
    databasePath,
    repositoryId: 'b'.repeat(64),
    root,
    worktreeLockPath: join(root, 'locks', 'indexes', 'code-graph', 'worktrees', checkoutId, `${worktrees[0]}.lock`),
    worktrees,
    writerLockPath: join(root, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`),
  };
}

function seedGraph(fixture: ViewFixture, snapshots: readonly SeedSnapshot[], views: readonly SeedView[]): void {
  const database = new Database(fixture.databasePath, {strict: true});
  try {
    database.run(
      `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, ?, 'sha1', ?, ?)`,
      [fixture.repositoryId, 'threadnote/view-removal-fixture', new Date(0).toISOString(), new Date(0).toISOString()],
    );
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'view-removal-test', ?, ?, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertView = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const [index, snapshot] of snapshots.entries()) {
        insertSnapshot.run(
          snapshot.id,
          fixture.repositoryId,
          snapshot.worktreeId,
          `${index}`.padStart(40, '0'),
          `content-${snapshot.id}`,
          snapshot.baseSnapshotId ?? null,
          snapshot.dirty ? 1 : 0,
          snapshot.dirty ? `overlay-${snapshot.id}` : null,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshot.id, CODE_GRAPH_EXTRACTOR_GENERATION);
      }
      for (const [index, view] of views.entries()) {
        insertView.run(view.worktreeId, view.snapshotId, new Date(index + 10).toISOString());
      }
    })();
  } finally {
    database.close(false);
  }
}

function legacyPromote(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worktree_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, snapshotId, new Date().toISOString());
  } finally {
    database.close(false);
  }
}

function activeView(databasePath: string, worktreeId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string]>('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(worktreeId)?.snapshot_id;
  } finally {
    database.close(false);
  }
}

function removedView(databasePath: string, worktreeId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly expected_snapshot_id: string}, [string]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?',
      )
      .get(worktreeId)?.expected_snapshot_id;
  } finally {
    database.close(false);
  }
}

function identityFor(fixture: ViewFixture, worktreeId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: fixture.checkoutId,
    displayName: 'threadnote/view-removal-fixture',
    gitCommonDirectory: fixture.root,
    headCommit: 'f'.repeat(40),
    objectFormat: 'sha1',
    repositoryId: fixture.repositoryId,
    repoRoot: fixture.root,
    worktreeId,
  };
}

function lockOptions(onAcquired: () => Effect.Effect<void, never>) {
  return {
    onAcquired,
    retryIntervalMilliseconds: 5,
    staleAfterMilliseconds: 120_000,
    waitTimeoutMilliseconds: 5_000,
  } as const;
}
