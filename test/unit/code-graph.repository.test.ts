import {execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {normalizeCredentialFreeRemote, resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('code graph repository identity', () => {
  it('strips credentials and non-identity URL fields from remotes', () => {
    expect(normalizeCredentialFreeRemote('git@github.com:Kashkovsky/threadnote.git')).toBe(
      'github.com/Kashkovsky/threadnote',
    );
    expect(
      normalizeCredentialFreeRemote('https://user:secret@github.com/Kashkovsky/threadnote.git?token=private#fragment'),
    ).toBe('github.com/Kashkovsky/threadnote');
    expect(normalizeCredentialFreeRemote('file:///private/repository')).toBeUndefined();
  });

  it('uses only the folder label for a local repository display name', async () => {
    const root = localRepository();
    const identity = await runEffect(
      Effect.gen(function* () {
        return yield* resolveRepositoryIdentity(root);
      }),
    );

    expect(identity.displayName).toBe(basename(root));
    expect(identity.remoteIdentity).toBeUndefined();
  });

  it('shares repository identity but isolates linked worktree identity', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked']);
    const linked = join(mkdtempSync(join(tmpdir(), 'threadnote-code-graph-linked-')), 'worktree');
    git(root, ['worktree', 'add', linked, 'linked']);
    const [primary, worktree] = await runEffect(
      Effect.gen(function* () {
        return yield* Effect.all([resolveRepositoryIdentity(root), resolveRepositoryIdentity(linked)], {
          concurrency: 2,
        });
      }),
    );

    expect(worktree.repositoryId).toBe(primary.repositoryId);
    expect(worktree.checkoutId).toBe(primary.checkoutId);
    expect(worktree.worktreeId).not.toBe(primary.worktreeId);
  });

  it('shares remote identity while assigning independent clones separate storage identities', async () => {
    const firstRoot = localRepository();
    const secondRoot = localRepository();
    for (const root of [firstRoot, secondRoot]) {
      git(root, ['remote', 'add', 'origin', 'https://github.com/example/shared.git']);
    }
    const [first, second] = await runEffect(
      Effect.gen(function* () {
        return yield* Effect.all([resolveRepositoryIdentity(firstRoot), resolveRepositoryIdentity(secondRoot)], {
          concurrency: 2,
        });
      }),
    );

    expect(first.repositoryId).toBe(second.repositoryId);
    expect(first.checkoutId).not.toBe(second.checkoutId);
  });
});

function localRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-identity-'));
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
