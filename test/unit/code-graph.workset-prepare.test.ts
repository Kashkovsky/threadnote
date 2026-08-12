import {TestError} from '../helpers/test-error.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, Exit, FileSystem, Path, Semaphore} from 'effect';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../../src/code_graph/indexer.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {inspectCodeGraphWorksetStatus, prepareCodeGraphWorkset} from '../../src/code_graph/workset_catalog/workset.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationReceiptInputV1,
  type CodeGraphWorksetCatalogGenerationReceiptV1,
} from '../../src/code_graph/workset_catalog/types.js';
import type {CodeGraphIndexSummary, RepositoryIdentity} from '../../src/code_graph/types.js';
import type {ResolvedWorkset, RuntimeConfig} from '../../src/types.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';

const mocks = vi.hoisted(() => ({
  maintainPage: vi.fn(),
  retirePreparation: vi.fn(),
  expandPath: vi.fn(),
  leaseGuard: vi.fn(),
  publishGeneration: vi.fn(),
  readBridgeSummary: vi.fn(),
  readSnapshotMonikers: vi.fn(),
  readPublishedGeneration: vi.fn(),
  registerQualifiedRef: vi.fn(),
  replaceBridgeSet: vi.fn(),
  requireWorkset: vi.fn(),
  stageGeneration: vi.fn(),
  stageProjection: vi.fn(),
  worksetLock: vi.fn(),
}));

vi.mock('../../src/effect/file_lock.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/effect/file_lock.js')>()),
  withExclusiveFileLock: mocks.worksetLock,
}));

vi.mock('../../src/manifest.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/manifest.js')>()),
  requireWorkset: mocks.requireWorkset,
}));

vi.mock('../../src/utils.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/utils.js')>()),
  expandPath: mocks.expandPath,
}));

vi.mock('../../src/code_graph/workset_catalog/projection_builder.js', () => ({
  stageCodeGraphWorksetRoutingProjectionScoped: mocks.stageProjection,
}));

vi.mock('../../src/code_graph/cross_repository/snapshot_monikers.js', () => ({
  readCodeGraphReadySnapshotMonikers: mocks.readSnapshotMonikers,
}));

vi.mock('../../src/code_graph/cross_repository/store.js', () => ({
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary: mocks.readBridgeSummary,
  replaceCodeGraphWorksetCatalogBridgeSet: mocks.replaceBridgeSet,
}));

vi.mock('../../src/code_graph/workset_catalog/store.js', () => ({
  maintainCodeGraphWorksetCatalogPreparationPage: mocks.maintainPage,
  publishCodeGraphWorksetCatalogGeneration: mocks.publishGeneration,
  readPublishedCodeGraphWorksetCatalogGeneration: mocks.readPublishedGeneration,
  registerCodeGraphQualifiedRef: mocks.registerQualifiedRef,
  retireCodeGraphWorksetCatalogPreparation: mocks.retirePreparation,
  stageCodeGraphWorksetCatalogGenerationFromReceipts: mocks.stageGeneration,
}));

