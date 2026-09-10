import fc from 'fast-check';
import {Effect} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {succeedUndefined} from '../../src/effect/optional.js';
import {observeProcessInstanceIdentity, processInstanceIdentityMatches} from '../../src/process/process_identity.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const darwinCLocaleStart = fc
  .tuple(
    fc.constantFrom(...WEEKDAYS),
    fc.constantFrom(...MONTHS),
    fc.integer({min: 1, max: 31}),
    fc.integer({min: 0, max: 23}),
    fc.integer({min: 0, max: 59}),
    fc.integer({min: 0, max: 59}),
    fc.integer({min: 2020, max: 2035}),
  )
  .map(([weekday, month, day, hour, minute, second, year]) => {
    const dayField = day < 10 ? ` ${day}` : String(day);
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    return `${weekday} ${month} ${dayField} ${time} ${year}`;
  });

describe('process instance identity', () => {
  it('keeps a live process when observation cannot be read', () => {
    expect(processInstanceIdentityMatches('darwin-v2:Sat Aug  8 23:04:27 2026', undefined)).toBe(true);
    expect(processInstanceIdentityMatches(undefined, 'darwin-v2:Sat Aug  8 23:04:27 2026')).toBe(true);
  });

  it('rejects a canonical identity that no longer matches the running process', () => {
    expect(
      processInstanceIdentityMatches('darwin-v2:Sat Aug  8 23:04:27 2026', 'darwin-v2:Sun Aug  9 00:00:00 2026'),
    ).toBe(false);
  });

  it('does not treat two different locale-sensitive Darwin strings as the same process', () => {
    expect(processInstanceIdentityMatches('darwin:Thu Sep 10 16:44:09 2026', 'darwin:Thu 10 Sep 16:44:09 2026')).toBe(
      false,
    );
  });

  it('accepts a pre-canonical Darwin row once the observer has a locale-stable identity', () => {
    fc.assert(
      fc.property(darwinCLocaleStart, start => {
        expect(processInstanceIdentityMatches(`darwin:${start}`, `darwin-v2:${start}`)).toBe(true);
        expect(processInstanceIdentityMatches(`darwin-v2:${start}`, `darwin-v2:${start}`)).toBe(true);
      }),
      {numRuns: 200},
    );
  });
});

describe('observeProcessInstanceIdentity', () => {
  effectIt.effect('prefers canonical process start identity when it is defined', () =>
    Effect.gen(function* () {
      const observed = yield* observeProcessInstanceIdentity(
        {
          canonicalProcessStartIdentity: () => Effect.succeed('darwin-v2:canonical'),
          processStartIdentity: () => Effect.succeed('darwin:fallback'),
        },
        1,
      );
      expect(observed).toBe('darwin-v2:canonical');
    }),
  );

  effectIt.effect('falls back to locale-sensitive identity when canonical observation is missing', () =>
    Effect.gen(function* () {
      const observed = yield* observeProcessInstanceIdentity(
        {
          processStartIdentity: () => Effect.succeed('darwin:fallback'),
        },
        1,
      );
      expect(observed).toBe('darwin:fallback');
    }),
  );

  effectIt.effect('falls back when canonical observation returns undefined', () =>
    Effect.gen(function* () {
      const observed = yield* observeProcessInstanceIdentity(
        {
          canonicalProcessStartIdentity: () => succeedUndefined,
          processStartIdentity: () => Effect.succeed('darwin:fallback'),
        },
        1,
      );
      expect(observed).toBe('darwin:fallback');
    }),
  );
});
