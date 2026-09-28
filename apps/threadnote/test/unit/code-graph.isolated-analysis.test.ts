import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor, type CommandResult} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {TestError} from '@threadnote/testing/test-error';
import {analyzeCodeGraphReadIsolated} from '@threadnote/graph/isolated/analysis';
import {provideTestLayer} from '../helpers/effect-layer.js';

const platform = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));
const layer = CommandExecutor.layer.pipe(Layer.provideMerge(platform));

function analysisWorkerFixture(directory: string, mode: 'busy-release' | 'elapsed-budget') {
  return `
    import {Effect} from ${JSON.stringify(import.meta.resolve('effect'))};
    import * as BunServices from ${JSON.stringify(import.meta.resolve('@effect/platform-bun/BunServices'))};
    import {CodeGraphAnalysis, analyzeCodeGraphWithLease} from ${JSON.stringify(import.meta.resolve('@threadnote/graph/analysis'))};
    import {CodeGraphIndexer} from ${JSON.stringify(import.meta.resolve('@threadnote/graph/indexer'))};
    import {codeGraphAnalysisWorkerProgram} from ${JSON.stringify(import.meta.resolve('@threadnote/graph/isolated/analysis'))};
    import {CodeGraphQueryService} from ${JSON.stringify(import.meta.resolve('@threadnote/graph/query'))};
    import {CodeGraphStoreBusyError} from ${JSON.stringify(import.meta.resolve('@threadnote/graph/types'))};
    import {analysisSnapshot, pagedAnalysisStore} from ${JSON.stringify(import.meta.resolve('@threadnote/graph/test/helpers/code-graph-analysis'))};
    const directory = ${JSON.stringify(directory)};
    const elapsed = ${mode === 'elapsed-budget'};
    const snapshot = {...analysisSnapshot([], []), symbolCount: elapsed ? 1_000_000_000 : 0};
    const status = {
      databasePath: directory + '/graph.sqlite', freshness: 'current', stale: false,
      readySnapshot: snapshot, languagePacks: [], identity: {
        caseMode: 'sensitive', checkoutId: 'checkout', displayName: 'fixture',
        gitCommonDirectory: directory + '/.git', headCommit: snapshot.commit, objectFormat: 'sha1',
        repoRoot: directory, repositoryId: snapshot.repositoryId, worktreeId: snapshot.worktreeId,
      },
    };
    const calls = {status: 0, release: 0, pages: 0};
    const store = {
      ...pagedAnalysisStore([], []),
      acquireSnapshotLease: () => Effect.succeed('lease-token'),
      withSession: (_path, effect) => effect,
      releaseSnapshotLease: () => Effect.gen(function* () {
        calls.release += 1;
        if (!elapsed) return yield* CodeGraphStoreBusyError.of('busy release');
        yield* Effect.sleep(50);
      }),
      ...(elapsed ? {loadAnalysisSymbolAggregatePage: (_path, _id, _cursor, limit) =>
        Effect.gen(function* () {
          yield* Effect.sleep(100);
          calls.pages += 1;
          return {rows: limit, lastId: String(calls.pages).padStart(12, '0'),
            counts: [{count: limit, kind: 'function', language: 'typescript'}]};
        })} : {}),
    };
    await Effect.runPromise(codeGraphAnalysisWorkerProgram(directory).pipe(
      Effect.provideService(CodeGraphAnalysis, {analyze: options => analyzeCodeGraphWithLease(store, options)}),
      Effect.provideService(CodeGraphQueryService, {status: () => Effect.gen(function* () {
        calls.status += 1;
        if (calls.status > 1) yield* Effect.sleep(50);
        return status;
      })}),
      Effect.provideService(CodeGraphIndexer, {index: () => Effect.die('unused')}),
      Effect.provide(BunServices.layer),
    ));
    await Bun.write(directory + '/lifecycle.json', JSON.stringify(calls));
  `;
}

