import {Database} from 'bun:sqlite';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {runCodeGraphRepair} from '../../src/code_graph/commands.js';
import {codeGraphDoctorCheck, repairCodeGraphIndexes} from '../../src/code_graph/maintenance.js';
import {codeGraphRepositoryLockPath, codeGraphWorktreeLockPath} from '../../src/code_graph/layout.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {captureConsole} from '../../src/effect/console.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import type {RuntimeConfig} from '../../src/types.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('bounded code graph maintenance', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('lets update-time quick repair defer an actively built large store without waiting or opening it', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-');
    homes.push(home);
    const checkoutId = 'a'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(databasePath, 'this file must never be opened while its build lock is active');
    const progress: string[] = [];

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lockPath = codeGraphWorktreeLockPath(path, home, checkoutId, 'b'.repeat(64));
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            lockPath,
            {
              heartbeatIntervalMilliseconds: 20,
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = yield* Clock.currentTimeMillis;
        const summary = yield* repairCodeGraphIndexes(
          home,
          false,
          state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
          undefined,
          {mode: 'quick'},
        );
        const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - startedAt;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return {elapsedMilliseconds, summary};
      }),
    );

    expect(result.elapsedMilliseconds).toBeLessThan(1_000);
    expect(result.summary).toMatchObject({
      databases: 1,
      deferredDatabases: 1,
      discarded: 0,
      removedIncompleteSnapshots: 0,
      removedTemporaryFiles: 0,
    });
    expect(progress).toEqual(['checking:none', 'deferred:active-build']);
    expect(await Bun.file(databasePath).text()).toContain('must never be opened');
  });

  it('recovers an orphaned checkout lock instead of deferring doctor forever', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-stale-checkout-');
    homes.push(home);
    const checkoutId = 'c'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await mkdir(repositoryRoot, {recursive: true});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const lockPath = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        return codeGraphRepositoryLockPath(path, home, checkoutId);
      }),
    );
    await mkdir(join(lockPath, '..'), {recursive: true});
    await writeFile(
      lockPath,
      `${JSON.stringify({
        processId: 2_147_483_647,
        processStartIdentity: 'orphaned-process-instance',
        token: 'orphaned-checkout-lock',
        version: 1,
      })}\n`,
    );
    const progress: string[] = [];

    const doctor = await runEffect(
      codeGraphDoctorCheck(home, state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`))),
    );

    expect(doctor).toMatchObject({status: 'ok'});
    expect(progress).toEqual(['checking:none']);
    await expect(Bun.file(lockPath).exists()).resolves.toBe(false);
  });

  it('reports an interrupted extension revision and never discards the recoverable database', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-extension-revision-');
    homes.push(home);
    const checkoutId = 'd'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const interrupted = new Database(databasePath, {strict: true});
    try {
      interrupted.exec(`
        DELETE FROM schema_metadata WHERE key = 'persistent_extension_schema_revision';
        DROP TABLE building_materialization_batches;
      `);
    } finally {
      interrupted.close(false);
    }

    const progress: string[] = [];
    const doctorBefore = await runEffect(codeGraphDoctorCheck(home));
    const repair = await runEffect(
      repairCodeGraphIndexes(
        home,
        false,
        state => Effect.sync(() => progress.push(`${state.phase}:${state.reason ?? 'none'}`)),
        undefined,
        {mode: 'deep'},
      ),
    );

    expect(doctorBefore).toMatchObject({status: 'fail'});
    expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
    expect(progress).toEqual(['checking:none', 'deferred:schema-upgrade-on-use']);
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'ok'});
  });

  it('reports exact extension contract drift with a current receipt and preserves the database for self-healing', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-extension-contract-');
    homes.push(home);
    const checkoutId = 'e'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const drifted = new Database(databasePath, {strict: true});
    try {
      drifted.exec('PRAGMA foreign_keys = OFF');
      drifted.exec(`
        DROP TABLE snapshot_build_owners;
        CREATE TABLE snapshot_build_owners (
          snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id),
          owner_token TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        );
      `);
    } finally {
      drifted.close(false);
    }

    const doctorBefore = await runEffect(codeGraphDoctorCheck(home));
    const repair = await runEffect(repairCodeGraphIndexes(home, false, undefined, undefined, {mode: 'deep'}));

    expect(doctorBefore).toMatchObject({status: 'fail'});
    expect(repair).toMatchObject({databases: 1, deferredDatabases: 1, discarded: 0});
    await expect(Bun.file(databasePath).exists()).resolves.toBe(true);

    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'ok'});
  });

  it('explicitly migrates recoverable schemas without waiting for a graph query', async () => {
    const home = await mkdtemp('threadnote-graph-maintenance-explicit-migration-');
    homes.push(home);
    const checkoutId = 'f'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const databasePath = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const interrupted = new Database(databasePath, {strict: true});
    try {
      interrupted.exec(`
        DELETE FROM schema_metadata WHERE key = 'persistent_extension_schema_revision';
        DROP TABLE building_materialization_batches;
      `);
    } finally {
      interrupted.close(false);
    }

    const previewProgress: string[] = [];
    const preview = await runEffect(
      repairCodeGraphIndexes(home, true, state => Effect.sync(() => previewProgress.push(state.phase)), undefined, {
        migrateSchema: true,
        mode: 'quick',
      }),
    );
    expect(preview).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
    expect(previewProgress).toEqual(['checking', 'migrating-schema']);
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'fail'});

    const repairProgress: string[] = [];
    const repair = await runEffect(
      repairCodeGraphIndexes(home, false, state => Effect.sync(() => repairProgress.push(state.phase)), undefined, {
        migrateSchema: true,
        mode: 'quick',
      }),
    );
    expect(repair).toMatchObject({deferredDatabases: 0, migratedDatabases: 1});
    expect(repairProgress).toEqual(['checking', 'migrating-schema']);
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'ok'});
  });

  it('exposes foreground schema migration through graph repair --all', async () => {
    const home = await mkdtemp('threadnote-graph-repair-command-');
    homes.push(home);
    const checkoutId = '1'.repeat(64);
    const databasePath = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      checkoutId,
      `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
    );
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
      }),
    );
    const interrupted = new Database(databasePath, {strict: true});
    try {
      interrupted.exec(`
        DELETE FROM schema_metadata WHERE key = 'persistent_extension_schema_revision';
        DROP TABLE building_materialization_batches;
      `);
    } finally {
      interrupted.close(false);
    }
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };

    const output = await runEffect(captureConsole(runCodeGraphRepair(config, {all: true, json: true})));

    expect(JSON.parse(output.output)).toMatchObject({
      doctor: {status: 'ok'},
      dryRun: false,
      mode: 'quick',
      summary: {deferredDatabases: 0, migratedDatabases: 1},
      type: 'code-graph-repair',
      version: 1,
    });
    await expect(runEffect(codeGraphDoctorCheck(home))).resolves.toMatchObject({status: 'ok'});
  });
});
