import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, FileSystem, Ref} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CodeGraphMaintenanceCoordinator,
  makeCodeGraphMaintenanceCoordinator,
  type CodeGraphRoutineMaintenanceTick,
} from '../../src/code_graph/maintenance_coordinator.js';
import {CodeGraphStore, type CodeGraphRoutineMaintenanceResult} from '../../src/code_graph/store.js';
import {withCodeGraphMaintenanceIntent} from '../../src/code_graph/maintenance_gate.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('routine code graph maintenance', () => {
  it('defers immediately on checkout writer contention without opening SQLite', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-contention-', false);
    await writeFile(fixture.databasePath, 'must not be opened while the writer gate is held');

    const observed = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CodeGraphStore;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            fixture.writerLockPath,
            {
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = performance.now();
        const result = yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
        const elapsedMilliseconds = performance.now() - startedAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return {elapsedMilliseconds, result};
      }),
    );

    expect(observed.result).toEqual({reason: 'writer-busy', state: 'deferred'});
    expect(observed.elapsedMilliseconds).toBeLessThan(500);
    await expect(Bun.file(fixture.databasePath).text()).resolves.toContain('must not be opened');
  });

  it('defers an explicit global maintenance intent before opening SQLite', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-intent-', false);
    await writeFile(fixture.databasePath, 'must not be opened during explicit maintenance');

    const result = await runEffect(
      Effect.gen(function* () {
        const coordinator = yield* CodeGraphMaintenanceCoordinator;
        return yield* withCodeGraphMaintenanceIntent(
          fixture.home,
          coordinator.tick({
            databasePath: fixture.databasePath,
            threadnoteHome: fixture.home,
            writerLockPath: fixture.writerLockPath,
          }),
        );
      }),
    );

    expect(result).toEqual({reason: 'external-maintenance', state: 'deferred'});
    await expect(Bun.file(fixture.databasePath).text()).resolves.toContain('must not be opened');
  });

  it('reclaims exactly one physical table page per tick and becomes idempotent', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-page-');
    seedCleanupPages(fixture.databasePath);

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const run = () => store.runRoutineMaintenance(fixture.databasePath, {writerLockPath: fixture.writerLockPath});
        return [yield* run(), yield* run(), yield* run(), yield* run(), yield* run()] as const;
      }),
    );

    expect(results[0]).toMatchObject({cleanup: 'completed-build', rowsDeleted: 1, state: 'completed'});
    expect(results[1]).toMatchObject({cleanup: 'retired-snapshot', rowsDeleted: 1, state: 'completed'});
    expect(results[2]).toMatchObject({cleanup: 'retired-snapshot', rowsDeleted: 1, state: 'completed'});
    expect(results[3]).toEqual({
      cleanup: 'none',
      expiredLeases: 0,
      remaining: false,
      retiredSnapshots: 0,
      rowsDeleted: 0,
      state: 'completed',
    });
    expect(results[4]).toEqual(results[3]);

    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT COUNT(*) AS count FROM building_lexical_counters').get()).toEqual({count: 0});
      expect(database.query("SELECT COUNT(*) AS count FROM snapshots WHERE state = 'retired'").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close(false);
    }
  });

  it('bounds an expired-lease page and does not combine it with physical cleanup', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-leases-');
    seedLeaseAndCleanupPages(fixture.databasePath, 101);

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const run = () => store.runRoutineMaintenance(fixture.databasePath, {writerLockPath: fixture.writerLockPath});
        return [yield* run(), yield* run(), yield* run()] as const;
      }),
    );

    expect(results[0]).toMatchObject({cleanup: 'none', expiredLeases: 100, rowsDeleted: 0});
    expect(results[1]).toMatchObject({cleanup: 'none', expiredLeases: 1, rowsDeleted: 0});
    expect(results[2]).toMatchObject({cleanup: 'completed-build', expiredLeases: 0, rowsDeleted: 1});
  });

  it('adds only the lease column on a partial schema and skips absent cleanup tables', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-partial-', false);
    const database = new Database(fixture.databasePath, {create: true, strict: true});
    try {
      database.exec(`
        CREATE TABLE snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          worktree_id TEXT NOT NULL,
          state TEXT NOT NULL,
          base_snapshot_id TEXT
        );
        CREATE TABLE active_snapshots (
          worktree_id TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL
        );
        CREATE TABLE snapshot_leases (
          token TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    } finally {
      database.close(false);
    }

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
      }),
    );

    expect(result).toMatchObject({cleanup: 'none', state: 'completed'});
    const reopened = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(
        reopened
          .query("SELECT COUNT(*) AS count FROM pragma_table_info('snapshot_leases') WHERE name = ?")
          .get('retire_when_inactive'),
      ).toEqual({count: 1});
      expect(reopened.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).not.toContainEqual({
        name: 'symbols',
      });
    } finally {
      reopened.close(false);
    }
  });

  it('skips an incomplete base schema before applying the additive lease migration', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-incomplete-', false);
    const database = new Database(fixture.databasePath, {create: true, strict: true});
    try {
      database.exec(`
        CREATE TABLE snapshots (
          id TEXT PRIMARY KEY NOT NULL,
          state TEXT NOT NULL,
          base_snapshot_id TEXT
        );
        CREATE TABLE active_snapshots (
          worktree_id TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL
        );
        CREATE TABLE snapshot_leases (
          token TEXT PRIMARY KEY NOT NULL,
          snapshot_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    } finally {
      database.close(false);
    }

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
      }),
    );

    expect(result).toEqual({reason: 'schema-unavailable', state: 'skipped'});
    const reopened = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(
        reopened
          .query("SELECT COUNT(*) AS count FROM pragma_table_info('snapshot_leases') WHERE name = ?")
          .get('retire_when_inactive'),
      ).toEqual({count: 0});
    } finally {
      reopened.close(false);
    }
  });

  it('preserves the full base closure of an active snapshot while reaping an expired lease', async () => {
    const fixture = await routineFixture('threadnote-routine-maintenance-base-');
    seedProtectedBaseClosure(fixture.databasePath);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.runRoutineMaintenance(fixture.databasePath, {
          writerLockPath: fixture.writerLockPath,
        });
      }),
    );

    expect(result).toMatchObject({
      cleanup: 'none',
      expiredLeases: 1,
      retiredSnapshots: 0,
      rowsDeleted: 0,
      state: 'completed',
    });
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT state FROM snapshots WHERE id = ?').get('base-root')).toEqual({state: 'ready'});
      expect(database.query('SELECT COUNT(*) AS count FROM snapshot_leases').get()).toEqual({count: 0});
    } finally {
      database.close(false);
    }
  });

  it('coalesces one database and rejects a second database in the same home', async () => {
    const first = tick('/home', '/database/one');
    const second = tick('/home', '/database/two');
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
          Ref.updateAndGet(calls, count => count + 1).pipe(
            Effect.tap(() => Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(noWorkResult),
          ),
        );
        const owner = yield* Effect.forkChild(coordinator.tick(first));
        yield* Deferred.await(started);
        const joined = yield* Effect.forkChild(coordinator.tick(first));
        yield* Effect.sleep(5);
        const competing = yield* coordinator.tick(second);
        yield* Deferred.succeed(release, undefined);
        const joinedResults = yield* Effect.all([Fiber.join(owner), Fiber.join(joined)]);

        return {
          calls: yield* Ref.get(calls),
          competing,
          joinedResults,
        };
      }),
    );

    expect(observed.calls).toBe(1);
    expect(observed.joinedResults).toEqual([noWorkResult, noWorkResult]);
    expect(observed.competing).toEqual({reason: 'home-tick-active', state: 'deferred'});
  });

  it('single-flights every bounded number of concurrent callers for one database', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({max: 16, min: 2}), async callers => {
        const observed = await Effect.runPromise(
          Effect.gen(function* () {
            const calls = yield* Ref.make(0);
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const coordinator = yield* makeCodeGraphMaintenanceCoordinator(() =>
              Ref.updateAndGet(calls, count => count + 1).pipe(
                Effect.tap(() => Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.as(noWorkResult),
              ),
            );
            const first = yield* Effect.forkChild(coordinator.tick(tick('/home', '/database')));
            yield* Deferred.await(started);
            const joined = yield* Effect.forkChild(
              Effect.all(
                Array.from({length: callers - 1}, () => coordinator.tick(tick('/home', '/database'))),
                {
                  concurrency: 'unbounded',
                },
              ),
            );
            yield* Effect.sleep(5);
            yield* Deferred.succeed(release, undefined);
            return {
              calls: yield* Ref.get(calls),
              results: [yield* Fiber.join(first), ...(yield* Fiber.join(joined))],
            };
          }),
        );
        expect(observed.calls).toBe(1);
        expect(observed.results).toEqual(Array.from({length: callers}, () => noWorkResult));
      }),
      {numRuns: 30},
    );
  });
});