describe('code graph workset mixed-coverage preparation', () => {
  const config: RuntimeConfig = {
    account: 'test',
    agentContextHome: '/threadnote-home',
    agentId: 'test-agent',
    manifestPath: '/manifest.json',
    user: 'test-user',
  };
  const identity = repositoryIdentity('ready');
  const summary = indexSummary(identity);
  const generation: CodeGraphWorksetCatalogGenerationReceiptV1 = {
    digest: 'd'.repeat(64),
    id: `cgwg_${'e'.repeat(40)}`,
    manifestDigest: 'f'.repeat(64),
    memberCount: 1,
    state: 'staging',
    worksetName: 'engineering',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkset.mockReturnValue(Effect.succeed(workset()));
    mocks.maintainPage.mockReturnValue(Effect.succeed({pendingCleanup: false}));
    mocks.retirePreparation.mockReturnValue(Effect.void);
    mocks.worksetLock.mockImplementation((_fs, _path, _options, effect) => effect);
    mocks.expandPath.mockImplementation((value: string) => Effect.succeed(value));
    mocks.stageProjection.mockReturnValue(
      Effect.succeed({
        assertLease: Effect.sync(() => mocks.leaseGuard()),
        receipt: {
          checkoutId: identity.checkoutId,
          commitId: summary.snapshot.commit,
          componentCount: 1,
          extractorGeneration: 1,
          projectionDigest: 'b'.repeat(64),
          projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
          repositoryId: identity.repositoryId,
          snapshotDigest: 'c'.repeat(64),
          snapshotId: summary.snapshot.id,
          symbolCount: 1,
          worktreeId: identity.worktreeId,
        },
        stats: {
          componentCount: 1,
          dependencyCount: 0,
          lookupKeysOmitted: 0,
          lookupKeysObserved: 0,
          pagesRead: 1,
          symbolsRead: 1,
          termsOmitted: 0,
          termsObserved: 0,
        },
      }),
    );
    mocks.stageGeneration.mockImplementation((_home: string, input: CodeGraphWorksetCatalogGenerationReceiptInputV1) =>
      Effect.succeed({...generation, manifestDigest: input.manifestDigest}),
    );
    mocks.publishGeneration.mockImplementation(
      (
        _home: string,
        input: {
          readonly beforePointerSwap?: () => Effect.Effect<void, unknown>;
        },
      ) =>
        (input.beforePointerSwap?.() ?? Effect.void).pipe(
          Effect.as({...generation, manifestDigest: codeGraphManifestDigestFromStage()}),
        ),
    );
    mocks.readPublishedGeneration.mockReturnValue(Effect.succeed(undefined));
    mocks.readBridgeSummary.mockReturnValue(Effect.succeed(undefined));
    mocks.readSnapshotMonikers.mockReturnValue(Effect.succeed([]));
    mocks.registerQualifiedRef.mockReturnValue(Effect.succeed(undefined));
    mocks.replaceBridgeSet.mockImplementation(
      (
        _home: string,
        input: {
          readonly bridges: readonly unknown[];
          readonly coverage?: {readonly rejectionCount: number};
          readonly generationId: string;
        },
      ) =>
        Effect.succeed({
          bridgeCount: input.bridges.length,
          coverage: input.coverage,
          digest: '9'.repeat(64),
          generationId: input.generationId,
          replacedAt: '2026-01-01T00:00:00.000Z',
          resolverVersion: 1,
          state: 'staged',
          worksetName: 'engineering',
        }),
    );
  });

  it('publishes the non-empty ready subset and keeps the missing member receipt', async () => {
    const fs = {exists: (path: string) => Effect.succeed(path === '/ready')} as unknown as FileSystem.FileSystem;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };

    const result = await runEffect(
      prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      ),
    );

    expect(result.state).toBe('ready');
    expect(result.bridges).toMatchObject({bridgeCount: 0, rejectionCount: 0, state: 'ready'});
    expect(result.members).toEqual([
      expect.objectContaining({project: 'ready', state: 'ready'}),
      {project: 'missing', reason: 'missing-path', state: 'missing'},
    ]);
    expect(mocks.stageGeneration).toHaveBeenCalledOnce();
    expect(mocks.stageGeneration.mock.calls[0]?.[1]).toMatchObject({
      members: [
        {
          projectionDigest: 'b'.repeat(64),
          repositoryId: identity.repositoryId,
          repositoryKey: 'ready',
          snapshotId: summary.snapshot.id,
        },
      ],
    });
    expect(mocks.publishGeneration).toHaveBeenCalledOnce();
    expect(mocks.leaseGuard).toHaveBeenCalledTimes(4);
    expect(mocks.replaceBridgeSet).toHaveBeenCalledWith(
      config.agentContextHome,
      expect.objectContaining({bridges: [], generationId: generation.id}),
    );

    mocks.readPublishedGeneration.mockReturnValue(
      Effect.succeed({
        digest: generation.digest,
        id: generation.id,
        manifestDigest: result.manifestDigest,
        members: [
          {
            checkoutId: identity.checkoutId,
            commitId: summary.snapshot.commit,
            ordinal: 0,
            projectionDigest: 'b'.repeat(64),
            repositoryId: identity.repositoryId,
            repositoryKey: 'ready',
            snapshotDigest: 'c'.repeat(64),
            snapshotId: summary.snapshot.id,
            symbolCount: 1,
            worktreeId: identity.worktreeId,
          },
        ],
        worksetName: 'engineering',
      }),
    );
    const query = {
      status: () =>
        Effect.succeed({
          databasePath: '/db',
          freshness: 'current' as const,
          identity,
          languagePacks: [],
          readySnapshot: summary.snapshot,
          stale: false,
        }),
    };
    const status = await runEffect(
      inspectCodeGraphWorksetStatus(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphQueryService, query as never),
      ),
    );
    expect(status.members).toEqual([
      expect.objectContaining({project: 'ready', state: 'current'}),
      {project: 'missing', reason: 'missing-path', state: 'missing'},
    ]);
    expect(status.catalog.state).toBe('stale');
  });

  it('withholds every bridge when any ready member moniker surface is unreadable', async () => {
    const fs = {exists: (path: string) => Effect.succeed(path === '/ready')} as unknown as FileSystem.FileSystem;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.readSnapshotMonikers.mockReturnValue(Effect.fail(new TestError('malformed moniker row')));

    const result = await runEffect(
      prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      ),
    );

    expect(result.state).toBe('ready');
    expect(result.bridges).toMatchObject({
      bridgeCount: 0,
      rejectionCount: 0,
      state: 'unavailable',
      unavailableRepositories: ['ready'],
    });
    expect(mocks.replaceBridgeSet).toHaveBeenCalledWith(config.agentContextHome, {
      bridges: [],
      coverage: {
        diagnostics: ['moniker-read-failed'],
        failedRepositoryCount: 1,
        rejectionCount: 0,
        repositoriesRead: 0,
        state: 'failed',
      },
      generationId: generation.id,
    });
    expect(mocks.publishGeneration).toHaveBeenCalledOnce();
  });

  effectIt.effect('discards its exact staged generation when bridge preparation fails', () => {
    const fs = {exists: (path: string) => Effect.succeed(path === '/ready')} as unknown as FileSystem.FileSystem;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.replaceBridgeSet.mockReturnValue(
      Effect.fail(new CodeGraphWorksetCatalogError('capacity', 'bridge capacity fixture')),
    );

    return Effect.gen(function* () {
      const failure = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, {join: (...parts: string[]) => parts.join('/')} as Path.Path),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.flip,
      );

      expect(failure).toMatchObject({reason: 'capacity'});
      expect(mocks.retirePreparation).toHaveBeenCalledOnce();
      expect(mocks.retirePreparation).toHaveBeenCalledWith(config.agentContextHome, {
        generationId: generation.id,
        projectionDigests: ['b'.repeat(64)],
      });
      expect(mocks.publishGeneration).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('serializes identical prepares so a failed attempt cannot retire its successor', () =>
    Effect.gen(function* () {
      const fs = {exists: (path: string) => Effect.succeed(path === '/ready')} as unknown as FileSystem.FileSystem;
      const indexer: CodeGraphIndexerShape = {
        ensureCommit: () => Effect.die('not used'),
        index: () => Effect.succeed(summary),
      };
      const semaphore = yield* Semaphore.make(1);
      const events: string[] = [];
      let bridgeAttempt = 0;
      mocks.worksetLock.mockImplementation((_fs, _path, _options, effect) => semaphore.withPermits(1)(effect));
      mocks.replaceBridgeSet.mockImplementation((_home: string, input: {readonly generationId: string}) =>
        Effect.suspend(() => {
          bridgeAttempt += 1;
          if (bridgeAttempt === 1) {
            events.push('bridge-failed');
            return Effect.fail(new CodeGraphWorksetCatalogError('capacity', 'bridge capacity fixture'));
          }
          events.push('bridge-ready');
          return Effect.succeed({
            bridgeCount: 0,
            coverage: {
              diagnostics: [],
              failedRepositoryCount: 0,
              rejectionCount: 0,
              repositoriesRead: 1,
              repositoryCount: 1,
              state: 'complete' as const,
            },
            digest: '9'.repeat(64),
            generationId: input.generationId,
            replacedAt: '2026-01-01T00:00:00.000Z',
            resolverVersion: 1 as const,
            state: 'staged' as const,
            worksetName: 'engineering',
          });
        }),
      );
      mocks.retirePreparation.mockImplementation(() =>
        Effect.sync(() => {
          events.push('retired');
        }),
      );
      mocks.publishGeneration.mockImplementation(
        (
          _home: string,
          input: {
            readonly beforePointerSwap?: () => Effect.Effect<void, unknown>;
          },
        ) =>
          (input.beforePointerSwap?.() ?? Effect.void).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                events.push('published');
              }),
            ),
            Effect.as({...generation, manifestDigest: codeGraphManifestDigestFromStage()}),
          ),
      );

      const outcomes = yield* Effect.all(
        [prepareCodeGraphWorkset(config, 'engineering'), prepareCodeGraphWorkset(config, 'engineering')].map(effect =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(CodeGraphIndexer, indexer),
            Effect.exit,
          ),
        ),
        {concurrency: 2},
      );

      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(mocks.retirePreparation).toHaveBeenCalledOnce();
      expect(mocks.publishGeneration).toHaveBeenCalledOnce();
      expect(events.indexOf('retired')).toBeGreaterThan(events.indexOf('bridge-failed'));
      expect(events.indexOf('published')).toBeGreaterThan(events.indexOf('retired'));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a definition changed after indexing but before the prepare lock', () => {
    const fs = {exists: (path: string) => Effect.succeed(path === '/ready')} as unknown as FileSystem.FileSystem;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.requireWorkset
      .mockReturnValueOnce(Effect.succeed(workset()))
      .mockReturnValueOnce(Effect.succeed({...workset(), unresolvedProjects: ['renamed']}));

    return Effect.gen(function* () {
      const failure = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.flip,
      );
      expect(failure).toMatchObject({reason: 'stale'});
      expect(mocks.stageProjection).not.toHaveBeenCalled();
      expect(mocks.publishGeneration).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('revalidates the definition in the final pointer fence', () => {
    const fs = {exists: (path: string) => Effect.succeed(path === '/ready')} as unknown as FileSystem.FileSystem;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.succeed(summary),
    };
    mocks.requireWorkset
      .mockReturnValueOnce(Effect.succeed(workset()))
      .mockReturnValueOnce(Effect.succeed(workset()))
      .mockReturnValueOnce(Effect.succeed({...workset(), unresolvedProjects: ['deleted']}));

    return Effect.gen(function* () {
      const failure = yield* prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
        Effect.flip,
      );
      expect(failure).toMatchObject({reason: 'stale'});
      expect(mocks.publishGeneration).toHaveBeenCalledOnce();
      expect(mocks.retirePreparation).toHaveBeenCalledWith(config.agentContextHome, {
        generationId: generation.id,
        projectionDigests: ['b'.repeat(64)],
      });
    }).pipe(provideTestLayer(ApplicationLayer));
  });

  it('does not publish an empty successful subset', async () => {
    const fs = {exists: () => Effect.succeed(false)} as unknown as FileSystem.FileSystem;
    const indexer: CodeGraphIndexerShape = {
      ensureCommit: () => Effect.die('not used'),
      index: () => Effect.die('missing paths must not index'),
    };

    const result = await runEffect(
      prepareCodeGraphWorkset(config, 'engineering').pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(CodeGraphIndexer, indexer),
      ),
    );

    expect(result.state).toBe('failed');
    expect(mocks.stageGeneration).not.toHaveBeenCalled();
    expect(mocks.publishGeneration).not.toHaveBeenCalled();
  });
});

