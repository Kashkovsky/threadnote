import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect, Option, Path} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {compareCodeUnits} from '../../src/code_graph/ordering.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CodeGraphStore, type CodeGraphVisualizationCatalog, type StoredCodeGraph} from '../../src/code_graph/store.js';
import type {CodeGraphMaterializationMetrics, CodeGraphQueryResult} from '../../src/code_graph/types.js';
import {runEffect} from '../helpers/effect-runtime.js';

interface DifferentialScenario {
  readonly baseTargets: readonly number[];
  readonly dirty: ReadonlySet<number>;
  readonly dirtyTargets: readonly number[];
  readonly fileCount: number;
  readonly salt: number;
}

interface BarrelScenario {
  readonly barrelDepth: number;
  readonly cleanArities: readonly number[];
  readonly dirtyArities: readonly number[];
  readonly revision: number;
}

const scenarioArbitrary = FC.record({
  baseTargets: FC.array(FC.integer({max: 31, min: 0}), {maxLength: 7, minLength: 7}),
  dirtyMask: FC.array(FC.boolean(), {maxLength: 7, minLength: 7}),
  dirtyTargets: FC.array(FC.integer({max: 31, min: 0}), {maxLength: 7, minLength: 7}),
  fileCount: FC.integer({max: 7, min: 3}),
  salt: FC.integer({max: 10_000, min: 0}),
}).map(({baseTargets, dirtyMask, dirtyTargets, fileCount, salt}) => {
  const dirty = new Set(dirtyMask.slice(3, fileCount).flatMap((enabled, index) => (enabled ? [index + 3] : [])));
  dirty.add(0);
  dirty.add(2);
  const anchoredBaseTargets = baseTargets.slice(0, fileCount);
  const anchoredDirtyTargets = dirtyTargets.slice(0, fileCount);
  anchoredBaseTargets[0] = 1;
  anchoredDirtyTargets[0] = 2;
  anchoredBaseTargets[1] = 0;
  anchoredDirtyTargets[1] = 0;
  anchoredBaseTargets[2] = 1;
  anchoredDirtyTargets[2] = 1;
  return {
    baseTargets: anchoredBaseTargets,
    dirty,
    dirtyTargets: anchoredDirtyTargets,
    fileCount,
    salt,
  } satisfies DifferentialScenario;
});

const barrelScenarioArbitrary = FC.record({
  barrelDepth: FC.integer({max: 4, min: 1}),
  cleanZero: FC.boolean(),
  cleanTwo: FC.boolean(),
  dirtyZero: FC.boolean(),
  dirtyTwo: FC.boolean(),
  revision: FC.integer({max: 10_000, min: 1}),
}).map(({barrelDepth, cleanTwo, cleanZero, dirtyTwo, dirtyZero, revision}) => ({
  barrelDepth,
  cleanArities: [cleanZero ? 0 : -1, cleanTwo ? 2 : -1].filter(arity => arity >= 0),
  dirtyArities: [dirtyZero ? 0 : -1, dirtyTwo ? 2 : -1].filter(arity => arity >= 0),
  revision,
}));

