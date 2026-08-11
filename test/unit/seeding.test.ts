import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect} from 'vitest';
import {runInitManifest, runSeed, runSeedSkills, seedDependencyGraphs} from '../../src/seeding.js';
import {readSeedManifest} from '../../src/manifest.js';
import {captureConsole as captureEffectConsole} from '../../src/effect/console.js';
import {ApplicationLayer, type ApplicationServices} from '../../src/effect/runtime.js';
import type {RuntimeConfig, SeedManifest} from '../../src/types.js';
import {runCommand} from '../../src/utils.js';

const GIT_ENV_KEYS = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;

const run = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>) => effect.pipe(provideTestLayer(ApplicationLayer));

const captureConsole = <E>(effect: Effect.Effect<void, E, ApplicationServices>) =>
  run(captureEffectConsole(effect)).pipe(Effect.map(result => result.output));

describe('runSeed', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('previews native resource imports without external runtime arguments', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() => writeFile(join(repo, 'README.md'), '# Sample\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: sample-repo',
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/sample-repo',
            '    seed:',
            '      - README.md',
            '',
          ].join('\n'),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('Would seed resource:');
      expect(output).toContain('threadnote://resources/repos/sample-repo/README.md');
      expect(output).not.toContain('--wait');
      expect(output).not.toContain('--reason');
      expect(output).not.toContain('Project guidance for');
    }),
  );

  effectIt.effect('does not skip same-size files changed within the recorded millisecond', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const readmePath = join(repo, 'README.md');
      yield* Effect.promise(() => writeFile(readmePath, '# Sample\n', 'utf8'));
      const fractionalSeconds = 1_700_000_000.123456;
      yield* Effect.promise(() => utimes(readmePath, fractionalSeconds, fractionalSeconds));
      const readmeStat = yield* Effect.promise(() => stat(readmePath));
      const recordedMtimeMs = readmeStat.mtime.getTime();
      expect(readmeStat.mtimeMs).not.toBe(recordedMtimeMs);

      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: sample-repo',
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/sample-repo',
            '    seed:',
            '      - README.md',
            '',
          ].join('\n'),
        ),
      );
      yield* Effect.promise(() =>
        writeFile(
          join(contextHome, 'seed-state.json'),
          JSON.stringify({
            files: {
              'threadnote://resources/repos/sample-repo/README.md': {
                mtimeMs: recordedMtimeMs,
                size: readmeStat.size,
              },
            },
            version: 1,
          }),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('Would seed resource:');
      expect(output).toContain(
        'Seed complete: 1 candidate(s), 0 unchanged, 0 stale removed, 0 skipped for safety, 0 project(s) failed.',
      );
    }),
  );

  effectIt.effect('uses the publish scrubber patterns when skipping seed files', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() =>
        writeFile(join(repo, 'README.md'), 'dsn=postgres://user:password@db.example.com:5432/app\n', 'utf8'),
      );
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: sample-repo',
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/sample-repo',
            '    seed:',
            '      - README.md',
            '',
          ].join('\n'),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {dryRun: true}));

      expect(output).toContain('SKIP sample-repo/README.md: possible secret (database URI)');
      expect(output).toContain(
        'Seed complete: 0 candidate(s), 0 unchanged, 0 stale removed, 1 skipped for safety, 0 project(s) failed.',
      );
      expect(output).toContain('Seed safety summary: 1 file(s) were not seeded.');
    }),
  );

  effectIt.effect('redacts real macOS homes in every seeded text file without rejecting Windows path conventions', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() =>
        writeFile(
          join(repo, 'CLAUDE.md'),
          [
            'Local checkout: /Users/jane/work/project',
            'Git-Bash commands use /c/Users/jane/work/project',
            'WSL commands use /mnt/c/Users/jane/work/project',
            'Windows tools use C:/Users/jane/work/project',
            '',
          ].join('\n'),
          'utf8',
        ),
      );
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: sample-repo',
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/sample-repo',
            '    seed: [CLAUDE.md]',
            '',
          ].join('\n'),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeed(config, {}));
      const seeded = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'CLAUDE.md'), 'utf8'),
      );

      expect(output).not.toContain('SKIP');
      expect(seeded).toContain('Local checkout: <local-path>');
      expect(seeded).toContain('/c/Users/jane/work/project');
      expect(seeded).toContain('/mnt/c/Users/jane/work/project');
      expect(seeded).toContain('C:/Users/jane/work/project');
    }),
  );

  effectIt.effect(
    'prunes ignored and implicit hidden directories while retaining explicitly seeded guidance roots',
    () =>
      Effect.gen(function* () {
        const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
        const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
        homes.push(contextHome, repo);
        yield* Effect.promise(() => mkdir(join(repo, 'node_modules', 'pkg'), {recursive: true}));
        yield* Effect.promise(() => mkdir(join(repo, '.nx', 'cache'), {recursive: true}));
        yield* Effect.promise(() => mkdir(join(repo, '.private'), {recursive: true}));
        yield* Effect.promise(() => mkdir(join(repo, '.claude', 'commands'), {recursive: true}));
        yield* Effect.promise(() => writeFile(join(repo, 'README.md'), '# Root\n', 'utf8'));
        yield* Effect.promise(() =>
          writeFile(join(repo, 'node_modules', 'pkg', 'README.md'), '# Dependency\n', 'utf8'),
        );
        yield* Effect.promise(() => writeFile(join(repo, '.nx', 'cache', 'result.md'), '# Cache\n', 'utf8'));
        yield* Effect.promise(() => writeFile(join(repo, '.private', 'notes.md'), '# Private hidden folder\n', 'utf8'));
        yield* Effect.promise(() =>
          writeFile(join(repo, '.claude', 'commands', 'review.md'), '# Explicit guidance\n', 'utf8'),
        );
        const manifestPath = join(contextHome, 'seed-manifest.yaml');
        yield* Effect.promise(() =>
          writeFile(
            manifestPath,
            [
              'version: 1',
              'projects:',
              '  - name: sample-repo',
              `    path: ${repo}`,
              '    uri: threadnote://resources/repos/sample-repo',
              '    seed:',
              '      - "**/*.md"',
              '      - ".claude/**/*.md"',
              '',
            ].join('\n'),
          ),
        );
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: contextHome,
          agentId: 'threadnote',
          manifestPath,
          user: 'denys',
        };

        const output = yield* captureConsole(runSeed(config, {dryRun: true}));

        expect(output).toContain('sample-repo/README.md');
        expect(output).toContain('sample-repo/.claude/commands/review.md');
        expect(output).not.toContain('node_modules');
        expect(output).not.toContain('/.nx/');
        expect(output).not.toContain('/.private/');
      }),
  );

  effectIt.effect('continues seeding later projects and reports an aggregate failure when one project fails', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const failingRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-failing-repo-')));
      const healthyRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-healthy-repo-')));
      homes.push(contextHome, failingRepo, healthyRepo);
      yield* Effect.promise(() => writeFile(join(failingRepo, 'bad?.md'), '# Failing project\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(healthyRepo, 'README.md'), '# Healthy project\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: failing',
            `    path: ${failingRepo}`,
            '    uri: threadnote://resources/repos/failing',
            '    seed: ["*.md"]',
            '  - name: healthy',
            `    path: ${healthyRepo}`,
            '    uri: threadnote://resources/repos/healthy',
            '    seed: [README.md]',
            '',
          ].join('\n'),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const failure = yield* run(runSeed(config, {})).pipe(Effect.flip);
      expect(String(failure)).toContain('1 project(s) failed');
      const healthy = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'healthy', 'README.md'), 'utf8'),
      );
      expect(healthy).toContain('Healthy project');
    }),
  );

  effectIt.effect('removes stale canonical resources when a seeded file is deleted or renamed', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const source = join(repo, 'README.md');
      const renamed = join(repo, 'GUIDE.md');
      yield* Effect.promise(() => writeFile(source, '# Sample\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: sample-repo',
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/sample-repo',
            '    seed:',
            '      - "*.md"',
            '',
          ].join('\n'),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      yield* captureConsole(runSeed(config, {}));
      yield* Effect.promise(() => rename(source, renamed));
      const output = yield* captureConsole(runSeed(config, {}));

      const removed = yield* Effect.tryPromise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'README.md')),
      ).pipe(Effect.flip);
      expect(removed).toBeDefined();
      const guide = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'sample-repo', 'GUIDE.md'), 'utf8'),
      );
      expect(guide).toContain('Sample');
      expect(output).toContain('1 stale removed');
    }),
  );

  effectIt.effect('transfers seed-state ownership when a manifest project is renamed', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-repo-')));
      homes.push(contextHome, repo);
      const source = join(repo, 'README.md');
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      const writeManifest = (name: string) =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            `  - name: ${name}`,
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/stable-uri',
            '    seed: [README.md]',
            '',
          ].join('\n'),
        );
      yield* Effect.promise(() => writeFile(source, '# Project\n\nrename ownership anchor'));
      yield* Effect.promise(() => writeManifest('old-project-name'));
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };
      yield* captureConsole(runSeed(config, {}));

      yield* Effect.promise(() => writeManifest('new-project-name'));
      yield* Effect.promise(() => rm(source));
      const output = yield* captureConsole(runSeed(config, {}));

      const removed = yield* Effect.tryPromise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'stable-uri', 'README.md')),
      ).pipe(Effect.flip);
      expect(removed).toBeDefined();
      const state = JSON.parse(yield* Effect.promise(() => readFile(join(contextHome, 'seed-state.json'), 'utf8'))) as {
        readonly files: Record<string, unknown>;
      };
      expect(state.files['threadnote://resources/repos/stable-uri/README.md']).toBeUndefined();
      expect(output).toContain('1 stale removed');
    }),
  );

  effectIt.effect('keeps child-project resources when seed URI roots are nested', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-context-')));
      const parentRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-parent-')));
      const childRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-child-')));
      homes.push(contextHome, parentRepo, childRepo);
      yield* Effect.promise(() => writeFile(join(parentRepo, 'parent.md'), '# Parent\n', 'utf8'));
      yield* Effect.promise(() => writeFile(join(childRepo, 'child.md'), '# Child\n', 'utf8'));
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: child',
            `    path: ${childRepo}`,
            '    uri: threadnote://resources/repos/platform/service',
            '    seed: ["*.md"]',
            '  - name: parent',
            `    path: ${parentRepo}`,
            '    uri: threadnote://resources/repos/platform',
            '    seed: ["*.md"]',
            '',
          ].join('\n'),
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      yield* captureConsole(runSeed(config, {}));

      const child = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'platform', 'service', 'child.md'), 'utf8'),
      );
      expect(child).toContain('Child');
      const state = JSON.parse(yield* Effect.promise(() => readFile(join(contextHome, 'seed-state.json'), 'utf8'))) as {
        readonly files: Record<string, {readonly project?: string}>;
      };
      expect(state.files['threadnote://resources/repos/platform/service/child.md']?.project).toBe('child');
    }),
  );
});