describe('isolated analysis worker result finalization', () => {
  for (const mode of ['busy-release', 'elapsed-budget'] as const) {
    effectIt.effect(`preserves the analysis response after ${mode}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const command = yield* CommandExecutor;
        const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-finalization-'});
        const script = path.join(directory, 'worker.ts');
        yield* fs.writeFileString(script, analysisWorkerFixture(directory, mode));
        let output: CommandResult | undefined;
        const started = yield* Clock.currentTimeMillis;
        const deadlineMilliseconds = started + 4000;
        const read = yield* analyzeCodeGraphReadIsolated({
          cwd: directory,
          threadnoteHome: directory,
          freshness: 'current',
          operation: 'stats',
          deadlineMilliseconds,
        }).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            developmentEntrypoint: script,
            processArguments: [system.executablePath, 'test.ts'],
          }),
          Effect.provideService(CommandExecutor, {
            ...command,
            execute: (...args) =>
              command.execute(...args).pipe(Effect.tap(result => Effect.sync(() => (output = result)))),
          }),
        );
        expect(yield* Clock.currentTimeMillis).toBeLessThan(deadlineMilliseconds);
        if (read.state !== 'ready') return yield* TestError.make({message: `Analysis returned ${read.state}.`});
        expect(JSON.parse(output!.stdout)).toHaveProperty('ok', true);
        expect(JSON.parse(yield* fs.readFileString(path.join(directory, 'lifecycle.json')))).toMatchObject({
          release: 1,
          status: 2,
        });
        if (mode === 'busy-release') {
          expect(read.result.leaseCleanup).toMatchObject({state: 'expiry'});
          expect(output!.stderr).toContain('Code graph analysis lease cleanup deferred to bounded expiry.');
          expect(output!.stdout).not.toContain('Code graph analysis lease cleanup deferred');
        } else {
          expect(read.result.leaseCleanup).toMatchObject({state: 'released'});
          expect(read.result.coverage.complete).toBe(false);
          expect(read.result.coverage.aggregates.symbols.complete).toBe(false);
          expect(read.result.coverage.aggregates.symbols.rows).toBeGreaterThan(0);
          expect(read.result.coverage.aggregates.symbols.rows).toBeLessThan(read.result.budget.maxNodes);
        }
      }).pipe(TestClock.withLive, provideTestLayer(layer)),
    );
  }
});

describe('isolated analysis native cancellation', () => {
  for (const stop of ['deadline', 'interrupt'] as const) {
    effectIt.effect(`reaps a child blocked in native synchronous work after ${stop}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-analysis-cancellation-'});
        const script = path.join(directory, 'blocked.ts');
        const marker = path.join(directory, 'child.pid');
        yield* fs.writeFileString(
          script,
          `
          const input = JSON.parse(await Bun.stdin.text());
          await Bun.write(input.cwd + '/child.pid', String(process.pid));
          while (true) {}
        `,
        );
        const started = yield* Clock.currentTimeMillis;
        const fiber = yield* analyzeCodeGraphReadIsolated({
          cwd: directory,
          threadnoteHome: directory,
          freshness: 'allow-stale',
          operation: 'stats',
          deadlineMilliseconds: started + (stop === 'deadline' ? 1500 : 5000),
        }).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            developmentEntrypoint: script,
            processArguments: [system.executablePath, 'test.ts'],
          }),
          Effect.forkChild,
        );
        let pid: number | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (yield* fs.exists(marker)) {
            pid = Number(yield* fs.readFileString(marker));
            if (Number.isSafeInteger(pid) && pid > 0) break;
          }
          yield* Effect.sleep(10);
        }
        if (pid === undefined) return yield* TestError.make({message: 'Native worker did not signal readiness.'});
        if (stop === 'interrupt') yield* Fiber.interrupt(fiber);
        else expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toHaveProperty('_tag', 'CodeGraphAnalysisReadTimedOut');
        expect(system.isProcessRunning(pid)).toBe(false);
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(3500);
      }).pipe(TestClock.withLive, provideTestLayer(layer)),
    );
  }
});
