import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApplicationLayer, type ApplicationServices} from '../../src/effect/runtime.js';
import {hasAgentSkillCatalogIntent, runRecall, stripAdvancedSearchFlags} from '../../src/memory.js';
import type {RuntimeConfig} from '../../src/types.js';
import * as indexRepair from '../../src/index_repair.js';
import * as utils from '../../src/utils.js';

const run = <A, E>(effect: Effect.Effect<A, E, ApplicationServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ApplicationLayer)));

vi.mock('../../src/index_repair.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/index_repair.js')>();
  return {
    ...actual,
    repairStaleRecallIndex: vi.fn(),
  };
});

vi.mock('../../src/utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/utils.js')>();
  return {
    ...actual,
    openVikingCliForMode: vi.fn().mockReturnValue(Effect.succeed('/ov')),
  };
});

const runtime: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-test',
  agentId: 'threadnote',
  host: '127.0.0.1',
  manifestPath: '/tmp/threadnote-test/seed-manifest.yaml',
  openVikingVersion: '0.0.0',
  port: 1933,
  user: 'denys',
};

beforeEach(() => {
  vi.mocked(indexRepair.repairStaleRecallIndex).mockReset();
  vi.mocked(indexRepair.repairStaleRecallIndex).mockReturnValue(
    Effect.succeed({
      repairedUris: [],
      skippedRecentUris: [],
      warnings: [],
    }),
  );
  vi.mocked(utils.openVikingCliForMode).mockReturnValue(Effect.succeed('/ov'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recall skill catalog intent inference', () => {
  it('does not treat seed-skills maintenance queries as agent skill lookup', () => {
    expect(hasAgentSkillCatalogIntent('threadnote seed skills claude commands')).toBe(false);
    expect(hasAgentSkillCatalogIntent('fix seed-skills not recognizing claude commands')).toBe(false);
    expect(hasAgentSkillCatalogIntent('skill seeding should include repo commands')).toBe(false);
  });

  it('still recognizes explicit skill catalog lookup queries', () => {
    expect(hasAgentSkillCatalogIntent('skills')).toBe(true);
    expect(hasAgentSkillCatalogIntent('find skill for swiftui performance')).toBe(true);
    expect(hasAgentSkillCatalogIntent('show skills that help with release notes')).toBe(true);
    expect(hasAgentSkillCatalogIntent('skills for ios debugging')).toBe(true);
  });
});

describe('runRecall index repair fallback', () => {
  it('continues to search when automatic index repair fails', async () => {
    vi.mocked(indexRepair.repairStaleRecallIndex).mockReturnValue(Effect.fail(new Error('repair failed')));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run(runRecall(runtime, {dryRun: true, query: 'availability check'}));

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Auto-index repair warning: repair failed');
    expect(output).toContain('Would run: /ov search');
    expect(output).toContain('availability check');
  });

  it('keeps deterministic recall available when the optional local AI config is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-malformed-local-ai-'));
    await mkdir(join(dir, 'threadnote'), {recursive: true});
    await writeFile(join(dir, 'threadnote', 'local-ai.json'), '{invalid', 'utf8');
    const runCommand = vi
      .spyOn(utils, 'runCommand')
      .mockReturnValue(Effect.succeed({exitCode: 0, stderr: '', stdout: '[]'}));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await run(
        runRecall(
          {...runtime, agentContextHome: dir, manifestPath: join(dir, 'missing-seed-manifest.yaml')},
          {inferScope: false, query: 'deterministic fallback'},
        ),
      );
    } finally {
      runCommand.mockRestore();
      await rm(dir, {force: true, recursive: true});
    }

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Local AI recall unavailable: Invalid Threadnote local AI configuration');
    expect(output).toContain('Deterministic recall continued.');
  });

  it('adds remote-derived project memory scopes for current repo recall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-remote-project-'));
    const repoRoot = join(dir, 'easy-to-type');
    const previousCallerCwd = process.env.THREADNOTE_CALLER_CWD;
    const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
    const previousGitEnv = new Map(gitEnvKeys.map(key => [key, process.env[key]]));
    for (const key of gitEnvKeys) {
      delete process.env[key];
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await mkdir(repoRoot);
      await run(utils.runCommand('git', ['init'], {cwd: repoRoot}));
      await run(
        utils.runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {
          cwd: repoRoot,
        }),
      );
      process.env.THREADNOTE_CALLER_CWD = repoRoot;

      await run(
        runRecall(
          {...runtime, manifestPath: join(dir, 'missing-seed-manifest.yaml')},
          {dryRun: true, query: 'current repo latest handoff'},
        ),
      );
    } finally {
      if (previousCallerCwd === undefined) {
        delete process.env.THREADNOTE_CALLER_CWD;
      } else {
        process.env.THREADNOTE_CALLER_CWD = previousCallerCwd;
      }
      for (const key of gitEnvKeys) {
        const value = previousGitEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(dir, {force: true, recursive: true});
    }

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('current repo latest handoff');
    expect(output).toContain('threadnote');
    expect(output).toContain('--uri viking://user/denys/memories/durable/projects/threadnote');
    expect(output).toContain('--uri viking://user/denys/memories/handoffs/active/threadnote');
    expect(output).not.toContain('easy-to-type');
  });

  it('prefers a project named by the query over the current workspace project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-query-project-'));
    const repoRoot = join(dir, 'easy-to-type');
    const manifestPath = join(dir, 'seed-manifest.yaml');
    const previousCallerCwd = process.env.THREADNOTE_CALLER_CWD;
    const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
    const previousGitEnv = new Map(gitEnvKeys.map(key => [key, process.env[key]]));
    for (const key of gitEnvKeys) {
      delete process.env[key];
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await mkdir(repoRoot);
      await run(utils.runCommand('git', ['init'], {cwd: repoRoot}));
      await run(
        utils.runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {
          cwd: repoRoot,
        }),
      );
      await writeFile(
        manifestPath,
        [
          'version: 1',
          'projects:',
          '  - name: threadnote',
          `    path: ${repoRoot}`,
          '    uri: viking://resources/repos/threadnote',
          '    seed: []',
          '  - name: orion-worker',
          `    path: ${dir}/orion-worker`,
          '    uri: viking://resources/repos/orion-worker',
          '    seed: []',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.THREADNOTE_CALLER_CWD = repoRoot;

      await run(runRecall({...runtime, manifestPath}, {dryRun: true, query: 'worker lease renewal'}));
    } finally {
      if (previousCallerCwd === undefined) {
        delete process.env.THREADNOTE_CALLER_CWD;
      } else {
        process.env.THREADNOTE_CALLER_CWD = previousCallerCwd;
      }
      for (const key of gitEnvKeys) {
        const value = previousGitEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(dir, {force: true, recursive: true});
    }

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('--uri viking://user/denys/memories/durable/projects/orion-worker');
    expect(output).toContain('--uri viking://resources/repos/orion-worker');
    expect(output).not.toContain('--uri viking://user/denys/memories/durable/projects/threadnote');
  });

  it('does not duplicate current project durable scope through workset expansion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-workset-dedupe-'));
    const repoRoot = join(dir, 'easy-to-type');
    const manifestPath = join(dir, 'seed-manifest.yaml');
    const previousCallerCwd = process.env.THREADNOTE_CALLER_CWD;
    const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
    const previousGitEnv = new Map(gitEnvKeys.map(key => [key, process.env[key]]));
    for (const key of gitEnvKeys) {
      delete process.env[key];
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await mkdir(repoRoot);
      await run(utils.runCommand('git', ['init'], {cwd: repoRoot}));
      await run(
        utils.runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {
          cwd: repoRoot,
        }),
      );
      await writeFile(
        manifestPath,
        [
          'version: 1',
          'projects:',
          '  - name: threadnote',
          `    path: ${repoRoot}`,
          '    uri: viking://resources/repos/threadnote',
          '    seed: []',
          'worksets:',
          '  - name: platform',
          '    projects: [threadnote]',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.THREADNOTE_CALLER_CWD = repoRoot;

      await run(
        runRecall(
          {...runtime, manifestPath},
          {dryRun: true, query: 'current repo latest handoff', workset: 'platform'},
        ),
      );
    } finally {
      if (previousCallerCwd === undefined) {
        delete process.env.THREADNOTE_CALLER_CWD;
      } else {
        process.env.THREADNOTE_CALLER_CWD = previousCallerCwd;
      }
      for (const key of gitEnvKeys) {
        const value = previousGitEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(dir, {force: true, recursive: true});
    }

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    const durableScope = '--uri viking://user/denys/memories/durable/projects/threadnote';
    expect(output.split(durableScope)).toHaveLength(2);
  });

  it('honors an explicit workset when inference is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-workset-'));
    const manifestPath = join(dir, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: alpha',
        `    path: ${dir}/alpha`,
        '    uri: viking://resources/repos/alpha',
        '    seed: []',
        'worksets:',
        '  - name: platform',
        '    projects: [alpha]',
        '',
      ].join('\n'),
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await run(
        runRecall(
          {...runtime, manifestPath},
          {
            dryRun: true,
            inferScope: false,
            query: 'current status',
            workset: 'platform',
          },
        ),
      );
    } finally {
      await rm(dir, {force: true, recursive: true});
    }

    const output = log.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Workset scope: platform (alpha)');
    expect(output).toContain('viking://resources/repos/alpha');
  });

  it('reports an unknown explicit workset instead of running unscoped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-missing-workset-'));
    const manifestPath = join(dir, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: alpha',
        `    path: ${dir}/alpha`,
        '    uri: viking://resources/repos/alpha',
        '    seed: []',
        'worksets:',
        '  - name: platform',
        '    projects: [alpha]',
        '',
      ].join('\n'),
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(
        run(
          runRecall(
            {...runtime, manifestPath},
            {
              dryRun: true,
              query: 'current status',
              workset: 'platfrom',
            },
          ),
        ),
      ).rejects.toThrow(`No workset named "platfrom" in ${manifestPath}.`);
    } finally {
      await rm(dir, {force: true, recursive: true});
    }
    expect(log.mock.calls.map(call => call.join(' ')).join('\n')).not.toContain('/ov search');
  });

  it('validates an explicit workset before a pinned uri search', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'threadnote-recall-pinned-workset-'));
    const manifestPath = join(dir, 'seed-manifest.yaml');
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: alpha',
        `    path: ${dir}/alpha`,
        '    uri: viking://resources/repos/alpha',
        '    seed: []',
        'worksets:',
        '  - name: platform',
        '    projects: [alpha]',
        '',
      ].join('\n'),
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(
        run(
          runRecall(
            {...runtime, manifestPath},
            {
              dryRun: true,
              query: 'current status',
              uri: 'viking://resources/repos/alpha',
              workset: 'platfrom',
            },
          ),
        ),
      ).rejects.toThrow(`No workset named "platfrom" in ${manifestPath}.`);
    } finally {
      await rm(dir, {force: true, recursive: true});
    }
    expect(log.mock.calls.map(call => call.join(' ')).join('\n')).not.toContain('/ov search');
  });
});

describe('stripAdvancedSearchFlags', () => {
  it('removes --threshold and --level with their values, keeping the rest', () => {
    expect(
      stripAdvancedSearchFlags(['search', 'q', '--threshold', '0.45', '--level', '2', '--uri', 'viking://x']),
    ).toEqual(['search', 'q', '--uri', 'viking://x']);
  });

  it('is a no-op when no advanced flags are present', () => {
    expect(stripAdvancedSearchFlags(['search', 'q', '--node-limit', '5'])).toEqual([
      'search',
      'q',
      '--node-limit',
      '5',
    ]);
  });
});
