import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {
  codeGraphDatabaseWriteLockPath,
  codeGraphMaintenanceIntentPath,
  codeGraphMaintenanceLockPath,
  codeGraphRepositoryLockPath,
} from '../../src/code_graph/layout.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {CODE_GRAPH_SCHEMA_VERSION} from '../../src/code_graph/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

const CHECKOUT_ID = 'a'.repeat(64);

describe('code graph repair process signals', () => {
  effectIt.effect(
    'terminates a blocked deep scan and releases every parent-owned lock after SIGTERM',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-repair-signal-'});
          const databasePath = path.join(
            home,
            'indexes',
            'code-graph',
            'repositories',
            CHECKOUT_ID,
            `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
          );
          yield* store.initialize(databasePath);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const database = new Database(databasePath);
              database.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE');
              return database;
            }),
            database =>
              Effect.sync(() => {
                try {
                  database.exec('ROLLBACK');
                } finally {
                  database.close(false);
                }
              }),
          );
          const locks = [
            codeGraphMaintenanceLockPath(path, home),
            codeGraphMaintenanceIntentPath(path, home),
            codeGraphRepositoryLockPath(path, home, CHECKOUT_ID),
            codeGraphDatabaseWriteLockPath(path, home, CHECKOUT_ID),
          ];
          const standalone = Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url));
          const child = Bun.spawn({
            cmd: [process.execPath, standalone, 'graph', 'repair', '--all', '--dry-run', '--deep', '--json'],
            env: {...process.env, THREADNOTE_HOME: home},
            stderr: 'pipe',
            stdout: 'pipe',
          });
          const stdout = new Response(child.stdout).text();
          const stderr = new Response(child.stderr).text();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (child.exitCode === null) child.kill('SIGKILL');
            }),
          );

          yield* Effect.promise(() => waitFor(() => Promise.all(locks.map(lock => Bun.file(lock).exists()))));
          // Give the repair process time to enter the synchronous SQLite call.
          // A timer cannot advance reliably while this fixture owns an exclusive
          // SQLite transaction in the same Bun process, so use a bounded wait.
          yield* Effect.sync(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100));
          const startedAt = performance.now();
          child.kill('SIGTERM');
          const exitCode = yield* Effect.promise(() => boundedExit(child, 3_000));
          const elapsed = performance.now() - startedAt;

          if (exitCode === 'timeout') {
            child.kill('SIGKILL');
            yield* Effect.promise(() => child.exited);
            const [capturedStdout, capturedStderr] = yield* Effect.promise(() => Promise.all([stdout, stderr]));
            throw new Error(
              `Repair ignored SIGTERM. stdout=${JSON.stringify(capturedStdout)} stderr=${JSON.stringify(capturedStderr)}`,
            );
          }
          expect(elapsed).toBeLessThan(3_000);
          yield* Effect.promise(() => waitFor(async () => !(await anyExists(locks)), 2_000));
          expect(yield* Effect.promise(() => anyExists(locks))).toBe(false);
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    15_000,
  );
});

async function anyExists(paths: readonly string[]): Promise<boolean> {
  return (await Promise.all(paths.map(path => Bun.file(path).exists()))).some(Boolean);
}

async function boundedExit(child: Bun.Subprocess, timeoutMilliseconds: number): Promise<number | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<'timeout'>(resolve => {
        timeout = setTimeout(() => resolve('timeout'), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitFor(
  observe: () => Promise<boolean | readonly boolean[]>,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMilliseconds) {
    const observed = await observe();
    if (Array.isArray(observed) ? observed.every(Boolean) : observed) return;
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the repair signal fixture.');
}