describe('code graph incremental-overlay differential properties', () => {
  it.effect.prop(
    'matches a full rebuild after randomized body-only edits change multi-file references',
    {scenario: scenarioArbitrary},
    ({scenario}) =>
      Effect.promise(async () => {
        const root = createRepository(scenario);
        const incrementalHome = join(root, '.threadnote-incremental-home');
        const fullHome = join(root, '.threadnote-full-home');
        const fullStorageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
        try {
          await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            }),
          );
          applyDirtyScenario(root, scenario);
          const result = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const query = yield* CodeGraphQueryService;
              const store = yield* CodeGraphStore;
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
                onProgress: progress =>
                  Effect.sync(() => {
                    if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                      fullStorageObservations.push(progress.metrics.storage);
                    }
                  }),
                threadnoteHome: fullHome,
              });
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
              const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
              const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);
              const [incrementalQuery, fullQuery] = yield* Effect.all(
                [
                  query.inspect({
                    cwd: root,
                    operation: 'query',
                    query: 'symbol0',
                    refresh: false,
                    threadnoteHome: incrementalHome,
                  }),
                  query.inspect({
                    cwd: root,
                    operation: 'query',
                    query: 'symbol0',
                    refresh: false,
                    threadnoteHome: fullHome,
                  }),
                ],
                {concurrency: 1},
              );
              return {
                full,
                fullCatalog: yield* store.loadVisualizationCatalog(fullLayout.databasePath),
                fullDatabasePath: fullLayout.databasePath,
                fullGraph,
                fullHealth: yield* store.diagnose(fullLayout.databasePath),
                fullQuery,
                incremental,
                incrementalCatalog: yield* store.loadVisualizationCatalog(incrementalLayout.databasePath),
                incrementalGraph,
                incrementalHealth: yield* store.diagnose(incrementalLayout.databasePath),
                incrementalQuery,
              };
            }),
          );

          expect(result.incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            stagedFiles: scenario.dirty.size,
            totalFiles: scenario.fileCount,
          });
          expect(result.full.materialization).toEqual({
            fallbackReason: 'disabled',
            mode: 'full',
            stagedFiles: scenario.fileCount,
            totalFiles: scenario.fileCount,
          });
          expect(normalizeGraph(result.incrementalGraph)).toEqual(normalizeGraph(result.fullGraph));
          expect(normalizeCatalog(result.incrementalCatalog)).toEqual(normalizeCatalog(result.fullCatalog));
          expect(normalizeQuery(result.incrementalQuery)).toEqual(normalizeQuery(result.fullQuery));
          expect(result.incrementalHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(result.fullHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(result.full.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: true, state: 'ready'});
          expect(persistedSnapshots(result.fullDatabasePath)).toEqual([
            {
              baseSnapshotId: Option.none(),
              dirty: 1,
              id: result.full.snapshot.id,
              state: 'ready',
            },
          ]);
          expect(fullStorageObservations.at(-1)).toMatchObject({
            materializationMode: 'direct-persistent',
            temporaryDatabaseBytes: 0,
            temporaryDatabaseHighWaterBytes: 0,
          });

          const expectedCalls = new Set(
            Array.from({length: scenario.fileCount}, (_, source) => {
              const rawTarget = scenario.dirty.has(source)
                ? scenario.dirtyTargets[source]!
                : scenario.baseTargets[source]!;
              return `symbol${source}->symbol${differentFile(rawTarget, source, scenario.fileCount)}`;
            }),
          );
          const resolvedCalls = new Set(
            result.incrementalGraph.edges
              .filter(edge => edge.relation === 'calls' && edge.sourceId !== undefined && edge.targetId !== undefined)
              .map(edge => `${edge.sourceName}->${edge.targetName}`),
          );
          expect(resolvedCalls).toEqual(expectedCalls);
        } finally {
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      fastCheck: {interruptAfterTimeLimit: 90_000, markInterruptAsFailure: true, numRuns: 10},
      timeout: 100_000,
    },
  );

  it('resumes an interrupted forced dirty direct build without creating a second snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 41,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-forced-full-home');
    const storageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
    try {
      applyDirtyScenario(root, scenario);
      const interrupted = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const identity = yield* resolveRepositoryIdentity(root);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const exit = yield* indexer
            .index({
              cwd: root,
              force: true,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          return {databasePath: layout.databasePath, exit};
        }),
      );
      expect(interrupted.exit._tag).toBe('Failure');
      const checkpoint = persistedForcedBuildCheckpoint(interrupted.databasePath);
      expect(checkpoint).toMatchObject({batchCount: 1, dirty: 1, state: 'building'});

      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const store = yield* CodeGraphStore;
          const summary = yield* indexer.index({
            cwd: root,
            force: true,
            onProgress: progress =>
              Effect.sync(() => {
                if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                  storageObservations.push(progress.metrics.storage);
                }
              }),
            threadnoteHome: home,
          });
          const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
          return {
            databasePath: layout.databasePath,
            health: yield* store.diagnose(layout.databasePath),
            summary,
          };
        }),
      );

      expect(result.summary.materialization).toEqual({
        fallbackReason: 'forced-full-rebuild',
        mode: 'full',
        stagedFiles: scenario.fileCount,
        totalFiles: scenario.fileCount,
      });
      expect(result.summary.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: true, state: 'ready'});
      expect(result.summary.snapshot.id).toBe(checkpoint.id);
      expect(persistedSnapshotStartedAt(result.databasePath, result.summary.snapshot.id)).toBe(checkpoint.startedAt);
      expect(persistedSnapshots(result.databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 1,
          id: result.summary.snapshot.id,
          state: 'ready',
        },
      ]);
      expect(storageObservations.at(-1)).toMatchObject({
        materializationMode: 'direct-persistent',
        temporaryDatabaseBytes: 0,
        temporaryDatabaseHighWaterBytes: 0,
      });
      expect(result.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('does not reuse a completed incremental request for an explicit direct rebuild', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 61,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-completed-mode-switch-home');
    try {
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );
      applyDirtyScenario(root, scenario);
      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: home});
          const direct = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: home});
          return {direct, incremental};
        }),
      );

      expect(result.incremental.materialization?.mode).toBe('incremental-overlay');
      expect(result.incremental.snapshot.baseSnapshotId).toBeDefined();
      expect(result.direct.materialization).toMatchObject({fallbackReason: 'disabled', mode: 'full'});
      expect(result.direct.snapshot.id).toMatch(/-direct$/);
      expect(result.direct.snapshot.id).not.toBe(result.incremental.snapshot.id);
      expect(result.direct.snapshot.baseSnapshotId).toBeUndefined();
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('reclaims an interrupted direct sibling before reusing the ready logical snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 62,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-ready-logical-interrupted-direct-home');
    try {
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );
      applyDirtyScenario(root, scenario);
      const interrupted = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const logical = yield* indexer.index({cwd: root, threadnoteHome: home});
          const layout = codeGraphLayout(path, home, logical.identity.checkoutId, logical.identity.worktreeId);
          const exit = yield* indexer
            .index({
              cwd: root,
              incrementalOverlay: false,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          return {databasePath: layout.databasePath, exit, logical};
        }),
      );

      expect(interrupted.logical.materialization?.mode).toBe('incremental-overlay');
      expect(interrupted.logical.snapshot.baseSnapshotId).toBeDefined();
      expect(interrupted.exit._tag).toBe('Failure');
      const direct = persistedBuildingSnapshot(interrupted.databasePath);
      expect(direct.id).toMatch(/-direct$/);
      expect(Option.isNone(direct.baseSnapshotId)).toBe(true);
      expect(persistedSnapshotRowCount(interrupted.databasePath, direct.id, 'symbols')).toBeGreaterThan(0);

      const reused = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );

      expect(reused.snapshot.id).toBe(interrupted.logical.snapshot.id);
      expect(reused.materialization?.mode).toBe('reused-snapshot');
      expect(persistedSnapshotState(interrupted.databasePath, direct.id)).toBeUndefined();
      expect(persistedSnapshotRowCount(interrupted.databasePath, direct.id, 'symbols')).toBe(0);
      expect(persistedSnapshotRowCount(interrupted.databasePath, direct.id, 'building_materialization_batches')).toBe(
        0,
      );
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('keeps the explicit overlay option inert for a clean canonical snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0]),
      dirtyTargets: [1, 0, 1],
      fileCount: 3,
      salt: 63,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-clean-mode-home');
    try {
      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const explicit = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: home});
          const normal = yield* indexer.index({cwd: root, threadnoteHome: home});
          return {
            databasePath: codeGraphLayout(path, home, explicit.identity.checkoutId, explicit.identity.worktreeId)
              .databasePath,
            explicit,
            normal,
          };
        }),
      );

      expect(result.explicit.snapshot.dirty).toBe(false);
      expect(result.explicit.snapshot.id).not.toMatch(/-direct$/);
      expect(result.normal.snapshot.id).toBe(result.explicit.snapshot.id);
      expect(persistedSnapshots(result.databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 0,
          id: result.explicit.snapshot.id,
          state: 'ready',
        },
      ]);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('keeps explicit direct semantics when default and direct dirty requests overlap', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 67,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-concurrent-mode-switch-home');
    try {
      await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );
      applyDirtyScenario(root, scenario);
      const result = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const [defaultRequest, directRequest] = yield* Effect.all(
            [
              indexer.index({cwd: root, threadnoteHome: home}),
              indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: home}),
            ],
            {concurrency: 2},
          );
          return {defaultRequest, directRequest};
        }),
      );

      expect(result.directRequest.snapshot.id).toMatch(/-direct$/);
      expect(result.directRequest.snapshot.baseSnapshotId).toBeUndefined();
      if (result.defaultRequest.snapshot.baseSnapshotId !== undefined) {
        expect(result.defaultRequest.snapshot.id).not.toBe(result.directRequest.snapshot.id);
      }
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('reclaims an interrupted dirty direct build before indexing the restored clean worktree', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 71,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-dirty-to-clean-home');
    try {
      applyDirtyScenario(root, scenario);
      const databasePath = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const identity = yield* resolveRepositoryIdentity(root);
          const exit = yield* indexer
            .index({
              cwd: root,
              incrementalOverlay: false,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          expect(exit._tag).toBe('Failure');
          return codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).databasePath;
        }),
      );
      const interrupted = persistedBuildingSnapshot(databasePath);
      expect(interrupted.id).toMatch(/-direct$/);
      restoreCleanScenario(root, scenario);

      const clean = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );

      expect(clean.snapshot.dirty).toBe(false);
      expect(clean.snapshot.id).not.toMatch(/-direct$/);
      expect(persistedSnapshotState(databasePath, interrupted.id)).toBeUndefined();
      expect(persistedSnapshots(databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 0,
          id: clean.snapshot.id,
          state: 'ready',
        },
      ]);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('switches an interrupted incremental overlay to the disjoint explicit direct snapshot', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 73,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-incremental-to-direct-home');
    const storageObservations: NonNullable<CodeGraphMaterializationMetrics['storage']>[] = [];
    try {
      const databasePath = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const clean = yield* indexer.index({cwd: root, threadnoteHome: home});
          return codeGraphLayout(path, home, clean.identity.checkoutId, clean.identity.worktreeId).databasePath;
        }),
      );
      applyDirtyScenario(root, scenario);
      const interrupted = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer
            .index({
              cwd: root,
              onProgress: progress =>
                progress.phase === 'materializing' &&
                progress.total === scenario.dirty.size &&
                progress.completed === progress.total
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
        }),
      );
      expect(interrupted._tag).toBe('Failure');
      const incremental = persistedBuildingSnapshot(databasePath);
      expect(Option.isSome(incremental.baseSnapshotId)).toBe(true);

      const direct = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            onProgress: progress =>
              Effect.sync(() => {
                if (progress.phase === 'materializing' && progress.metrics?.storage !== undefined) {
                  storageObservations.push(progress.metrics.storage);
                }
              }),
            threadnoteHome: home,
          });
        }),
      );

      expect(direct.snapshot.id).not.toBe(incremental.id);
      expect(direct.snapshot.id).toMatch(/-direct$/);
      expect(direct.snapshot.baseSnapshotId).toBeUndefined();
      expect(persistedSnapshotState(databasePath, incremental.id)).toBeUndefined();
      expect(storageObservations.at(-1)).toMatchObject({
        materializationMode: 'direct-persistent',
        temporaryDatabaseBytes: 0,
        temporaryDatabaseHighWaterBytes: 0,
      });
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it('resumes an interrupted deterministic direct snapshot when normal indexing follows', async () => {
    const scenario = {
      baseTargets: [1, 0, 1],
      dirty: new Set([0, 2]),
      dirtyTargets: [2, 0, 1],
      fileCount: 3,
      salt: 97,
    } satisfies DifferentialScenario;
    const root = createRepository(scenario);
    const home = join(root, '.threadnote-direct-to-default-home');
    try {
      applyDirtyScenario(root, scenario);
      const databasePath = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          const path = yield* Path.Path;
          const identity = yield* resolveRepositoryIdentity(root);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const exit = yield* indexer
            .index({
              cwd: root,
              incrementalOverlay: false,
              onProgress: progress =>
                progress.phase === 'materializing' && (progress.metrics?.batchesCompleted ?? 0) > 0
                  ? Effect.interrupt
                  : Effect.void,
              threadnoteHome: home,
            })
            .pipe(Effect.exit);
          expect(exit._tag).toBe('Failure');
          return layout.databasePath;
        }),
      );
      const checkpoint = persistedBuildingSnapshot(databasePath);
      expect(checkpoint.id).toMatch(/-direct$/);
      const startedAt = persistedSnapshotStartedAt(databasePath, checkpoint.id);

      const resumed = await runEffect(
        Effect.gen(function* () {
          const indexer = yield* CodeGraphIndexer;
          return yield* indexer.index({cwd: root, threadnoteHome: home});
        }),
      );

      expect(resumed.materialization).toEqual({
        fallbackReason: 'staging-unavailable',
        mode: 'full',
        stagedFiles: scenario.fileCount,
        totalFiles: scenario.fileCount,
      });
      expect(resumed.snapshot.id).toBe(checkpoint.id);
      expect(persistedSnapshotStartedAt(databasePath, resumed.snapshot.id)).toBe(startedAt);
      expect(persistedSnapshots(databasePath)).toEqual([
        {
          baseSnapshotId: Option.none(),
          dirty: 1,
          id: resumed.snapshot.id,
          state: 'ready',
        },
      ]);
    } finally {
      rmSync(root, {force: true, recursive: true});
    }
  });

  it.effect.prop(
    'matches a full rebuild through randomized transitive and cyclic named barrels',
    {scenario: barrelScenarioArbitrary},
    ({scenario}) =>
      Effect.promise(async () => {
        const root = createBarrelRepository(scenario);
        const incrementalHome = join(root, '.threadnote-barrel-incremental-home');
        const fullHome = join(root, '.threadnote-barrel-full-home');
        try {
          await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            }),
          );
          writeBarrelConsumer(root, scenario.barrelDepth, scenario.dirtyArities, scenario.revision);
          const result = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const store = yield* CodeGraphStore;
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
                threadnoteHome: fullHome,
              });
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
              return {
                fullGraph: yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id),
                incremental,
                incrementalGraph: yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id),
              };
            }),
          );

          expect(result.incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            stagedFiles: 1,
            totalFiles: scenario.barrelDepth + 4,
          });
          expect(normalizeGraph(result.incrementalGraph)).toEqual(normalizeGraph(result.fullGraph));
          const resolvedArities = new Set(
            result.incrementalGraph.edges
              .filter(edge => edge.relation === 'calls' && edge.targetName === 'decode' && edge.targetId !== undefined)
              .flatMap(edge => {
                const target = result.incrementalGraph.symbols.find(symbol => symbol.id === edge.targetId);
                return target?.arity === undefined ? [] : [target.arity];
              }),
          );
          expect(resolvedArities).toEqual(new Set(scenario.dirtyArities));
        } finally {
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      fastCheck: {interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true, numRuns: 6},
      timeout: 70_000,
    },
  );
});

