import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  isThreadnoteStorageLayoutMigrationPending,
  migrateThreadnoteStorageLayout,
  STORAGE_LAYOUT_MIGRATION_ID,
  StorageLayoutMigrationConflict,
} from '../../src/migration/layout.js';

describe('Threadnote storage layout migration', () => {
  it.effect('flattens beta.1 accounts into data and records a resumable migration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-migration-'});
        const source = path.join(home, 'data', 'viking', 'local', 'resources', 'repos', 'threadnote', 'guide.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, '# Guide\n');
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"version":1}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({accounts: 1, action: 'dry_run'});
        expect(yield* fs.exists(source)).toBe(true);

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(
          yield* fs.readFileString(path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'guide.md')),
        ).toContain('Guide');
        expect(yield* fs.exists(path.join(home, 'data', 'viking'))).toBe(false);
        expect(yield* fs.exists(path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`))).toBe(true);
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('refuses an account collision without moving either tree', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-conflict-'});
        const source = path.join(home, 'data', 'viking', 'local', 'memory.md');
        const target = path.join(home, 'data', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(source, 'source');
        yield* fs.writeFileString(target, 'target');

        const failure = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(source)).toBe('source');
        expect(yield* fs.readFileString(target)).toBe('target');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('merges disjoint beta.1 and canonical account contents', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-merge-'});
        const source = path.join(home, 'data', 'viking', 'local', 'current.md');
        const target = path.join(home, 'data', 'local', 'legacy.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(source, 'current beta memory');
        yield* fs.writeFileString(target, 'legacy memory');

        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(yield* fs.readFileString(path.join(home, 'data', 'local', 'current.md'))).toBe('current beta memory');
        expect(yield* fs.readFileString(target)).toBe('legacy memory');
        expect(yield* fs.exists(path.join(home, 'data', 'viking'))).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
