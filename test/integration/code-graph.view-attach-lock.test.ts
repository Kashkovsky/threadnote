import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from '../../src/code_graph/types.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('shared ready view attachment locking', () => {
  it('defers without mutation when the target builder is active, then attaches after release', async () => {
    const root = temporaryRepository();
    const repositoryRoot = join(root, 'repository');
    const threadnoteHome = join(root, 'threadnote-home');

    const observed = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const graph = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const identity = yield* resolveRepositoryIdentity(repositoryRoot);
        const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
        const snapshot = readySnapshot(identity);
        yield* store.activate(layout.databasePath, identity, snapshot, [], [], []);
        const before = yield* graph.statusForIdentity(threadnoteHome, identity);

        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            layout.lockPath,
            {
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const startedAt = performance.now();
        const deferred = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before);
        const elapsedMilliseconds = performance.now() - startedAt;
        const pointerWhileBusy = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);

        const counts = {fullIdentity: 0, git: 0, publicationProof: 0, status: 0};
        const mutableCommand = command as {
          execute: typeof command.execute;
          executeBytes?: NonNullable<typeof command.executeBytes>;
        };
        const execute = command.execute;
        const executeBytes = command.executeBytes;
        const observeInvocation = (executable: string, args: readonly string[]) => {
          if (executable !== 'git') return;
          counts.git += 1;
          if (args[2] === 'rev-parse' && args[3] === '--show-toplevel') counts.fullIdentity += 1;
          if (args[2] === 'status') {
            counts.status += 1;
            if (args.includes('--porcelain=v2')) counts.publicationProof += 1;
          }
        };
        const attached = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            mutableCommand.execute = (executable, args, options) => {
              observeInvocation(executable, args);
              return execute(executable, args, options);
            };
            if (executeBytes) {
              mutableCommand.executeBytes = (executable, args, options) => {
                observeInvocation(executable, args);
                return executeBytes(executable, args, options);
              };
            }
          }),
          () => graph.attachSharedReadySnapshot(threadnoteHome, identity, before),
          () =>
            Effect.sync(() => {
              mutableCommand.execute = execute;
              mutableCommand.executeBytes = executeBytes;
            }),
        );
        return {attached, before, counts, deferred, elapsedMilliseconds, pointerWhileBusy, snapshot};
      }),
    );

    expect(observed.before.readySnapshot).toBeUndefined();
    expect(observed.deferred.readySnapshot).toBeUndefined();
    expect(observed.pointerWhileBusy).toBeUndefined();
    expect(observed.elapsedMilliseconds).toBeLessThan(500);
    expect(observed.attached.readySnapshot?.id).toBe(observed.snapshot.id);
    expect(observed.attached.stale).toBe(false);
    expect(observed.counts).toEqual({fullIdentity: 1, git: 8, publicationProof: 1, status: 2});
  });

  it('does not promote an optimistic candidate after HEAD moves before target-lock acquisition', async () => {
    const root = temporaryRepository();
    const repositoryRoot = join(root, 'repository');
    const threadnoteHome = join(root, 'threadnote-home');
    const nextCommit = createNextCommit(repositoryRoot);
    git(repositoryRoot, ['reset', '--hard', 'HEAD~1']);

    const observed = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const graph = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const identity = yield* resolveRepositoryIdentity(repositoryRoot);
        const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
        const snapshot = readySnapshot(identity);
        yield* store.activate(layout.databasePath, identity, snapshot, [], [], []);
        const before = yield* graph.statusForIdentity(threadnoteHome, identity);
        const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
          afterOptimisticCandidate: () => Effect.sync(() => git(repositoryRoot, ['reset', '--hard', nextCommit])),
        });
        const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
        return {attached, identity, pointer};
      }),
    );

    expect(observed.attached.identity.headCommit).toBe(nextCommit);
    expect(observed.attached.identity.headCommit).not.toBe(observed.identity.headCommit);
    expect(observed.attached.readySnapshot).toBeUndefined();
    expect(observed.attached.stale).toBe(true);
    expect(observed.pointer).toBeUndefined();
  });

  it('reports the new identity as stale when HEAD moves immediately after promotion', async () => {
    const root = temporaryRepository();
    const repositoryRoot = join(root, 'repository');
    const threadnoteHome = join(root, 'threadnote-home');
    const nextCommit = createNextCommit(repositoryRoot);
    git(repositoryRoot, ['reset', '--hard', 'HEAD~1']);

    const observed = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const graph = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const identity = yield* resolveRepositoryIdentity(repositoryRoot);
        const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
        const snapshot = readySnapshot(identity);
        yield* store.activate(layout.databasePath, identity, snapshot, [], [], []);
        const before = yield* graph.statusForIdentity(threadnoteHome, identity);
        const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
          afterPromotion: () => Effect.sync(() => git(repositoryRoot, ['reset', '--hard', nextCommit])),
        });
        const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
        return {attached, pointer, snapshot};
      }),
    );

    expect(observed.attached.identity.headCommit).toBe(nextCommit);
    expect(observed.attached.readySnapshot?.id).toBe(observed.snapshot.id);
    expect(observed.attached.stale).toBe(true);
    expect(observed.pointer?.id).toBe(observed.snapshot.id);
  });

  it('reports stale when a tracked file changes immediately after promotion without moving HEAD', async () => {
    const root = temporaryRepository();
    const repositoryRoot = join(root, 'repository');
    const threadnoteHome = join(root, 'threadnote-home');

    const observed = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const graph = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const identity = yield* resolveRepositoryIdentity(repositoryRoot);
        const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
        const snapshot = readySnapshot(identity);
        yield* store.activate(layout.databasePath, identity, snapshot, [], [], []);
        const before = yield* graph.statusForIdentity(threadnoteHome, identity);
        const attached = yield* graph.attachSharedReadySnapshot(threadnoteHome, identity, before, {
          afterPromotion: () =>
            Effect.sync(() => writeFileSync(join(repositoryRoot, 'main.ts'), 'export const attached = "dirty";\n')),
        });
        const pointer = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
        return {attached, identity, pointer, snapshot};
      }),
    );

    expect(observed.attached.identity.headCommit).toBe(observed.identity.headCommit);
    expect(observed.attached.readySnapshot?.id).toBe(observed.snapshot.id);
    expect(observed.attached.stale).toBe(true);
    expect(observed.pointer?.id).toBe(observed.snapshot.id);
  });
});

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-view-attach-lock-'));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, 'repository');
  execFileSync('git', ['init', repositoryRoot], {stdio: 'ignore'});
  execFileSync('git', ['-C', repositoryRoot, 'config', 'user.email', 'threadnote-test@example.invalid']);
  execFileSync('git', ['-C', repositoryRoot, 'config', 'user.name', 'Threadnote Test']);
  writeFileSync(join(repositoryRoot, 'main.ts'), 'export const attached = true;\n');
  git(repositoryRoot, ['add', 'main.ts']);
  git(repositoryRoot, ['commit', '-m', 'fixture']);
  return root;
}

function createNextCommit(repositoryRoot: string): string {
  writeFileSync(join(repositoryRoot, 'main.ts'), 'export const attached = "new-head";\n');
  git(repositoryRoot, ['add', 'main.ts']);
  git(repositoryRoot, ['commit', '-m', 'next']);
  return git(repositoryRoot, ['rev-parse', 'HEAD']);
}

function git(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function readySnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-08-08T00:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: 'view-attach-lock-test',
    fileCount: 0,
    id: 'snapshot-view-attach-lock',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}
