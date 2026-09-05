import type {Sql} from 'postgres';
import {sha256HexSync} from '../crypto/sha256.js';
import {remoteMemoryError} from './errors.js';

export const STANDALONE_REMOTE_MEMORY_MIGRATION_DIRECTORY = 'remote-memory/migrations';

export function standaloneMigrationFilePath(executablePath: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/u.test(name)) {
    throw remoteMemoryError('invalid_request', 'Remote memory migration file name is invalid.');
  }
  const trimmed = executablePath.replace(/[\\/]+$/u, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  const slash = trimmed.lastIndexOf(separator);
  const root = slash <= 0 ? trimmed : trimmed.slice(0, slash);
  return [root, ...STANDALONE_REMOTE_MEMORY_MIGRATION_DIRECTORY.split('/'), name].join(separator);
}

function migrationFile(name: string): string | URL {
  return typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE
    ? standaloneMigrationFilePath(process.execPath, name)
    : new URL(`./migrations/${name}`, import.meta.url);
}

const MIGRATIONS = [
  {file: migrationFile('001_initial.sql'), version: 1},
  {file: migrationFile('002_git_canonical_pointers.sql'), version: 2},
] as const;
const MIGRATION_LOCK = 7_427_190_041;

export async function migrateRemoteMemoryDatabase(sql: Sql): Promise<void> {
  const connection = await sql.reserve();
  await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
  try {
    await connection.unsafe(
      'CREATE SCHEMA IF NOT EXISTS remote_memory; CREATE TABLE IF NOT EXISTS remote_memory.schema_migrations ' +
        '(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of MIGRATIONS) {
      const source = await Bun.file(migration.file).text();
      const checksum = sha256HexSync(source);
      const applied = await connection<{checksum: string}[]>`
        SELECT checksum FROM remote_memory.schema_migrations WHERE version = ${migration.version}
      `;
      if (applied[0]) {
        if (applied[0].checksum !== checksum) {
          throw remoteMemoryError(
            'service_unavailable',
            `Remote memory migration ${migration.version} changed after apply.`,
          );
        }
        continue;
      }
      await connection.unsafe('BEGIN');
      try {
        await connection.unsafe(source);
        await connection`
          INSERT INTO remote_memory.schema_migrations(version, checksum)
          VALUES (${migration.version}, ${checksum})
          ON CONFLICT (version) DO NOTHING
        `;
        const recorded = await connection<{checksum: string}[]>`
          SELECT checksum FROM remote_memory.schema_migrations WHERE version = ${migration.version}
        `;
        if (recorded[0]?.checksum !== checksum) {
          throw remoteMemoryError(
            'service_unavailable',
            `Remote memory migration ${migration.version} changed while applying.`,
          );
        }
        await connection.unsafe('COMMIT');
      } catch (cause) {
        await connection.unsafe('ROLLBACK');
        throw cause;
      }
    }
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    } finally {
      connection.release();
    }
  }
}
