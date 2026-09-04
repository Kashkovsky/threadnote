import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';
import {MEMORY_READ_CURSOR_TTL_MILLISECONDS, type MemoryReadCursorState} from './read_projection.js';

const CURSOR_TOKEN = /^tnrc_[0-9a-f]{32}$/u;
const NAMESPACE = /^[0-9a-f]{64}$/u;
const SOURCE_HASH = /^[0-9a-f]{64}$/u;
const CURSOR_DATABASE_FILENAME = 'read-context-cursors-v1.sqlite';
const CURSOR_DATABASE_BUSY_TIMEOUT_MILLISECONDS = 5_000;
const CURSOR_STATE_MAXIMUM_BYTES = 262_144;
const CURSOR_STORE_MAXIMUM_ENTRIES = 256;

interface StoredCursorRow {
  readonly expires_at: unknown;
  readonly state_json: unknown;
}

interface StoredCursorEnvelopeV1 {
  readonly expiresAt: number;
  readonly state: MemoryReadCursorState;
  readonly version: 1;
}

export class PersistentMemoryReadCursorStoreError extends Schema.TaggedError<PersistentMemoryReadCursorStoreError>()(
  'PersistentMemoryReadCursorStoreError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export interface PersistentMemoryReadCursorStoreOptions {
  readonly maximumEntries?: number;
  readonly ttlMilliseconds?: number;
}

export function memoryReadCursorNamespace(input: {
  readonly account: string;
  readonly memoryRoot?: string;
  readonly team?: string;
  readonly toolName: string;
  readonly user: string;
}): string {
  return sha256HexSync(
    JSON.stringify({
      account: input.account,
      memoryRoot: input.memoryRoot ?? null,
      team: input.team ?? null,
      toolName: input.toolName,
      user: input.user,
      version: 1,
    }),
  );
}

export function serializePersistentMemoryReadCursorState(state: MemoryReadCursorState, expiresAt: number): string {
  assertCursorState(state);
  if (!validTimestamp(expiresAt))
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor expiry is invalid.'});
  const serialized = JSON.stringify({expiresAt, state, version: 1} satisfies StoredCursorEnvelopeV1);
  if (new TextEncoder().encode(serialized).byteLength > CURSOR_STATE_MAXIMUM_BYTES) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor state exceeds its bounded size.'});
  }
  return serialized;
}

export function parsePersistentMemoryReadCursorState(serialized: string): StoredCursorEnvelopeV1 {
  if (new TextEncoder().encode(serialized).byteLength > CURSOR_STATE_MAXIMUM_BYTES) {
    throw PersistentMemoryReadCursorStoreError.make({
      message: 'Stored memory read cursor state exceeds its bounded size.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Stored memory read cursor state is not valid JSON.'});
  }
  if (!exactRecord(parsed, ['expiresAt', 'state', 'version']) || parsed.version !== 1) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Stored memory read cursor envelope is invalid.'});
  }
  if (!validTimestamp(parsed.expiresAt)) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Stored memory read cursor expiry is invalid.'});
  }
  assertCursorState(parsed.state);
  return {expiresAt: parsed.expiresAt, state: parsed.state, version: 1};
}

