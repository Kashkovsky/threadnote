import {copyFile, rename} from 'node:fs/promises';
import {Database} from 'bun:sqlite';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {codeGraphWorktreeLockPath} from '../../src/code_graph/layout.js';
import {
  codeGraphStorageUnattributedBytes,
  codeGraphCompactionRequiredFreeBytes,
  compactCodeGraphStorage,
  inspectCodeGraphStorage,
} from '../../src/code_graph/storage.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {SystemInfo} from '../../src/effect/system.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('active code graph storage', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('reports exact sidecar bytes and transactionally compacts verified free pages', async () => {
    const fixture = await storageFixture(homes);
    const ordinary = await runEffect(inspectCodeGraphStorage(fixture.home, fixture.checkoutId));
    if (ordinary.state !== 'available' || ordinary.pageStorage.state !== 'available') {
      throw new Error('missing ordinary storage');
    }
    expect(ordinary.pageStorage.attribution).toBeUndefined();

    const before = await runEffect(inspectCodeGraphStorage(fixture.home, fixture.checkoutId, {attributeObjects: true}));
    expect(before).toMatchObject({state: 'available'});
    if (before.state !== 'available' || before.pageStorage.state !== 'available') throw new Error('missing storage');
    expect(before.filesystemBytes).toBe(before.databaseBytes + before.walBytes + before.journalBytes + before.shmBytes);
    expect(before.totalBytes).toBe(before.filesystemBytes + before.temporaryBytes);
    expect(before.pageStorage.freelistPages).toBeGreaterThan(0);
    expect(before.pageStorage.reclaimableBytes).toBe(before.pageStorage.pageSize * before.pageStorage.freelistPages);
    const attribution = before.pageStorage.attribution;
    expect(attribution).toBeDefined();
    if (!attribution) throw new Error('missing deep storage attribution');
    if (attribution.state === 'unavailable') {
      expect(attribution.reason).toBe('sqlite-dbstat-unavailable');
    } else {
      expect(attribution.allocatedBytes).toBe(before.pageStorage.pageCount * before.pageStorage.pageSize);
      expect(attribution.freelistBytes).toBe(before.pageStorage.reclaimableBytes);
      expect(attribution.attributedBytes + attribution.freelistBytes + attribution.unattributedBytes).toBe(
        attribution.allocatedBytes,
      );
      expect(attribution.objectsTruncated).toBe(false);
      expect(attribution.objects).toHaveLength(attribution.objectCount);
      expect(attribution.objects.reduce((total, object) => total + object.bytes, 0)).toBe(attribution.attributedBytes);
      expect(attribution.objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({kind: 'internal', name: 'sqlite_schema'}),
          expect.objectContaining({kind: 'table', name: 'payload'}),
        ]),
      );
      for (const object of attribution.objects) {
        expect(object.bytes).toBe(object.pages * before.pageStorage.pageSize);
      }
    }

    const dryRun = await runEffect(
      compactCodeGraphStorage(fixture.home, fixture.checkoutId, {dryRun: true, force: true}),
    );
    expect(dryRun).toMatchObject({action: 'would-compact', dryRun: true});

    const compacted = await runEffect(
      compactCodeGraphStorage(fixture.home, fixture.checkoutId, {dryRun: false, force: true}),
    );
    expect(compacted).toMatchObject({action: 'compacted', dryRun: false});
    if (compacted.action !== 'compacted') throw new Error(`unexpected action ${compacted.action}`);
    expect(compacted.reclaimedBytes).toBeGreaterThan(0);
    expect(compacted.after?.pageStorage).toMatchObject({freelistPages: 0, state: 'available'});
    const database = new Database(fixture.databasePath, {readonly: true, strict: true});
    try {
      expect(database.query('SELECT COUNT(*) AS count FROM payload').get()).toEqual({count: 128});
      expect(database.query('PRAGMA quick_check').get()).toEqual({quick_check: 'ok'});
    } finally {
      database.close(false);
    }
  });

  it('keeps exact attribution accounting for every valid allocation split', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 1_000_000_000, min: 0}),
        fc.nat({max: 1_000_000_000}),
        fc.nat({max: 1_000_000_000}),
        (allocatedBytes, attributedSeed, freelistSeed) => {
          const attributedBytes = attributedSeed % (allocatedBytes + 1);
          const remainingBytes = allocatedBytes - attributedBytes;
          const freelistBytes = freelistSeed % (remainingBytes + 1);
          const unattributedBytes = codeGraphStorageUnattributedBytes(allocatedBytes, attributedBytes, freelistBytes);

          expect(unattributedBytes).toBeGreaterThanOrEqual(0);
          expect(attributedBytes + freelistBytes + unattributedBytes).toBe(allocatedBytes);
        },
      ),
      {numRuns: 500},
    );
  });

  it('refuses compaction before VACUUM when available disk space is below the conservative requirement', async () => {
    const fixture = await storageFixture(homes);
    const before = await runEffect(inspectCodeGraphStorage(fixture.home, fixture.checkoutId));
    if (before.state !== 'available') throw new Error('missing storage');
    const required = codeGraphCompactionRequiredFreeBytes(before);

    await expect(compactWithAvailableDisk(fixture, required - 1)).rejects.toThrow(
      new RegExp(`needs ${required.toLocaleString()} bytes free`),
    );
    expect(storagePayloadCount(fixture.databasePath)).toBe(128);
  });

  it('compacts when available disk space meets the conservative requirement', async () => {
    const fixture = await storageFixture(homes);
    const compacted = await compactWithAvailableDisk(fixture, Number.MAX_SAFE_INTEGER);

    expect(compacted).toMatchObject({action: 'compacted'});
    expect(storagePayloadCount(fixture.databasePath)).toBe(128);
  });

  it('refuses compaction safely when available disk space cannot be determined', async () => {
    const fixture = await storageFixture(homes);

    await expect(compactWithAvailableDisk(fixture, undefined)).rejects.toThrow(
      /Could not determine free disk space before code graph compaction/,
    );
    expect(storagePayloadCount(fixture.databasePath)).toBe(128);
  });

  it('defers without opening an invalid database while linked worktree builds share the checkout store', async () => {
    const home = await mkdtemp('threadnote-graph-storage-locked-');
    homes.push(home);
    const checkoutId = 'b'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(databasePath, 'must not be opened');

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const acquiredA = yield* Deferred.make<void>();
        const acquiredB = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lockOptions = (acquired: Deferred.Deferred<void>) => ({
          heartbeatIntervalMilliseconds: 20,
          onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
          retryIntervalMilliseconds: 5,
          staleAfterMilliseconds: 100,
          waitTimeoutMilliseconds: 5_000,
        });
        const owners = yield* Effect.forEach(
          [
            {acquired: acquiredA, worktreeId: 'c'.repeat(64)},
            {acquired: acquiredB, worktreeId: 'd'.repeat(64)},
          ],
          entry =>
            Effect.forkChild(
              withExclusiveFileLock(
                fs,
                codeGraphWorktreeLockPath(path, home, checkoutId, entry.worktreeId),
                lockOptions(entry.acquired),
                Deferred.await(release),
              ),
            ),
        );
        yield* Effect.all([Deferred.await(acquiredA), Deferred.await(acquiredB)], {concurrency: 2});
        const storage = yield* inspectCodeGraphStorage(home, checkoutId);
        const compacted = yield* compactCodeGraphStorage(home, checkoutId, {dryRun: false, force: true});
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(owners, Fiber.join, {concurrency: 2});
        return {compacted, storage};
      }),
    );

    expect(result.storage).toMatchObject({
      databaseBytes: 18,
      pageStorage: {reason: 'active-build', state: 'deferred'},
      state: 'available',
    });
    expect(result.compacted).toMatchObject({action: 'deferred', reason: 'active-build'});
    await expect(Bun.file(databasePath).text()).resolves.toBe('must not be opened');
  });

  it('defers compaction for every linked-worktree builder and succeeds after both release', async () => {
    const fixture = await storageFixture(homes);
    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const acquiredA = yield* Deferred.make<void>();
        const acquiredB = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owners = yield* Effect.forEach(
          [
            {acquired: acquiredA, worktreeId: 'c'.repeat(64)},
            {acquired: acquiredB, worktreeId: 'd'.repeat(64)},
          ],
          entry =>
            Effect.forkChild(
              withExclusiveFileLock(
                fs,
                codeGraphWorktreeLockPath(path, fixture.home, fixture.checkoutId, entry.worktreeId),
                {
                  heartbeatIntervalMilliseconds: 20,
                  onAcquired: () => Deferred.succeed(entry.acquired, undefined).pipe(Effect.asVoid),
                  retryIntervalMilliseconds: 5,
                  staleAfterMilliseconds: 100,
                  waitTimeoutMilliseconds: 5_000,
                },
                Deferred.await(release),
              ),
            ),
        );
        yield* Effect.all([Deferred.await(acquiredA), Deferred.await(acquiredB)], {concurrency: 2});
        const deferred = yield* compactCodeGraphStorage(fixture.home, fixture.checkoutId, {
          dryRun: false,
          force: true,
        });
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(owners, Fiber.join, {concurrency: 2});
        const system = yield* SystemInfo;
        const compacted = yield* compactCodeGraphStorage(fixture.home, fixture.checkoutId, {
          dryRun: false,
          force: true,
        }).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({...system, availableDiskBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER)}),
          ),
        );
        return {compacted, deferred};
      }),
    );

    expect(result.deferred).toMatchObject({action: 'deferred', reason: 'active-build'});
    expect(result.compacted).toMatchObject({action: 'compacted'});
  });

  it('reclaims an abandoned worktree build lock before compacting', async () => {
    const fixture = await storageFixture(homes);
    const lockPath = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return codeGraphWorktreeLockPath(path, fixture.home, fixture.checkoutId, 'e'.repeat(64));
      }),
    );
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(lockPath, '2147483647:abandoned-builder\n');

    const inspected = await runEffect(inspectCodeGraphStorage(fixture.home, fixture.checkoutId));
    expect(inspected).toMatchObject({pageStorage: {state: 'available'}, state: 'available'});
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);

    const compacted = await runEffect(
      compactCodeGraphStorage(fixture.home, fixture.checkoutId, {dryRun: true, force: true}),
    );

    expect(compacted).toMatchObject({action: 'would-compact'});
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a replaced database target during preflight revalidation',
    async () => {
      const fixture = await storageFixture(homes);
      const replacement = `${fixture.databasePath}.replacement`;
      await copyFile(fixture.databasePath, replacement);

      await expect(
        runEffect(
          compactCodeGraphStorage(fixture.home, fixture.checkoutId, {
            dryRun: false,
            force: true,
            interlock: {
              beforeRevalidation: () =>
                Effect.promise(async () => {
                  await rename(replacement, fixture.databasePath);
                }),
            },
          }),
        ),
      ).rejects.toThrow(/changed before compaction/);

      const database = new Database(fixture.databasePath, {readonly: true, strict: true});
      try {
        expect(database.query('PRAGMA quick_check').get()).toEqual({quick_check: 'ok'});
        expect(database.query('SELECT COUNT(*) AS count FROM payload').get()).toEqual({count: 128});
      } finally {
        database.close(false);
      }
    },
  );

  it('leaves the original database intact when SQLite-level contention aborts VACUUM', async () => {
    const fixture = await storageFixture(homes);
    const writer = new Database(fixture.databasePath, {create: false, strict: true});
    try {
      writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;');
      await expect(
        runEffect(compactCodeGraphStorage(fixture.home, fixture.checkoutId, {dryRun: false, force: true})),
      ).rejects.toThrow(/compaction failed safely/);
      writer.exec('ROLLBACK');
      expect(writer.query('SELECT COUNT(*) AS count FROM payload').get()).toEqual({count: 128});
      expect(writer.query('PRAGMA quick_check').get()).toEqual({quick_check: 'ok'});
    } finally {
      try {
        writer.exec('ROLLBACK');
      } catch {
        // The assertion path already released the transaction.
      }
      writer.close(false);
    }
  });
});