function createRepository(scenario: DifferentialScenario): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-overlay-property-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  for (let source = 0; source < scenario.fileCount; source += 1) {
    writeSource(root, source, scenario.baseTargets[source]!, scenario.fileCount, 0);
  }
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'property fixture',
  ]);
  return root;
}

function applyDirtyScenario(root: string, scenario: DifferentialScenario): void {
  for (const source of scenario.dirty) {
    writeSource(root, source, scenario.dirtyTargets[source]!, scenario.fileCount, scenario.salt + source + 1);
  }
}

function restoreCleanScenario(root: string, scenario: DifferentialScenario): void {
  for (const source of scenario.dirty) {
    writeSource(root, source, scenario.baseTargets[source]!, scenario.fileCount, 0);
  }
}

function createBarrelRepository(scenario: BarrelScenario): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-barrel-property-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(
    join(root, 'src', 'declarations.ts'),
    [
      'export declare function decode(): string;',
      'export declare function decode(a: string, b: string): string;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'src', 'cycle-a.ts'), 'export {decode} from "./cycle-b.js";\n');
  writeFileSync(
    join(root, 'src', 'cycle-b.ts'),
    ['export {decode} from "./cycle-a.js";', 'export {decode} from "./declarations.js";', ''].join('\n'),
  );
  for (let index = 0; index < scenario.barrelDepth; index += 1) {
    const target = index === 0 ? 'cycle-a' : `barrel-${index - 1}`;
    writeFileSync(join(root, 'src', `barrel-${index}.ts`), `export {decode} from "./${target}.js";\n`);
  }
  writeBarrelConsumer(root, scenario.barrelDepth, scenario.cleanArities, 0);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'barrel property fixture',
  ]);
  return root;
}

