import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES, CodeGraphStore} from '../../src/code_graph/store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('code graph SQLite page size', () => {
  effectIt.effect('uses the reviewed page size for new stores without rewriting existing stores', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-graph-page-size-'});
        const newDatabasePath = path.join(root, 'new.sqlite');
        const existingDatabasePath = path.join(root, 'existing.sqlite');

        yield* store.initialize(newDatabasePath);
        expect(sqlitePageSize(newDatabasePath)).toBe(CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES);

        yield* Effect.acquireUseRelease(
          Effect.sync(() => new Database(existingDatabasePath, {create: true, strict: true})),
          database =>
            Effect.sync(() => {
              database.exec('PRAGMA page_size = 4096; CREATE TABLE legacy_page_contract (value TEXT NOT NULL)');
            }),
          database => Effect.sync(() => database.close(false)),
        );
        yield* store.initialize(existingDatabasePath);
        expect(sqlitePageSize(existingDatabasePath)).toBe(4_096);
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

function sqlitePageSize(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return Number(database.query<{readonly page_size: number}, []>('PRAGMA page_size').get()?.page_size ?? 0);
  } finally {
    database.close(false);
  }
}