async function storageFixture(homes: string[]) {
  const home = await mkdtemp('threadnote-graph-storage-');
  homes.push(home);
  const checkoutId = 'a'.repeat(64);
  const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
  const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
  await mkdir(repositoryRoot, {recursive: true});
  const database = new Database(databasePath, {create: true, strict: true});
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE schema_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_metadata (key, value) VALUES ('schema_version', '${CODE_GRAPH_SCHEMA_VERSION}');
      CREATE TABLE snapshots (state TEXT NOT NULL);
      INSERT INTO snapshots (state) VALUES ('ready');
      CREATE TABLE active_snapshots (snapshot_id TEXT NOT NULL);
      INSERT INTO active_snapshots (snapshot_id) VALUES ('ready-snapshot');
      CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB NOT NULL);
    `);
    const insert = database.prepare('INSERT INTO payload (id, value) VALUES (?, ?)');
    const payload = new Uint8Array(16 * 1024).fill(37);
    database.transaction(() => {
      for (let index = 0; index < 2_048; index += 1) insert.run(index, payload);
    })();
    database.exec('DELETE FROM payload WHERE id >= 128; PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    database.close(false);
  }
  return {checkoutId, databasePath, home};
}

function compactWithAvailableDisk(
  fixture: Awaited<ReturnType<typeof storageFixture>>,
  availableBytes: number | undefined,
) {
  return runEffect(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      return yield* compactCodeGraphStorage(fixture.home, fixture.checkoutId, {
        dryRun: false,
        force: true,
      }).pipe(
        Effect.provideService(
          SystemInfo,
          SystemInfo.of({...system, availableDiskBytes: () => Effect.succeed(availableBytes)}),
        ),
      );
    }),
  );
}

function storagePayloadCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM payload').get()!.count;
  } finally {
    database.close(false);
  }
}