describe('seed-skills', () => {
  const homes: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('discovers global and repo-local Claude command markdown files', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-skills-home-')));
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-skills-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-seed-skills-repo-')));
      homes.push(home, contextHome, repo);
      process.env.HOME = home;

      yield* Effect.promise(() => mkdir(join(home, '.claude', 'commands'), {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(home, '.claude', 'commands', 'weekly.md'), '# Weekly\n\nSummarize the week.\n'),
      );
      yield* Effect.promise(() => mkdir(join(repo, '.claude', 'commands'), {recursive: true}));
      yield* Effect.promise(() =>
        writeFile(join(repo, '.claude', 'commands', 'review-pr.md'), '# Review PR\n\nReview the current PR.\n'),
      );
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: sample-repo',
            `    path: ${repo}`,
            '    uri: threadnote://resources/repos/sample-repo',
            '    seed: []',
            '',
          ].join('\n'),
        ),
      );

      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      const output = yield* captureConsole(runSeedSkills(config, {dryRun: true}));

      expect(output).toContain(`Command claude-commands-global: ${join(home, '.claude', 'commands', 'weekly.md')}`);
      expect(output).toContain(
        `Command repo-local:sample-repo:claude-commands: ${join(repo, '.claude', 'commands', 'review-pr.md')}`,
      );
      expect(output).toMatch(/threadnote:\/\/resources\/agent-skills\/claude-commands-global\/weekly-[a-f0-9]{12}\.md/);
      expect(output).toMatch(
        /threadnote:\/\/resources\/agent-skills\/repo-local-sample-repo-claude-commands\/review-pr-[a-f0-9]{12}\.md/,
      );
      expect(output).not.toContain('--reason');
      expect(output).not.toContain('Agent command catalog item from claude-commands-global: weekly.md');
      expect(output).toContain('Skill seed complete: 2 unique catalog item(s).');
    }),
  );
});

