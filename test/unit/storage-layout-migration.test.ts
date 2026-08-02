import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {sha256FileHex, sha256Hex} from '../../src/effect/digest.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {SystemInfo} from '../../src/effect/system.js';
import {
  isThreadnoteStorageLayoutMigrationPending,
  migrateThreadnoteStorageLayout,
  STORAGE_LAYOUT_MIGRATION_ID,
  StorageLayoutMigrationConflict,
} from '../../src/migration/layout.js';

describe('Threadnote storage layout migration', () => {
  it.effect('ignores empty beta layout scaffolds, including after a completed migration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-empty-scaffold-'});
        yield* fs.makeDirectory(path.join(home, 'data', 'viking', 'local', 'user'), {recursive: true});

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
        expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
          accounts: 0,
          action: 'no_legacy_layout',
        });

        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'completed',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 0,
          action: 'already_current',
        });
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

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

  it.effect('recovers beta.1 data even when repair already wrote the current layout marker', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-current-marker-'});
        const source = path.join(home, 'data', 'viking', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, 'beta memory');
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'migrated',
        });
        expect(yield* fs.readFileString(path.join(home, 'data', 'local', 'memory.md'))).toBe('beta memory');
        expect(yield* fs.exists(path.join(home, 'data', 'viking'))).toBe(false);
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('resumes a pending receipt even when the current layout marker already exists', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-pending-marker-'});
        const target = path.join(home, 'data', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(target), {recursive: true});
        yield* fs.writeFileString(target, 'already moved');
        const digest = yield* sha256FileHex(target);
        const treeSha256 = yield* sha256Hex(`file\0memory.md\0${'already moved'.length}\0${digest}\n`);
        yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
        yield* fs.writeFileString(
          path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
          `${JSON.stringify({
            accounts: [{name: 'local', treeSha256}],
            id: STORAGE_LAYOUT_MIGRATION_ID,
            sourceLayoutVersion: 1,
            status: 'pending',
            targetLayoutVersion: 2,
            version: 1,
          })}\n`,
        );
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
        expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
          accounts: 1,
          action: 'resumed',
        });
        expect(yield* fs.readFileString(target)).toBe('already moved');
        expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('reports and repairs a missing or stale layout marker from a completed receipt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-marker-repair-'});
        for (const [name, marker] of [
          ['missing', undefined],
          ['stale', '{"createdBy":"threadnote","version":1}\n'],
        ] as const) {
          const home = path.join(root, name);
          yield* fs.makeDirectory(path.join(home, 'migration'), {recursive: true});
          yield* fs.writeFileString(
            path.join(home, 'migration', `${STORAGE_LAYOUT_MIGRATION_ID}.json`),
            `${JSON.stringify({
              accounts: [],
              id: STORAGE_LAYOUT_MIGRATION_ID,
              sourceLayoutVersion: 1,
              status: 'completed',
              targetLayoutVersion: 2,
              version: 1,
            })}\n`,
          );
          if (marker !== undefined) yield* fs.writeFileString(path.join(home, 'layout.json'), marker);

          expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(true);
          expect(yield* migrateThreadnoteStorageLayout({home})).toEqual({
            accounts: 0,
            action: 'would_repair_marker',
          });
          expect(yield* migrateThreadnoteStorageLayout({apply: true, home})).toEqual({
            accounts: 0,
            action: 'repaired_marker',
          });
          expect(JSON.parse(yield* fs.readFileString(path.join(home, 'layout.json')))).toEqual({
            createdBy: 'threadnote',
            version: 2,
          });
          expect(yield* isThreadnoteStorageLayoutMigrationPending({home})).toBe(false);
        }
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('rejects a symbolic-link legacy root before eligibility or apply can traverse it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-root-link-'});
        const external = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-external-'});
        const externalMemory = path.join(external, 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(externalMemory), {recursive: true});
        yield* fs.writeFileString(externalMemory, 'must remain external');
        yield* fs.makeDirectory(path.join(home, 'data'), {recursive: true});
        yield* fs.symlink(external, path.join(home, 'data', 'viking'));
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const eligibility = yield* isThreadnoteStorageLayoutMigrationPending({home}).pipe(Effect.flip);
        const apply = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(eligibility).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(apply).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(externalMemory)).toBe('must remain external');
        expect(yield* fs.exists(path.join(home, 'data', 'local'))).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('rejects a symbolic-link data parent before eligibility or apply can reach external beta data', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-data-link-'});
        const externalData = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-external-data-'});
        const externalMemory = path.join(externalData, 'viking', 'local', 'memory.md');
        yield* fs.makeDirectory(path.dirname(externalMemory), {recursive: true});
        yield* fs.writeFileString(externalMemory, 'must remain external');
        yield* fs.symlink(externalData, path.join(home, 'data'));
        yield* fs.writeFileString(path.join(home, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const eligibility = yield* isThreadnoteStorageLayoutMigrationPending({home}).pipe(Effect.flip);
        const apply = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(eligibility).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(apply).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(externalMemory)).toBe('must remain external');
        expect(yield* fs.exists(path.join(externalData, 'local'))).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('rejects a non-directory legacy root before eligibility or apply can traverse it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-layout-root-file-'});
        const legacyRoot = path.join(home, 'data', 'viking');
        yield* fs.makeDirectory(path.dirname(legacyRoot), {recursive: true});
        yield* fs.writeFileString(legacyRoot, 'not a directory');

        const eligibility = yield* isThreadnoteStorageLayoutMigrationPending({home}).pipe(Effect.flip);
        const apply = yield* migrateThreadnoteStorageLayout({apply: true, home}).pipe(Effect.flip);
        expect(eligibility).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(apply).toBeInstanceOf(StorageLayoutMigrationConflict);
        expect(yield* fs.readFileString(legacyRoot)).toBe('not a directory');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
