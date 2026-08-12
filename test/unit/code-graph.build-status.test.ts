import {TestError} from '../helpers/test-error.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {existsSync} from '../helpers/node-fs.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS,
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  calibratedCodeGraphEtaConfidence,
  makeCodeGraphBuildReporter,
  observeCodeGraphBuildStatus,
  readAllCodeGraphBuildStatuses,
  readCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
} from '../../src/code_graph/build_status.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {runCodeGraphStatus} from '../../src/code_graph/commands.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {captureConsole} from '../../src/effect/console.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  type CodeGraphResolutionActivity,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '../../src/code_graph/types.js';
import type {RuntimeConfig} from '../../src/types.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('code graph cross-process build status', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('calibrates ETA confidence from variance, prediction error, and silent intervals', () => {
    const stable = {
      completed: 500,
      cumulativeRate: 1,
      intervalSamplesMilliseconds: Array.from({length: 24}, () => 1_000),
      rateForecastErrorSamples: Array.from({length: 23}, () => 0.05),
      rateSamples: Array.from({length: 24}, (_, index) => 1 + ((index % 3) - 1) * 0.01),
      sampleCount: 24,
      silenceMilliseconds: 1_000,
      total: 1_000,
    };
    expect(calibratedCodeGraphEtaConfidence(stable)).toBe('high');
    expect(
      calibratedCodeGraphEtaConfidence({
        ...stable,
        rateForecastErrorSamples: Array.from({length: 23}, (_, index) => (index % 2 === 0 ? 0.9 : 0.1)),
        rateSamples: Array.from({length: 24}, (_, index) => (index % 2 === 0 ? 0.1 : 4)),
      }),
    ).toBe('low');
    expect(calibratedCodeGraphEtaConfidence({...stable, silenceMilliseconds: 60_000})).toBe('low');
    expect(
      calibratedCodeGraphEtaConfidence({...stable, rateSamples: stable.rateSamples.slice(0, 2), sampleCount: 2}),
    ).toBeUndefined();
  });

  effectIt.effect('publishes a reporter ETA only after stable phase-local throughput', () =>
    Effect.gen(function* () {
      const confidenceFor = (delays: readonly number[]) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectory({prefix: 'threadnote-graph-eta-reporter-'});
          homes.push(home);
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* reporter.progress({completed: 0, phase: 'materializing', reused: 0, total: 50, unit: 'files'});
          for (const [index, milliseconds] of delays.entries()) {
            yield* TestClock.adjust(milliseconds);
            yield* reporter.progress({
              completed: index + 1,
              phase: 'materializing',
              reused: 0,
              total: 50,
              unit: 'files',
            });
          }
          return (yield* readCodeGraphBuildStatuses(layout))[0]?.eta;
        }).pipe(provideTestLayer(ApplicationLayer));

      const stable = yield* confidenceFor(Array.from({length: 24}, () => 50));
      expect(stable).toMatchObject({scope: 'phase'});
      expect(['high', 'medium']).toContain(stable?.confidence);
      expect(yield* confidenceFor(Array.from({length: 24}, (_, index) => (index % 2 === 0 ? 5 : 90)))).toBeUndefined();
    }),
  );

  it('keeps active owner and queued observer jobs separate and atomically readable', async () => {
    const home = await mkdtemp('threadnote-graph-build-status-');
    homes.push(home);
    const result = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const owner = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* owner.progress({completed: 8, phase: 'materializing', reused: 5, total: 20, unit: 'files'});
        const observer = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* observer.progress({phase: 'waiting', reason: 'database-writer'});
        return {
          global: yield* readAllCodeGraphBuildStatuses(home),
          scoped: yield* readCodeGraphBuildStatuses(layout),
        };
      }),
    );
    const statuses = result.scoped;

    expect(statuses).toHaveLength(2);
    expect(new Set(statuses.map(status => status.buildId)).size).toBe(2);
    expect(statuses.every(status => status.observation.liveness === 'active')).toBe(true);
    expect(statuses.map(status => status.state).sort()).toEqual(['queued', 'running']);
    expect(statuses.find(status => status.state === 'queued')?.subphase).toBe('database-writer');
    expect(statuses.find(status => status.state === 'running')?.counters).toMatchObject({
      completed: 8,
      reused: 5,
      total: 20,
      unit: 'files',
    });
    expect(JSON.stringify(statuses)).not.toContain(home);
    expect(result.global).toHaveLength(2);
    expect(result.global.every(status => status.managerContext?.worktreePath === `${home}/repository`)).toBe(true);
    expect(result.global.every(status => status.managerContext?.branch === 'feature/manager-labels')).toBe(true);
  });

  it('persists privacy-safe superseded-snapshot reclamation progress', async () => {
    const home = await mkdtemp('threadnote-graph-reclaim-status-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          completed: 0,
          pagesCompleted: 0,
          phase: 'reclaiming',
          rowsDeleted: 0,
          total: 1,
          unit: 'snapshots',
        });
        yield* reporter.progress({
          completed: 0,
          pagesCompleted: 3,
          phase: 'reclaiming',
          rowsDeleted: 15_000,
          total: 1,
          unit: 'snapshots',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0];
      }),
    );

    expect(status).toMatchObject({
      counters: {
        completed: 0,
        pagesCompleted: 3,
        rowsDeleted: 15_000,
        total: 1,
        unit: 'snapshots',
      },
      phase: 'reclaiming',
      subphase: 'superseded-snapshots',
    });
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('persists materialization commits while throttling ordinary steady-state counter writes', async () => {
    const home = await mkdtemp('threadnote-graph-build-throttle-');
    homes.push(home);
    const observations = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({completed: 1, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
        const afterTransition = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        yield* reporter.progress({completed: 2, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
        const afterThrottledCounter = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        yield* reporter.progress({
          completed: 0,
          embedded: 0,
          phase: 'embedding',
          reused: 0,
          total: 10,
          unit: 'symbols',
        });
        const afterPhaseTransition = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        yield* reporter.progress({
          completed: 1,
          embedded: 1,
          phase: 'embedding',
          reused: 0,
          total: 10,
          unit: 'symbols',
        });
        const afterThrottledEmbeddingCounter = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        yield* Effect.sleep(CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS + 10);
        yield* reporter.progress({
          completed: 3,
          embedded: 3,
          phase: 'embedding',
          reused: 0,
          total: 10,
          unit: 'symbols',
        });
        const afterInterval = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        return {
          afterInterval,
          afterPhaseTransition,
          afterThrottledCounter,
          afterThrottledEmbeddingCounter,
          afterTransition,
        };
      }),
    );

    expect(observations.afterTransition).toMatchObject({
      counters: {completed: 1},
      phase: 'materializing',
    });
    expect(observations.afterThrottledCounter).toMatchObject({
      counters: {completed: 2},
      phase: 'materializing',
    });
    expect(observations.afterPhaseTransition).toMatchObject({
      counters: {completed: 0},
      phase: 'embedding',
    });
    expect(observations.afterThrottledEmbeddingCounter).toMatchObject({
      counters: {completed: 0},
      phase: 'embedding',
    });
    expect(observations.afterInterval).toMatchObject({
      counters: {completed: 3, embedded: 3},
      phase: 'embedding',
    });
  });

  it('persists completed scan batches immediately without leaking the in-flight path', async () => {
    const home = await mkdtemp('threadnote-graph-build-scan-progress-');
    homes.push(home);
    const secretPath = 'customers/private-project/internal/architecture.ts';
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          accepted: 8,
          activity: {
            batchCompleted: 1,
            batchTotal: 8,
            bytes: 4_096,
            classifier: 'typescript',
            factsBytes: 2_048,
            language: 'typescript',
            parseMilliseconds: 1_250,
            path: secretPath,
            relations: 7,
            role: 'source',
            sizeBucket: '0-16KiB',
            stage: 'extracting',
            symbols: 3,
          },
          completed: 0,
          excluded: 2,
          metrics: {
            factsBytesCompleted: 2_048,
            sourceBytesCompleted: 4_096,
            sourceBytesTotal: 32_768,
            workUnitsCompleted: 8_192,
            workUnitsTotal: 65_536,
          },
          phase: 'scanning',
          skipped: 0,
          timings: {
            extractionMilliseconds: 1_250,
            persistenceMilliseconds: 0,
            readingMilliseconds: 1.5,
          },
          total: 10,
          unit: 'files',
        });
        yield* reporter.progress({
          accepted: 8,
          completed: 8,
          excluded: 2,
          phase: 'scanning',
          skipped: 0,
          total: 10,
          unit: 'files',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0]!;
      }),
    );

    expect(status.counters).toMatchObject({completed: 8, total: 10});
    expect(status.extraction).toMatchObject({
      completedFiles: 1,
      metrics: {
        factsBytesCompleted: 2_048,
        sourceBytesCompleted: 4_096,
        sourceBytesTotal: 32_768,
        workUnitsCompleted: 8_192,
        workUnitsTotal: 65_536,
      },
      slowFiles: 1,
      topSlowFiles: [
        {
          classifier: 'typescript',
          durationMilliseconds: 1_250,
          extension: '.ts',
          factsBytes: 2_048,
          language: 'typescript',
          relations: 7,
          role: 'source',
          sizeBucket: '0-16KiB',
          sourceBytes: 4_096,
          symbols: 3,
        },
      ],
    });
    expect(status.extraction?.topSlowFiles[0]?.pathHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(status)).not.toContain(secretPath);
  });

  it('keeps cumulative resolution activity anchored to the phase across alias passes', async () => {
    const home = await mkdtemp('threadnote-graph-resolution-phase-time-');
    homes.push(home);
    const observations = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: resolutionActivity({pass: 1, referencesCompleted: 5_000, referencesExamined: 5_000}),
          phase: 'resolving',
          subphase: 'references',
        });
        const first = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        yield* Effect.sleep(10);
        yield* reporter.progress({
          activity: resolutionActivity({pass: 2, referencesCompleted: 5_000, referencesExamined: 15_000}),
          phase: 'resolving',
          subphase: 'references',
        });
        const second = (yield* readCodeGraphBuildStatuses(layout))[0]!;
        return {first, second};
      }),
    );

    expect(observations.second.resolution?.activity.pass).toBe(2);
    expect(observations.second.resolution?.activity.startedAt).toBe(observations.first.resolution?.activity.startedAt);
    expect(observations.second.timestamps.phaseStartedAt).toBe(observations.first.timestamps.phaseStartedAt);
  });

  it('persists privacy-safe materialization substages, row totals, timings, and TEMP database high-water', async () => {
    const home = await mkdtemp('threadnote-graph-build-materialization-progress-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        const metrics = (completed: number) => ({
          attributionMilliseconds: completed * 3,
          batchesCompleted: completed,
          batchesTotal: 10,
          cachedFactBytesCompleted: completed * 40_000,
          cachedFactBytesTotal: 400_000,
          factsBytesCompleted: completed * 50_000,
          factsBytesTotal: 500_000,
          loadingMilliseconds: completed * 2,
          rows: {
            deduplicatedEdges: completed * 5,
            deduplicatedReferences: completed * 3,
            edges: completed * 700,
            lookupKeys: completed * 300,
            referenceCandidates: completed * 500,
            references: completed * 100,
            symbols: completed * 200,
            terms: completed * 1_100,
          },
          sourceBytesCompleted: completed * 10_000,
          sourceBytesTotal: 100_000,
          storage: {
            availableBytes: 2_000_000,
            estimateBasis: 'final-fact-bytes' as const,
            estimatedConcurrentBuildBytes: 500_000,
            estimatedDurableSnapshotBytes: 200_000,
            estimatedJournalBytes: 100_000,
            estimatedRequiredBytes: 1_000_000,
            estimatedTemporaryDatabaseBytes: 200_000,
            temporaryDatabaseBytes: completed * 20_000,
            temporaryDatabaseHighWaterBytes: completed * 25_000,
          },
          transactionMilliseconds: completed * 10,
        });
        yield* reporter.progress({
          activity: {
            batchCompleted: 0,
            batchTotal: 10,
            sourceBytes: 10_000,
            stage: 'loading-cache',
          },
          completed: 0,
          metrics: metrics(0),
          phase: 'materializing',
          reused: 90,
          total: 10,
          unit: 'files',
        });
        for (let completed = 1; completed <= 5; completed += 1) {
          yield* Effect.sleep(20);
          yield* reporter.progress({
            activity: {
              batchCompleted: completed,
              batchTotal: 10,
              cachedFactBytes: 40_000,
              elapsedMilliseconds: 20,
              factsBytes: 50_000,
              rows: {
                deduplicatedEdges: 5,
                deduplicatedReferences: 3,
                edges: 700,
                lookupKeys: 300,
                referenceCandidates: 500,
                references: 100,
                symbols: 200,
                terms: 1_100,
              },
              sourceBytes: 10_000,
              stage: 'committing',
              transactionMilliseconds: 10,
            },
            completed,
            metrics: metrics(completed),
            phase: 'materializing',
            reused: 90,
            total: 10,
            unit: 'files',
          });
          if (completed < 5) {
            yield* reporter.progress({
              activity: {
                batchCompleted: completed,
                batchTotal: 10,
                sourceBytes: 10_000,
                stage: 'loading-cache',
              },
              completed,
              metrics: metrics(completed),
              phase: 'materializing',
              reused: 90,
              total: 10,
              unit: 'files',
            });
          }
        }
        return (yield* readCodeGraphBuildStatuses(layout))[0]!;
      }),
    );

    expect(status).toMatchObject({
      counters: {completed: 5, reused: 90, total: 10},
      materialization: {
        activity: {
          batchCompleted: 5,
          batchTotal: 10,
          cachedFactBytes: 40_000,
          factsBytes: 50_000,
          rows: {edges: 700, symbols: 200, terms: 1_100},
          stage: 'committing',
          transactionMilliseconds: 10,
        },
        metrics: {
          batchesCompleted: 5,
          batchesTotal: 10,
          cachedFactBytesCompleted: 200_000,
          cachedFactBytesTotal: 400_000,
          factsBytesCompleted: 250_000,
          factsBytesTotal: 500_000,
          rows: {
            deduplicatedEdges: 25,
            deduplicatedReferences: 15,
            edges: 3_500,
            symbols: 1_000,
            terms: 5_500,
          },
          sourceBytesCompleted: 50_000,
          sourceBytesTotal: 100_000,
          storage: {
            availableBytes: 2_000_000,
            estimateBasis: 'final-fact-bytes',
            estimatedConcurrentBuildBytes: 500_000,
            estimatedDurableSnapshotBytes: 200_000,
            estimatedJournalBytes: 100_000,
            estimatedRequiredBytes: 1_000_000,
            estimatedTemporaryDatabaseBytes: 200_000,
            temporaryDatabaseBytes: 100_000,
            temporaryDatabaseHighWaterBytes: 125_000,
          },
        },
      },
      phase: 'materializing',
      subphase: 'committing',
    });
    expect(status).not.toHaveProperty('eta');
    expect(Date.parse(status.materialization!.activity!.startedAt)).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('persists the active durable-snapshot activation substage without repository data', async () => {
    const home = await mkdtemp('threadnote-graph-build-activation-progress-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: {
            elapsedMilliseconds: 500,
            rows: 4_200,
            stage: 'copying-symbols',
            stageElapsedMilliseconds: 0,
            state: 'started',
          },
          phase: 'activating',
          snapshotId: 'cgsn_activation-progress',
        });
        yield* reporter.progress({
          activity: {
            elapsedMilliseconds: 1_250,
            rows: 42_000,
            stage: 'copying-terms',
            stageElapsedMilliseconds: 750,
            state: 'completed',
            transactionMilliseconds: 125,
          },
          phase: 'activating',
          snapshotId: 'cgsn_activation-progress',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0]!;
      }),
    );

    expect(status).toMatchObject({
      activation: {
        activity: {
          elapsedMilliseconds: 1_250,
          rows: 42_000,
          stage: 'copying-terms',
          stageElapsedMilliseconds: 750,
          state: 'completed',
          transactionMilliseconds: 125,
        },
      },
      phase: 'activating',
      subphase: 'copying-terms',
    });
    expect(Date.parse(status.activation!.activity.startedAt)).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(home);
  });

  it('validates owner start identity before trusting a live PID and detects stale heartbeats', async () => {
    const home = await mkdtemp('threadnote-graph-build-owner-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'waiting'});
        return (yield* readCodeGraphBuildStatuses(layout))[0]!;
      }),
    );
    const now = Date.parse(status.timestamps.heartbeatAt);

    expect(
      observeCodeGraphBuildStatus(status, {
        isRunning: true,
        nowMilliseconds: now,
        processStartIdentity: `${status.owner.processStartIdentity ?? 'known'}-replacement`,
      }).observation,
    ).toMatchObject({liveness: 'abandoned', reason: 'pid-reused'});

    expect(
      observeCodeGraphBuildStatus(status, {
        isRunning: true,
        nowMilliseconds: now + CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS + 1,
        processStartIdentity: status.owner.processStartIdentity,
      }).observation,
    ).toMatchObject({liveness: 'stalled', reason: 'heartbeat-stale'});

    expect(
      observeCodeGraphBuildStatus(status, {
        isRunning: false,
        nowMilliseconds: now,
      }).observation,
    ).toMatchObject({liveness: 'abandoned', reason: 'owner-exited'});
  });

  it('keeps a lock-verified CPU-bound owner authoritative while counting live waiters separately', async () => {
    const home = await mkdtemp('threadnote-graph-build-selection-');
    homes.push(home);
    const statuses = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const running = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* running.progress({
          completed: 12,
          phase: 'scanning',
          accepted: 12,
          excluded: 0,
          skipped: 0,
          total: 100,
          unit: 'files',
        });
        const waiting = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* waiting.progress({phase: 'waiting'});
        return yield* readCodeGraphBuildStatuses(layout);
      }),
    );
    const running = statuses.find(status => status.state === 'running')!;
    const waiting = statuses.find(status => status.state === 'queued')!;
    const owner = {
      ...running,
      coordination: {lockVerified: true, role: 'owner' as const},
      observation: {
        heartbeatAgeMilliseconds: 60_000,
        liveness: 'stalled' as const,
        reason: 'heartbeat-stale' as const,
      },
    };
    const waiter = {
      ...waiting,
      coordination: {lockVerified: false, role: 'waiter' as const},
      observation: {heartbeatAgeMilliseconds: 10, liveness: 'active' as const},
    };

    const selected = selectCodeGraphBuildStatuses([waiter, owner]);

    expect(selected.builds).toEqual([owner]);
    expect(selected.waiters).toEqual([waiter]);

    const completed = {
      ...owner,
      coordination: {lockVerified: false, role: 'history' as const},
      observation: {heartbeatAgeMilliseconds: 1_000, liveness: 'completed' as const},
      state: 'completed' as const,
    };
    const abandoned = {
      ...owner,
      coordination: {lockVerified: false, role: 'history' as const},
      observation: {
        heartbeatAgeMilliseconds: 120_000,
        liveness: 'abandoned' as const,
        reason: 'owner-exited' as const,
      },
    };
    expect(selectCodeGraphBuildStatuses([abandoned, completed]).builds).toEqual([completed]);

    const otherCheckout = {
      ...owner,
      buildId: `${owner.buildId.slice(0, -1)}0`,
      identity: {...owner.identity, checkoutId: 'f'.repeat(64)},
    };
    expect(selectCodeGraphBuildStatuses([owner, otherCheckout]).builds).toHaveLength(2);
  });

  it('uses the validated lock lease to keep a progress-silent owner live', async () => {
    const home = await mkdtemp('threadnote-graph-build-lock-liveness-');
    homes.push(home);
    const owner = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({completed: 1, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
        const directory = path.join(layout.repositoryRoot, 'build-status', identity.worktreeId);
        const statusFile = (yield* fs.readDirectory(directory)).find(name => name.endsWith('.json'))!;
        const statusPath = path.join(directory, statusFile);
        const status = JSON.parse(yield* fs.readFileString(statusPath)) as {
          timestamps: Record<string, string>;
        };
        const stale = new Date(Date.now() - CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS - 5_000).toISOString();
        yield* fs.writeFileString(
          statusPath,
          `${JSON.stringify({...status, timestamps: {...status.timestamps, heartbeatAt: stale}})}\n`,
        );
        return yield* withExclusiveFileLock(
          fs,
          layout.lockPath,
          {
            retryIntervalMilliseconds: 5,
            staleAfterMilliseconds: 1_000,
            waitTimeoutMilliseconds: 1_000,
          },
          Effect.map(readCodeGraphBuildStatuses(layout), statuses => statuses[0]!),
        );
      }),
    );

    expect(owner.coordination).toEqual({lockVerified: true, progressSilent: true, role: 'owner'});
    expect(owner.observation).toMatchObject({liveness: 'active'});
  });

  it('retains a bounded privacy-safe terminal result without source paths', async () => {
    const home = await mkdtemp('threadnote-graph-build-terminal-');
    homes.push(home);
    const result = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const completed = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* completed.completeSnapshot(fixtureSnapshot(identity));
        const failed = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* failed.fail(new TestError(`Could not read ${home}/private/source.ts while indexing`));
        return yield* readCodeGraphBuildStatuses(layout);
      }),
    );

    expect(result.find(status => status.state === 'completed')).toMatchObject({
      observation: {liveness: 'completed'},
      result: {edges: 34, files: 12, symbols: 56},
    });
    const failure = result.find(status => status.state === 'failed');
    expect(failure?.observation.liveness).toBe('failed');
    expect(failure?.error?.summary).toContain('<local-path>');
    expect(failure?.error?.summary).not.toContain(home);
    expect(failure?.error?.summary.length).toBeLessThanOrEqual(300);
  });

  it('serves graph status JSON from the sidecar without creating or opening the graph database', async () => {
    const home = await mkdtemp('threadnote-graph-status-command-');
    homes.push(home);
    const repository = join(home, 'repository');
    await mkdir(repository, {recursive: true});
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    runGit(repository, ['init', '--quiet']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Threadnote Test']);
    runGit(repository, ['add', 'source.ts']);
    runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const identity = yield* resolveRepositoryIdentity(repository);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const idleOutput = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: {
            batchCompleted: 3,
            batchTotal: 10,
            cachedFactBytes: 6_000,
            rows: {edges: 30, symbols: 20},
            sourceBytes: 4_000,
            stage: 'writing-facts',
          },
          completed: 3,
          metrics: {
            batchesCompleted: 3,
            batchesTotal: 10,
            fallbackReason: 'file-set-changed',
            mode: 'full',
            rows: {edges: 90, symbols: 60},
            sourceBytesCompleted: 12_000,
            sourceBytesTotal: 40_000,
            storage: {
              availableBytes: 100_000,
              durableAvailableBytes: 100_000,
              durableDatabaseBytes: 48_000,
              durableDatabaseFileBytes: 48_000,
              durableDatabaseFileHighWaterBytes: 56_000,
              durableDatabaseGrowthBytes: 8_000,
              durableDatabaseGrowthHighWaterBytes: 16_000,
              durableDatabaseHighWaterBytes: 64_000,
              durableDatabaseStartBytes: 40_000,
              durableFilesystemBytes: 70_000,
              durableFilesystemHighWaterBytes: 90_000,
              durableJournalBytes: 2_000,
              durableJournalHighWaterBytes: 10_000,
              durableSharedMemoryBytes: 1_000,
              durableSharedMemoryHighWaterBytes: 4_000,
              durableWalBytes: 19_000,
              durableWalHighWaterBytes: 25_000,
              estimatedDurableFilesystemRequiredBytes: 200_000,
              estimatedRequiredBytes: 500_000,
              estimatedTemporaryFilesystemRequiredBytes: 300_000,
              filesystemsShared: true,
              materializationMode: 'direct-persistent',
              temporaryAvailableBytes: 100_000,
              temporaryDatabaseBytes: 24_000,
              temporaryDatabaseHighWaterBytes: 32_000,
            },
          },
          phase: 'materializing',
          reused: 2,
          total: 10,
          unit: 'files',
        });
        yield* fs.writeFileString(path.join(layout.repositoryRoot, 'graph-v2.sqlite'), 'obsolete graph\n');
        yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const startedAt = Date.now();
        const output = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const human = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}));
        return {
          databasePath: layout.databasePath,
          elapsedMilliseconds: Date.now() - startedAt,
          human: human.output,
          idleOutput: idleOutput.output.trim(),
          output: output.output.trim(),
        };
      }),
    );

    expect(existsSync(result.databasePath)).toBe(false);
    expect(result.elapsedMilliseconds).toBeLessThan(2_000);
    const status = JSON.parse(result.output) as Record<string, unknown>;
    expect(status).toMatchObject({
      build: {
        counters: {completed: 3, reused: 2, total: 10},
        materialization: {metrics: {fallbackReason: 'file-set-changed', mode: 'full'}},
        state: 'running',
      },
      obsoleteStores: {bytes: 15, fileCount: 1, unsafeEntryCount: 0},
      type: 'code-graph-status',
      version: 2,
    });
    const idleStatus = JSON.parse(result.idleOutput) as Record<string, unknown>;
    expect(idleStatus).toMatchObject({build: null, builds: [], type: 'code-graph-status', version: 2});
    expect(Object.keys(idleStatus).sort()).toEqual(Object.keys(status).sort());
    expect(result.human).toContain('Current activity: writing graph facts');
    expect(result.human).toContain('full materialization');
    expect(result.human).toContain('incremental fallback: file set changed');
    expect(result.human).toContain('23.4 KiB current TEMP database');
    expect(result.human).toContain('31.3 KiB TEMP database high-water');
    expect(result.human).toContain('46.9 KiB allocated durable pages');
    expect(result.human).toContain('62.5 KiB allocated-page high-water');
    expect(result.human).toContain('15.6 KiB main-database growth');
    expect(result.human).toContain('87.9 KiB DB + sidecars high-water');
    expect(result.human).toContain('24.4 KiB WAL high-water');
    expect(result.human).toContain('9.77 KiB rollback-journal high-water');
    expect(result.human).toContain('direct persistent materialization');
    expect(result.human).toContain('488 KiB combined estimate');
    expect(result.human).toContain('rollback journals excluded from TEMP totals');
    expect(result.human).toContain(
      'Warning: low disk: 97.7 KiB available is below the 488 KiB conservative combined estimate',
    );
    expect(result.human).toContain('indexing continues with live telemetry');
  });

  it('does not let another worktree sidecar hide the current ready snapshot', async () => {
    const home = await mkdtemp('threadnote-graph-status-ready-');
    homes.push(home);
    const repository = join(home, 'repository');
    await mkdir(repository, {recursive: true});
    await writeFile(join(repository, 'source.ts'), 'export const readyValue = 1;\n');
    runGit(repository, ['init', '--quiet']);
    runGit(repository, ['config', 'user.email', 'test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Threadnote Test']);
    runGit(repository, ['add', 'source.ts']);
    runGit(repository, ['commit', '--quiet', '-m', 'fixture']);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };

    const output = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const indexer = yield* CodeGraphIndexer;
        const summary = yield* indexer.index({cwd: repository, threadnoteHome: home});
        const currentLayout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
        yield* fs.remove(path.join(currentLayout.repositoryRoot, 'build-status', summary.identity.worktreeId), {
          force: true,
          recursive: true,
        });
        const otherIdentity = {...summary.identity, worktreeId: 'e'.repeat(64)};
        const otherLayout = codeGraphLayout(path, home, otherIdentity.checkoutId, otherIdentity.worktreeId);
        const other = yield* makeCodeGraphBuildReporter(otherIdentity, otherLayout);
        yield* other.completeSnapshot({...summary.snapshot, worktreeId: otherIdentity.worktreeId});
        return {
          human: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository}))).output,
          json: (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}))).output.trim(),
        };
      }),
    );
    const status = JSON.parse(output.json) as {
      readonly build?: unknown;
      readonly builds: readonly {readonly identity: {readonly worktreeId: string}}[];
      readonly readySnapshot?: {readonly id: string};
      readonly stale: boolean;
    };

    expect(status.build).toBeNull();
    expect(status.builds).toEqual([
      expect.objectContaining({identity: expect.objectContaining({worktreeId: 'e'.repeat(64)})}),
    ]);
    expect(status.readySnapshot?.id).toMatch(/^cgsn_/);
    expect(status.stale).toBe(false);
    expect(output.human).toContain('Ready snapshot: cgsn_');
  });
});

