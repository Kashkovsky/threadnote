import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  parseRepositoryIdentityWorktreeObservation,
  parseRepositoryReadFenceSetupObservation,
  resolveRepositoryIdentity,
  resolveRepositoryIdentityForExpectation,
  resolveRepositoryIdentityForExpectationAndWorktree,
  resolvePublishedRepositoryReadFence,
  revalidateRepositoryIdentityFence,
} from '../../src/code_graph/repository.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

describe('code graph expected repository identity', () => {
  effectIt.layer(ApplicationLayer)(it => {
    it.effect('matches full discovery and rejects a changed remote identity', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* Effect.acquireRelease(
              fs.makeTempDirectory({prefix: 'threadnote-expected-identity-'}),
              directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
            );
            yield* git(root, ['init', '-q']);
            yield* git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'fixture',
            ]);
            const sourceDirectory = path.join(root, 'src');
            yield* fs.makeDirectory(sourceDirectory);
            const local = yield* resolveRepositoryIdentity(root);
            const localExpected = {
              checkoutId: local.checkoutId,
              repositoryId: local.repositoryId,
              worktreeId: local.worktreeId,
            };
            expect(yield* resolveRepositoryIdentityForExpectation(sourceDirectory, localExpected)).toEqual(local);
            expect(yield* resolveRepositoryIdentityForExpectationAndWorktree(sourceDirectory, localExpected)).toEqual({
              identity: local,
              worktreeChanged: false,
            });
            yield* fs.writeFileString(path.join(sourceDirectory, 'dirty.ts'), 'export const dirty = true;\n');
            expect(
              (yield* resolveRepositoryIdentityForExpectationAndWorktree(sourceDirectory, localExpected))
                .worktreeChanged,
            ).toBe(true);
            yield* fs.remove(path.join(sourceDirectory, 'dirty.ts'));

            yield* git(root, ['remote', 'add', 'origin', 'https://github.com/example/original.git']);
            const localFailure = yield* resolveRepositoryIdentityForExpectation(root, localExpected).pipe(Effect.flip);
            expect(localFailure.message).toBe('Repository identity does not match the published workset.');

            const remote = yield* resolveRepositoryIdentity(root);
            const remoteExpected = {
              checkoutId: remote.checkoutId,
              repositoryId: remote.repositoryId,
              worktreeId: remote.worktreeId,
            };
            expect(yield* resolveRepositoryIdentityForExpectation(root, remoteExpected)).toEqual(remote);

            yield* git(root, ['remote', 'set-url', 'origin', 'https://github.com/example/replaced.git']);
            const failure = yield* resolveRepositoryIdentityForExpectation(root, remoteExpected).pipe(Effect.flip);
            expect(failure.message).toBe('Repository identity does not match the published workset.');
          }),
        ),
      ),
    );

    it.effect('revalidates code-bearing identity fields and observes a changed HEAD', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* Effect.acquireRelease(
              fs.makeTempDirectory({prefix: 'threadnote-identity-fence-'}),
              directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
            );
            yield* git(root, ['init', '-q']);
            yield* git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'fixture',
            ]);
            const before = yield* resolveRepositoryIdentity(root);
            expect(yield* revalidateRepositoryIdentityFence(root, before)).toEqual(before);

            yield* git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'next',
            ]);
            const after = yield* revalidateRepositoryIdentityFence(root, before);
            expect(after.headCommit).not.toBe(before.headCommit);
            expect(after.repositoryId).toBe(before.repositoryId);
            expect(after.worktreeId).toBe(before.worktreeId);

            yield* git(root, ['remote', 'add', 'origin', 'https://github.com/example/replaced.git']);
            const failure = yield* revalidateRepositoryIdentityFence(root, before).pipe(Effect.flip);
            expect(failure.message).toBe('Repository identity changed during the graph read.');
          }),
        ),
      ),
    );

    it.effect('closes a clean published read across caller-path, worktree, and HEAD observations', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const parent = yield* Effect.acquireRelease(
              fs.makeTempDirectory({prefix: 'threadnote-published-read-fence-'}),
              directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
            );
            const first = path.join(parent, 'first');
            const second = path.join(parent, 'second');
            const caller = path.join(parent, 'caller');
            yield* fs.makeDirectory(first);
            yield* git(first, ['init', '-q']);
            yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'export const tracked = 1;\n');
            yield* git(first, ['add', 'tracked.ts']);
            yield* git(first, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'fixture',
            ]);
            yield* git(first, ['remote', 'add', 'origin', 'https://github.com/example/read-fence.git']);
            yield* git(parent, ['clone', '--quiet', first, second]);
            yield* git(second, ['remote', 'set-url', 'origin', 'https://github.com/example/read-fence.git']);
            yield* fs.symlink(first, caller);
            const identity = yield* resolveRepositoryIdentity(caller);
            const expected = {
              checkoutId: identity.checkoutId,
              repositoryId: identity.repositoryId,
              worktreeId: identity.worktreeId,
            };
            const command = yield* CommandExecutor;
            const invocations: string[][] = [];
            const recording = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                Effect.sync(() => {
                  if (executable === 'git') invocations.push([...args]);
                }).pipe(Effect.andThen(command.execute(executable, args, options))),
            });
            expect(
              yield* resolvePublishedRepositoryReadFence(caller, expected).pipe(
                Effect.provideService(CommandExecutor, recording),
              ),
            ).toEqual({
              ...expected,
              headCommit: identity.headCommit,
              worktreeChanged: false,
            });
            expect(invocations).toHaveLength(3);
            expect(invocations.filter(args => args.includes('status'))).toHaveLength(1);
            expect(
              invocations.map(args => args.find(argument => ['remote', 'rev-parse', 'status'].includes(argument))),
            ).toEqual(['rev-parse', 'remote', 'status']);

            const failure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              afterInitialIdentity: () => fs.remove(caller).pipe(Effect.andThen(fs.symlink(second, caller))),
            }).pipe(Effect.flip);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toBe('Repository identity changed during the graph read.');

            yield* fs.remove(caller);
            yield* fs.symlink(first, caller);
            const remoteFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              afterInitialIdentity: () =>
                git(first, ['remote', 'set-url', 'origin', 'https://github.com/example/replaced.git']).pipe(
                  Effect.asVoid,
                ),
            }).pipe(Effect.flip);
            expect(remoteFailure).toBeInstanceOf(Error);
            expect((remoteFailure as Error).message).toBe('Repository identity changed during the graph read.');
            yield* git(first, ['remote', 'set-url', 'origin', 'https://github.com/example/read-fence.git']);

            const lateRetargetFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                fs.remove(caller).pipe(Effect.andThen(fs.symlink(second, caller))),
            }).pipe(Effect.flip);
            expect(lateRetargetFailure).toBeInstanceOf(Error);
            expect((lateRetargetFailure as Error).message).toBe('Repository identity changed during the graph read.');

            yield* fs.remove(caller);
            yield* fs.symlink(first, caller);
            const changed = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                fs.writeFileString(path.join(first, 'tracked.ts'), 'export const tracked = 2;\n'),
            });
            expect(changed).toEqual({...expected, headCommit: identity.headCommit, worktreeChanged: true});
            yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'export const tracked = 1;\n');

            const firstGitDirectory = path.join(first, '.git');
            const savedFirstGitDirectory = path.join(first, '.git-before-retarget');
            const commonDirectoryFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                fs
                  .rename(firstGitDirectory, savedFirstGitDirectory)
                  .pipe(
                    Effect.andThen(fs.writeFileString(firstGitDirectory, `gitdir: ${path.join(second, '.git')}\n`)),
                  ),
            }).pipe(
              Effect.ensuring(
                fs
                  .remove(firstGitDirectory, {force: true})
                  .pipe(Effect.andThen(fs.rename(savedFirstGitDirectory, firstGitDirectory)), Effect.orDie),
              ),
              Effect.flip,
            );
            expect(commonDirectoryFailure).toBeInstanceOf(Error);
            expect((commonDirectoryFailure as Error).message).toBe(
              'Repository identity changed during the graph read.',
            );

            const headFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                git(first, [
                  '-c',
                  'user.name=Threadnote Test',
                  '-c',
                  'user.email=test@threadnote.local',
                  'commit',
                  '--allow-empty',
                  '-qm',
                  'interlocked next head',
                ]).pipe(Effect.asVoid),
            }).pipe(Effect.flip);
            expect(headFailure).toBeInstanceOf(Error);
            expect((headFailure as Error).message).toBe('Repository identity changed during the graph read.');
          }),
        ),
      ),
    );
  });

  it('never classifies a porcelain-v2 change record as a clean worktree', () => {
    const head = 'a'.repeat(40);
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9._/-]{1,64}$/u), repositoryPath => {
        const output = `# branch.oid ${head}\0# branch.head main\0? ${repositoryPath}\0`;
        expect(parseRepositoryIdentityWorktreeObservation(output, 'sha1')).toMatchObject({
          changed: true,
          headCommit: head,
        });
      }),
      {numRuns: 100},
    );
  });

  it('parses one bounded setup identity and rejects missing, duplicate, or unsafe fields', () => {
    const prefix = '00:00:00.000000 trace.c:1 setup: ';
    expect(
      parseRepositoryReadFenceSetupObservation(
        `${prefix}git_common_dir: /repo/.git\n${prefix}worktree: /repo with spaces\n`,
      ),
    ).toEqual({gitCommonDirectory: '/repo/.git', worktree: '/repo with spaces'});
    expect(parseRepositoryReadFenceSetupObservation(`${prefix}worktree: /repo\n`)).toBeUndefined();
    expect(
      parseRepositoryReadFenceSetupObservation(
        `${prefix}git_common_dir: /repo/.git\n${prefix}worktree: /repo\n${prefix}worktree: /other\n`,
      ),
    ).toBeUndefined();
    expect(
      parseRepositoryReadFenceSetupObservation(
        `${prefix}git_common_dir: /repo/.git\n${prefix}worktree: /repo\u0000other\n`,
      ),
    ).toBeUndefined();
  });

  it('rejects every duplicated setup identity field', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9._-]{1,32}$/u),
        fc.constantFrom('git_common_dir', 'worktree'),
        (segment, duplicate) => {
          const prefix = '00:00:00.000000 trace.c:1 setup: ';
          const gitCommonDirectory = `/repo/${segment}/.git`;
          const worktree = `/repo/${segment}`;
          const base = `${prefix}git_common_dir: ${gitCommonDirectory}\n${prefix}worktree: ${worktree}\n`;
          const repeated = duplicate === 'git_common_dir' ? gitCommonDirectory : worktree;
          expect(
            parseRepositoryReadFenceSetupObservation(`${base}${prefix}${duplicate}: ${repeated}\n`),
          ).toBeUndefined();
        },
      ),
      {numRuns: 100},
    );
  });
});

const git = Effect.fn('codeGraphExpectedIdentityTest.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}),
);
