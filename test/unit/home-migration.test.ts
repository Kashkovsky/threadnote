import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  assertSufficientHomeMigrationDiskSpace,
  HomeMigrationInsufficientSpace,
  isLegacyHomeMigrationPending,
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
        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
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

        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(true);
        const preview = yield* migrateOpenVikingHome({legacyHome, targetHome});
        expect(preview.action).toBe('dry_run');
        expect(preview.receipt).toMatchObject({files: 3, legacyHome, targetHome});
        expect(yield* fs.exists(targetHome)).toBe(false);

        const migrated = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(migrated.action).toBe('migrated');
        expect(yield* isLegacyHomeMigrationPending({legacyHome, targetHome})).toBe(false);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'runtime.md',
            ),
          ),
        ).toContain('Canonical memory');
        expect(yield* fs.exists(path.join(targetHome, 'seed-manifest.yaml'))).toBe(true);
        expect(
          yield* fs.readFileString(
            path.join(targetHome, 'data', 'local', 'resources', 'repos', 'threadnote', 'Cargo.lock'),
          ),
        ).toContain('version = 4');
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
        expect(
          yield* fs.readFileString(
            path.join(targetHome, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md'),
          ),
        ).toBe('newer canonical value');
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

  it.effect('does not treat generic Threadnote-like directory names as an owned target home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-generic-marker-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        yield* fs.makeDirectory(legacyHome);
        for (const marker of ['cache', 'data', 'indexes', 'models', 'share', 'threadnote']) {
          const targetHome = path.join(root, `.threadnote-${marker}`);
          const sentinel = path.join(targetHome, marker, 'sentinel.txt');
          yield* fs.makeDirectory(path.dirname(sentinel), {recursive: true});
          yield* fs.writeFileString(sentinel, `preserve-${marker}`);

          const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

          expect(error._tag).toBe('HomeMigrationConflict');
          expect(yield* fs.readFileString(sentinel)).toBe(`preserve-${marker}`);
          expect(yield* fs.readDirectory(targetHome)).toEqual([marker]);
          expect(yield* fs.readDirectory(path.join(targetHome, marker))).toEqual(['sentinel.txt']);
        }
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('requires a strong ownership receipt before recovering into an existing target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-weak-marker-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        yield* fs.makeDirectory(legacyHome);
        const cases = [
          {content: '{"createdBy":', name: 'malformed-layout', relativePath: 'layout.json'},
          {
            content: '{"createdBy":"another-tool","version":2}',
            name: 'unowned-layout',
            relativePath: 'layout.json',
          },
          {
            content: '{"id":',
            name: 'malformed-storage-receipt',
            relativePath: 'migration/threadnote-storage-layout-v2.json',
          },
          {
            content: '{"id":"threadnote-storage-layout-v2","version":1}',
            name: 'incomplete-storage-receipt',
            relativePath: 'migration/threadnote-storage-layout-v2.json',
          },
          {
            content: '{"version":1,"roles":{}}',
            name: 'model-selection',
            relativePath: 'models/selection.json',
          },
          {
            content: '{"version":1,"teams":{}}',
            name: 'share-config',
            relativePath: 'share/teams.json',
          },
          {
            content: 'unowned resource bytes',
            name: 'canonical-looking-data',
            relativePath: 'data/local/resources/sentinel.txt',
          },
        ] as const;

        for (const fixture of cases) {
          const targetHome = path.join(root, `.threadnote-${fixture.name}`);
          const marker = path.join(targetHome, fixture.relativePath);
          yield* fs.makeDirectory(path.dirname(marker), {recursive: true});
          yield* fs.writeFileString(marker, fixture.content);
          const before = yield* snapshotDirectory(fs, path, targetHome);

          const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

          expect(error._tag).toBe('HomeMigrationConflict');
          expect(yield* snapshotDirectory(fs, path, targetHome)).toEqual(before);
        }
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('recovers into an empty beta home without copying server metadata or overwriting generated state', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-recovery-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const source = path.join(
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
          'recovery.md',
        );
        yield* fs.makeDirectory(path.dirname(source), {recursive: true});
        yield* fs.writeFileString(source, '# Recovered memory\n');
        const legacyCurrent = path.join(
          legacyHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          'current.md',
        );
        const betaCurrent = path.join(
          targetHome,
          'data',
          'viking',
          'local',
          'user',
          'tester',
          'memories',
          'handoffs',
          'active',
          'threadnote',
          'current.md',
        );
        yield* fs.makeDirectory(path.dirname(legacyCurrent), {recursive: true});
        yield* fs.writeFileString(legacyCurrent, '# Legacy handoff\n');
        yield* fs.makeDirectory(path.dirname(betaCurrent), {recursive: true});
        yield* fs.writeFileString(betaCurrent, '# Current beta handoff\n');
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'viking', 'backend_meta.json'), '{"server":true}');
        const legacyUpdateCache = '{"channel":"stable","latestVersion":"3.0.3"}';
        const betaUpdateCache = '{"channel":"beta","latestVersion":"4.0.0-beta.9"}';
        yield* fs.writeFileString(path.join(legacyHome, 'update-check.json'), legacyUpdateCache);
        yield* fs.makeDirectory(path.join(targetHome, 'cache'), {recursive: true});
        yield* fs.makeDirectory(path.join(targetHome, 'data', 'local'), {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'cache', 'recall.json'), 'derived beta state');
        yield* fs.writeFileString(path.join(targetHome, 'update-check.json'), betaUpdateCache);

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(result.action).toBe('recovered');
        expect(result.receipt?.files).toBe(2);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'recovery.md',
            ),
          ),
        ).toContain('Recovered memory');
        expect(yield* fs.readFileString(path.join(targetHome, 'cache', 'recall.json'))).toBe('derived beta state');
        expect(yield* fs.readFileString(path.join(targetHome, 'update-check.json'))).toBe(betaUpdateCache);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'handoffs',
              'active',
              'threadnote',
              'current.md',
            ),
          ),
        ).toContain('Current beta handoff');
        expect(yield* fs.exists(path.join(targetHome, 'data', 'backend_meta.json'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'data', 'viking'))).toBe(false);
        expect(yield* fs.readFileString(source)).toContain('Recovered memory');
        expect(yield* fs.readFileString(path.join(legacyHome, 'update-check.json'))).toBe(legacyUpdateCache);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('preserves newer canonical content when recovering into a current-layout beta home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-current-content-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const relativeMemory = path.join(
          'local',
          'user',
          'tester',
          'memories',
          'durable',
          'projects',
          'front-end-web-monorepo',
          'aspect-checkout-mvp-api.md',
        );
        const legacyMemory = path.join(legacyHome, 'data', 'viking', relativeMemory);
        const targetMemory = path.join(targetHome, 'data', relativeMemory);
        const legacyOnly = path.join(
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
          'legacy-only.md',
        );
        yield* fs.makeDirectory(path.dirname(legacyMemory), {recursive: true});
        yield* fs.writeFileString(legacyMemory, '# Older legacy memory\n');
        yield* fs.makeDirectory(path.dirname(legacyOnly), {recursive: true});
        yield* fs.writeFileString(legacyOnly, '# Legacy-only memory\n');
        yield* fs.makeDirectory(path.dirname(targetMemory), {recursive: true});
        yield* fs.writeFileString(targetMemory, '# Newer beta memory\n');
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const preview = yield* migrateOpenVikingHome({legacyHome, targetHome});
        expect(preview.action).toBe('dry_run');
        expect(preview.receipt?.preservedCurrentEntries).toBe(1);
        expect(yield* fs.readFileString(targetMemory)).toBe('# Newer beta memory\n');
        expect(yield* fs.exists(path.join(targetHome, 'migration', 'openviking-home-v1.json'))).toBe(false);

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});

        expect(result.action).toBe('recovered');
        expect(result.receipt?.preservedCurrentEntries).toBe(1);
        expect(yield* fs.readFileString(targetMemory)).toBe('# Newer beta memory\n');
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'legacy-only.md',
            ),
          ),
        ).toBe('# Legacy-only memory\n');
        expect(yield* fs.readFileString(legacyMemory)).toBe('# Older legacy memory\n');
        expect((yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome})).action).toBe('already_migrated');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('still rejects different non-canonical content in a recoverable target home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-config-conflict-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        yield* fs.makeDirectory(legacyHome);
        yield* fs.makeDirectory(targetHome);
        yield* fs.writeFileString(path.join(legacyHome, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
        yield* fs.writeFileString(
          path.join(targetHome, 'seed-manifest.yaml'),
          'version: 1\nprojects:\n  - root: current\n',
        );
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":2}\n');

        const error = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome}).pipe(Effect.flip);

        expect(error._tag).toBe('HomeMigrationConflict');
        expect(yield* fs.readFileString(path.join(targetHome, 'seed-manifest.yaml'))).toContain('root: current');
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('ignores mutable operating-system metadata while recovering into an existing beta home', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-home-os-metadata-'});
        const legacyHome = path.join(root, '.openviking');
        const targetHome = path.join(root, '.threadnote');
        const sourceMemory = path.join(
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
          'metadata.md',
        );
        yield* fs.makeDirectory(path.dirname(sourceMemory), {recursive: true});
        yield* fs.writeFileString(sourceMemory, '# Real content\n');
        yield* fs.writeFileString(path.join(legacyHome, 'data', '.DS_Store'), 'mutable legacy metadata');
        yield* fs.writeFileString(path.join(legacyHome, 'data', '._metadata.md'), 'appledouble metadata');
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'Thumbs.db'), 'Windows thumbnail metadata');
        yield* fs.writeFileString(path.join(legacyHome, 'data', 'desktop.ini'), 'Windows folder metadata');
        yield* fs.makeDirectory(path.join(targetHome, 'data', 'viking'), {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'data', '.DS_Store'), 'newer Finder metadata');

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});

        expect(result.action).toBe('recovered');
        expect(result.receipt?.files).toBe(1);
        expect(
          yield* fs.readFileString(
            path.join(
              targetHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'projects',
              'threadnote',
              'metadata.md',
            ),
          ),
        ).toContain('Real content');
        expect(yield* fs.readFileString(path.join(targetHome, 'data', '.DS_Store'))).toBe('newer Finder metadata');
        expect(yield* fs.exists(path.join(targetHome, 'data', '._metadata.md'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'data', 'Thumbs.db'))).toBe(false);
        expect(yield* fs.exists(path.join(targetHome, 'data', 'desktop.ini'))).toBe(false);
      }),
    ).pipe(Effect.provide(ApplicationLayer)),
  );

  it.effect('isolates legacy shares while preserving unpublished state and ignoring transient Git files', () =>
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
        const unpublishedCommit = '0123456789abcdef0123456789abcdef01234567';
        const unpublishedObject = path.join(legacyGitdir, 'objects', '01', unpublishedCommit.slice(2));
        yield* fs.makeDirectory(path.dirname(unpublishedObject), {recursive: true});
        yield* fs.writeFileString(unpublishedObject, 'unpublished commit object');
        yield* fs.makeDirectory(path.join(legacyGitdir, 'refs', 'heads'), {recursive: true});
        yield* fs.writeFileString(path.join(legacyGitdir, 'refs', 'heads', 'main'), `${unpublishedCommit}\n`);
        yield* fs.writeFileString(path.join(legacyGitdir, 'ORIG_HEAD'), `${unpublishedCommit}\n`);
        yield* fs.writeFileString(
          path.join(legacyGitdir, 'FETCH_HEAD'),
          `${unpublishedCommit}\tnot-for-merge\tbranch 'main' of git@example.invalid:team/memories.git\n`,
        );
        yield* fs.writeFileString(path.join(legacyGitdir, 'COMMIT_EDITMSG'), 'Unpublished shared memory\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'gc.log'), 'Background maintenance output\n');
        yield* fs.writeFileString(path.join(legacyGitdir, 'index.lock'), 'transient index lock');
        yield* fs.writeFileString(path.join(legacyGitdir, 'refs', 'heads', 'main.lock'), 'transient ref lock');
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
        yield* fs.makeDirectory(path.join(targetHome, 'cache'), {recursive: true});
        yield* fs.writeFileString(path.join(targetHome, 'layout.json'), '{"createdBy":"threadnote","version":1}\n');
        const currentCommitMessage = 'Current beta share operation\n';
        yield* fs.makeDirectory(path.join(targetHome, 'share', 'teams', 'default.gitdir'), {recursive: true});
        yield* fs.writeFileString(
          path.join(targetHome, 'share', 'teams', 'default.gitdir', 'COMMIT_EDITMSG'),
          currentCommitMessage,
        );

        const result = yield* migrateOpenVikingHome({apply: true, legacyHome, targetHome});
        expect(result.action).toBe('recovered');
        expect(result.receipt?.stagedTreeSha256).toMatch(/^[0-9a-f]{64}$/);

        const canonicalMemory = path.join(
          targetHome,
          'data',
          'local',
          'user',
          'tester',
          'memories',
          'shared',
          'default',
          memoryRelative,
        );
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
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'refs', 'heads', 'main'))).toBe(
          `${unpublishedCommit}\n`,
        );
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'ORIG_HEAD'))).toBe(`${unpublishedCommit}\n`);
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'objects', '01', unpublishedCommit.slice(2)))).toBe(
          'unpublished commit object',
        );
        expect(yield* fs.exists(path.join(migratedGitdir, 'FETCH_HEAD'))).toBe(false);
        expect(yield* fs.readFileString(path.join(migratedGitdir, 'COMMIT_EDITMSG'))).toBe(currentCommitMessage);
        expect(yield* fs.exists(path.join(migratedGitdir, 'gc.log'))).toBe(false);
        expect(yield* fs.exists(path.join(migratedGitdir, 'index.lock'))).toBe(false);
        expect(yield* fs.exists(path.join(migratedGitdir, 'refs', 'heads', 'main.lock'))).toBe(false);
        const migratedTeams = JSON.parse(yield* fs.readFileString(path.join(targetHome, 'share', 'teams.json'))) as {
          readonly teams: {readonly default: {readonly gitdir: string; readonly worktree: string}};
        };
        expect(migratedTeams.teams.default).toMatchObject({
          gitdir: migratedGitdir,
          worktree: migratedWorktree,
        });

        expect(yield* fs.readFileString(path.join(legacyWorktree, '.git'))).toBe(`gitdir: ${legacyGitdir}\n`);
        expect(yield* fs.exists(path.join(legacyGitdir, 'FETCH_HEAD'))).toBe(true);
        expect(yield* fs.readFileString(path.join(legacyGitdir, 'COMMIT_EDITMSG'))).toBe('Unpublished shared memory\n');
        expect(yield* fs.exists(path.join(legacyGitdir, 'gc.log'))).toBe(true);
        expect(yield* fs.exists(path.join(legacyGitdir, 'index.lock'))).toBe(true);
        expect(yield* fs.exists(path.join(legacyGitdir, 'refs', 'heads', 'main.lock'))).toBe(true);
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

function snapshotDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<readonly string[], unknown> {
  const walk = (directory: string): Effect.Effect<readonly string[], unknown> =>
    Effect.gen(function* () {
      const snapshot: string[] = [];
      for (const name of (yield* fs.readDirectory(directory)).sort()) {
        const absolutePath = path.join(directory, name);
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        const info = yield* fs.stat(absolutePath);
        if (info.type === 'Directory') {
          snapshot.push(`directory:${relativePath}`, ...(yield* walk(absolutePath)));
        } else {
          snapshot.push(`file:${relativePath}:${yield* fs.readFileString(absolutePath)}`);
        }
      }
      return snapshot;
    });
  return walk(root);
}
