import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {nextPersistentActivationBatchRows} from '../../src/code_graph/store.js';

describe('code graph activation batching properties', () => {
  it.prop(
    'keeps adaptive pages bounded and moves only in the direction implied by observed duration',
    {
      current: FC.integer({max: 100_000, min: 250}),
      duration: FC.integer({max: 60_000, min: 0}),
      maximumExtra: FC.integer({max: 100_000, min: 0}),
    },
    ({current, duration, maximumExtra}) => {
      const maximum = current + maximumExtra;
      const next = nextPersistentActivationBatchRows(current, duration, maximum);

      expect(Number.isSafeInteger(next)).toBe(true);
      expect(next).toBeGreaterThanOrEqual(250);
      expect(next).toBeLessThanOrEqual(maximum);
      expect(next).toBeLessThanOrEqual(current * 2);
      if (duration >= 2_000 && duration <= 5_000) expect(next).toBe(current);
      else if (duration > 5_000) expect(next).toBeLessThanOrEqual(current);
      else expect(next).toBeGreaterThanOrEqual(current);
    },
    {fastCheck: {numRuns: 250}},
  );
});