const noWorkResult = {
  cleanup: 'none',
  expiredLeases: 0,
  remaining: false,
  retiredSnapshots: 0,
  rowsDeleted: 0,
  state: 'completed',
} as const satisfies CodeGraphRoutineMaintenanceResult;

function tick(threadnoteHome: string, databasePath: string): CodeGraphRoutineMaintenanceTick {
  return {databasePath, threadnoteHome, writerLockPath: `${databasePath}.lock`};
}

async function routineFixture(prefix: string, initialize = true) {
  const home = await mkdtemp(prefix);
  temporaryHomes.push(home);
  const checkoutId = 'a'.repeat(64);
  const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
  const databasePath = join(repositoryRoot, 'graph-v3.sqlite');
  const writerLockPath = join(home, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
  await mkdir(repositoryRoot, {recursive: true});
  if (initialize) {
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
  }
  return {databasePath, home, writerLockPath};
}

function seedCleanupPages(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'completed-build', 'ready');
    insertSnapshot(database, 'retired-data', 'retired');
    database
      .query(
        `INSERT INTO building_lexical_counters
          (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
         VALUES (?, 1, 1, 1, 1)`,
      )
      .run('completed-build');
    database
      .query(
        `INSERT INTO symbols (
           snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         ) VALUES (?, 'symbol', 'hash', 'function', 'symbol', 'symbol', 'src/symbol.ts', 'typescript',
           NULL, '[]', 'typescript', NULL, NULL, 0, NULL, NULL,
           '{"line":1,"column":1,"endLine":1,"endColumn":2}')`,
      )
      .run('retired-data');
  } finally {
    database.close(false);
  }
}