function writeBarrelConsumer(root: string, barrelDepth: number, arities: readonly number[], revision: number): void {
  const calls = arities.map(arity => (arity === 0 ? 'decode()' : 'decode("a", "b")'));
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      `import {decode} from './barrel-${barrelDepth - 1}.js';`,
      'export function useDecode(): string {',
      `  const revision = ${revision};`,
      `  return [String(revision)${calls.map(call => `, ${call}`).join('')}].join(":");`,
      '}',
      '',
    ].join('\n'),
  );
}

function writeSource(root: string, source: number, rawTarget: number, fileCount: number, revision: number): void {
  const target = differentFile(rawTarget, source, fileCount);
  writeFileSync(
    join(root, 'src', `file-${source}.ts`),
    [
      `import {symbol${target}} from './file-${target}.js';`,
      `export function symbol${source}(): number {`,
      `  // body revision ${revision}`,
      `  return symbol${target}() + ${revision};`,
      '}',
      '',
    ].join('\n'),
  );
}

function differentFile(rawTarget: number, source: number, fileCount: number): number {
  const candidate = rawTarget % fileCount;
  return candidate === source ? (candidate + 1) % fileCount : candidate;
}

function normalizeGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    symbols: [...graph.symbols].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {baseSnapshotId: _baseSnapshotId, completedAt: _completedAt, id: _id, ...stableSnapshot} = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

