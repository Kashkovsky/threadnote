import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import {expect} from 'vitest';
import {MaterializationSubphaseTiming} from '../../src/code_graph/materialization_subphase_timing.js';

effectIt.effect.prop(
  'attributes nested serialization separately from adjacent fact preparation',
  {
    attribution: FC.integer({max: 10_000, min: 0}),
    preparationAfter: FC.integer({max: 10_000, min: 0}),
    preparationBefore: FC.integer({max: 10_000, min: 0}),
    serialization: FC.integer({max: 10_000, min: 0}),
  },
  sample =>
    Effect.sync(() => {
      let now = 0;
      const timing = new MaterializationSubphaseTiming(() => now);
      timing.measure('attributionCompute', () => {
        now += sample.attribution;
      });
      timing.measureExcluding('factBatchPreparation', 'shardSerialization', () => {
        now += sample.preparationBefore;
        timing.measure('shardSerialization', () => {
          now += sample.serialization;
        });
        now += sample.preparationAfter;
      });

      expect(timing.snapshot()).toMatchObject({
        attributionCompute: sample.attribution,
        factBatchPreparation: sample.preparationBefore + sample.preparationAfter,
        shardSerialization: sample.serialization,
      });
    }),
  {fastCheck: {numRuns: 100}},
);
