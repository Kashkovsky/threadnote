import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runShareSync} from '../../src/share.js';
import type {ShareRuntime, ShareTeamsFile} from '../../src/types.js';
import {runCommand} from '../../src/utils.js';

interface TestShareRepo {
  readonly config: ShareRuntime;
  readonly home: string;
  readonly worktree: string;
}

const homes: string[] = [];
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
] as const;
const savedGitEnv = new Map<string, string | undefined>();

async function git(args: readonly string[], cwd?: string): Promise<void> {
  await runCommand('git', args, {cwd});
}

async function gitOutput(args: readonly string[], cwd?: string): Promise<string> {
  const result = await runCommand('git', args, {cwd});
  return result.stdout.trim();
}

async function makeShareRepo(): Promise<TestShareRepo> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-share-sync-'));
  homes.push(root);

  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await mkdir(seed, {recursive: true});
  await git(['init', '--bare', remote]);
  await git(['init'], seed);
  await git(['checkout', '-b', 'main'], seed);
  await git(['config', 'user.email', 'threadnote-test@example.com'], seed);
  await git(['config', 'user.name', 'Threadnote Test'], seed);
  await writeFile(join(seed, 'README.md'), '# Shared memories\n', 'utf8');
  await git(['add', 'README.md'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', '-u', 'origin', 'main'], seed);
  await git(['checkout', '-b', 'other'], seed);
  await writeFile(join(seed, 'other.md'), 'other branch\n', 'utf8');
  await git(['add', 'other.md'], seed);
  await git(['commit', '-m', 'other branch'], seed);
  await git(['push', 'origin', 'other'], seed);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const home = join(root, 'home');
  const worktree = join(home, 'data', 'viking', 'local', 'user', 'denys', 'memories', 'shared', 'default');
  const gitdir = join(home, 'share', 'teams', 'default.gitdir');
  await mkdir(dirname(worktree), {recursive: true});
  await mkdir(dirname(gitdir), {recursive: true});
  await git(['clone', `--separate-git-dir=${gitdir}`, '--branch', 'main', '--', remote, worktree]);
  await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
  await git(['config', 'user.name', 'Threadnote Test'], worktree);

  const config: ShareRuntime = {account: 'local', agentContextHome: home, agentId: 'threadnote', user: 'denys'};
  const teams: ShareTeamsFile = {
    defaultTeam: 'default',
    teams: {
      default: {
        addedAt: new Date(0).toISOString(),
        gitdir,
        name: 'default',
        remote,
        worktree,
      },
    },
    version: 1,
  };
  await mkdir(join(home, 'share'), {recursive: true});
  await writeFile(join(home, 'share', 'teams.json'), `${JSON.stringify(teams, undefined, 2)}\n`, 'utf8');
  return {config, home, worktree};
}

describe('share sync git handling', () => {
  beforeEach(() => {
    savedGitEnv.clear();
    for (const key of GIT_ENV_KEYS) {
      savedGitEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
    for (const key of GIT_ENV_KEYS) {
      const value = savedGitEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedGitEnv.clear();
  });

  it('auto-commits root Claude guidance and rebases onto the configured upstream', async () => {
    const {config, worktree} = await makeShareRepo();
    await writeFile(join(worktree, 'CLAUDE.md'), '# Shared Claude guidance\n', 'utf8');

    await runShareSync(config, {message: 'share: test sync', push: false});

    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toBe('');
    await expect(gitOutput(['ls-files', 'CLAUDE.md'], worktree)).resolves.toBe('CLAUDE.md');
    await expect(gitOutput(['log', '-1', '--format=%s', '--', 'CLAUDE.md'], worktree)).resolves.toBe(
      'share: test sync',
    );
  });

  it('stops before rebase when non-shareable untracked files remain', async () => {
    const {config, worktree} = await makeShareRepo();
    await writeFile(join(worktree, 'local.txt'), 'local only\n', 'utf8');

    await expect(runShareSync(config, {message: 'share: test sync', push: false})).rejects.toThrow(
      /did not auto-commit/,
    );
    await expect(gitOutput(['status', '--porcelain'], worktree)).resolves.toContain('?? local.txt');
  });
});