function normalizeQuery(result: CodeGraphQueryResult): unknown {
  return {
    edges: [...result.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    nodes: result.nodes,
    operation: result.operation,
    warnings: result.warnings,
  };
}

function persistedSnapshots(databasePath: string): readonly {
  readonly baseSnapshotId: Option.Option<string>;
  readonly dirty: number;
  readonly id: string;
  readonly state: string;
}[] {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<
        {readonly baseSnapshotId: unknown; readonly dirty: number; readonly id: string; readonly state: string},
        []
      >('SELECT id, base_snapshot_id AS baseSnapshotId, dirty, state FROM snapshots ORDER BY started_at ASC, id ASC')
      .all()
      .map(row => ({
        ...row,
        baseSnapshotId: typeof row.baseSnapshotId === 'string' ? Option.some(row.baseSnapshotId) : Option.none(),
      }));
  } finally {
    database.close();
  }
}

function persistedForcedBuildCheckpoint(databasePath: string): {
  readonly batchCount: number;
  readonly dirty: number;
  readonly id: string;
  readonly startedAt: string;
  readonly state: string;
} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const snapshot = database
      .query<{readonly dirty: number; readonly id: string; readonly startedAt: string; readonly state: string}, []>(
        "SELECT id, dirty, started_at AS startedAt, state FROM snapshots WHERE state = 'building' ORDER BY started_at, id",
      )
      .get();
    if (snapshot === null) throw new Error('Interrupted forced build did not preserve its building snapshot.');
    const receipt = database
      .query<{readonly count: number}, [string]>(
        'SELECT COUNT(*) AS count FROM building_materialization_batches WHERE snapshot_id = ?',
      )
      .get(snapshot.id);
    return {...snapshot, batchCount: Number(receipt?.count ?? 0)};
  } finally {
    database.close();
  }
}

