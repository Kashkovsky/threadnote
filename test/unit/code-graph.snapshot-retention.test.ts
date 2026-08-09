import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphStore, type CodeGraphStoreShape} from '../../src/code_graph/store.js';
import {CodeGraphStoreBusyError, type CodeGraphSnapshot, type RepositoryIdentity} from '../../src/code_graph/types.js';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
});

describe('code graph ready snapshot retention', () => {
  effectIt.effect('keeps every sibling view and its graph rows during concurrent promotion load', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-many-worktrees-'));
        temporaryRoots.push(root);
        const baseIdentity = repositoryIdentity(root);
        const databasePath = join(
          root,
          'indexes',
          'code-graph',
          'repositories',
          baseIdentity.checkoutId,
          'graph-v3.sqlite',
        );
        const fixtures = Array.from({length: 64}, (_, index) => {
          const identity = {...baseIdentity, worktreeId: index.toString(16).padStart(64, '0')};
          return {identity, snapshot: snapshot(identity, `registered-${index}`)};
        });
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.forEach(
          fixtures,
          fixture =>
            registerReadySnapshots(store, databasePath, fixture.identity, [fixture.snapshot]).pipe(
              Effect.andThen(store.promote(databasePath, fixture.identity, fixture.snapshot.id)),
            ),
          {concurrency: 1, discard: true},
        );
        yield* Effect.sync(() => seedSymbol(databasePath, fixtures[0]!.snapshot.id));
        yield* Effect.forEach(
          Array.from({length: 128}, (_, index) => fixtures[index % fixtures.length]!),
          fixture => store.promote(databasePath, fixture.identity, fixture.snapshot.id),
          {concurrency: 8, discard: true},
        );
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            expect(database.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({
              count: fixtures.length,
            });
            expect(database.query("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'ready'").get()).toEqual({
              count: fixtures.length,
            });
            expect(
              database
                .query('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
                .get(fixtures[0]!.snapshot.id),
            ).toEqual({count: 1});
            expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
          } finally {
            database.close(false);
          }
        });
      }).pipe(Effect.provide(ApplicationLayer)),
    ),
  );

  it('preserves a ready snapshot that was leased by ID without becoming an active worktree view', async () => {
    const root = await mkdtemp('threadnote-ready-retention-non-active-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const exported = snapshot(identity, 'exported-by-id');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [exported]);
        const lease = yield* store.acquireSnapshotLease(databasePath, exported.id, 60_000);
        yield* store.releaseSnapshotLease(databasePath, lease);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(exported.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT COUNT(*) AS count FROM active_snapshots').get()).toEqual({count: 0});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('reclaims a non-active snapshot after an explicitly transient lease is released', async () => {
    const root = await mkdtemp('threadnote-ready-retention-transient-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const transient = snapshot(identity, 'transient-by-id');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [transient]);
        const lease = yield* store.acquireSnapshotLease(databasePath, transient.id, 60_000, {
          retireWhenInactive: true,
        });
        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, transient.id);
      }),
    );

    expect(readSnapshotState(databasePath, transient.id)).toBeUndefined();
  });

  it('reclaims a superseded snapshot when its last lease is released and preserves the active view and base', async () => {
    const root = await mkdtemp('threadnote-ready-retention-release-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const base = snapshot(identity, 'base', {dirty: false});
    const superseded = snapshot(identity, 'superseded', {baseSnapshotId: base.id});
    const current = snapshot(identity, 'current', {baseSnapshotId: base.id});

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [base, superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const lease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => seedSymbol(databasePath, superseded.id));

        expect(readSnapshotState(databasePath, superseded.id)).toBe('ready');
        yield* store.releaseSnapshotLease(databasePath, lease);
        expect(readSnapshotState(databasePath, superseded.id)).not.toBe('ready');
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(superseded.id)).toBeNull();
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(base.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(current.id)).toEqual({state: 'ready'});
      expect(
        database.query('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?').get(identity.worktreeId),
      ).toEqual({snapshot_id: current.id});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
      expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close(false);
    }
  });

  effectIt.effect('reclaims a superseded leased overlay while retaining its detached base as a warm leaf', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp('threadnote-ready-retention-base-closure-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const base = snapshot(identity, 'detached-base', {dirty: false});
        const superseded = snapshot(identity, 'leased-overlay', {baseSnapshotId: base.id});
        const current = snapshot(identity, 'unrelated-current');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [base, superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const lease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);

        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
        expect(readSnapshotState(databasePath, superseded.id)).toBeUndefined();
        expect(readSnapshotState(databasePath, base.id)).toBe('ready');
        expect(readSnapshotState(databasePath, current.id)).toBe('ready');
      }).pipe(Effect.provide(ApplicationLayer)),
    ),
  );

  it('keeps a displaced view until every overlapping lease is released', async () => {
    const root = await mkdtemp('threadnote-ready-retention-overlapping-leases-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const displaced = snapshot(identity, 'overlap-displaced');
    const current = snapshot(identity, 'overlap-current');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [displaced]);
        yield* store.promote(databasePath, identity, displaced.id);
        const first = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
        const second = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);

        yield* store.releaseSnapshotLease(databasePath, first);
        expect(readSnapshotState(databasePath, displaced.id)).toBe('ready');
        yield* store.releaseSnapshotLease(databasePath, second);
        yield* waitForSnapshotRemoval(databasePath, displaced.id);
      }),
    );

    expect(readSnapshotState(databasePath, displaced.id)).toBeUndefined();
    expect(readSnapshotState(databasePath, current.id)).toBe('ready');
  });

  it('carries retirement provenance from an expired lease to a renewed overlapping lease', async () => {
    const root = await mkdtemp('threadnote-ready-retention-renewed-overlap-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const displaced = snapshot(identity, 'renew-displaced');
    const current = snapshot(identity, 'renew-current');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [displaced]);
        yield* store.promote(databasePath, identity, displaced.id);
        const expired = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
        const renewed = yield* store.acquireSnapshotLease(databasePath, displaced.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => expireLease(databasePath, expired));

        yield* store.renewSnapshotLease(databasePath, renewed, 60_000);
        expect(readSnapshotState(databasePath, displaced.id)).toBe('ready');
        yield* store.releaseSnapshotLease(databasePath, renewed);
        yield* waitForSnapshotRemoval(databasePath, displaced.id);
      }),
    );

    expect(readSnapshotState(databasePath, displaced.id)).toBeUndefined();
  });

  it('retires a lease acquired by ID when that snapshot is later promoted and displaced', async () => {
    const root = await mkdtemp('threadnote-ready-retention-acquire-promote-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const acquired = snapshot(identity, 'acquired-before-promotion');
    const current = snapshot(identity, 'after-acquired-promotion');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [acquired]);
        const lease = yield* store.acquireSnapshotLease(databasePath, acquired.id, 60_000);
        yield* store.promote(databasePath, identity, acquired.id);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);

        yield* store.releaseSnapshotLease(databasePath, lease);
        yield* waitForSnapshotRemoval(databasePath, acquired.id);
      }),
    );

    expect(readSnapshotState(databasePath, acquired.id)).toBeUndefined();
    expect(readSnapshotState(databasePath, current.id)).toBe('ready');
  });

  it('reaps an expired reader lease on the next ordinary acquire', async () => {
    const root = await mkdtemp('threadnote-ready-retention-expired-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const superseded = snapshot(identity, 'expired-reader');
    const current = snapshot(identity, 'current');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const expiredLease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => expireLease(databasePath, expiredLease));

        const currentLease = yield* store.acquireSnapshotLease(databasePath, current.id, 60_000);
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
        yield* store.releaseSnapshotLease(databasePath, currentLease);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(superseded.id)).toBeNull();
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(current.id)).toEqual({state: 'ready'});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('migrates an expired displaced active-view lease from the pre-retention schema', async () => {
    const root = await mkdtemp('threadnote-ready-retention-migration-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const superseded = snapshot(identity, 'legacy-expired-reader');
    const current = snapshot(identity, 'current');

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [superseded]);
        yield* store.promote(databasePath, identity, superseded.id);
        const expiredLease = yield* store.acquireSnapshotLease(databasePath, superseded.id, 60_000);
        yield* registerReadySnapshots(store, databasePath, identity, [current]);
        yield* store.promote(databasePath, identity, current.id);
        yield* Effect.sync(() => {
          expireLease(databasePath, expiredLease);
          dropLeaseRetirementColumn(databasePath);
        });
      }),
    );

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        // Lease acquisition is the first writer in this process. It must apply
        // the additive schema migration before executing lease SQL.
        const currentLease = yield* store.acquireSnapshotLease(databasePath, current.id, 60_000);
        yield* waitForSnapshotRemoval(databasePath, superseded.id);
        yield* store.releaseSnapshotLease(databasePath, currentLease);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      const columns = database.query("PRAGMA table_info('snapshot_leases')").all() as readonly {
        readonly name: string;
      }[];
      expect(columns.map(column => column.name)).toContain('retire_when_inactive');
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(superseded.id)).toBeNull();
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get(current.id)).toEqual({state: 'ready'});
    } finally {
      database.close(false);
    }
  });

  it('migrates the lease schema before releasing a lease', async () => {
    const root = await mkdtemp('threadnote-ready-retention-release-migration-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const ready = snapshot(identity, 'release-migration');
    const token = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        return yield* store.acquireSnapshotLease(databasePath, ready.id, 60_000);
      }),
    );
    dropLeaseRetirementColumn(databasePath);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.releaseSnapshotLease(databasePath, token);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(leaseColumns(database)).toContain('retire_when_inactive');
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('migrates the lease schema before renewing a lease', async () => {
    const root = await mkdtemp('threadnote-ready-retention-renew-migration-');
    temporaryRoots.push(root);
    const databasePath = join(root, 'graph-v3.sqlite');
    const identity = repositoryIdentity(root);
    const ready = snapshot(identity, 'renew-migration');
    const token = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        return yield* store.acquireSnapshotLease(databasePath, ready.id, 60_000);
      }),
    );
    const before = readLeaseExpiration(databasePath, token);
    dropLeaseRetirementColumn(databasePath);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.renewSnapshotLease(databasePath, token, 10 * 60_000);
      }),
    );
    const after = readLeaseExpiration(databasePath, token);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.releaseSnapshotLease(databasePath, token);
      }),
    );

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(leaseColumns(database)).toContain('retire_when_inactive');
      expect(readLeaseExpiration(databasePath, token)).toBeUndefined();
      expect(before).toBeDefined();
      expect(after).toBeGreaterThan(before ?? 0);
    } finally {
      database.close(false);
    }
  });

  it('returns a typed privacy-safe error when a bounded lease writer wait expires', async () => {
    const home = await mkdtemp('threadnote-ready-retention-writer-busy-');
    temporaryRoots.push(home);
    const checkoutId = 'c'.repeat(64);
    const databasePath = join(home, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
    const writerLockPath = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
    const identity = {
      ...repositoryIdentity(home),
      checkoutId,
      worktreeId: 'd'.repeat(64),
    };
    const ready = snapshot(identity, 'bounded-writer-wait');

    const error = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* registerReadySnapshots(store, databasePath, identity, [ready]);
        const writerAcquired = yield* Deferred.make<void>();
        const releaseWriter = yield* Deferred.make<void>();
        const writer = yield* store
          .withSession(databasePath, store.initialize(databasePath), {
            onWriterAcquired: () =>
              Deferred.succeed(writerAcquired, undefined).pipe(Effect.andThen(Deferred.await(releaseWriter))),
            writerLockPath,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(writerAcquired);
        const busy = yield* store
          .acquireSnapshotLease(databasePath, ready.id, 60_000, {waitTimeoutMilliseconds: 0})
          .pipe(Effect.flip, Effect.ensuring(Deferred.succeed(releaseWriter, undefined).pipe(Effect.asVoid)));
        yield* Fiber.join(writer);
        return busy;
      }),
    );

    expect(error).toBeInstanceOf(CodeGraphStoreBusyError);
    expect(error.message).toContain('another code graph writer owns this checkout');
    expect(error.message).not.toContain(home);
  });
});

