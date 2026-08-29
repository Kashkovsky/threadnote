import {it as effectIt} from '@effect/vitest';
import fc from 'fast-check';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {HttpService} from '../../src/effect/http.js';
import {fetchManagerLatestVersion, managerUpdateAvailable} from '../../src/manager/state.js';
import {managerUpdateIndicator} from '../../src/manager/update_indicator.js';

describe('Manager runtime state', () => {
  it.each([
    {current: '4.2.0-beta.2', expected: true, latest: '4.2.0'},
    {current: '4.2.0-beta.2', expected: false, latest: '4.2.0-beta.2'},
    {current: '4.2.0', expected: false, latest: '4.2.0-beta.9'},
    {current: '4.2.0-beta.2', expected: false, latest: '4.1.9'},
    {
      current: '4.4.2-local.g9d9e0358d2d1ac4736480fcf199a3cafdbb62249',
      expected: false,
      latest: '4.4.2',
    },
    {current: '4.2.0', expected: false, latest: undefined},
  ])('reports $latest over $current as updateAvailable=$expected', ({current, expected, latest}) => {
    expect(managerUpdateAvailable(current, latest)).toBe(expected);
  });

  it('matches numeric SemVer precedence for stable release triples', () => {
    const version = fc.tuple(
      fc.integer({max: 99, min: 0}),
      fc.integer({max: 99, min: 0}),
      fc.integer({max: 99, min: 0}),
    );
    fc.assert(
      fc.property(version, version, (current, latest) => {
        const currentVersion = current.join('.');
        const latestVersion = latest.join('.');
        const expected =
          latest[0] > current[0] ||
          (latest[0] === current[0] && latest[1] > current[1]) ||
          (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2]);
        expect(managerUpdateAvailable(currentVersion, latestVersion)).toBe(expected);
      }),
    );
  });

  it('never advertises a release update from a development runtime', () => {
    const version = fc.tuple(
      fc.integer({max: 99, min: 0}),
      fc.integer({max: 99, min: 0}),
      fc.integer({max: 99, min: 0}),
    );
    const commit = fc
      .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: 40, minLength: 40})
      .map(characters => characters.join(''));
    fc.assert(
      fc.property(version, version, commit, (current, latest, revision) => {
        const currentVersion = `${current.join('.')}-local.g${revision}`;
        expect(managerUpdateAvailable(currentVersion, latest.join('.'))).toBe(false);
      }),
    );
  });

  effectIt.effect('does not check releases while reading development-runtime Manager state', () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpService.of({
        downloadToFile: () => Effect.die('not used'),
        getJson: () =>
          Effect.sync(() => {
            requests += 1;
            return {body: [], status: 200};
          }),
        getStatus: () => Effect.die('not used'),
        getText: () => Effect.die('not used'),
      });
      const latestVersion = yield* fetchManagerLatestVersion(
        `4.4.2-local.g${'a'.repeat(40)}`,
        'https://example.invalid/releases',
      ).pipe(Effect.provideService(HttpService, http));

      expect(latestVersion).toBeUndefined();
      expect(requests).toBe(0);
    }),
  );

  it.each([
    {
      autoUpdate: {
        effectivePolicy: 'automatic' as const,
        lastSuccess: {repairRequired: true, toVersion: '4.3.0'},
        running: {fromVersion: '4.2.2'},
      },
      expected: {detail: 'from v4.2.2', label: 'Updating in background'},
      latestVersion: '4.3.0',
      updateAvailable: true,
    },
    {
      autoUpdate: {
        effectivePolicy: 'automatic' as const,
        lastSuccess: {repairRequired: true, toVersion: '4.3.0'},
      },
      expected: {detail: 'v4.3.0', label: 'Update needs attention'},
      latestVersion: '4.3.0',
      updateAvailable: true,
    },
    {
      autoUpdate: {effectivePolicy: 'automatic' as const},
      expected: {detail: 'v4.3.0', label: 'Update queued'},
      latestVersion: '4.3.0',
      updateAvailable: true,
    },
    {
      autoUpdate: {effectivePolicy: 'notify' as const},
      expected: {detail: 'v4.3.0', label: 'Update available'},
      latestVersion: '4.3.0',
      updateAvailable: true,
    },
  ])('selects the highest-priority update indicator', state => {
    expect(managerUpdateIndicator(state)).toEqual(state.expected);
  });
});
