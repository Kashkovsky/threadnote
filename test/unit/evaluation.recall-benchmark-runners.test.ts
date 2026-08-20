import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {parseRecallCrossScopeSqliteBenchmarkArguments} from '../../scripts/benchmark-recall-cross-scope-sqlite.js';
import {parseRecallEligibilityBenchmarkArguments} from '../../scripts/benchmark-recall-eligibility-production.js';
import {
  parseRecallMonorepoSharesBenchmarkArguments,
  rotateRecallBenchmarkPasses,
} from '../../scripts/benchmark-recall-monorepo-shares.js';

describe('recall benchmark runner arguments', () => {
  it('keeps the documented bounded defaults', () => {
    expect(parseRecallCrossScopeSqliteBenchmarkArguments([])).toEqual({
      documents: 4_000,
      outputPath: undefined,
      samples: 5,
      topK: 5,
      warmups: 1,
    });
    expect(parseRecallMonorepoSharesBenchmarkArguments([])).toEqual({
      fixture: {
        logicalMemoriesPerPackage: 128,
        packages: 64,
        seed: 0x4_02_07,
        shareAliasesPerMemory: 3,
        siblingPackage: 1,
        targetPackage: 0,
        topK: 5,
      },
      outputPath: undefined,
      samples: 10,
      warmups: 2,
    });
    expect(parseRecallEligibilityBenchmarkArguments([])).toEqual({
      distractorsPerClass: 525,
      outputPath: undefined,
      samples: 5,
      topK: 5,
      warmups: 1,
    });
  });

  it.each(['1.5', '7junk', '1e3', '+7', '-0', ' 7'])('rejects partial or non-canonical numeric input %j', value => {
    expect(() => parseRecallCrossScopeSqliteBenchmarkArguments(['--samples', value])).toThrow(
      'requires a non-negative integer',
    );
    expect(() => parseRecallMonorepoSharesBenchmarkArguments(['--samples', value])).toThrow(
      'requires a non-negative integer',
    );
    expect(() => parseRecallEligibilityBenchmarkArguments(['--samples', value])).toThrow(
      'requires a non-negative integer',
    );
  });

  it('accepts zero only for non-negative controls', () => {
    expect(parseRecallCrossScopeSqliteBenchmarkArguments(['--warmups', '0']).warmups).toBe(0);
    expect(parseRecallMonorepoSharesBenchmarkArguments(['--share-aliases', '0', '--warmups', '0'])).toMatchObject({
      fixture: {shareAliasesPerMemory: 0},
      warmups: 0,
    });
    expect(() => parseRecallCrossScopeSqliteBenchmarkArguments(['--samples', '0'])).toThrow(
      'requires a positive integer',
    );
    expect(() => parseRecallMonorepoSharesBenchmarkArguments(['--samples', '0'])).toThrow(
      'requires a positive integer',
    );
    expect(parseRecallEligibilityBenchmarkArguments(['--warmups', '0']).warmups).toBe(0);
    expect(() => parseRecallEligibilityBenchmarkArguments(['--samples', '0'])).toThrow('requires a positive integer');
  });

  it('preserves a fixture larger than the lexical posting pool', () => {
    expect(() => parseRecallEligibilityBenchmarkArguments(['--distractors-per-class', '500'])).toThrow(
      'must be at least 501',
    );
    expect(parseRecallEligibilityBenchmarkArguments(['--distractors-per-class', '501']).distractorsPerClass).toBe(501);
  });
});

describe('recall benchmark pass rotation', () => {
  it('moves each of the six scenario/mode passes through the first measured position', () => {
    const passes = [
      'current/full',
      'current/scoped',
      'current/cross',
      'sibling/full',
      'sibling/scoped',
      'sibling/cross',
    ];
    expect(
      Array.from({length: passes.length}, (_unused, sample) => rotateRecallBenchmarkPasses(passes, sample)[0]),
    ).toEqual(passes);
  });

  it.prop(
    'preserves every pass exactly once under arbitrary bounded rotations',
    {
      sample: FC.integer({max: 1_000, min: 0}),
      size: FC.integer({max: 12, min: 1}),
    },
    ({sample, size}) => {
      const passes = Array.from({length: size}, (_unused, index) => `pass-${index}`);
      const rotated = rotateRecallBenchmarkPasses(passes, sample);
      expect(rotated).toHaveLength(size);
      expect(new Set(rotated)).toEqual(new Set(passes));
      expect(rotated[0]).toBe(passes[sample % size]);
    },
    {fastCheck: {numRuns: 50}},
  );
});
