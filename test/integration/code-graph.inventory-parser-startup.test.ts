import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {vi} from 'vitest';
import {inventoryRepository} from '../../src/code_graph/inventory.js';
import {resolveRepositoryIdentity} from '../../src/code_graph/repository.js';
import {CommandExecutor, runCommandEffect} from '../../src/effect/command.js';
import {SystemInfo} from '../../src/effect/system.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const testLayer = CommandExecutor.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, SystemInfo.layer)));

describe('inventory parser preparation', () => {
  it.effect('prepares once after reading and excludes parser startup from read accounting', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = yield* CommandExecutor;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inventory-parser-startup-'});
      yield* fs.writeFileString(path.join(root, 'source.ts'), 'export const source = true;\n');
      yield* runCommandEffect('git', ['init', '-q', root]);
      yield* runCommandEffect('git', ['-C', root, 'add', '.']);
      yield* runCommandEffect('git', [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
      const identity = yield* resolveRepositoryIdentity(root);
      const events: string[] = [];
      let milliseconds = 0;
      let readingMilliseconds = -1;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(performance, 'now').mockImplementation(() => milliseconds)),
        () =>
          inventoryRepository(identity, {
            onContentBatch: (_files, context) =>
              Effect.sync(() => {
                events.push('extract');
                readingMilliseconds = context.readingMilliseconds;
              }),
            onParserWorkPlanned: () =>
              Effect.sync(() => {
                events.push('prepare');
                milliseconds += 1_000;
              }),
          }).pipe(
            Effect.provideService(CommandExecutor, {
              ...command,
              executeBytes: (executable, args, options) =>
                command.executeBytes!(executable, args, options).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (args.includes('cat-file') && args.includes('--batch')) {
                        events.push('read');
                        milliseconds += 7;
                      }
                    }),
                  ),
                ),
            }),
          ),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect(events).toEqual(['read', 'prepare', 'extract']);
      expect(readingMilliseconds).toBe(7);
    }).pipe(provideTestLayer(testLayer), TestClock.withLive),
  );
});
