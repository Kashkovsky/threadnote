import {describe, expect, it} from '@effect/vitest';
import {Option} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {
  makeCodeGraphEtaTracker,
  observeCodeGraphEta,
  type CodeGraphEtaMeasurement,
} from '../../src/code_graph/progress_eta.js';

describe('code graph progress ETA properties', () => {
  it.prop(
    'preserves estimate and confidence parity when measured work is scaled',
    {
      intervalMilliseconds: FC.integer({max: 5_000, min: 10}),
      scale: FC.integer({max: 100, min: 1}),
      units: FC.integer({max: 10_000, min: 1}),
    },
    ({intervalMilliseconds, scale, units}) => {
      const base = stableTrace(units, intervalMilliseconds, 40);
      const scaled = stableTrace(units * scale, intervalMilliseconds, 40);
      const baseEstimate = Option.getOrUndefined(base.estimate);
      const scaledEstimate = Option.getOrUndefined(scaled.estimate);
      expect(scaledEstimate?.basis).toBe(baseEstimate?.basis);
      expect(scaledEstimate?.confidence).toBe(baseEstimate?.confidence);
      expect(
        Math.abs((scaledEstimate?.remainingMilliseconds ?? 0) - (baseEstimate?.remainingMilliseconds ?? 0)),
      ).toBeLessThanOrEqual(1_000);
      expect(Option.getOrUndefined(scaled.confidence)).toBe(Option.getOrUndefined(base.confidence));
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'resets calibration for any phase or measurement-basis transition',
    {
      completed: FC.integer({max: 1_000_000, min: 1}),
      totalRemainder: FC.integer({max: 1_000_000, min: 1}),
    },
    ({completed, totalRemainder}) => {
      const initial = observeCodeGraphEta(
        makeCodeGraphEtaTracker(),
        Option.some({basis: 'files', completed: 0, phase: 'scanning', total: completed + totalRemainder}),
        0,
      );
      const advanced = observeCodeGraphEta(
        initial.tracker,
        Option.some({basis: 'files', completed, phase: 'scanning', total: completed + totalRemainder}),
        1_000,
      );
      const reset = observeCodeGraphEta(
        advanced.tracker,
        Option.some({
          basis: 'cached-fact-bytes',
          completed,
          phase: 'materializing',
          total: completed + totalRemainder,
        }),
        2_000,
      );
      expect(reset.tracker.sampleCount).toBe(0);
      expect(Option.isNone(reset.estimate)).toBe(true);
    },
    {fastCheck: {numRuns: 200}},
  );
});

function stableTrace(units: number, intervalMilliseconds: number, samples: number) {
  const measurement: CodeGraphEtaMeasurement = {
    basis: 'cached-fact-bytes',
    completed: 0,
    phase: 'materializing',
    total: units * 100,
  };
  let observation = observeCodeGraphEta(makeCodeGraphEtaTracker(), Option.some(measurement), 0);
  for (let sample = 1; sample <= samples; sample += 1) {
    observation = observeCodeGraphEta(
      observation.tracker,
      Option.some({...measurement, completed: units * sample}),
      intervalMilliseconds * sample,
    );
  }
  return observation;
}
