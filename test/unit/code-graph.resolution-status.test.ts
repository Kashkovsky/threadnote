import {Effect, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  makeCodeGraphBuildReporter,
  parseCodeGraphBuildStatus,
  readCodeGraphBuildStatuses,
} from '../../src/code_graph/build_status.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import type {CodeGraphResolutionActivity, RepositoryIdentity} from '../../src/code_graph/types.js';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('code graph reference-resolution status', () => {
  it('persists every completed page without the ordinary progress throttle hiding a worst-case page gap', async () => {
    const home = await mkdtemp('threadnote-resolution-status-');
    homes.push(home);
    const statuses = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({phase: 'resolving', subphase: 'references'});
        const persisted = [];
        for (const completed of [0, 500, 1_000, 1_201]) {
          const activity = resolutionActivity(completed);
          yield* reporter.progress({activity, phase: 'resolving', subphase: 'references'});
          persisted.push((yield* readCodeGraphBuildStatuses(layout))[0]!);
        }
        return persisted;
      }),
    );

    expect(statuses.map(status => status.counters.completed)).toEqual([0, 500, 1_000, 1_201]);
    expect(statuses.map(status => status.resolution?.activity.pageCompleted)).toEqual([0, 1, 2, 3]);
    expect(statuses.at(-1)).toMatchObject({
      counters: {completed: 1_201, resolved: 317, total: 1_201, unit: 'references'},
      phase: 'resolving',
      resolution: {
        activity: {
          aliasesDiscovered: 12,
          matchingMilliseconds: 700,
          pageCompleted: 3,
          pageTotal: 3,
          pagesCompleted: 3,
          pass: 1,
          referencesCompleted: 1_201,
          referencesExamined: 1_201,
          referencesTotal: 1_201,
          resolved: 317,
          transactionMilliseconds: 300,
        },
      },
      subphase: 'references',
    });
    expect(JSON.stringify(statuses)).not.toContain(home);
    expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(statuses.at(-1))))).toBeDefined();
    expect(
      parseCodeGraphBuildStatus({
        ...statuses.at(-1),
        resolution: {
          activity: {...statuses.at(-1)!.resolution!.activity, referencesCompleted: 1_202},
        },
      }),
    ).toBeUndefined();
  });

  it('clears completed resolution activity when activation begins', async () => {
    const home = await mkdtemp('threadnote-resolution-status-exit-');
    homes.push(home);
    const status = await runEffect(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const identity = fixtureIdentity(home);
        const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
        const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
        yield* reporter.progress({
          activity: resolutionActivity(500),
          phase: 'resolving',
          subphase: 'references',
        });
        yield* reporter.progress({
          activity: {
            elapsedMilliseconds: 0,
            stage: 'validating-input',
            stageElapsedMilliseconds: 0,
            state: 'started',
          },
          phase: 'activating',
          snapshotId: 'cgsn_resolution-exit',
        });
        return (yield* readCodeGraphBuildStatuses(layout))[0]!;
      }),
    );

    expect(status).toMatchObject({phase: 'activating', subphase: 'validating-input'});
    expect(status.resolution).toBeUndefined();
  });
});

function resolutionActivity(completed: number): CodeGraphResolutionActivity {
  const pageCompleted = completed === 0 ? 0 : completed <= 500 ? 1 : completed <= 1_000 ? 2 : 3;
  return {
    aliasesDiscovered: Math.min(12, pageCompleted * 4),
    elapsedMilliseconds: pageCompleted * 500,
    matchingMilliseconds: Math.min(700, pageCompleted * 240),
    pageCompleted,
    pageTotal: 3,
    pagesCompleted: pageCompleted,
    pass: 1,
    referencesCompleted: completed,
    referencesExamined: completed,
    referencesTotal: 1_201,
    resolved: Math.min(317, completed),
    transactionMilliseconds: pageCompleted * 100,
  };
}

function fixtureIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'b'.repeat(64),
    displayName: 'resolution-status-fixture',
    gitCommonDirectory: root,
    headCommit: 'c'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'd'.repeat(64),
    worktreeId: 'e'.repeat(64),
  };
}
