import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  makeCodeGraphBuildReporter,
  parseCodeGraphBuildStatus,
  readCodeGraphBuildStatuses,
  type CodeGraphBuildStatus,
} from '../../src/code_graph/build_status.js';
import {
  accumulateCodeGraphBuildScheduling,
  CODE_GRAPH_BUILD_PHASES,
  CODE_GRAPH_BUILD_WAIT_REASONS,
  parseCodeGraphBuildScheduling,
} from '../../src/code_graph/build_status_scheduling.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {
  CODE_GRAPH_STATUS_BUILD_SUMMARY_MAXIMUM_BYTES,
  projectCodeGraphStatusBuildSummaryV5,
} from '../../src/code_graph/status_projection.js';
import {CODE_GRAPH_EXTRACTOR_SET_VERSION, type RepositoryIdentity} from '../../src/code_graph/types.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const testLayer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

describe('bounded persisted build scheduling', () => {
  effectIt.effect('retains queue and cumulative phase/wait durations through completion and JSON projection', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-build-scheduling-'});
      const identity: RepositoryIdentity = {
        branch: 'main',
        caseMode: 'sensitive',
        checkoutId: 'a'.repeat(64),
        displayName: 'fixture',
        gitCommonDirectory: path.join(home, '.git'),
        headCommit: 'd'.repeat(40),
        objectFormat: 'sha1',
        remoteIdentity: 'fixture',
        repoRoot: home,
        repositoryId: 'b'.repeat(64),
        worktreeId: 'c'.repeat(64),
      };
      const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
      const reporter = yield* makeCodeGraphBuildReporter(identity, layout);
      const enqueuedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* reporter.admission({admissionClass: 'background', enqueuedAt, position: 3, size: 4});
      yield* reporter.progress({phase: 'waiting', reason: 'home-builder-cap'});
      yield* TestClock.adjust(120);
      yield* reporter.admission();
      yield* reporter.progress({phase: 'registering'});
      yield* TestClock.adjust(30);
      yield* reporter.progress({phase: 'waiting', reason: 'database-writer'});
      yield* TestClock.adjust(70);
      yield* reporter.progress({
        phase: 'scanning',
        accepted: 0,
        completed: 0,
        excluded: 0,
        skipped: 0,
        total: 1,
        unit: 'files',
      });
      yield* TestClock.adjust(50);
      yield* reporter.progress({phase: 'waiting', reason: 'database-writer'});
      yield* TestClock.adjust(20);
      yield* reporter.progress({
        phase: 'scanning',
        accepted: 1,
        completed: 1,
        excluded: 0,
        skipped: 0,
        total: 1,
        unit: 'files',
      });
      yield* TestClock.adjust(10);
      yield* reporter.completeSnapshot({
        commit: identity.headCommit,
        completedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        dirty: false,
        edgeCount: 2,
        extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
        fileCount: 1,
        id: `cgsn_${'f'.repeat(40)}`,
        repositoryId: identity.repositoryId,
        state: 'ready',
        symbolCount: 3,
        worktreeId: identity.worktreeId,
      });
      const [status] = yield* readCodeGraphBuildStatuses(layout);
      expect(status?.scheduling).toEqual({
        admittedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(enqueuedAt) + 120)),
        queue: {admissionClass: 'background', enqueuedAt, position: 3, size: 4},
        phaseMilliseconds: {registering: 30, scanning: 60, waiting: 210},
        waitMilliseconds: {'database-writer': 90, 'home-builder-cap': 120},
      });
      expect(projectCodeGraphStatusBuildSummaryV5(status).scheduling).toEqual(status.scheduling);
      expect(parseCodeGraphBuildStatus({...status, scheduling: undefined})?.scheduling).toBeUndefined();
      expect(parseCodeGraphBuildStatus({...status, scheduling: {phaseMilliseconds: {privatePath: 1}}})).toBeUndefined();
      const maximal = {
        ...status,
        scheduling: {
          ...status.scheduling,
          phaseMilliseconds: Object.fromEntries(CODE_GRAPH_BUILD_PHASES.map(phase => [phase, Number.MAX_SAFE_INTEGER])),
          waitMilliseconds: Object.fromEntries(
            CODE_GRAPH_BUILD_WAIT_REASONS.map(reason => [reason, Number.MAX_SAFE_INTEGER]),
          ),
        },
      };
      expect(
        new TextEncoder().encode(JSON.stringify(projectCodeGraphStatusBuildSummaryV5(maximal))).length,
      ).toBeLessThanOrEqual(CODE_GRAPH_STATUS_BUILD_SUMMARY_MAXIMUM_BYTES);
    }).pipe(provideTestLayer(testLayer)),
  );

  it('accumulates interval partitions equivalently and preserves unknown or terminal telemetry', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: 1_000_000}), {maxLength: 50}),
        fc.constantFrom(...CODE_GRAPH_BUILD_PHASES),
        (intervals, phase) => {
          const initial: Pick<CodeGraphBuildStatus, 'phase' | 'scheduling' | 'state'> = {
            phase,
            scheduling: {phaseMilliseconds: {}, waitMilliseconds: {}},
            state: 'running',
          };
          let current = initial;
          for (const elapsed of intervals)
            current = {...current, scheduling: accumulateCodeGraphBuildScheduling(current, elapsed)};
          const total = intervals.reduce((sum, elapsed) => sum + elapsed, 0);
          if (intervals.length > 0)
            expect(current.scheduling).toEqual(accumulateCodeGraphBuildScheduling(initial, total));
          expect(accumulateCodeGraphBuildScheduling({...initial, scheduling: undefined}, total)).toBeUndefined();
          expect(accumulateCodeGraphBuildScheduling({...current, state: 'completed'}, total)).toEqual(
            current.scheduling,
          );
          expect(accumulateCodeGraphBuildScheduling({...current, state: 'failed'}, total)).toEqual(current.scheduling);
        },
      ),
      {numRuns: 150},
    );
  });

  it('accepts only bounded known numeric durations and queue positions', () => {
    for (const duration of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, '10'])
      expect(parseCodeGraphBuildScheduling({phaseMilliseconds: {waiting: duration}})).toBeUndefined();
    for (const position of [0, 3, 257])
      expect(
        parseCodeGraphBuildScheduling({
          queue: {admissionClass: 'background', enqueuedAt: '2026-09-17T12:00:00.000Z', position, size: 2},
        }),
      ).toBeUndefined();
    expect(parseCodeGraphBuildScheduling({waitMilliseconds: {'/private/source.ts': 10}})).toBeUndefined();
    expect(parseCodeGraphBuildScheduling({blocker: '/private/source.ts'})).toBeUndefined();
  });
});
