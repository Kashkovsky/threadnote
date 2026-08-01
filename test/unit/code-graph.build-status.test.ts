import {existsSync} from 'node:fs';
import {Effect, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS,
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  calibratedCodeGraphEtaConfidence,
  makeCodeGraphBuildReporter,
  observeCodeGraphBuildStatus,
  readCodeGraphBuildStatuses,
  selectCodeGraphBuildStatuses,
} from '../../src/code_graph/build_status.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {runCodeGraphStatus} from '../../src/code_graph/commands.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {captureConsole} from '../../src/effect/console.js';
import {withExclusiveFileLock} from '../../src/effect/file_lock.js';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
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
      intervalSamplesMilliseconds: Array.from({length: 8}, () => 1_000),
      rateForecastErrorSamples: Array.from({length: 7}, () => 0.05),
      rateSamples: [1, 1.02, 0.99, 1.01, 1, 0.98, 1.02, 1],
      realizedCompletionErrorSamples: Array.from({length: 6}, () => 0.08),
      silenceMilliseconds: 1_000,
    };
    expect(calibratedCodeGraphEtaConfidence(stable)).toBe('high');
    expect(
      calibratedCodeGraphEtaConfidence({
        ...stable,
        rateForecastErrorSamples: [0.9, 0.1, 0.8, 0.2, 0.95, 0.05, 0.7],
        rateSamples: [0.1, 2, 0.2, 3, 0.1, 2.5, 0.3, 4],
        realizedCompletionErrorSamples: [0.9, 0.8, 0.95, 0.7],
      }),
    ).toBe('low');
    expect(calibratedCodeGraphEtaConfidence({...stable, silenceMilliseconds: 60_000})).toBe('low');
    expect(calibratedCodeGraphEtaConfidence({...stable, rateSamples: stable.rateSamples.slice(0, 2)})).toBeUndefined();
  });

  it('withholds high ETA confidence until a reporter observes accurate phase completion forecasts', async () => {
    const confidenceFor = async (delays: readonly number[]) => {
      const home = await mkdtemp('threadnote-graph-eta-reporter-');
      homes.push(home);
      return runEffect(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const identity = fixtureIdentity(home);
          const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
          const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
          yield* reporter.progress({completed: 0, phase: 'materializing', reused: 0, total: 10, unit: 'files'});
          for (const [index, delay] of delays.entries()) {
            yield* Effect.sleep(delay);
            yield* reporter.progress({
              completed: index + 1,
              phase: 'materializing',
              reused: 0,
              total: 10,
              unit: 'files',
            });
          }
          return (yield* readCodeGraphBuildStatuses(layout))[0]?.eta?.confidence;
        }),
      );
    };

    expect(await confidenceFor(Array.from({length: 10}, () => 30))).toBe('high');
    expect(await confidenceFor([5, 90, 5, 100, 5, 80, 5, 110, 5, 90])).toBe('low');
  });

  it('keeps active owner and queued observer jobs separate and atomically readable', async () => {
    const home = await mkdtemp('threadnote-graph-build-status-');
    homes.push(home);
    const statuses = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const owner = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* owner.progress({completed: 8, phase: 'materializing', reused: 5, total: 20, unit: 'files'});
        const observer = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* observer.progress({phase: 'waiting'});
        return yield* readCodeGraphBuildStatuses(layout);
      }),
    );

    expect(statuses).toHaveLength(2);
    expect(new Set(statuses.map(status => status.buildId)).size).toBe(2);
    expect(statuses.every(status => status.observation.liveness === 'active')).toBe(true);
    expect(statuses.map(status => status.state).sort()).toEqual(['queued', 'running']);
    expect(statuses.find(status => status.state === 'running')?.counters).toMatchObject({
      completed: 8,
      reused: 5,
      total: 20,
      unit: 'files',
    });
    expect(JSON.stringify(statuses)).not.toContain(home);
  });

  it('throttles steady-state counter writes while persisting transitions immediately', async () => {
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
        return {afterInterval, afterPhaseTransition, afterThrottledCounter, afterTransition};
      }),
    );

    expect(observations.afterTransition).toMatchObject({
      counters: {completed: 1},
      phase: 'materializing',
    });
    expect(observations.afterThrottledCounter).toMatchObject({
      counters: {completed: 1},
      phase: 'materializing',
    });
    expect(observations.afterPhaseTransition).toMatchObject({
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
            language: 'typescript',
            parseMilliseconds: 12.5,
            path: secretPath,
            stage: 'extracting',
          },
          completed: 0,
          excluded: 2,
          phase: 'scanning',
          skipped: 0,
          timings: {
            extractionMilliseconds: 12.5,
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
    expect(JSON.stringify(status)).not.toContain(secretPath);
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
        const statusPath = path.join(directory, (yield* fs.readDirectory(directory))[0]!);
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
        yield* failed.fail(new Error(`Could not read ${home}/private/source.ts while indexing`));
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
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({completed: 3, phase: 'materializing', reused: 2, total: 10, unit: 'files'});
        yield* fs.writeFileString(path.join(layout.repositoryRoot, 'graph-v2.sqlite'), 'obsolete graph\n');
        yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        const startedAt = Date.now();
        const output = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        return {
          databasePath: layout.databasePath,
          elapsedMilliseconds: Date.now() - startedAt,
          output: output.output.trim(),
        };
      }),
    );

    expect(existsSync(result.databasePath)).toBe(false);
    expect(result.elapsedMilliseconds).toBeLessThan(2_000);
    const status = JSON.parse(result.output) as Record<string, unknown>;
    expect(status).toMatchObject({
      build: {counters: {completed: 3, reused: 2, total: 10}, state: 'running'},
      obsoleteStores: {bytes: 15, fileCount: 1, unsafeEntryCount: 0},
      type: 'code-graph-status',
      version: 2,
    });
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
        return (yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}))).output.trim();
      }),
    );
    const status = JSON.parse(output) as {
      readonly build?: unknown;
      readonly builds: readonly {readonly identity: {readonly worktreeId: string}}[];
      readonly readySnapshot?: {readonly id: string};
      readonly stale: boolean;
    };

    expect(status.build).toBeUndefined();
    expect(status.builds).toEqual([
      expect.objectContaining({identity: expect.objectContaining({worktreeId: 'e'.repeat(64)})}),
    ]);
    expect(status.readySnapshot?.id).toMatch(/^cgsn_/);
    expect(status.stale).toBe(false);
  });
});

function fixtureIdentity(home: string): RepositoryIdentity {
  return {
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
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
