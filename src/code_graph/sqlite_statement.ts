import type {Database, SQLQueryBindings} from 'bun:sqlite';

/**
 * Bun otherwise releases prepared statements at garbage-collection time. Code
 * graph sidecars must release them synchronously before strong-closing or
 * attaching the database on platforms with mandatory file locks.
 */
export function codeGraphSqliteAll<Row>(
  database: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): readonly Row[] {
  const statement = database.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.all(...bindings);
  } finally {
    statement.finalize();
  }
}

export function codeGraphSqliteGet<Row>(database: Database, sql: string, ...bindings: SQLQueryBindings[]): Row | null {
  const statement = database.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.get(...bindings);
  } finally {
    statement.finalize();
  }
}

export function codeGraphSqliteRun(database: Database, sql: string, ...bindings: SQLQueryBindings[]): void {
  const statement = database.prepare<unknown, SQLQueryBindings[]>(sql);
  try {
    statement.run(...bindings);
  } finally {
    statement.finalize();
  }
}
