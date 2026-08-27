import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  resolveRepositoryIdentity,
  resolveRepositoryIdentityForExpectation,
  revalidateRepositoryIdentityFence,
} from '../../src/code_graph/repository.js';
import {runCommandEffect} from '../../src/effect/command.js';
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
  });
});

const git = Effect.fn('codeGraphExpectedIdentityTest.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}),
);
