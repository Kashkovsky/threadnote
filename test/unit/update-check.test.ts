import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Effect} from 'effect';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {checkForThreadnoteUpdate} from '../../src/update-check.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {force: true, recursive: true})));
});

describe('Effect update check', () => {
  it('skips network work for unknown development versions', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(runCheck('/unused', 'unknown')).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a fresh cache without fetching', async () => {
    const directory = await temporaryDirectory();
    const cachePath = join(directory, 'update.json');
    await writeFile(
      cachePath,
      JSON.stringify({checkedAt: new Date().toISOString(), latestVersion: '2.0.0', version: 1}),
      'utf8',
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(runCheck(cachePath, '1.0.0')).resolves.toEqual({
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      outdated: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches through HttpService and persists a successful result', async () => {
    const directory = await temporaryDirectory();
    const cachePath = join(directory, 'update.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({version: '1.2.0'})),
    );

    await expect(runCheck(cachePath, '1.1.0')).resolves.toEqual({
      currentVersion: '1.1.0',
      latestVersion: '1.2.0',
      outdated: true,
    });
    await expect(readFile(cachePath, 'utf8')).resolves.toContain('"latestVersion":"1.2.0"');
  });
});

function runCheck(cachePath: string, currentVersion: string) {
  return Effect.runPromise(
    checkForThreadnoteUpdate({cachePath, currentVersion}).pipe(Effect.provide(ApplicationLayer)),
  );
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'threadnote-update-check-'));
  temporaryDirectories.push(directory);
  return directory;
}
