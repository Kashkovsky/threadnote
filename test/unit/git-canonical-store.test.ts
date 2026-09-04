import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {mkdir, rm, writeFile} from '../helpers/node-fs-promises.js';
import {dirname, join} from '../helpers/node-path.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {
  GitCanonicalMemoryStore,
  gitCanonicalSharePath,
  parseGitCanonicalSharePath,
} from '../../src/remote_memory/git_canonical_store.js';
import {cloneGitShareWorktree, createGitShareWorktreeFixture, git} from '../helpers/git-share-worktree.js';

const portableSegment = FC.stringMatching(/^[a-z][a-z0-9-]{0,15}$/u);

describe('git canonical memory store', () => {
  it('round-trips share path encoding for durable and handoff files', () => {
    FC.assert(
      FC.property(FC.constantFrom('durable', 'handoff'), portableSegment, portableSegment, (kind, project, topic) => {
        const path = gitCanonicalSharePath(kind, project, topic);
        expect(parseGitCanonicalSharePath(path)).toEqual({kind, project, topic});
      }),
    );
  });

  it('rejects malformed git share paths', () => {
    FC.assert(
      FC.property(FC.string({maxLength: 64}), value => {
        expect(parseGitCanonicalSharePath(value) === undefined || value.split('/').length === 4).toBe(true);
      }),
    );
    expect(parseGitCanonicalSharePath('')).toBeUndefined();
    expect(parseGitCanonicalSharePath('durable/projects/x')).toBeUndefined();
    expect(parseGitCanonicalSharePath('durable/projects/x/y.txt')).toBeUndefined();
    expect(parseGitCanonicalSharePath('../durable/projects/x/y.md')).toBeUndefined();
  });

  it('commits a memory body, hashes it, and reads the same blob back', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const store = new GitCanonicalMemoryStore({worktree: fixture.worktree});
      const path = gitCanonicalSharePath('durable', 'threadnote', 'composer-roundtrip');
      const content = '# MEMORY\n\nComposer wrote this body.\n';
      const committed = await store.commit({content, message: 'remember composer-roundtrip', path});
      expect(committed.gitPath).toBe(path);
      expect(committed.contentHash).toBe(sha256HexSync(content));
      expect(committed.gitCommit).toMatch(/^[0-9a-f]{40}$/u);
      expect(await store.read({commit: committed.gitCommit, path})).toBe(content);
      const listed = await store.listCanonicalPaths();
      expect(listed).toEqual([
        expect.objectContaining({
          blobId: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
          gitCommit: committed.gitCommit,
          gitPath: path,
          kind: 'durable',
          project: 'threadnote',
          topic: 'composer-roundtrip',
        }),
      ]);
      const other = gitCanonicalSharePath('durable', 'threadnote', 'composer-sibling');
      await store.commit({content: '# MEMORY\n\nSibling.\n', message: 'remember sibling', path: other});
      const afterSibling = await store.listCanonicalPaths();
      expect(afterSibling.find(entry => entry.gitPath === path)?.blobId).toBe(listed[0]?.blobId);
      expect(afterSibling.find(entry => entry.gitPath === path)?.gitCommit).not.toBe(committed.gitCommit);
      const clone = join(fixture.root, 'laptop');
      await cloneGitShareWorktree(fixture.remote, clone);
      expect(await git(['show', `HEAD:${path}`], clone)).toBe(content);
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('rejects a stale expected content hash instead of merging', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const path = gitCanonicalSharePath('durable', 'threadnote', 'cas-conflict');
      const composer = new GitCanonicalMemoryStore({worktree: fixture.worktree});
      const first = await composer.commit({
        content: '# MEMORY\n\nFirst writer.\n',
        message: 'remember first',
        path,
      });
      await expect(
        composer.commit({
          content: '# MEMORY\n\nStale writer.\n',
          expectedContentHash: undefined,
          message: 'remember stale create',
          path,
        }),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'git_cas'}});
      await expect(
        composer.commit({
          content: '# MEMORY\n\nStale update.\n',
          expectedContentHash: 'ab'.repeat(32),
          message: 'remember stale update',
          path,
        }),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'git_cas'}});
      const second = await composer.commit({
        content: '# MEMORY\n\nSecond writer.\n',
        expectedContentHash: first.contentHash,
        message: 'remember second',
        path,
      });
      expect(second.gitCommit).not.toBe(first.gitCommit);
      expect(await composer.read({commit: second.gitCommit, path})).toBe('# MEMORY\n\nSecond writer.\n');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('reads a known commit without fetching when the remote is unavailable', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const path = gitCanonicalSharePath('durable', 'threadnote', 'offline-read');
      const store = new GitCanonicalMemoryStore({worktree: fixture.worktree});
      const committed = await store.commit({
        content: '# MEMORY\n\nReadable without fetch.\n',
        message: 'remember offline-read',
        path,
      });
      await git(['remote', 'remove', 'origin'], fixture.worktree);
      expect(await store.read({commit: committed.gitCommit, path})).toBe('# MEMORY\n\nReadable without fetch.\n');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('rejects a malformed git commit pointer before invoking git show', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const store = new GitCanonicalMemoryStore({worktree: fixture.worktree});
      await expect(
        store.read({
          commit: '--output=/tmp/threadnote-git-show',
          path: gitCanonicalSharePath('durable', 'threadnote', 'unsafe'),
        }),
      ).rejects.toMatchObject({code: 'invalid_request'});
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('commits through a separate-git-dir worktree', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const gitDir = join(fixture.root, 'separated.git');
      const worktree = join(fixture.root, 'separated');
      await git(['clone', '--separate-git-dir', gitDir, '--branch', 'main', '--', fixture.remote, worktree]);
      await git(['config', 'user.email', 'threadnote-test@example.com'], worktree);
      await git(['config', 'user.name', 'Threadnote Test'], worktree);
      const store = new GitCanonicalMemoryStore({worktree});
      const path = gitCanonicalSharePath('handoff', 'threadnote', 'separated-lock');
      const committed = await store.commit({
        content: '# MEMORY\n\nSeparated git dir.\n',
        message: 'remember separated-lock',
        path,
      });
      expect(await store.read({commit: committed.gitCommit, path})).toBe('# MEMORY\n\nSeparated git dir.\n');
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });

  it('surfaces a laptop push as a conflict instead of merging', async () => {
    const fixture = await createGitShareWorktreeFixture();
    try {
      const path = gitCanonicalSharePath('durable', 'threadnote', 'interleave');
      const composer = new GitCanonicalMemoryStore({worktree: fixture.worktree});
      const first = await composer.commit({
        content: '# MEMORY\n\nComposer first.\n',
        message: 'remember composer first',
        path,
      });
      const laptop = join(fixture.root, 'laptop');
      await cloneGitShareWorktree(fixture.remote, laptop);
      await git(['checkout', 'main'], laptop);
      const laptopPath = join(laptop, ...path.split('/'));
      await mkdir(dirname(laptopPath), {recursive: true});
      await writeFile(laptopPath, '# MEMORY\n\nLaptop publish.\n', 'utf8');
      await git(['add', '--', path], laptop);
      await git(['commit', '-m', 'laptop publish'], laptop);
      await git(['push', 'origin', 'main'], laptop);
      await expect(
        composer.commit({
          content: '# MEMORY\n\nComposer second.\n',
          expectedContentHash: first.contentHash,
          message: 'remember composer second',
          path,
        }),
      ).rejects.toMatchObject({code: 'conflict', details: {reason: 'git_cas'}});
    } finally {
      await rm(fixture.root, {force: true, recursive: true});
    }
  });
});