function seedLeaseAndCleanupPages(databasePath: string, leases: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'lease-target', 'ready');
    database
      .query(
        `INSERT INTO building_lexical_counters
          (snapshot_id, completed_batch_count, posting_count, symbol_count, term_count)
         VALUES (?, 1, 1, 1, 1)`,
      )
      .run('lease-target');
    const insert = database.query(
      `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
       VALUES (?, 'lease-target', 0, 0)`,
    );
    database.transaction(() => {
      for (let index = 0; index < leases; index += 1) insert.run(`expired-${index.toString().padStart(3, '0')}`);
    })();
  } finally {
    database.close(false);
  }
}

function seedProtectedBaseClosure(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    insertSnapshot(database, 'base-root', 'ready');
    insertSnapshot(database, 'base-alias', 'ready', 'base-root');
    insertSnapshot(database, 'active-overlay', 'ready', 'base-alias');
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, 10)')
      .run('active-overlay');
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run('active-worktree', 'active-overlay', new Date().toISOString());
    database
      .query(
        `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
         VALUES ('expired-base-reader', 'base-root', 0, 1)`,
      )
      .run();
  } finally {
    database.close(false);
  }
}

function seedRepository(database: Database): void {
  const now = new Date().toISOString();
  database
    .query(
      `INSERT OR IGNORE INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES ('repository', 'fixture', 'sha1', ?, ?)`,
    )
    .run(now, now);
}

function insertSnapshot(database: Database, id: string, state: 'ready' | 'retired', baseSnapshotId?: string): void {
  const now = new Date().toISOString();
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
         extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
         edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, 'repository', 'fixture-worktree', 'commit', ?, ?, 'extractor', 0, NULL, ?, 0, 0, 0, ?, ?, NULL)`,
    )
    .run(id, id, baseSnapshotId ?? null, state, now, now);
}
