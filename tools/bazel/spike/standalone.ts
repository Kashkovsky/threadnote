import {Database} from 'bun:sqlite';
import {Effect} from 'effect';

const database = new Database(':memory:');
const result = database.query('SELECT 42 AS answer').get();
database.close();
process.stdout.write(JSON.stringify({result, effect: Effect.runSync(Effect.succeed('ok')), bun: Bun.version}));
