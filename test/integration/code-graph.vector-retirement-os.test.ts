import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {codeGraphDiskReservationRoot, codeGraphVectorWriteLockPath} from '../../src/code_graph/layout.js';
import {
  type CodeGraphVectorRetirementCapacityProtector,
  admitOneCodeGraphVectorRetirementWithCapacity,
  prepareCodeGraphVectorRetirement,
  runCodeGraphOrdinaryVectorMaintenanceUnit,
} from '../../src/code_graph/vector_maintenance.js';
import {SystemInfo} from '../../src/effect/system.js';

const CHECKOUT_ID = 'a'.repeat(64);
const MODEL_NAME = 'model-os';
const OS_VECTOR_ROWS = 1_001;
const VectorOsLayer = Layer.mergeAll(BunServices.layer, SystemInfo.layer);
const identityCapacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => transaction;

interface VectorChildProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly kill: (signal?: NodeJS.Signals | number) => void;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
}

describe('code graph vector retirement OS recovery', () => {
  effectIt.effect(
    'reaps a killed post-commit receipt and converges the durable cursor intent exactly once',
    () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-os-'});
            const home = yield* fs.realPath(root);
            const modelRoot = path.join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              CHECKOUT_ID,
              'vectors',
              MODEL_NAME,
            );
            const databasePath = path.join(modelRoot, 'vectors-v2.sqlite');
            const cursorPath = path.join(
              home,
              'indexes',
              'code-graph',
              'repositories',
              CHECKOUT_ID,
              'vectors',
              '.ordinary-vector-retirement-v1.cursor',
            );
            const markerPath = path.join(home, 'page-committed.marker');
            yield* fs.makeDirectory(modelRoot, {recursive: true, mode: 0o700});
            yield* Effect.sync(() => seedVectorDatabase(databasePath));
            yield* prepareRetirementUntilReady(databasePath);
            expect(
              yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
                capacityProtector: identityCapacityProtector,
              }),
            ).toMatchObject({generation: 'generation-os', state: 'admitted'});
            expect(
              yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
                capacityProtector: identityCapacityProtector,
              }),
            ).toEqual({state: 'wrapped'});
            expect(readVectorState(databasePath)).toEqual({
              generations: 1,
              markers: 1,
              pageRevision: 0,
              sequence: 1,
              vectors: OS_VECTOR_ROWS,
            });

            yield* Effect.acquireUseRelease(
              startVectorChild(home, markerPath),
              child =>
                Effect.gen(function* () {
                  yield* waitForMarker(fs, markerPath, child);
                  expect(child.exitCode).toBeNull();
                  expect(readVectorState(databasePath)).toEqual({
                    generations: 1,
                    markers: 1,
                    pageRevision: 1,
                    sequence: 1,
                    vectors: 1,
                  });
                  expect(yield* fs.exists(cursorPath)).toBe(true);
                  expect(yield* activeReceiptOperations(fs, path, home)).toEqual([
                    'maintain code graph vector retirement',
                  ]);
                  expect(
                    yield* fs.exists(codeGraphVectorWriteLockPath(path, home, CHECKOUT_ID, sha256HexSync(MODEL_NAME))),
                  ).toBe(false);

                  child.kill('SIGKILL');
                  yield* Effect.promise(() => child.exited);
                  expect(yield* activeReceiptOperations(fs, path, home)).toEqual([
                    'maintain code graph vector retirement',
                  ]);

                  let completed = false;
                  for (let unit = 0; unit < 32; unit += 1) {
                    const startedAt = performance.now();
                    const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(
                      {checkoutId: CHECKOUT_ID, threadnoteHome: home},
                      {
                        availableDiskBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
                        deadlineMonotonicMilliseconds: startedAt + 250,
                        // This OS test proves killed-receipt recovery and cursor
                        // convergence. Keep its deadline deterministic so hosted
                        // runner contention cannot turn that contract into a
                        // performance assertion; the load suite owns live timing.
                        monotonicMilliseconds: () => startedAt,
                        reservationMode: 'nonblocking-one-attempt',
                      },
                    );
                    const receiptOperations = yield* activeReceiptOperations(fs, path, home);
                    expect([[], ['maintain code graph vector retirement']]).toContainEqual(receiptOperations);
                    if (result.state === 'complete') {
                      expect(receiptOperations).toEqual([]);
                      completed = true;
                      break;
                    }
                    if (result.state === 'deferred') {
                      // The OS can briefly retain the killed process identity,
                      // receipt, or cursor temporary after child.exited settles.
                      // Keep retrying with a real bounded yield; exact final
                      // convergence below still rejects a durable invalid state.
                      expect(['invalid-sidecar', 'model-unavailable']).toContain(result.blockedCode);
                      yield* Effect.sleep(10);
                      continue;
                    }
                    expect(result.state).toBe('progress');
                  }
                  expect(completed).toBe(true);
                  expect(yield* activeReceiptOperations(fs, path, home)).toEqual([]);
                  expect(readVectorState(databasePath)).toEqual({
                    generations: 0,
                    markers: 0,
                    pageRevision: null,
                    sequence: 1,
                    vectors: 0,
                  });
                  const streams = yield* collectChildStreams(child);
                  expect(streams.stderr).toBe('');
                  expect(JSON.parse(streams.stdout)).toMatchObject({event: 'vector-page-committed'});
                }),
              terminateVectorChild,
            );
          }),
        ),
      ).pipe(Effect.provide(VectorOsLayer)),
    60_000,
  );
});

