import {mkdir, mkdtemp, rm, symlink, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {dirname, join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';
import {listChangedFiles, mergeChanges} from '../../src/share.js';
import type {ChangedFile} from '../../src/share.js';
import {runCommand as runCommandEffect} from '../../src/utils.js';
import {runEffect} from '../helpers/effect-runtime.js';

const runCommand = (...args: Parameters<typeof runCommandEffect>) => runEffect(runCommandEffect(...args));

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

describe('mergeChanges', () => {
  const make = (relativePath: string, status: ChangedFile['status']): ChangedFile => ({
    path: `/repo/${relativePath}`,
    relativePath,
    status,
  });

  it('returns an empty array for no lists', () => {
    expect(mergeChanges()).toEqual([]);
  });

  it('returns the single list unchanged when given one input', () => {
    const list = [make('a.md', 'added'), make('b.md', 'modified')];
    expect(mergeChanges(list)).toEqual(list);
  });

  it('deduplicates by relativePath; later lists override earlier ones', () => {
    const previous = [make('a.md', 'modified'), make('b.md', 'removed')];
    const current = [make('a.md', 'added'), make('c.md', 'added')];
    const out = mergeChanges(previous, current);
    expect(out).toHaveLength(3);
    expect(out.find(c => c.relativePath === 'a.md')?.status).toBe('added');
    expect(out.find(c => c.relativePath === 'b.md')?.status).toBe('removed');
    expect(out.find(c => c.relativePath === 'c.md')?.status).toBe('added');
  });

  it('preserves order of first occurrence', () => {
    const previous = [make('z.md', 'modified'), make('a.md', 'modified')];
    const current = [make('a.md', 'added'), make('b.md', 'added')];
    const out = mergeChanges(previous, current);
    expect(out.map(c => c.relativePath)).toEqual(['z.md', 'a.md', 'b.md']);
  });
});

describe('listChangedFiles', () => {
  async function git(args: readonly string[], cwd: string): Promise<void> {
    await runCommand('git', args, {cwd});
  }

  async function gitOutput(args: readonly string[], cwd: string): Promise<string> {
    const result = await runCommand('git', args, {cwd});
    return result.stdout.trim();
  }

  it('does not report symlink additions as ingestible files', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'threadnote-share-changes-'));
    const previousGitEnv = new Map(GIT_ENV_KEYS.map(key => [key, process.env[key]]));
    let secretPath: string | undefined;
    try {
      for (const key of GIT_ENV_KEYS) {
        delete process.env[key];
      }
      await git(['init'], repo);
      await git(['config', 'user.email', 'threadnote-test@example.com'], repo);
      await git(['config', 'user.name', 'Threadnote Test'], repo);
      const durableDir = join(repo, 'durable', 'projects', 'threadnote');
      await mkdir(durableDir, {recursive: true});
      await writeFile(join(durableDir, 'replace.md'), 'original\n', 'utf8');
      await git(['add', 'durable/projects/threadnote/replace.md'], repo);
      await git(['commit', '-m', 'initial'], repo);
      const beforeRev = await gitOutput(['rev-parse', 'HEAD'], repo);

      secretPath = join(dirname(repo), 'local-secret.txt');
      await writeFile(secretPath, 'do not ingest\n', 'utf8');
      await symlink(secretPath, join(durableDir, 'leak.md'));
      await rm(join(durableDir, 'replace.md'));
      await symlink(secretPath, join(durableDir, 'replace.md'));
      await git(['add', '-A'], repo);
      await git(['commit', '-m', 'add symlink memory'], repo);
      const afterRev = await gitOutput(['rev-parse', 'HEAD'], repo);

      const changes = await runEffect(listChangedFiles(repo, beforeRev, afterRev));

      expect(changes).not.toContainEqual(
        expect.objectContaining({relativePath: 'durable/projects/threadnote/leak.md'}),
      );
      expect(changes).toContainEqual(
        expect.objectContaining({
          path: join(repo, 'durable/projects/threadnote/replace.md'),
          previousRevision: beforeRev,
          relativePath: 'durable/projects/threadnote/replace.md',
          status: 'removed',
        }),
      );
      expect(changes[0]?.previousContent).toBeUndefined();
    } finally {
      if (secretPath) {
        await rm(secretPath, {force: true});
      }
      await rm(repo, {force: true, recursive: true});
      for (const key of GIT_ENV_KEYS) {
        const value = previousGitEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