function registerReadySnapshots(
  store: CodeGraphStoreShape,
  databasePath: string,
  identity: RepositoryIdentity,
  snapshots: readonly CodeGraphSnapshot[],
) {
  return Effect.gen(function* () {
    for (const candidate of snapshots) yield* store.markBuilding(databasePath, identity, candidate);
    yield* Effect.sync(() => {
      const database = new Database(databasePath, {strict: true});
      try {
        const ready = database.prepare("UPDATE snapshots SET state = 'ready', completed_at = ? WHERE id = ?");
        const generation = database.prepare(
          "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
        );
        database.transaction(() => {
          for (const candidate of snapshots) {
            ready.run(new Date().toISOString(), candidate.id);
            generation.run(candidate.id);
          }
        })();
      } finally {
        database.close(false);
      }
    });
  });
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'snapshot-retention-fixture',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
}

function snapshot(
  identity: RepositoryIdentity,
  suffix: string,
  options: {readonly baseSnapshotId?: string; readonly dirty?: boolean} = {},
): CodeGraphSnapshot {
  const dirty = options.dirty ?? true;
  return {
    ...(options.baseSnapshotId ? {baseSnapshotId: options.baseSnapshotId} : {}),
    commit: identity.headCommit,
    dirty,
    edgeCount: 0,
    extractorSet: 'extractor-set',
    fileCount: 0,
    id: `cgsn_${createHash('sha1').update(suffix).digest('hex')}`,
    ...(dirty ? {overlayFingerprint: `overlay-${suffix}`} : {}),
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function seedSymbol(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO symbols (
           snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         ) VALUES (?, 'superseded-symbol', 'content', 'function', 'stale', 'stale',
           'src/stale.ts', 'typescript', NULL, '[]', 'typescript', NULL, NULL, 0,
           NULL, NULL, '{"startLine":1,"endLine":1}')`,
      )
      .run(snapshotId);
  } finally {
    database.close(false);
  }
}

function expireLease(databasePath: string, token: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('UPDATE snapshot_leases SET expires_at = ? WHERE token = ?').run(Date.now() - 1, token);
  } finally {
    database.close(false);
  }
}

function dropLeaseRetirementColumn(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('BEGIN IMMEDIATE');
    database.run('ALTER TABLE snapshot_leases DROP COLUMN retire_when_inactive');
    database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete');
    database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert');
    database.run('DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update');
    database.run('DROP TABLE IF EXISTS removed_view_cleanup');
    database.run('DROP TABLE IF EXISTS snapshot_build_owner_instances');
    database.run(
      `DELETE FROM schema_metadata
       WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor')`,
    );
    database.run("UPDATE schema_metadata SET value = '6' WHERE key = 'persistent_extension_schema_revision'");
    database.run('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.run('ROLLBACK');
    throw error;
  } finally {
    database.close(false);
  }
}

function leaseColumns(database: Database): readonly string[] {
  return (
    database.query("PRAGMA table_info('snapshot_leases')").all() as readonly {
      readonly name: string;
    }[]
  ).map(column => column.name);
}

function readLeaseExpiration(databasePath: string, token: string): number | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query('SELECT expires_at FROM snapshot_leases WHERE token = ?').get(token) as
        {readonly expires_at: number} | undefined
    )?.expires_at;
  } finally {
    database.close(false);
  }
}

function readSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query('SELECT state FROM snapshots WHERE id = ?').get(snapshotId) as {readonly state: string} | undefined
    )?.state;
  } finally {
    database.close(false);
  }
}

function waitForSnapshotRemoval(databasePath: string, snapshotId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (readSnapshotState(databasePath, snapshotId) === undefined) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.fail(new Error(`Timed out waiting for retired snapshot ${snapshotId} to be reclaimed.`));
  });
}
