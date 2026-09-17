import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT} from '../../src/code_graph/build_resources.js';
import {codeGraphPreparedSpoolBudgetRoot} from '../../src/code_graph/layout.js';
import {withCodeGraphPreparedSpoolBudget} from '../../src/code_graph/prepared_spool_budget.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const testLayer = SystemInfo.layer.pipe(Layer.provideMerge(BunServices.layer));

describe('prepared spool budget process boundary', () => {
  effectIt.effect('ignores a killed pre-rename writer temporary sibling outside the closed ledger', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-prepared-spool-budget-temp-'});
      const root = codeGraphPreparedSpoolBudgetRoot(path, home);
      yield* fs.makeDirectory(path.dirname(root), {recursive: true});
      yield* fs.writeFileString(`${root}.pending`, 'partial');
      let admitted = false;
      yield* withCodeGraphPreparedSpoolBudget(
        {
          bytes: 1,
          checkoutId: 'a'.repeat(64),
          snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
          threadnoteHome: home,
        },
        Effect.sync(() => {
          admitted = true;
        }),
      );
      expect(admitted).toBe(true);
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }).pipe(provideTestLayer(testLayer)),
  );

  effectIt.effect(
    'drains for the oldest blocked reservation before admitting a later small spool',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-prepared-spool-budget-fifo-'});
          const events = yield* Ref.make<string[]>([]);
          const activeStarted = yield* Deferred.make<void>();
          const releaseActive = yield* Deferred.make<void>();
          const releaseOlder = yield* Deferred.make<void>();
          const active = yield* withCodeGraphPreparedSpoolBudget(
            {
              bytes: 20 * 1_024 * 1_024 * 1_024,
              checkoutId: 'a'.repeat(64),
              snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
              threadnoteHome: home,
            },
            Ref.update(events, values => [...values, 'active']).pipe(
              Effect.andThen(Deferred.succeed(activeStarted, undefined)),
              Effect.andThen(Deferred.await(releaseActive)),
            ),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(activeStarted);
          const older = yield* withCodeGraphPreparedSpoolBudget(
            {
              bytes: 20 * 1_024 * 1_024 * 1_024,
              checkoutId: 'c'.repeat(64),
              snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
              threadnoteHome: home,
            },
            Ref.update(events, values => [...values, 'older']).pipe(Effect.andThen(Deferred.await(releaseOlder))),
          ).pipe(Effect.forkChild);
          yield* Effect.sleep(10);
          const later = yield* withCodeGraphPreparedSpoolBudget(
            {
              bytes: 1,
              checkoutId: 'e'.repeat(64),
              snapshotId: `cgsn_${'f'.repeat(40)}-direct`,
              threadnoteHome: home,
            },
            Ref.update(events, values => [...values, 'later']),
          ).pipe(Effect.forkChild);
          yield* Effect.sleep(100);
          expect(yield* Ref.get(events)).toEqual(['active']);
          yield* Deferred.succeed(releaseActive, undefined);
          while (!(yield* Ref.get(events)).includes('older')) yield* Effect.sleep(10);
          expect((yield* Ref.get(events))[1]).toBe('older');
          yield* Deferred.succeed(releaseOlder, undefined);
          yield* Fiber.join(active);
          yield* Fiber.join(older);
          yield* Fiber.join(later);
          expect(yield* Ref.get(events)).toEqual(['active', 'older', 'later']);
        }).pipe(provideTestLayer(testLayer)),
      ),
    {timeout: 30_000},
  );

  effectIt.effect('rejects non-canonical and symbolic receipt metadata without following it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-prepared-spool-budget-metadata-'});
      const root = codeGraphPreparedSpoolBudgetRoot(path, home);
      yield* fs.makeDirectory(root, {recursive: true});
      const token = 'e'.repeat(64);
      const receiptPath = path.join(root, `v1-${token}.json`);
      const forged = JSON.stringify({
        bytes: 1,
        checkoutId: 'a'.repeat(64),
        processId: process.pid,
        snapshotId: `cgsn_${'b'.repeat(40)}-direct`,
        token,
        privatePath: '/private/source.ts',
        version: 1,
      });
      yield* fs.writeFileString(receiptPath, forged);
      const options = {
        bytes: 1,
        checkoutId: 'c'.repeat(64),
        snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
        threadnoteHome: home,
      } as const;
      expect((yield* Effect.exit(withCodeGraphPreparedSpoolBudget(options, Effect.void)))._tag).toBe('Failure');
      yield* fs.remove(receiptPath);
      const outside = path.join(home, 'outside.json');
      yield* fs.writeFileString(outside, forged);
      yield* fs.symlink(outside, receiptPath);
      expect((yield* Effect.exit(withCodeGraphPreparedSpoolBudget(options, Effect.void)))._tag).toBe('Failure');
    }).pipe(provideTestLayer(testLayer)),
  );

  effectIt.effect(
    'recovers a killed exclusive oversized reservation before admitting its successor',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-prepared-spool-budget-'});
          const moduleUrl = new URL('../../src/code_graph/prepared_spool_budget.ts', import.meta.url).href;
          const systemUrl = new URL('../../src/effect/system.ts', import.meta.url).href;
          const started = path.join(home, 'started');
          const child = Bun.spawn({
            cmd: [
              process.execPath,
              '--eval',
              `
                import {Effect, FileSystem, Layer} from 'effect';
                import * as BunServices from '@effect/platform-bun/BunServices';
                import * as BunRuntime from '@effect/platform-bun/BunRuntime';
                import {withCodeGraphPreparedSpoolBudget} from ${JSON.stringify(moduleUrl)};
                import {SystemInfo} from ${JSON.stringify(systemUrl)};
                BunRuntime.runMain(withCodeGraphPreparedSpoolBudget({
                  bytes: ${CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT + 1},
                  checkoutId: ${JSON.stringify('a'.repeat(64))},
                  snapshotId: ${JSON.stringify(`cgsn_${'b'.repeat(40)}-direct`)},
                  threadnoteHome: ${JSON.stringify(home)},
                }, Effect.gen(function* () {
                  const fs = yield* FileSystem.FileSystem;
                  yield* fs.writeFileString(${JSON.stringify(started)}, '');
                  return yield* Effect.never;
                })).pipe(Effect.provide(Layer.merge(SystemInfo.layer, BunServices.layer))));
              `,
            ],
            stderr: 'inherit',
            stdout: 'ignore',
          });
          while (!(yield* fs.exists(started))) yield* Effect.sleep(10);
          const root = codeGraphPreparedSpoolBudgetRoot(path, home);
          expect(yield* fs.readDirectory(root)).toHaveLength(1);
          const queued = path.join(home, 'queued');
          const admitted = path.join(home, 'admitted');
          const successor = yield* withCodeGraphPreparedSpoolBudget(
            {
              bytes: CODE_GRAPH_PREPARED_SPOOL_BYTES_LIMIT + 1,
              checkoutId: 'c'.repeat(64),
              onWaiting: fs.writeFileString(queued, '').pipe(Effect.orDie),
              snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
              threadnoteHome: home,
            },
            fs.writeFileString(admitted, ''),
          ).pipe(Effect.forkChild);
          while (!(yield* fs.exists(queued))) yield* Effect.sleep(10);
          child.kill('SIGKILL');
          yield* Effect.promise(() => child.exited);
          while (!(yield* fs.exists(admitted))) yield* Effect.sleep(10);
          yield* Fiber.join(successor);
          expect(yield* fs.readDirectory(root)).toEqual([]);
        }).pipe(provideTestLayer(testLayer)),
      ),
    {timeout: 30_000},
  );
});
