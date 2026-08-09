import {writeFileSync} from 'node:fs';
import {Database} from 'bun:sqlite';

const [databasePath, markerPath] = process.argv.slice(2);
if (!databasePath || !markerPath) {
  throw new Error('Expected database and marker paths.');
}

const database = new Database(databasePath);
try {
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('BEGIN IMMEDIATE');
  writeFileSync(markerPath, 'ready\n', {encoding: 'utf8', mode: 0o600});
  await Bun.sleep(10_000);
  database.exec('ROLLBACK');
} finally {
  database.close();
}
