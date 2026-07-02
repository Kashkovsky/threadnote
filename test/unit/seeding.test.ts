import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  parseSeedWatchIntervalMinutes,
  runInitManifest,
  runSeed,
  runSeedSkills,
  seedDependencyGraphs,
  seedWatchArgs,
} from '../../src/seeding.js';
import {readSeedManifest} from '../../src/manifest.js';
import type {RuntimeConfig, SeedManifest} from '../../src/types.js';

async function captureConsole(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: readonly unknown[]) => lines.push(args.map(String).join(' '));
  console.warn = (...args: readonly unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: readonly unknown[]) => lines.push(args.map(String).join(' '));
  try {
    await action();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return lines.join('\n');
}

describe('parseSeedWatchIntervalMinutes', () => {
  it('returns undefined when unset or not a positive integer', () => {
    expect(parseSeedWatchIntervalMinutes(undefined)).toBeUndefined();
    expect(parseSeedWatchIntervalMinutes('')).toBeUndefined();
    expect(parseSeedWatchIntervalMinutes('0')).toBeUndefined();
    expect(parseSeedWatchIntervalMinutes('-5')).toBeUndefined();
    expect(parseSeedWatchIntervalMinutes('abc')).toBeUndefined();
  });

  it('parses a positive integer cadence', () => {
    expect(parseSeedWatchIntervalMinutes('60')).toBe(60);
    expect(parseSeedWatchIntervalMinutes(' 1440 ')).toBe(1440);
  });
});

describe('seedWatchArgs', () => {
  it('attaches a watch only on the original, non-redaction-prone file when opted in', () => {
    expect(seedWatchArgs({watchIntervalMinutes: 60, importedOriginal: true, redactionProne: false})).toEqual([
      '--watch-interval',
      '60',
    ]);
  });

  it('never watches when the cadence is unset', () => {
    expect(seedWatchArgs({watchIntervalMinutes: undefined, importedOriginal: true, redactionProne: false})).toEqual([]);
  });

  it('never watches a redacted temp copy or a redaction-prone path', () => {
    // Bypassing Threadnote's per-import secret scan would be unsafe here.
    expect(seedWatchArgs({watchIntervalMinutes: 60, importedOriginal: false, redactionProne: false})).toEqual([]);
    expect(seedWatchArgs({watchIntervalMinutes: 60, importedOriginal: true, redactionProne: true})).toEqual([]);
  });
});

describe('runSeed', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('does not pass a reason to resource imports', async () => {
    const contextHome = await mkdtemp(join(tmpdir(), 'threadnote-seed-context-'));
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-seed-repo-'));
    homes.push(contextHome, repo);
    await writeFile(join(repo, 'README.md'), '# Sample\n', 'utf8');
    const manifestPath = join(contextHome, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: sample-repo',
        `    path: ${repo}`,
        '    uri: viking://resources/repos/sample-repo',
        '    seed:',
        '      - README.md',
        '',
      ].join('\n'),
    );
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: contextHome,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath,
      openVikingVersion: '0.0.0',
      port: 1933,
      user: 'denys',
    };

    const output = await captureConsole(() => runSeed(config, {dryRun: true}));

    expect(output).toContain('add-resource');
    expect(output).toContain('viking://resources/repos/sample-repo/README.md');
    expect(output).toContain('--wait');
    expect(output).not.toContain('--reason');
    expect(output).not.toContain('Project guidance for');
  });

  it('uses the publish scrubber patterns when skipping seed files', async () => {
    const contextHome = await mkdtemp(join(tmpdir(), 'threadnote-seed-context-'));
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-seed-repo-'));
    homes.push(contextHome, repo);
    await writeFile(join(repo, 'README.md'), 'dsn=postgres://user:password@db.example.com:5432/app\n', 'utf8');
    const manifestPath = join(contextHome, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: sample-repo',
        `    path: ${repo}`,
        '    uri: viking://resources/repos/sample-repo',
        '    seed:',
        '      - README.md',
        '',
      ].join('\n'),
    );
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: contextHome,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath,
      openVikingVersion: '0.0.0',
      port: 1933,
      user: 'denys',
    };

    const output = await captureConsole(() => runSeed(config, {dryRun: true}));

    expect(output).toContain('SKIP sample-repo/README.md: possible secret (database URI)');
    expect(output).toContain('Seed complete: 0 candidate(s), 0 unchanged, 1 skipped for safety.');
  });
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

  it('discovers global and repo-local Claude command markdown files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'threadnote-seed-skills-home-'));
    const contextHome = await mkdtemp(join(tmpdir(), 'threadnote-seed-skills-context-'));
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-seed-skills-repo-'));
    homes.push(home, contextHome, repo);
    process.env.HOME = home;

    await mkdir(join(home, '.claude', 'commands'), {recursive: true});
    await writeFile(join(home, '.claude', 'commands', 'weekly.md'), '# Weekly\n\nSummarize the week.\n');
    await mkdir(join(repo, '.claude', 'commands'), {recursive: true});
    await writeFile(join(repo, '.claude', 'commands', 'review-pr.md'), '# Review PR\n\nReview the current PR.\n');
    const manifestPath = join(contextHome, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: sample-repo',
        `    path: ${repo}`,
        '    uri: viking://resources/repos/sample-repo',
        '    seed: []',
        '',
      ].join('\n'),
    );

    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: contextHome,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath,
      openVikingVersion: '0.0.0',
      port: 1933,
      user: 'denys',
    };

    const output = await captureConsole(() => runSeedSkills(config, {dryRun: true}));

    expect(output).toContain(`Command claude-commands-global: ${join(home, '.claude', 'commands', 'weekly.md')}`);
    expect(output).toContain(
      `Command repo-local:sample-repo:claude-commands: ${join(repo, '.claude', 'commands', 'review-pr.md')}`,
    );
    expect(output).toMatch(/viking:\/\/resources\/agent-skills\/claude-commands-global\/weekly-[a-f0-9]{12}\.md/);
    expect(output).toMatch(
      /viking:\/\/resources\/agent-skills\/repo-local-sample-repo-claude-commands\/review-pr-[a-f0-9]{12}\.md/,
    );
    expect(output).not.toContain('--reason');
    expect(output).not.toContain('Agent command catalog item from claude-commands-global: weekly.md');
    expect(output).toContain('Skill seed complete: 2 unique catalog item(s).');
  });
});

