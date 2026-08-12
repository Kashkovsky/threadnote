import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {mkdtemp, readFile, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {Effect} from 'effect';
import {afterEach, describe, expect, vi} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {checkForThreadnoteUpdate} from '../../src/update-check.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('Effect update check', () => {
  effectIt.effect('skips network work for unknown development versions', () =>
    Effect.gen(function* () {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      yield* runCheck('/unused', 'unknown');
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('uses a fresh cache without fetching', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const cachePath = join(directory, 'update.json');
      yield* Effect.promise(() =>
        writeFile(
          cachePath,
          JSON.stringify({channel: 'latest', checkedAt: new Date().toISOString(), latestVersion: '2.0.0', version: 2}),
          'utf8',
        ),
      );
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      expect(yield* runCheck(cachePath, '1.0.0')).toEqual({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        outdated: true,
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('fetches through HttpService and persists a successful result', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const cachePath = join(directory, 'update.json');
      const fetch = vi.fn(async (_url: string | URL) =>
        Response.json([
          {
            assets: [],
            draft: false,
            immutable: true,
            prerelease: false,
            tag_name: 'v1.2.0',
          },
        ]),
      );
      vi.stubGlobal('fetch', fetch);

      expect(yield* runCheck(cachePath, '1.1.0')).toEqual({
        currentVersion: '1.1.0',
        latestVersion: '1.2.0',
        outdated: true,
      });
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/releases?per_page=100'))).toBe(true);
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"channel":"latest"');
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"latestVersion":"1.2.0"');
    }),
  );

  effectIt.effect('uses and caches the beta channel for an installed beta', () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(temporaryDirectory);
      const cachePath = join(directory, 'update.json');
      yield* Effect.promise(() =>
        writeFile(
          cachePath,
          JSON.stringify({channel: 'latest', checkedAt: new Date().toISOString(), latestVersion: '2.0.4', version: 2}),
          'utf8',
        ),
      );
      const fetch = vi.fn(async (_url: string | URL) =>
        Response.json([
          {
            assets: [],
            draft: false,
            immutable: true,
            prerelease: true,
            tag_name: 'v3.0.0-beta.2',
          },
        ]),
      );
      vi.stubGlobal('fetch', fetch);

      expect(yield* runCheck(cachePath, '3.0.0-beta.1')).toEqual({
        currentVersion: '3.0.0-beta.1',
        latestVersion: '3.0.0-beta.2',
        outdated: true,
      });
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/releases?per_page=100'))).toBe(true);
      expect(yield* Effect.promise(() => readFile(cachePath, 'utf8'))).toContain('"channel":"beta"');
    }),
  );
});

function runCheck(cachePath: string, currentVersion: string) {
  return checkForThreadnoteUpdate({cachePath, currentVersion}).pipe(provideTestLayer(ApplicationLayer));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'threadnote-update-check-'));
  temporaryDirectories.push(directory);
  return directory;
}