function workset(): ResolvedWorkset {
  return {
    name: 'engineering',
    projects: [
      {name: 'ready', path: '/ready', seed: [], uri: 'threadnote://resources/repos/ready'},
      {name: 'missing', path: '/missing', seed: [], uri: 'threadnote://resources/repos/missing'},
    ],
    unresolvedProjects: [],
  };
}

function repositoryIdentity(seed: string): RepositoryIdentity {
  const digest = sha256HexSync(seed);
  return {
    caseMode: 'sensitive',
    checkoutId: digest,
    displayName: seed,
    gitCommonDirectory: '.git',
    headCommit: 'a'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: `/${seed}`,
    repositoryId: digest,
    worktreeId: digest,
  };
}

function indexSummary(identity: RepositoryIdentity): CodeGraphIndexSummary {
  return {
    diagnostics: [],
    durationMs: 1,
    identity,
    reusedFiles: 0,
    skippedFiles: 0,
    snapshot: {
      commit: identity.headCommit,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'test',
      fileCount: 1,
      id: 'snapshot-ready',
      repositoryId: identity.repositoryId,
      state: 'ready',
      symbolCount: 1,
      worktreeId: identity.worktreeId,
    },
  };
}

function codeGraphManifestDigestFromStage(): string {
  const input = mocks.stageGeneration.mock.calls[0]?.[1] as CodeGraphWorksetCatalogGenerationReceiptInputV1 | undefined;
  return input?.manifestDigest ?? generationFallbackDigest();
}

function generationFallbackDigest(): string {
  return 'f'.repeat(64);
}
