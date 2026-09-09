import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import {vi} from 'vitest';

type NativeStatement = ReturnType<Database['query']> & {
  readonly isFinalized: boolean;
  safeIntegers(enabled: boolean): NativeStatement;
};

export interface ObservedNativeStatement {
  readonly sql: string;
  readonly statement: NativeStatement;
  readonly finalize: () => void;
}

/** Hold wrappers deliberately: collection must not make disposal assertions pass. */
export const observeNativeStatements = Effect.fn('test.observeNativeStatements')(function* (
  onPrepare?: (entry: ObservedNativeStatement) => void,
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => {
      const entries: ObservedNativeStatement[] = [];
      const databases = new Set<Database>();
      const originalPrepare = Database.prototype.prepare;
      const originalClose = Database.prototype.close;
      const observation = {closeAttempts: 0, entries, strictCloses: 0};
      const prepare = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
        this: Database,
        ...args: Parameters<Database['prepare']>
      ) {
        databases.add(this);
        const statement = Reflect.apply(originalPrepare, this, args) as NativeStatement;
        const finalize = statement.finalize.bind(statement);
        const entry = {finalize, sql: args[0], statement};
        entries.push(entry);
        onPrepare?.(entry);
        return statement;
      });
      const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database) {
        databases.add(this);
        observation.closeAttempts++;
        // Strict native close fails while any unfinalized statement is alive.
        originalClose.call(this, true);
        observation.strictCloses++;
      });
      return {databases, observation, originalClose, prepare, close};
    }),
    ({databases, observation, originalClose, prepare, close}) =>
      Effect.sync(() => {
        prepare.mockRestore();
        close.mockRestore();
        for (const entry of observation.entries) entry.finalize();
        for (const database of databases) originalClose.call(database, true);
      }),
  ).pipe(Effect.map(value => value.observation));
});
