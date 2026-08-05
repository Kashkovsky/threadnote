import {afterEach, describe, expect, it} from 'vitest';
import {Effect} from 'effect';
import {
  inspectAllCodeGraphs,
  renderCodeGraphDiagnostics,
  type CodeGraphDiagnosticsReport,
} from '../../src/code_graph/diagnostics.js';
import {runCodeGraphDiagnostics} from '../../src/code_graph/commands.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '../../src/code_graph/types.js';
import {captureConsole} from '../../src/effect/console.js';
import type {RuntimeConfig} from '../../src/types.js';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('all-code-graph diagnostics', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('reports every database without a repository cwd and keeps JSON privacy-safe', async () => {
    const home = await mkdtemp('threadnote-graph-diagnostics-');
    homes.push(home);
    const healthyCheckoutId = '1'.repeat(64);
    const unreadableCheckoutId = '2'.repeat(64);
    const healthyRoot = join(home, 'indexes', 'code-graph', 'repositories', healthyCheckoutId);
    const healthyDatabase = join(healthyRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    const unreadableRoot = join(home, 'indexes', 'code-graph', 'repositories', unreadableCheckoutId);
    const unreadableDatabase = join(unreadableRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    const identity = repositoryIdentity(home, healthyCheckoutId);
    const snapshot = readySnapshot(identity);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(healthyDatabase, identity, snapshot, [], [], []);
      }),
    );
    await writeFile(join(healthyRoot, 'graph-v2.sqlite'), 'obsolete graph\n');
    await mkdir(unreadableRoot, {recursive: true});
    await writeFile(unreadableDatabase, 'not a sqlite database');

    const report = await runEffect(inspectAllCodeGraphs(home, {analyze: true}));
    expect(report.summary).toMatchObject({
      databaseCount: 2,
      healthyDatabaseCount: 1,
      readySnapshotCount: 1,
      unreadableDatabaseCount: 1,
      viewCount: 1,
    });
    expect(report.obsoleteStores).toMatchObject({fileCount: 1, unsafeEntryCount: 0});
    expect(report.databases.find(database => database.checkoutId === healthyCheckoutId)).toMatchObject({
      health: {integrity: 'ok', readySnapshots: 1},
      healthState: 'checked',
      views: [
        {
          analysis: {
            coverage: {complete: true, topology: {state: 'complete'}},
            statistics: {snapshotEdgeCount: 0, snapshotNodeCount: 0},
          },
          repository: {displayName: 'acme/diagnostics'},
          snapshot: {id: snapshot.id},
        },
      ],
    });
    const unreadable = report.databases.find(database => database.checkoutId === unreadableCheckoutId);
    expect(unreadable?.healthState).toBe('unreadable');
    expect(unreadable?.issues.map(issue => issue.code)).toContain('health-check-failed');
    expect(JSON.stringify(report)).not.toContain(home);
    expect(renderCodeGraphDiagnostics(report)).toContain('Native code graph diagnostics');

    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: join(home, 'manifest.yaml'),
      user: 'tester',
    };
    const output = await runEffect(captureConsole(runCodeGraphDiagnostics(config, {analyze: true, json: true})));
    const commandReport = JSON.parse(output.output) as CodeGraphDiagnosticsReport;
    expect(commandReport).toMatchObject({
      mode: {analyze: true, deep: false},
      summary: {analysisCompleteCount: 1, databaseCount: 2},
      type: 'code-graph-diagnostics',
      version: 1,
    });
    expect(commandReport.databases.find(database => database.checkoutId === healthyCheckoutId)).toMatchObject({
      views: [{analysis: {coverage: {complete: true, topology: {state: 'complete'}}}}],
    });
  });
});

function repositoryIdentity(root: string, checkoutId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'acme/diagnostics',
    gitCommonDirectory: join(root, '.git'),
    headCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: '3'.repeat(64),
    worktreeId: '4'.repeat(64),
  };
}

function readySnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-08-05T08:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: 'diagnostics-test',
    fileCount: 0,
    id: 'cgsn_diagnostics',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}
