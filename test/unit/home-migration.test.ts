import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  assertSufficientHomeMigrationDiskSpace,
  HomeMigrationInsufficientSpace,
  migrateOpenVikingHome,
} from '../../src/migration/home.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('OpenViking home migration', () => {
  it.effect('rejects a staged copy when the target volume cannot hold the source plus margin', () =>
    Effect.gen(function* () {
      const failure = yield* assertSufficientHomeMigrationDiskSpace(100, 1_000).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(HomeMigrationInsufficientSpace);
      expect(failure.requiredBytes).toBeGreaterThan(100);
    }),
  );

  it.effect('dry-runs, validates, promotes, preserves the source, and is idempotent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-migration-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const memory = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'threadnote',
          'runtime.md',
        );
        yield* fs.makeDirectory(path.dirname(memory), {recursive: true});
        yield* fs.writeFileString(memory, '# Runtime\n\nCanonical memory.\n');
        const contentLock = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'resources',
          'repos',
          'threadnote',
          'Cargo.lock',
        );
        yield* fs.makeDirectory(path.dirname(contentLock), {recursive: true});
        yield* fs.writeFileString(contentLock, 'version = 4\n');
        yield* fs.writeFileString(path.join(legacyHome, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        yield* fs.makeDirectory(path.join(legacyHome, 'logs'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyHome, 'logs', 'server.log'), 'legacy runtime noise');
        yield* fs.writeFileString(path.join(legacyHome, 'ov.conf'), '{"legacy":true}');

        const preview = yield* migrateOpenVikingHome({legacyHome, targetHome});
        expect(preview.action).toBe('dry_run');
        expect(preview.receipt).toMatchObject({files: 3, legacyHome, targetHome});
        expect(yield* fs.exists(targetHome)).toBe(false);

        const migrated = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(migrated.action).toBe('migrated');
        expect(yield* fs.readFileString(path.join(targetHome, path.relative(legacyHome, memory)))).toContain(
          'Canonical memory',
        );
        expect(yield* fs.exists(path.join(targetHome, 'seed-manifest.yaml'))).toBe(true);
        expect(yield* fs.readFileString(path.join(targetHome, path.relative(legacyHome, contentLock)))).toContain(
          'version = 4',
        );
        expect(yield* fs.exists(path.join(targetHome, 'logs', 'server.log'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'ov.conf'))).toBe(false);
        expect(yield* fs.readFileString(memory)).toContain('Canonical memory');

        const receipt = JSON.parse(
          yield* fs.readFileString(path.join(targetHome, 'migration', 'openviking-home-v1.json')),
        ) as {readonly sourceTreeSha256: string};
        expect(receipt.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);

        const repeated = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(repeated.action).toBe('already_migrated');
        expect(repeated.receipt?.sourceTreeSha256).toBe(receipt.sourceTreeSha256);

        const interruptedStage = path.join(root, '.threadnote.migrate-interrupted');
        yield* fs.rename(targetHome, interruptedStage);
        const resumed = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(resumed.action).toBe('resumed');
        expect(yield* fs.exists(interruptedStage)).toBe(false);
        expect(yield* fs.exists(targetHome)).toBe(true);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('does not promote a resumable stage after the legacy source changes', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-stale-resume-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const source = path.join(legacyHome, 'data', 'viking', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, 'first canonical value');
        expect((yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).action).toBe('migrated');

        const interruptedStage = path.join(root, '.threadnote.migrate-interrupted');
        yield* fs.rename(targetHome, interruptedStage);
        yield* fs.writeFileString(source, 'newer canonical value');

        const resumed = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(resumed.action).toBe('migrated');
        expect(yield* fs.readFileString(path.join(targetHome, path.relative(legacyHome, source)))).toBe(
          'newer canonical value',
        );
        expect(yield* fs.exists(interruptedStage)).toBe(true);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('refuses to overwrite an unrelated target home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        yield* fs.makeDirectory(targetHome);
        yield* fs.writeFileString(path.join(targetHome, 'unrelated.txt'), 'keep');
        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);
        expect(error._tag).toBe('HomeMigrationConflict');
        expect(yield* fs.readFileString(path.join(targetHome, 'unrelated.txt'))).toBe('keep');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('isolates legacy share worktrees while preserving canonical shared memories and git metadata', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-share-migration-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const legacyWorktree = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
        );
        const legacyGitdir = path.join(legacyHome, 'share', 'teams', 'default.gitdir');
        const memoryRelative = path.join('durable', 'projects', 'threadnote', 'storage.md');
        yield* fs.makeDirectory(path.dirname(path.join(legacyWorktree, memoryRelative)), {recursive: true});
        yield* fs.makeDirectory(legacyGitdir, {recursive: true});
        yield* fs.writeFileString(path.join(legacyWorktree, memoryRelative), '# Shared storage contract\n');
        yield* fs.writeFileString(path.join(legacyWorktree, '.git'), `gitdir: ${legacyGitdir}\n`);
        yield* fs.writeFileString(
          path.join(legacyGitdir, 'config'),
          `[core]\n\tworktree = ${legacyWorktree}\n[remote "origin"]\n\turl = git@example.invalid:team/memories.git\n`,
        );
        yield* fs.makeDirectory(path.join(legacyHome, 'share'), {recursive: true});
        yield* fs.writeFileString(
          path.join(legacyHome, 'share', 'teams.json'),
          `${JSON.stringify(
            {
              defaultTeam: 'default',
              teams: {
                default: {
                  addedAt: new Date(0).toISOString(),
                  gitdir: legacyGitdir,
                  name: 'default',
                  remote: 'git@example.invalid:team/memories.git',
                  worktree: legacyWorktree,
                },
              },
              version: 1,
            },
            null,
            2,
          )}\n`,
        );

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(result.action).toBe('migrated');
        expect(result.receipt?.stagedTreeSha256).toMatch(/^[0-9a-f]{64}$/);

        const canonicalMemory = path.join(targetHome, path.relative(legacyHome, legacyWorktree), memoryRelative);
        const migratedWorktree = path.join(targetHome, 'share', 'worktrees', 'default');
        const migratedGitdir = path.join(targetHome, 'share', 'teams', 'default.gitdir');
        expect(yield* fs.readFileString(canonicalMemory)).toContain('Shared storage contract');
        expect(yield* fs.exists(path.join(path.dirname(canonicalMemory), '..', '..', '..', '.git'))).toBe(false);
        expect(yield* fs.readFileString(path.join(migratedWorktree, memoryRelative))).toContain(
          'Shared storage contract',
        );
        expect(yield* fs.readFileString(path.join(migratedWorktree, '.git'))).toBe(`gitdir: ${migratedGitdir}\n`);
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'config'))).toContain(
          `worktree = ${migratedWorktree}`,
        );
        const migratedTeams = JSON.parse(yield* fs.readFileString(path.join(targetHome, 'share', 'teams.json'))) as {
          readonly teams: {readonly default: {readonly gitdir: string; readonly worktree: string}};
        };
        expect(migratedTeams.teams.default).toMatchObject({
          gitdir: migratedGitdir,
          worktree: migratedWorktree,
        });

        expect(yield* fs.readFileString(path.join(legacyWorktree, '.git'))).toBe(`gitdir: ${legacyGitdir}\n`);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('rejects legacy symlinks that escape the owned home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-symlink-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        yield* fs.writeFileString(path.join(root, 'outside.md'), 'outside');
        yield* fs.symlink(path.join(root, 'outside.md'), path.join(legacyHome, 'escape.md'));
        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);
        expect(error._tag).toBe('HomeMigrationUnsafe');
        expect(yield* fs.exists(targetHome)).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('rejects absolute symlinks even when they point inside the legacy home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-absolute-symlink-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        const target = path.join(legacyHome, 'target.md');
        yield* fs.writeFileString(target, 'target');
        yield* fs.symlink(target, path.join(legacyHome, 'absolute.md'));
        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);
        expect(error._tag).toBe('HomeMigrationUnsafe');
        expect(error.message).toContain('Absolute symbolic links');
        expect(yield* fs.exists(targetHome)).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );
});
