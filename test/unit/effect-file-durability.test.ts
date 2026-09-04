import {it as effectIt} from '@effect/vitest';
import {TestError} from '../helpers/test-error.js';
import {Effect, FileSystem} from 'effect';
import {describe, expect} from 'vitest';
import {syncDirectoryBestEffort, syncWritableFile} from '../../src/effect/file_durability.js';

describe('file durability', () => {
  effectIt.effect('opens files with a writable handle before syncing', () =>
    Effect.gen(function* () {
      const calls: Array<{readonly flag: string; readonly target: string}> = [];
      let synced = false;
      const fs = {
        open: (target: string, options: {readonly flag: string}) => {
          calls.push({flag: options.flag, target});
          return Effect.succeed({
            sync: Effect.sync(() => {
              synced = true;
            }),
          });
        },
      } as unknown as FileSystem.FileSystem;

      yield* Effect.scoped(syncWritableFile(fs, 'state.json'));

      expect(calls).toEqual([{flag: 'r+', target: 'state.json'}]);
      expect(synced).toBe(true);
    }),
  );

  effectIt.effect('keeps directory syncing read-only and best effort', () =>
    Effect.gen(function* () {
      const calls: Array<{readonly flag: string; readonly target: string}> = [];
      const fs = {
        open: (target: string, options: {readonly flag: string}) => {
          calls.push({flag: options.flag, target});
          return Effect.fail(TestError.make({message: 'directory fsync is unsupported'}));
        },
      } as unknown as FileSystem.FileSystem;

      yield* syncDirectoryBestEffort(fs, 'parent');
      expect(calls).toEqual([{flag: 'r', target: 'parent'}]);
    }),
  );
});
