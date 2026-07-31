import {existsSync} from 'node:fs';
import {Effect, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_BUILD_PROGRESS_WRITE_INTERVAL_MILLISECONDS,
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  makeCodeGraphBuildReporter,
  observeCodeGraphBuildStatus,
  readCodeGraphBuildStatuses,
} from '../../src/code_graph/build_status.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {runCodeGraphStatus} from '../../src/code_graph/commands.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {captureConsole} from '../../src/effect/console.js';
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
        const output = yield* captureConsole(runCodeGraphStatus(config, {cwd: repository, json: true}));
        return {databasePath: layout.databasePath, output: output.output.trim()};
      }),
    );

    expect(existsSync(result.databasePath)).toBe(false);
    const status = JSON.parse(result.output) as Record<string, unknown>;
    expect(status).toMatchObject({
      build: {counters: {completed: 3, reused: 2, total: 10}, state: 'running'},
      obsoleteStores: {bytes: 15, fileCount: 1, unsafeEntryCount: 0},
      type: 'code-graph-status',
      version: 2,
    });
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
