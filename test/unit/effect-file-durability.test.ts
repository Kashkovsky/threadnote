import {Effect, FileSystem} from 'effect';
import {describe, expect, it} from 'vitest';
import {syncDirectoryBestEffort, syncWritableFile} from '../../src/effect/file_durability.js';

describe('file durability', () => {
  it('opens files with a writable handle before syncing', async () => {
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

    await Effect.runPromise(Effect.scoped(syncWritableFile(fs, 'state.json')));

    expect(calls).toEqual([{flag: 'r+', target: 'state.json'}]);
    expect(synced).toBe(true);
  });

  it('keeps directory syncing read-only and best effort', async () => {
    const calls: Array<{readonly flag: string; readonly target: string}> = [];
    const fs = {
      open: (target: string, options: {readonly flag: string}) => {
        calls.push({flag: options.flag, target});
        return Effect.fail(new Error('directory fsync is unsupported'));
      },
    } as unknown as FileSystem.FileSystem;

    await expect(Effect.runPromise(syncDirectoryBestEffort(fs, 'parent'))).resolves.toBeUndefined();
    expect(calls).toEqual([{flag: 'r', target: 'parent'}]);
  });
});
