import {Database} from 'bun:sqlite';
import {BunRuntime} from '@effect/platform-bun';
import {Clock, Effect, FileSystem} from 'effect';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideScriptLayer, ScriptError} from '../effect/errors.js';

const program = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const [lockPath, markerPath, releasePath, databasePath] = system.processArguments.slice(2);
  if (!lockPath || !markerPath || !releasePath)
    return yield* ScriptError.make({message: 'Missing gate lock arguments.'});
  yield* withExclusiveFileLock(
    fs,
    lockPath,
    {
      heartbeatIntervalMilliseconds: 1_000,
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 120_000,
      waitTimeoutMilliseconds: 10_000,
      useCanonicalProcessStartIdentity: true,
    },
    Effect.acquireUseRelease(
      Effect.try(() => {
        if (databasePath === undefined) return undefined;
        const database = new Database(databasePath);
        try {
          database.exec('PRAGMA journal_mode = WAL');
          database.exec('BEGIN IMMEDIATE');
          return database;
        } catch (cause) {
          database.close();
          throw cause;
        }
      }),
      () =>
        Effect.gen(function* () {
          yield* fs.writeFileString(markerPath, 'ready\n', {flag: 'wx', mode: 0o600});
          const deadline = (yield* Clock.currentTimeMillis) + 10 * 60_000;
          while (!(yield* fs.exists(releasePath))) {
            if ((yield* Clock.currentTimeMillis) >= deadline)
              return yield* ScriptError.make({message: 'Gate lock deadline.'});
            yield* Effect.sleep(50);
          }
        }),
      database =>
        Effect.sync(() => {
          database?.close();
        }),
    ),
  );
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, StandaloneBrokerLayer));