function resolutionActivity(
  overrides: Pick<CodeGraphResolutionActivity, 'pass' | 'referencesCompleted' | 'referencesExamined'>,
): CodeGraphResolutionActivity {
  return {
    aliasesDiscovered: 2,
    elapsedMilliseconds: overrides.referencesExamined,
    matchingMilliseconds: 100,
    pageCompleted: 1,
    pageTotal: 2,
    pagesCompleted: overrides.referencesExamined / 5_000,
    referencesTotal: 10_000,
    resolved: 3,
    transactionMilliseconds: 50,
    ...overrides,
  };
}

function fixtureIdentity(home: string): RepositoryIdentity {
  return {
    branch: 'feature/manager-labels',
    caseMode: 'sensitive',
    checkoutId: 'a'.repeat(64),
    displayName: 'example/repository',
    gitCommonDirectory: `${home}/repository/.git`,
    headCommit: 'd'.repeat(40),
    objectFormat: 'sha1',
    remoteIdentity: 'example.invalid/repository',
    repoRoot: `${home}/repository`,
    repositoryId: 'b'.repeat(64),
    worktreeId: 'c'.repeat(64),
  };
}

function fixtureSnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: new Date().toISOString(),
    dirty: false,
    edgeCount: 34,
    extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
    fileCount: 12,
    id: 'cgsn_fixture',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 56,
    worktreeId: identity.worktreeId,
  };
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({cmd: ['git', '-C', cwd, ...args], stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) throw new TestError(result.stderr.toString());
}