function persistedBuildingSnapshot(databasePath: string): {
  readonly baseSnapshotId: Option.Option<string>;
  readonly id: string;
} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const snapshot = database
      .query<{readonly baseSnapshotId: unknown; readonly id: string}, []>(
        "SELECT id, base_snapshot_id AS baseSnapshotId FROM snapshots WHERE state = 'building' ORDER BY started_at, id LIMIT 1",
      )
      .get();
    if (snapshot === null) throw new Error('Interrupted build did not preserve its building snapshot.');
    return {
      ...snapshot,
      baseSnapshotId:
        typeof snapshot.baseSnapshotId === 'string' ? Option.some(snapshot.baseSnapshotId) : Option.none(),
    };
  } finally {
    database.close();
  }
}

function persistedSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
      .get(snapshotId)?.state;
  } finally {
    database.close();
  }
}

function persistedSnapshotStartedAt(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true});
  try {
    return database
      .query<{readonly startedAt: string}, [string]>('SELECT started_at AS startedAt FROM snapshots WHERE id = ?')
      .get(snapshotId)?.startedAt;
  } finally {
    database.close();
  }
}

function persistedSnapshotRowCount(
  databasePath: string,
  snapshotId: string,
  table: 'building_materialization_batches' | 'symbols',
): number {
  const database = new Database(databasePath, {readonly: true});
  try {
    return Number(
      database
        .query<{readonly count: number}, [string]>(`SELECT COUNT(*) AS count FROM ${table} WHERE snapshot_id = ?`)
        .get(snapshotId)?.count ?? 0,
    );
  } finally {
    database.close();
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