describe('init-manifest', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('preserves worksets while adding a repo', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-init-manifest-context-')));
      const existingRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-existing-repo-')));
      const newRepo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-new-repo-')));
      homes.push(contextHome, existingRepo, newRepo);
      const manifestPath = join(contextHome, 'seed-manifest.yaml');
      yield* Effect.promise(() =>
        writeFile(
          manifestPath,
          [
            'version: 1',
            'projects:',
            '  - name: existing-repo',
            `    path: ${existingRepo}`,
            '    uri: threadnote://resources/repos/existing-repo',
            '    seed: [README.md]',
            'worksets:',
            '  - name: platform',
            '    description: existing grouped repos',
            '    projects: [existing-repo, missing-repo]',
            '',
          ].join('\n'),
        ),
      );

      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath,
        user: 'denys',
      };

      yield* captureConsole(runInitManifest(config, {path: manifestPath, repo: [newRepo]}));

      const manifest = yield* run(readSeedManifest(manifestPath));
      expect(manifest.projects).toHaveLength(2);
      expect(manifest.projects[0]?.name).toBe('existing-repo');
      expect(manifest.projects[1]?.path).toContain('threadnote-new-repo-');
      expect(manifest.worksets).toEqual([
        {
          description: 'existing grouped repos',
          name: 'platform',
          projects: ['existing-repo', 'missing-repo'],
        },
      ]);
    }),
  );

  effectIt.effect('uses the git remote repo name for new manifest projects', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-init-manifest-context-')));
      const repo = join(contextHome, 'easy-to-type');
      const previousGitEnv = new Map(GIT_ENV_KEYS.map(key => [key, process.env[key]]));
      homes.push(contextHome);
      for (const key of GIT_ENV_KEYS) {
        delete process.env[key];
      }
      try {
        yield* Effect.promise(() => mkdir(repo));
        yield* run(runCommand('git', ['init'], {cwd: repo}));
        yield* run(
          runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {cwd: repo}),
        );
        const manifestPath = join(contextHome, 'seed-manifest.yaml');
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: contextHome,
          agentId: 'threadnote',
          manifestPath,
          user: 'denys',
        };

        yield* captureConsole(runInitManifest(config, {path: manifestPath, repo: [repo]}));

        const manifest = yield* run(readSeedManifest(manifestPath));
        expect(manifest.projects[0]?.name).toBe('threadnote');
        expect(manifest.projects[0]?.uri).toBe('threadnote://resources/repos/threadnote');
      } finally {
        for (const key of GIT_ENV_KEYS) {
          const value = previousGitEnv.get(key);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    }).pipe(TestClock.withLive),
  );
});

