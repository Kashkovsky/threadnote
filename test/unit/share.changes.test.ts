import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {isResourceBusyFailure, isTransientOvFailure, listChangedFiles, mergeChanges} from '../../src/share.js';
import type {ChangedFile} from '../../src/share.js';
import {runCommand} from '../../src/utils.js';

describe('isTransientOvFailure', () => {
  it('classifies resource-busy errors as transient', () => {
    expect(isTransientOvFailure('Error: API error: [INVALID_ARGUMENT] resource is busy', '')).toBe(true);
    expect(isTransientOvFailure('', 'resource is being processed')).toBe(true);
  });

  it('classifies network-class errors as transient', () => {
    expect(isTransientOvFailure('', 'connection refused')).toBe(true);
    expect(isTransientOvFailure('', 'connection reset')).toBe(true);
    expect(isTransientOvFailure('', 'timed out waiting')).toBe(true);
    expect(isTransientOvFailure('', 'http request failed')).toBe(true);
    expect(isTransientOvFailure('', 'network error: ...')).toBe(true);
    expect(isTransientOvFailure('', 'error sending request')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isTransientOvFailure('Resource Is BUSY', '')).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientOvFailure('', '[NOT_FOUND] resource does not exist')).toBe(false);
    expect(isTransientOvFailure('permission denied', '')).toBe(false);
    expect(isTransientOvFailure('', '')).toBe(false);
  });
});

describe('isResourceBusyFailure', () => {
  it('matches only the busy-resource subset, not generic network errors', () => {
    expect(isResourceBusyFailure('', 'resource is busy')).toBe(true);
    expect(isResourceBusyFailure('', 'resource is being processed')).toBe(true);
    expect(isResourceBusyFailure('', 'connection refused')).toBe(false);
    expect(isResourceBusyFailure('', 'timed out')).toBe(false);
  });
});

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
    let secretPath: string | undefined;
    try {
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

      const changes = await listChangedFiles(repo, beforeRev, afterRev);

      expect(changes).not.toContainEqual(
        expect.objectContaining({relativePath: 'durable/projects/threadnote/leak.md'}),
      );
      expect(changes).toContainEqual(
        expect.objectContaining({
          path: join(repo, 'durable/projects/threadnote/replace.md'),
          previousContent: 'original\n',
          relativePath: 'durable/projects/threadnote/replace.md',
          status: 'removed',
        }),
      );
    } finally {
      if (secretPath) {
        await rm(secretPath, {force: true});
      }
      await rm(repo, {force: true, recursive: true});
    }
  });
});
