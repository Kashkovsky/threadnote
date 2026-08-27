import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {nextCodeGraphActiveViewActivationTimestamp} from '../../src/code_graph/store_active_views.js';

const canonicalTimestamp = fc
  .date({
    max: new Date('9998-12-31T23:59:59.999Z'),
    min: new Date('2000-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .map(value => value.toISOString());

describe('code graph active-view fence', () => {
  it('advances every prior activation generation', () => {
    fc.assert(
      fc.property(canonicalTimestamp, fc.array(canonicalTimestamp, {maxLength: 4}), (candidate, previous) => {
        const next = nextCodeGraphActiveViewActivationTimestamp(candidate, previous);
        expect(next).toBeDefined();
        expect(Date.parse(next!)).toBeGreaterThanOrEqual(Date.parse(candidate));
        for (const value of previous) expect(Date.parse(next!)).toBeGreaterThan(Date.parse(value));
      }),
      {numRuns: 100},
    );
  });

  it('fails closed when the canonical timestamp range cannot advance', () => {
    const maximum = '9999-12-31T23:59:59.999Z';
    expect(nextCodeGraphActiveViewActivationTimestamp(maximum, [maximum])).toBeUndefined();
    expect(nextCodeGraphActiveViewActivationTimestamp('not-a-timestamp', [])).toBeUndefined();
  });

  it('never restores the same generation through a same-clock promote/remove ABA sequence', () => {
    const clock = '2026-08-27T20:00:00.000Z';
    const firstB = nextCodeGraphActiveViewActivationTimestamp(clock, []);
    const removedB = nextCodeGraphActiveViewActivationTimestamp(clock, [firstB]);
    const activeA = nextCodeGraphActiveViewActivationTimestamp(clock, [removedB]);
    const removedA = nextCodeGraphActiveViewActivationTimestamp(clock, [activeA]);
    const finalB = nextCodeGraphActiveViewActivationTimestamp(clock, [removedA]);

    expect([firstB, removedB, activeA, removedA, finalB]).toEqual([
      '2026-08-27T20:00:00.000Z',
      '2026-08-27T20:00:00.001Z',
      '2026-08-27T20:00:00.002Z',
      '2026-08-27T20:00:00.003Z',
      '2026-08-27T20:00:00.004Z',
    ]);
    expect(finalB).not.toBe(firstB);
  });
});
