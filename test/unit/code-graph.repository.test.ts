import {execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, isAbsolute, join} from 'node:path';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {runCodeGraphCompact, runCodeGraphIndex} from '../../src/code_graph/commands.js';
import {
  normalizeCredentialFreeRemote,
  repositoryIdentityMatchesExpectation,
  resolveRepositoryIdentity,
  resolveRepositoryIdentityDetail,
} from '../../src/code_graph/repository.js';
import {CommandExecutor} from '../../src/effect/command.js';
import type {RuntimeConfig} from '../../src/types.js';
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

  it('shares one bounded directory command without serializing git-dir into public identity', async () => {
    const root = localRepository();
    const detail = await runEffect(resolveRepositoryIdentityDetail(root));

    expect(isAbsolute(detail.gitDirectory)).toBe(true);
    expect(detail.gitDirectory).toBe(detail.identity.gitCommonDirectory);
    expect(detail.identity).not.toHaveProperty('gitDirectory');

    const failure = await runEffect(
      Effect.gen(function* () {
        const command = yield* CommandExecutor;
        const executeBytes = command.executeBytes;
        if (executeBytes === undefined) return yield* Effect.fail(new Error('binary command adapter is unavailable'));
        const malformed = CommandExecutor.of({
          ...command,
          executeBytes: (executable, args, options) =>
            executable === 'git' && args.includes('--git-common-dir')
              ? Effect.succeed({exitCode: 0, stderr: '', stdout: new TextEncoder().encode(`${root}/.git\n`)})
              : executeBytes(executable, args, options),
        });
        return yield* resolveRepositoryIdentityDetail(root).pipe(
          Effect.provideService(CommandExecutor, malformed),
          Effect.flip,
        );
      }),
    );

    expect(failure.message).toBe('Git repository directory metadata is invalid.');
    expect(JSON.stringify(failure)).not.toContain(root);
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

  it('requires every Manager graph identity component to match', () => {
    const expected = {checkoutId: 'a'.repeat(64), repositoryId: 'b'.repeat(64), worktreeId: 'c'.repeat(64)};
    expect(repositoryIdentityMatchesExpectation(expected, expected)).toBe(true);
    for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
      expect(
        repositoryIdentityMatchesExpectation(
          {...expected, [component]: differentGraphId(expected[component])},
          expected,
        ),
        component,
      ).toBe(false);
    }
  });

  it('revalidates the complete expected identity in index and compact commands', async () => {
    const root = localRepository();
    const identity = await runEffect(resolveRepositoryIdentity(root));
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: join(root, '.threadnote-test-home'),
      agentId: 'threadnote',
      manifestPath: join(root, '.threadnote-test-home', 'manifest.yaml'),
      user: 'test',
    };
    for (const component of ['checkoutId', 'repositoryId', 'worktreeId'] as const) {
      const expectedIdentity = {...identity, [component]: differentGraphId(identity[component])};
      await expect(runEffect(runCodeGraphIndex(config, {cwd: root, expectedIdentity})), component).rejects.toThrow(
        'Repository identity does not match the requested graph target.',
      );
      await expect(
        runEffect(runCodeGraphCompact(config, {cwd: root, dryRun: true, expectedIdentity})),
        component,
      ).rejects.toThrow('Repository identity does not match the requested graph target.');
    }

    git(root, ['remote', 'add', 'origin', 'https://example.com/changed.git']);
    await expect(runEffect(runCodeGraphIndex(config, {cwd: root, expectedIdentity: identity}))).rejects.toThrow(
      'Repository identity does not match the requested graph target.',
    );
    await expect(
      runEffect(runCodeGraphCompact(config, {cwd: root, dryRun: true, expectedIdentity: identity})),
    ).rejects.toThrow('Repository identity does not match the requested graph target.');
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

function differentGraphId(value: string): string {
  return `${value.startsWith('f') ? 'e' : 'f'}${value.slice(1)}`;
}