export const putPersistentMemoryReadCursor = Effect.fn('memoryReadCursorStore.put')(function* (
  threadnoteHome: string,
  namespace: string,
  cursor: string,
  state: MemoryReadCursorState,
  now: number,
  options: PersistentMemoryReadCursorStoreOptions = {},
) {
  const {expiresAt, maximumEntries, serialized} = yield* Effect.try({
    try: () => {
      assertStoreIdentity(namespace, cursor, now);
      const ttlMilliseconds = options.ttlMilliseconds ?? MEMORY_READ_CURSOR_TTL_MILLISECONDS;
      const maximumEntries = options.maximumEntries ?? CURSOR_STORE_MAXIMUM_ENTRIES;
      if (
        !Number.isSafeInteger(ttlMilliseconds) ||
        ttlMilliseconds < 1 ||
        ttlMilliseconds > MEMORY_READ_CURSOR_TTL_MILLISECONDS
      ) {
        throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor TTL is invalid.'});
      }
      if (
        !Number.isSafeInteger(maximumEntries) ||
        maximumEntries < 1 ||
        maximumEntries > CURSOR_STORE_MAXIMUM_ENTRIES
      ) {
        throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor capacity is invalid.'});
      }
      const expiresAt = now + ttlMilliseconds;
      if (!validTimestamp(expiresAt)) {
        throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor expiry is invalid.'});
      }
      return {expiresAt, maximumEntries, serialized: serializePersistentMemoryReadCursorState(state, expiresAt)};
    },
    catch: persistentCursorStoreError,
  });
  yield* useCursorDatabase(threadnoteHome, database => {
    inImmediateTransaction(database, () => {
      database.query('DELETE FROM read_context_cursors WHERE expires_at <= ?').run(now);
      database
        .query(
          `INSERT INTO read_context_cursors
             (namespace, token, state_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(namespace, cursor, serialized, now, expiresAt);
      const count = Number(
        database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM read_context_cursors').get()
          ?.count ?? 0,
      );
      const excess = Math.max(0, count - maximumEntries);
      if (excess > 0) {
        database
          .query(
            `DELETE FROM read_context_cursors
             WHERE rowid IN (
               SELECT rowid FROM read_context_cursors
               WHERE NOT (namespace = ? AND token = ?)
               ORDER BY created_at, expires_at, token
               LIMIT ?
             )`,
          )
          .run(namespace, cursor, excess);
      }
    });
  });
});

export const takePersistentMemoryReadCursor = Effect.fn('memoryReadCursorStore.take')(function* (
  threadnoteHome: string,
  namespace: string,
  cursor: string,
  now: number,
) {
  yield* Effect.try({
    try: () => assertStoreIdentity(namespace, cursor, now),
    catch: persistentCursorStoreError,
  });
  return yield* useCursorDatabase(threadnoteHome, database => {
    const row = inImmediateTransaction(database, () => {
      database.query('DELETE FROM read_context_cursors WHERE expires_at <= ?').run(now);
      const selected = database
        .query<StoredCursorRow, [string, string]>(
          'SELECT state_json, expires_at FROM read_context_cursors WHERE namespace = ? AND token = ?',
        )
        .get(namespace, cursor);
      if (selected) {
        database.query('DELETE FROM read_context_cursors WHERE namespace = ? AND token = ?').run(namespace, cursor);
      }
      return selected;
    });
    if (!row) return undefined;
    if (typeof row.state_json !== 'string' || !validTimestamp(row.expires_at)) {
      throw PersistentMemoryReadCursorStoreError.make({message: 'Stored memory read cursor row is invalid.'});
    }
    const envelope = parsePersistentMemoryReadCursorState(row.state_json);
    if (envelope.expiresAt !== row.expires_at || envelope.expiresAt <= now) return undefined;
    return envelope.state;
  });
});

function useCursorDatabase<Value>(
  threadnoteHome: string,
  use: (database: Database) => Value,
): Effect.Effect<Value, PersistentMemoryReadCursorStoreError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(threadnoteHome, 'threadnote', 'mcp');
    const databasePath = path.join(root, CURSOR_DATABASE_FILENAME);
    yield* fs
      .makeDirectory(root, {recursive: true, mode: 0o700})
      .pipe(
        Effect.mapError(() =>
          PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor directory is unavailable.'}),
        ),
      );
    yield* fs
      .chmod(root, 0o700)
      .pipe(
        Effect.mapError(() =>
          PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor permissions are invalid.'}),
        ),
      );
    const result = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => new Database(databasePath, {create: true, strict: true}),
        catch: () =>
          PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor database could not be opened.'}),
      }),
      database =>
        Effect.try({
          try: () => {
            configureCursorDatabase(database);
            initializeCursorDatabase(database);
            return use(database);
          },
          catch: error =>
            Schema.is(PersistentMemoryReadCursorStoreError)(error)
              ? error
              : PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor database operation failed.'}),
        }),
      database => Effect.sync(() => database.close()),
    );
    yield* fs
      .chmod(databasePath, 0o600)
      .pipe(
        Effect.mapError(() =>
          PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor permissions are invalid.'}),
        ),
      );
    return result;
  });
}

function configureCursorDatabase(database: Database): void {
  database.exec(`
    PRAGMA busy_timeout = ${CURSOR_DATABASE_BUSY_TIMEOUT_MILLISECONDS};
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = MEMORY;
  `);
}

function initializeCursorDatabase(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS read_context_cursors (
      namespace TEXT NOT NULL,
      token TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, token)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS read_context_cursors_expiry
      ON read_context_cursors(expires_at, created_at, namespace, token);
  `);
}

function inImmediateTransaction<Value>(database: Database, use: () => Value): Value {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = use();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original operation failure.
    }
    throw error;
  }
}

function assertStoreIdentity(namespace: string, cursor: string, now: number): void {
  if (!NAMESPACE.test(namespace))
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor namespace is invalid.'});
  if (!CURSOR_TOKEN.test(cursor))
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor token is invalid.'});
  if (!validTimestamp(now))
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor timestamp is invalid.'});
}

function assertCursorState(value: unknown): asserts value is MemoryReadCursorState {
  if (!exactRecord(value, ['mode', 'position', 'section', 'sourceHashes', 'uris'], ['section'])) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor state is invalid.'});
  }
  if (value.mode !== 'content' && value.mode !== 'outline') {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor mode is invalid.'});
  }
  if (!exactRecord(value.position, ['characterOffset', 'resourceIndex'])) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor position is invalid.'});
  }
  const characterOffset = value.position.characterOffset;
  const resourceIndex = value.position.resourceIndex;
  if (
    typeof characterOffset !== 'number' ||
    !Number.isSafeInteger(characterOffset) ||
    characterOffset < 0 ||
    typeof resourceIndex !== 'number' ||
    !Number.isSafeInteger(resourceIndex) ||
    resourceIndex < 0
  ) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor position is invalid.'});
  }
  if (!Array.isArray(value.uris) || value.uris.length === 0 || !value.uris.every(uri => typeof uri === 'string')) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor resource identities are invalid.'});
  }
  if (
    !Array.isArray(value.sourceHashes) ||
    value.sourceHashes.length !== value.uris.length ||
    !value.sourceHashes.every(hash => typeof hash === 'string' && SOURCE_HASH.test(hash))
  ) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor source hashes are invalid.'});
  }
  if (resourceIndex >= value.uris.length || (value.section !== undefined && typeof value.section !== 'string')) {
    throw PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor state is inconsistent.'});
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.every(key => expected.has(key)) &&
    keys.every(key => optional.includes(key) || Object.prototype.hasOwnProperty.call(value, key))
  );
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799_999;
}

function persistentCursorStoreError(error: unknown): PersistentMemoryReadCursorStoreError {
  return Schema.is(PersistentMemoryReadCursorStoreError)(error)
    ? error
    : PersistentMemoryReadCursorStoreError.make({message: 'Memory read cursor input is invalid.'});
}
