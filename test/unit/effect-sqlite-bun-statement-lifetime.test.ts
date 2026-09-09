import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {describe, expect} from 'vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {observeNativeStatements} from '../helpers/sqlite-native-statements.js';

const layer = () => SqliteClient.layer({filename: ':memory:', disableWAL: true});
const query = (key: number) => `SELECT ? AS value /* statement-${key} */`;

describe('Effect Bun SQLite native statement lifetime', () => {
  effectIt.effect('disposes uncached statements before GC while retaining the first twenty native cache entries', () =>
    Effect.gen(function* () {
      const observed = yield* observeNativeStatements();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let key = 0; key < 100; key++) {
          expect(yield* sql.unsafe(query(key), [key])).toEqual([{value: key}]);
          expect(observed.entries.filter(entry => !entry.statement.isFinalized)).toHaveLength(Math.min(key + 1, 20));
          if (key >= 20) expect(observed.entries.at(-1)?.statement.isFinalized).toBe(true);
        }
        const preparations = observed.entries.length;
        expect(yield* sql.unsafe(query(0), [101])).toEqual([{value: 101}]);
        expect(observed.entries).toHaveLength(preparations);
        expect(observed.entries.slice(0, 20).every(entry => !entry.statement.isFinalized)).toBe(true);
      }).pipe(provideTestLayer(layer()));
      expect(observed.entries).toHaveLength(100);
      expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
      expect(observed.strictCloses).toBe(1);
    }),
  );

  effectIt.effect(
    'keeps exact SQL keys, excludes failed preparations and refreshes manually finalized cache entries',
    () =>
      Effect.gen(function* () {
        const observed = yield* observeNativeStatements();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const invalid of ['', ' ', 'SELECT FROM']) {
            const failure = yield* Effect.exit(sql.unsafe(invalid));
            expect(Exit.isFailure(failure)).toBe(true);
          }
          expect(observed.entries).toHaveLength(0);
          for (let key = 0; key < 20; key++) {
            expect(yield* sql.unsafe(`SELECT 1 AS value${' '.repeat(key)}`)).toEqual([{value: 1}]);
          }
          expect(observed.entries.filter(entry => !entry.statement.isFinalized)).toHaveLength(20);
          const first = observed.entries[0];
          yield* Effect.sync(first.finalize);
          expect(yield* sql.unsafe('SELECT 1 AS value')).toEqual([{value: 1}]);
          expect(observed.entries).toHaveLength(21);
          expect(Object.is(observed.entries.at(-1)?.statement, first.statement)).toBe(false);
          expect(observed.entries.at(-1)?.statement.isFinalized).toBe(false);
          expect(yield* sql.unsafe(query(21), [21])).toEqual([{value: 21}]);
          expect(observed.entries.at(-1)?.statement.isFinalized).toBe(true);
        }).pipe(provideTestLayer(layer()));
        expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
        expect(observed.strictCloses).toBe(1);
      }),
  );

  effectIt.effect(
    'owns statements before integer setup and preserves the primary error if temporary cleanup fails',
    () =>
      Effect.gen(function* () {
        const setupFailure = new Error('fixture integer setup failure');
        const cleanupFailure = new Error('fixture cleanup failure');
        const observed = yield* observeNativeStatements(entry => {
          if (entry.sql.includes('setup-failure')) {
            entry.statement.safeIntegers = () => {
              throw setupFailure;
            };
          }
          if (entry.sql.includes('cleanup-failure')) {
            entry.statement.finalize = () => {
              entry.finalize();
              throw cleanupFailure;
            };
          }
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const first = yield* Effect.flip(sql.unsafe('SELECT 0 /* setup-failure */'));
          expect(first.reason.cause).toBe(setupFailure);
          expect(observed.entries[0]?.statement.isFinalized).toBe(false);
          for (let key = 0; key < 19; key++) yield* sql.unsafe(query(key), [key]);
          for (const values of [false, true]) {
            const statement = sql.unsafe(`SELECT 1 /* setup-failure cleanup-failure ${values} */`);
            const failure = yield* Effect.flip(values ? statement.values : statement);
            expect(failure.reason.cause).toBe(setupFailure);
            expect(observed.entries.at(-1)?.statement.isFinalized).toBe(true);
          }
          const cleanupOnly = yield* Effect.flip(sql.unsafe('SELECT 1 /* cleanup-failure */'));
          expect(cleanupOnly.reason.cause).toBe(cleanupFailure);
          expect(observed.entries.at(-1)?.statement.isFinalized).toBe(true);
        }).pipe(provideTestLayer(layer()));
        expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
        expect(observed.strictCloses).toBe(1);
      }),
  );

  effectIt.effect(
    'attempts every retained finalizer and database close while preserving the first cleanup failure',
    () =>
      Effect.gen(function* () {
        const failure = new Error('fixture cached finalizer failure');
        let injected = false;
        const observed = yield* observeNativeStatements(entry => {
          if (entry.sql !== query(0)) return;
          entry.statement.finalize = () => {
            entry.finalize();
            if (!injected) {
              injected = true;
              throw failure;
            }
          };
        });
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (let key = 0; key < 20; key++) yield* sql.unsafe(query(key), [key]);
          }).pipe(provideTestLayer(layer())),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure);
        expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
        expect(observed.closeAttempts).toBe(1);
        expect(observed.strictCloses).toBe(1);
      }),
  );

  effectIt.effect('preserves nested rollback, constraint failures and scope cleanup after interruption', () =>
    Effect.gen(function* () {
      const observed = yield* observeNativeStatements();
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE entries(value INTEGER PRIMARY KEY)');
        for (let key = 0; key < 21; key++) yield* sql.unsafe(query(key), [key]);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe('INSERT INTO entries VALUES (1)');
            const inner = yield* Effect.exit(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe('INSERT INTO entries VALUES (2)');
                  yield* sql.unsafe('INSERT INTO entries VALUES (1)');
                }),
              ),
            );
            expect(Exit.isFailure(inner)).toBe(true);
            expect(yield* sql.unsafe('SELECT value FROM entries ORDER BY value')).toEqual([{value: 1}]);
          }),
        );
        expect(yield* sql.unsafe('SELECT value FROM entries')).toEqual([{value: 1}]);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe('INSERT INTO entries VALUES (3)');
            yield* Deferred.succeed(ready, undefined);
            return yield* Effect.never;
          }),
        );
      }).pipe(provideTestLayer(layer()), Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(observed.entries.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
      expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
      expect(observed.strictCloses).toBe(1);
    }),
  );

  effectIt.effect('preserves transformed rows and blob values after temporary disposal and connection close', () =>
    Effect.gen(function* () {
      const observed = yield* observeNativeStatements();
      const large = (1n << 60n) + 123n;
      const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
      const results = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const text = 'SELECT ? AS value, ? AS bytes';
        for (const safe of [true, false, true]) {
          expect(
            yield* sql.unsafe(text, [large, bytes]).pipe(Effect.provideService(SqlClient.SafeIntegers, safe)),
          ).toEqual([{VALUE: safe ? large : Number(large), BYTES: bytes}]);
        }
        expect(observed.entries).toHaveLength(1);
        for (let key = 1; key < 20; key++) yield* sql.unsafe(query(key), [key]);
        const rows = yield* sql.unsafe(text + ' /* temporary rows */', [large, bytes]);
        const values = yield* sql.unsafe(text + ' /* temporary values */', [large, bytes]).values;
        const raw = yield* sql.withoutTransforms().unsafe(text + ' /* temporary raw */', [large, bytes]);
        expect(observed.entries.slice(-3).every(entry => entry.statement.isFinalized)).toBe(true);
        return {rows, values, raw};
      }).pipe(
        provideTestLayer(
          SqliteClient.layer({
            filename: ':memory:',
            disableWAL: true,
            transformResultNames: name => name.toUpperCase(),
          }),
        ),
      );
      expect(results).toEqual({
        rows: [{VALUE: Number(large), BYTES: bytes}],
        values: [[Number(large), bytes]],
        raw: [{value: Number(large), bytes}],
      });
      expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
      expect(observed.strictCloses).toBe(1);
    }),
  );

  effectIt.effect.prop(
    'matches independent values and native lifetime bounds across query reuse, integer modes and retained blobs',
    {
      operations: FC.array(
        FC.record({
          bytes: FC.uint8Array({maxLength: 16}),
          key: FC.integer({min: 0, max: 31}),
          mode: FC.constantFrom('rows', 'values', 'raw', 'unprepared', 'valuesUnprepared'),
          safe: FC.boolean(),
          value: FC.bigInt({min: -(1n << 60n), max: 1n << 60n}),
        }),
        {minLength: 24, maxLength: 48},
      ),
    },
    ({operations}) =>
      Effect.gen(function* () {
        const observed = yield* observeNativeStatements();
        const retained: Array<{actual: unknown; expected: unknown}> = [];
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (let key = 0; key < 20; key++) {
            yield* sql.unsafe(`SELECT ? AS value, ? AS bytes /* property-${key} */`, [key, new Uint8Array()]);
          }
          for (const operation of operations) {
            const statement = sql.unsafe(`SELECT ? AS value, ? AS bytes /* property-${operation.key} */`, [
              operation.value,
              operation.bytes,
            ]);
            const effect = operation.mode === 'rows' ? statement : statement[operation.mode];
            const actual = yield* effect.pipe(Effect.provideService(SqlClient.SafeIntegers, operation.safe));
            const value = operation.safe ? operation.value : Number(operation.value);
            const bytes = Uint8Array.from(operation.bytes);
            const expected = operation.mode.startsWith('values') ? [[value, bytes]] : [{value, bytes}];
            expect(actual).toEqual(expected);
            retained.push({actual, expected});
            expect(observed.entries.filter(entry => !entry.statement.isFinalized)).toHaveLength(20);
          }
        }).pipe(provideTestLayer(layer()));
        for (const {actual, expected} of retained) expect(actual).toEqual(expected);
        expect(observed.entries.every(entry => entry.statement.isFinalized)).toBe(true);
        expect(observed.strictCloses).toBe(1);
      }),
    {fastCheck: {numRuns: 30}},
  );
});
