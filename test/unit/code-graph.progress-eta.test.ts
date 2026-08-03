import {Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  estimateCodeGraphEta,
  makeCodeGraphEtaTracker,
  observeCodeGraphEta,
  type CodeGraphEtaMeasurement,
  type CodeGraphEtaTracker,
} from '../../src/code_graph/progress_eta.js';

describe('code graph progress ETA', () => {
  it('uses cumulative phase throughput and promotes only calibrated stable estimates', () => {
    let state = startMeasurement({basis: 'cached-fact-bytes', completed: 0, phase: 'materializing', total: 1_000});
    for (let completed = 20; completed <= 160; completed += 20) {
      state = advance(state, completed, 1_000);
    }

    expect(Option.getOrUndefined(state.observation.estimate)).toEqual({
      basis: 'cached-fact-bytes',
      confidence: 'medium',
      remainingMilliseconds: 42_000,
    });

    for (let completed = 180; completed <= 480; completed += 20) {
      state = advance(state, completed, 1_000);
    }
    expect(Option.getOrUndefined(state.observation.estimate)).toEqual({
      basis: 'cached-fact-bytes',
      confidence: 'high',
      remainingMilliseconds: 26_000,
    });
  });

  it('suppresses heterogeneous and silent forecasts instead of publishing a volatile low-confidence number', () => {
    let state = startMeasurement({basis: 'cached-fact-bytes', completed: 0, phase: 'materializing', total: 2_000});
    for (let completed = 40; completed <= 320; completed += 40) state = advance(state, completed, 1_000);
    expect(Option.isSome(state.observation.estimate)).toBe(true);

    for (let completed = 321; completed <= 328; completed += 1) state = advance(state, completed, 10_000);
    expect(Option.getOrUndefined(state.observation.confidence)).toBe('low');
    expect(Option.isNone(state.observation.estimate)).toBe(true);

    let stable = startMeasurement({basis: 'files', completed: 0, phase: 'scanning', total: 100});
    for (let completed = 10; completed <= 80; completed += 10) stable = advance(stable, completed, 1_000);
    const silent = estimateCodeGraphEta(stable.tracker, stable.now + 5_001);
    expect(Option.getOrUndefined(silent.confidence)).toBe('low');
    expect(Option.isNone(silent.estimate)).toBe(true);
  });

  it('resets all calibration when phase, basis, total, or monotonic progress changes', () => {
    let state = startMeasurement({basis: 'cached-fact-bytes', completed: 0, phase: 'materializing', total: 1_000});
    for (let completed = 20; completed <= 160; completed += 20) state = advance(state, completed, 1_000);
    expect(state.tracker.sampleCount).toBe(8);

    const reset = observeCodeGraphEta(
      state.tracker,
      Option.some({basis: 'final-fact-bytes', completed: 160, phase: 'materializing', total: 1_100}),
      state.now + 1_000,
    );
    expect(reset.tracker.sampleCount).toBe(0);
    expect(Option.isNone(reset.estimate)).toBe(true);
  });
});

interface TraceState {
  readonly measurement: CodeGraphEtaMeasurement;
  readonly now: number;
  readonly observation: ReturnType<typeof observeCodeGraphEta>;
  readonly tracker: CodeGraphEtaTracker;
}

function startMeasurement(measurement: CodeGraphEtaMeasurement): TraceState {
  const observation = observeCodeGraphEta(makeCodeGraphEtaTracker(), Option.some(measurement), 0);
  return {measurement, now: 0, observation, tracker: observation.tracker};
}

function advance(state: TraceState, completed: number, elapsedMilliseconds: number): TraceState {
  const now = state.now + elapsedMilliseconds;
  const measurement = {...state.measurement, completed};
  const observation = observeCodeGraphEta(state.tracker, Option.some(measurement), now);
  return {measurement, now, observation, tracker: observation.tracker};
}