describe('init-manifest', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('preserves worksets while adding a repo', async () => {
    const contextHome = await mkdtemp(join(tmpdir(), 'threadnote-init-manifest-context-'));
    const existingRepo = await mkdtemp(join(tmpdir(), 'threadnote-existing-repo-'));
    const newRepo = await mkdtemp(join(tmpdir(), 'threadnote-new-repo-'));
    homes.push(contextHome, existingRepo, newRepo);
    const manifestPath = join(contextHome, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: existing-repo',
        `    path: ${existingRepo}`,
        '    uri: viking://resources/repos/existing-repo',
        '    seed: [README.md]',
        'worksets:',
        '  - name: platform',
        '    description: existing grouped repos',
        '    projects: [existing-repo, missing-repo]',
        '',
      ].join('\n'),
    );

    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: contextHome,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath,
      openVikingVersion: '0.0.0',
      port: 1933,
      user: 'denys',
    };

    await captureConsole(() => runInitManifest(config, {path: manifestPath, repo: [newRepo]}));

    const manifest = await readSeedManifest(manifestPath);
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
  });
});

describe('seedDependencyGraphs', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('uses a safe cache filename for manifest project names', async () => {
    const contextHome = await mkdtemp(join(tmpdir(), 'threadnote-graph-context-'));
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-graph-repo-'));
    homes.push(contextHome, repo);
    await writeFile(join(repo, 'package.json'), JSON.stringify({name: '@acme/pkg'}), 'utf8');
    const ov = join(contextHome, 'ov');
    const ovArgsLog = join(contextHome, 'ov-args.log');
    await writeFile(
      ov,
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >> ${JSON.stringify(ovArgsLog)}\nexit 0\n`,
      'utf8',
    );
    await chmod(ov, 0o700);
    const manifest: SeedManifest = {
      projects: [
        {
          name: '../bad',
          path: repo,
          seed: [],
          uri: 'viking://resources/repos/bad',
        },
      ],
      version: 1,
    };
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: contextHome,
      agentId: 'threadnote',
      host: '127.0.0.1',
      manifestPath: join(contextHome, 'seed-manifest.yaml'),
      openVikingVersion: '0.0.0',
      port: 1933,
      user: 'denys',
    };

    await captureConsole(() => seedDependencyGraphs(config, ov, manifest, manifest.projects, false));

    const graphFiles = await readdir(join(contextHome, 'graph'));
    expect(graphFiles).toHaveLength(1);
    expect(graphFiles[0]).not.toContain('/');
    expect(await readFile(join(contextHome, 'graph', graphFiles[0]), 'utf8')).toContain('# ../bad — dependency facts');
    const ovArgs = (await readFile(ovArgsLog, 'utf8')).trim().split('\n');
    expect(ovArgs).toContain('add-resource');
    expect(ovArgs).toContain('--wait');
    expect(ovArgs).not.toContain('--reason');
    await expect(readFile(join(contextHome, 'bad.graph.md'), 'utf8')).rejects.toThrow();
  });
});
