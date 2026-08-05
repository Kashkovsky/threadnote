import {readFile, readlink, rm as nodeRm, symlink} from 'node:fs/promises';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {codeGraphRepositoryLockPath} from '../../src/code_graph/layout.js';
import {purgeCodeGraphIndex} from '../../src/code_graph/maintenance.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('targeted code graph purge', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('previews and removes only the selected checkout without a worktree path', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-');
    homes.push(home);
    const checkoutId = 'a'.repeat(64);
    const siblingCheckoutId = 'b'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const siblingRoot = join(home, 'indexes', 'code-graph', 'repositories', siblingCheckoutId);
    await mkdir(join(repositoryRoot, 'vectors'), {recursive: true});
    await mkdir(siblingRoot, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'disposable graph\n');
    await writeFile(join(repositoryRoot, 'vectors', 'model.sqlite'), 'disposable vectors\n');
    await writeFile(join(siblingRoot, 'graph-v3.sqlite'), 'sibling must survive\n');

    await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: true}))).resolves.toEqual({
      checkoutId,
      dryRun: true,
      existed: true,
    });
    await expect(Bun.file(join(repositoryRoot, 'graph-v3.sqlite')).exists()).resolves.toBe(true);

    await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).resolves.toEqual({
      checkoutId,
      dryRun: false,
      existed: true,
    });
    await expect(Bun.file(join(repositoryRoot, 'graph-v3.sqlite')).exists()).resolves.toBe(false);
    await expect(readFile(join(siblingRoot, 'graph-v3.sqlite'), 'utf8')).resolves.toContain('must survive');

    await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).resolves.toEqual({
      checkoutId,
      dryRun: false,
      existed: false,
    });
  });

  it('rejects invalid checkout identities before inspecting storage', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-invalid-');
    homes.push(home);

    await fc.assert(
      fc.asyncProperty(
        fc.string().filter(value => !/^[0-9a-f]{64}$/.test(value)),
        async checkoutId => {
          await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).rejects.toThrow(
            'Code graph checkout identity is invalid',
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symbolic-link checkout root and preserves its target',
    async () => {
      const home = await mkdtemp('threadnote-targeted-graph-purge-link-');
      homes.push(home);
      const checkoutId = 'c'.repeat(64);
      const repositories = join(home, 'indexes', 'code-graph', 'repositories');
      const repositoryRoot = join(repositories, checkoutId);
      const external = join(home, 'external-graph');
      await mkdir(repositories, {recursive: true});
      await mkdir(external, {recursive: true});
      await writeFile(join(external, 'keep.txt'), 'external target must survive\n');
      await symlink(external, repositoryRoot);

      await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).rejects.toThrow(
        'symbolic-link checkout root',
      );
      await expect(readFile(join(external, 'keep.txt'), 'utf8')).resolves.toContain('must survive');
      await expect(readlink(repositoryRoot)).resolves.toBe(external);
    },
  );

  it('fails immediately while an active build owns the checkout lock', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-lock-');
    homes.push(home);
    const checkoutId = 'd'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'locked graph\n');

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            codeGraphRepositoryLockPath(path, home, checkoutId),
            {
              heartbeatIntervalMilliseconds: 20,
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const purged = yield* purgeCodeGraphIndex(home, checkoutId, {dryRun: false}).pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: summary => ({success: true as const, summary}),
          }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return purged;
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatchObject({name: 'FileLockTimeout'});
    await expect(readFile(join(repositoryRoot, 'graph-v3.sqlite'), 'utf8')).resolves.toContain('locked');
  });

  it.skipIf(process.platform === 'win32')('revalidates the checkout root after planning', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-race-');
    homes.push(home);
    const checkoutId = 'e'.repeat(64);
    const repositories = join(home, 'indexes', 'code-graph', 'repositories');
    const repositoryRoot = join(repositories, checkoutId);
    const external = join(home, 'external-race-graph');
    await mkdir(repositoryRoot, {recursive: true});
    await mkdir(external, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'initial graph\n');
    await writeFile(join(external, 'keep.txt'), 'external race target must survive\n');

    await expect(
      runEffect(
        purgeCodeGraphIndex(home, checkoutId, {
          dryRun: false,
          interlock: {
            beforeVerification: () =>
              Effect.promise(async () => {
                await nodeRm(repositoryRoot, {recursive: true});
                await symlink(external, repositoryRoot);
              }),
          },
        }),
      ),
    ).rejects.toThrow('symbolic-link checkout root');
    await expect(readFile(join(external, 'keep.txt'), 'utf8')).resolves.toContain('must survive');
    await expect(readlink(repositoryRoot)).resolves.toBe(external);
  });
});