function startVectorChild(threadnoteHome: string, markerPath: string): Effect.Effect<VectorChildProcess, never> {
  return Effect.sync(
    () =>
      Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          `${process.cwd()}/test/helpers/code-graph-vector-retirement-child.ts`,
          threadnoteHome,
          CHECKOUT_ID,
          markerPath,
        ],
        stderr: 'pipe',
        stdout: 'pipe',
      }) as VectorChildProcess,
  );
}

function terminateVectorChild(child: VectorChildProcess): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (child.exitCode === null) child.kill('SIGKILL');
    yield* Effect.promise(() => child.exited).pipe(Effect.catch(() => Effect.void));
  });
}

function waitForMarker(fs: FileSystem.FileSystem, markerPath: string, child: VectorChildProcess) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 15_000;
    while (!(yield* fs.exists(markerPath))) {
      if (child.exitCode !== null) {
        const streams = yield* collectChildStreams(child);
        return yield* Effect.fail(
          new Error(`Vector child exited before the commit barrier: ${JSON.stringify(streams)}`),
        );
      }
      if (Date.now() >= deadline) return yield* Effect.fail(new Error('Vector child missed the commit barrier.'));
      yield* Effect.sleep(10);
    }
  });
}

function collectChildStreams(child: VectorChildProcess) {
  return Effect.all(
    {
      stderr: readBoundedChildStream(child.stderr, 4_096).pipe(Effect.map(output => output.trim())),
      stdout: readBoundedChildStream(child.stdout, 4_096).pipe(Effect.map(output => output.trim())),
    },
    {concurrency: 2},
  );
}

function readBoundedChildStream(stream: ReadableStream<Uint8Array>, maximumBytes: number) {
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    reader =>
      Effect.tryPromise({
        try: async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          let output = '';
          while (true) {
            const next = await reader.read();
            if (next.done) return output + decoder.decode();
            bytes += next.value.byteLength;
            if (bytes > maximumBytes) throw new Error('Vector child output exceeded its byte bound.');
            output += decoder.decode(next.value, {stream: true});
          }
        },
        catch: cause => new Error('Could not read bounded vector child output.', {cause}),
      }),
    reader => Effect.sync(() => reader.releaseLock()),
  );
}

function prepareRetirementUntilReady(databasePath: string) {
  return Effect.gen(function* () {
    for (let step = 0; step < 4; step += 1) {
      const result = yield* prepareCodeGraphVectorRetirement(databasePath, {
        capacityProtector: identityCapacityProtector,
      });
      if (result.state === 'ready') return;
    }
    return yield* Effect.die(new Error('Vector retirement schema did not become ready.'));
  });
}

function activeReceiptOperations(fs: FileSystem.FileSystem, path: Path.Path, threadnoteHome: string) {
  return Effect.gen(function* () {
    const root = codeGraphDiskReservationRoot(path, threadnoteHome);
    if (!(yield* fs.exists(root))) return [] as string[];
    const names = (yield* fs.readDirectory(root)).filter(name => /^v1-[0-9a-f]{64}\.json$/.test(name)).sort();
    return yield* Effect.forEach(names, name =>
      fs
        .readFileString(path.join(root, name))
        .pipe(
          Effect.map(content => String((JSON.parse(content) as {readonly operation?: unknown}).operation ?? 'invalid')),
        ),
    );
  });
}

function seedVectorDatabase(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = 2;
      CREATE TABLE vector_generations (
        generation TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_sha256 TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        template_version INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE vector_pointers (
        worktree_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
      );
      CREATE INDEX vector_pointer_generation_lookup ON vector_pointers (generation);
      CREATE TABLE vectors (
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
        symbol_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (generation, symbol_id)
      ) WITHOUT ROWID;
      CREATE INDEX vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint);
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 1000;
    `);
    database
      .query(
        `INSERT INTO vector_generations (
           generation, snapshot_id, model_id, model_sha256, dimensions,
           template_version, count, state, created_at
         ) VALUES ('generation-os', 'snapshot-os', 'model-os', ?, 384, 1, ?, 'ready', ?)`,
      )
      .run('f'.repeat(64), OS_VECTOR_ROWS, new Date(0).toISOString());
    const insert = database.prepare(
      `INSERT INTO vectors (generation, symbol_id, fingerprint, vector)
       VALUES ('generation-os', ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < OS_VECTOR_ROWS; index += 1) {
        insert.run(`symbol-${index.toString().padStart(6, '0')}`, 'e'.repeat(64), new Uint8Array(16));
      }
    })();
  } finally {
    database.close(false);
  }
}

function readVectorState(databasePath: string): {
  readonly generations: number;
  readonly markers: number;
  readonly pageRevision: number | null;
  readonly sequence: number;
  readonly vectors: number;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const marker = database
      .query('SELECT page_revision FROM vector_generation_retirements ORDER BY retirement_id LIMIT 1')
      .get() as {readonly page_revision?: unknown} | null;
    const sequence = database
      .query("SELECT seq FROM sqlite_sequence WHERE name = 'vector_generation_retirements'")
      .get() as {readonly seq?: unknown} | null;
    return {
      generations: Number(
        (database.query('SELECT COUNT(*) AS count FROM vector_generations').get() as {readonly count: number}).count,
      ),
      markers: Number(
        (
          database.query('SELECT COUNT(*) AS count FROM vector_generation_retirements').get() as {
            readonly count: number;
          }
        ).count,
      ),
      pageRevision: marker === null ? null : Number(marker.page_revision),
      sequence: sequence === null ? 0 : Number(sequence.seq),
      vectors: Number(
        (database.query('SELECT COUNT(*) AS count FROM vectors').get() as {readonly count: number}).count,
      ),
    };
  } finally {
    database.close(false);
  }
}