describe('seedDependencyGraphs', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('writes dependency facts directly to the native resource store', () =>
    Effect.gen(function* () {
      const contextHome = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-graph-context-')));
      const repo = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-graph-repo-')));
      homes.push(contextHome, repo);
      yield* Effect.promise(() => writeFile(join(repo, 'package.json'), JSON.stringify({name: '@acme/pkg'}), 'utf8'));
      const manifest: SeedManifest = {
        projects: [
          {
            name: '../bad',
            path: repo,
            seed: [],
            uri: 'threadnote://resources/repos/bad',
          },
        ],
        version: 1,
      };
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: contextHome,
        agentId: 'threadnote',
        manifestPath: join(contextHome, 'seed-manifest.yaml'),
        user: 'denys',
      };

      yield* captureConsole(seedDependencyGraphs(config, 'threadnote-native', manifest, manifest.projects, false));

      const graph = yield* Effect.promise(() =>
        readFile(join(contextHome, 'data', 'local', 'resources', 'repos', 'bad', '.graph.md'), 'utf8'),
      );
      expect(graph).toContain('# ../bad — dependency facts');
      const misplaced = yield* Effect.tryPromise(() => readFile(join(contextHome, 'bad.graph.md'), 'utf8')).pipe(
        Effect.flip,
      );
      expect(misplaced).toBeDefined();
    }),
  );
});
