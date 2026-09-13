import {expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {fcEffectProp, fcProp} from '../helpers/fast-check-property.js';

fcProp(
  effectIt,
  'preserves tuple input shape for pure Fast-check properties',
  [FC.integer({min: 0, max: 10}), FC.constantFrom('a', 'b')] as const,
  ([count, label]) => {
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(10);
    expect(['a', 'b']).toContain(label);
  },
  {fastCheck: {numRuns: 20}},
);

fcEffectProp(
  effectIt,
  'preserves record input shape inside the Effect property runner',
  {count: FC.integer({min: 0, max: 10}), label: FC.constantFrom('a', 'b')},
  ({count, label}) =>
    Effect.sync(() => {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(10);
      expect(['a', 'b']).toContain(label);
    }),
  {fastCheck: {numRuns: 20}},
);
