import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {managerUpdateAvailable} from '../../src/manager_state.js';
import {managerUpdateIndicator} from '../../src/manager_update_indicator.js';

describe('Manager runtime state', () => {
  it.each([
    {current: '4.2.0-beta.2', expected: true, latest: '4.2.0'},
    {current: '4.2.0-beta.2', expected: false, latest: '4.2.0-beta.2'},
    {current: '4.2.0', expected: false, latest: '4.2.0-beta.9'},
    {current: '4.2.0-beta.2', expected: false, latest: '4.1.9'},
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
