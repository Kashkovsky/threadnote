import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {codeGraphVectorWriteLockPath} from '../../src/code_graph/layout.js';
import {
  codeGraphViewRemovalTargetFailure,
  removeCodeGraphView,
  serializeCodeGraphViewRemovalResult,
} from '../../src/code_graph/view_removal.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CodeGraphStoreBusyError} from '../../src/code_graph/types.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {SystemInfo} from '../../src/effect/system.js';

const CHECKOUT_ID = 'a'.repeat(64);
const WORKTREE_ID = '1'.repeat(64);
const SNAPSHOT_ID = `cgsn_${'c'.repeat(40)}-direct`;
const ViewRemovalCommandTestLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(SystemInfo.layer),
  Layer.provideMerge(BunServices.layer),
);

describe('code graph remove-view command core', () => {
  effectIt.layer(ViewRemovalCommandTestLayer)(layerIt => {
    layerIt.effect('previews without mutation, applies exactly, and emits deterministic path-free JSON', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};

          const preview = yield* removeCodeGraphView(fixture.home, target);
          const stale = yield* removeCodeGraphView(fixture.home, {...target, snapshotId: `cgsn_${'d'.repeat(40)}`});
          expect(preview).toMatchObject({applied: false, cleanup: {provenance: null, vectors: null}, state: 'ready'});
          expect(activeView(fixture.databasePath)).toBe(SNAPSHOT_ID);
          expect(removedView(fixture.databasePath)).toBeUndefined();
          expect(stale).toMatchObject({
            applied: false,
            observedSnapshotId: SNAPSHOT_ID,
            observedState: 'active',
            state: 'stale-target',
          });
          expect(codeGraphViewRemovalTargetFailure(stale)?.message).toMatch(/changed/);

          const first = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          const retry = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          expect(first).toMatchObject({applied: true, state: 'removed', warnings: []});
          expect(retry).toMatchObject({applied: true, state: 'already-removed', warnings: []});
          expect(activeView(fixture.databasePath)).toBeUndefined();
          expect(removedView(fixture.databasePath)).toBe(SNAPSHOT_ID);

          const serialized = serializeCodeGraphViewRemovalResult(first);
          expect(serialized).toBe(serializeCodeGraphViewRemovalResult(first));
          expect(JSON.parse(serialized)).toEqual(first);
          expect(serialized).not.toContain(fixture.home);
          expect(serialized).not.toContain('databasePath');
        }),
      ),
    );

    layerIt.effect('keeps core success when a vector writer is busy and converges on an already-removed retry', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vectorDatabase = yield* seedVectorDatabase(fixture.home);
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* withExclusiveFileLock(
            fs,
            codeGraphVectorWriteLockPath(path, fixture.home, CHECKOUT_ID, sha256HexSync('model-command')),
            {
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(acquired);

          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          const first = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          expect(first.state).toBe('removed');
          expect(first.warnings).toEqual([
            {
              code: 'vector-store-busy',
              message: 'A vector store is busy; rerun the command to retry residual cleanup.',
              occurrences: 1,
              retryable: true,
            },
          ]);
          expect(readVectorPointer(vectorDatabase)).toBe(SNAPSHOT_ID);

          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(owner);
          const retry = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          expect(retry.state).toBe('already-removed');
          expect(retry.cleanup.vectors?.pointersRemoved).toBe(1);
          expect(retry.warnings).toEqual([]);
          expect(readVectorPointer(vectorDatabase)).toBeUndefined();
        }),
      ),
    );

    layerIt.effect('returns promptly under sixteen zero-wait applies and bounded retries converge', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);
          const outcomes = yield* Effect.all(
            Array.from({length: 16}, () =>
              removeCodeGraphView(fixture.home, target, {apply: true}).pipe(
                Effect.match({
                  onFailure: error => ({error, state: 'failed' as const}),
                  onSuccess: result => ({result, state: 'succeeded' as const}),
                }),
              ),
            ),
            {concurrency: 'unbounded'},
          );
          const elapsed = (yield* TestClock.withLive(Clock.currentTimeMillis)) - startedAt;
          const successes = outcomes.filter(outcome => outcome.state === 'succeeded').map(outcome => outcome.result);
          const failures = outcomes.filter(outcome => outcome.state === 'failed').map(outcome => outcome.error);

          expect(successes.filter(result => result.state === 'removed')).toHaveLength(1);
          expect(successes.every(result => result.state === 'removed' || result.state === 'already-removed')).toBe(
            true,
          );
          expect(failures.every(error => error instanceof CodeGraphStoreBusyError)).toBe(true);
          expect(failures.every(error => !String(error).includes(fixture.home))).toBe(true);
          expect(elapsed).toBeLessThan(5_000);

          const retries = yield* Effect.forEach(
            Array.from({length: 16}),
            () => removeCodeGraphView(fixture.home, target, {apply: true}),
            {concurrency: 1},
          );
          expect(retries.every(result => result.state === 'already-removed')).toBe(true);
        }),
      ),
    );

    layerIt.effect('refuses a symlinked checkout ancestor without mutating the external database', () =>
      Effect.scoped(
        Effect.gen(function* () {
          if (process.platform === 'win32') return;
          const fixture = yield* viewActionFixture;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const checkoutRoot = path.dirname(fixture.databasePath);
          const externalCheckout = path.join(fixture.home, 'external-checkout');
          yield* fs.rename(checkoutRoot, externalCheckout);
          yield* fs.symlink(externalCheckout, checkoutRoot);
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};

          const preview = yield* removeCodeGraphView(fixture.home, target).pipe(
            Effect.match({onFailure: error => error, onSuccess: () => undefined}),
          );
          const apply = yield* removeCodeGraphView(fixture.home, target, {apply: true}).pipe(
            Effect.match({onFailure: error => error, onSuccess: () => undefined}),
          );

          expect(preview).toBeInstanceOf(Error);
          expect(apply).toBeInstanceOf(Error);
          expect(String(preview)).not.toContain(fixture.home);
          expect(String(apply)).not.toContain(fixture.home);
          expect(activeView(path.join(externalCheckout, path.basename(fixture.databasePath)))).toBe(SNAPSHOT_ID);
          expect(removedView(path.join(externalCheckout, path.basename(fixture.databasePath)))).toBeUndefined();
        }),
      ),
    );
  });
});

const viewActionFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-view-action-'});
  const databasePath = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite');
  yield* store.initialize(databasePath);
  yield* Effect.sync(() => seedGraph(databasePath));
  yield* store.acquireSnapshotLease(databasePath, SNAPSHOT_ID, 60_000);
  return {databasePath, home};
});

function seedGraph(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/view-command', 'sha1', ?, ?)`,
      )
      .run('b'.repeat(64), new Date(0).toISOString(), new Date(0).toISOString());
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) VALUES (?, ?, ?, ?, 'content-command', NULL, 'view-command-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      )
      .run(
        SNAPSHOT_ID,
        'b'.repeat(64),
        WORKTREE_ID,
        'f'.repeat(40),
        new Date(0).toISOString(),
        new Date(1).toISOString(),
      );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(SNAPSHOT_ID, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(WORKTREE_ID, SNAPSHOT_ID, new Date(2).toISOString());
  } finally {
    database.close(false);
  }
}

function seedVectorDatabase(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors', 'model-command');
    yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
    const databasePath = path.join(root, 'vectors-v2.sqlite');
    yield* Effect.sync(() => {
      const database = new Database(databasePath, {create: true, strict: true});
      try {
        database.run('PRAGMA user_version = 2');
        database.run(`CREATE TABLE vector_generations (
          generation TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, model_id TEXT NOT NULL,
          model_sha256 TEXT NOT NULL, dimensions INTEGER NOT NULL, template_version INTEGER NOT NULL,
          count INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
        )`);
        database.run('CREATE TABLE vector_pointers (worktree_id TEXT PRIMARY KEY, generation TEXT NOT NULL)');
        database
          .query(`INSERT INTO vector_generations VALUES (?, ?, 'model-command', ?, 3, 1, 0, 'ready', ?)`)
          .run('generation-command', SNAPSHOT_ID, 'e'.repeat(64), new Date(0).toISOString());
        database
          .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
          .run(WORKTREE_ID, 'generation-command');
      } finally {
        database.close(false);
      }
    });
    return databasePath;
  });
}

function activeView(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string]>('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(WORKTREE_ID)?.snapshot_id;
  } finally {
    database.close(false);
  }
}

function removedView(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly expected_snapshot_id: string}, [string]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?',
      )
      .get(WORKTREE_ID)?.expected_snapshot_id;
  } finally {
    database.close(false);
  }
}

function readVectorPointer(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string]>(
        `SELECT generation.snapshot_id
         FROM vector_pointers AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE pointer.worktree_id = ?`,
      )
      .get(WORKTREE_ID)?.snapshot_id;
  } finally {
    database.close(false);
  }
}
