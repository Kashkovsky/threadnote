import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  createMonorepoShareRecallStressFixture,
  monorepoShareRecallStressCandidates,
  runMonorepoShareRecallStressPass,
  summarizeMonorepoShareRecallStressPass,
  type MonorepoShareRecallStressOptions,
} from '../../src/evaluation/recall-monorepo-stress.js';

function evaluate(options: MonorepoShareRecallStressOptions, mode: 'full-corpus' | 'workspace-prefiltered') {
  const fixture = createMonorepoShareRecallStressFixture(options);
  const candidates = monorepoShareRecallStressCandidates(fixture, mode);
  const ranked = runMonorepoShareRecallStressPass(fixture, candidates);
  return {fixture, ranked, summary: summarizeMonorepoShareRecallStressPass(fixture, mode, candidates, ranked)};
}

describe('recall monorepo/share stress fixture', () => {
  it('reports physical aliases, logical candidates, package recall, and result deduplication separately', () => {
    const options: MonorepoShareRecallStressOptions = {
      logicalMemoriesPerPackage: 4,
      packages: 3,
      seed: 42,
      shareAliasesPerMemory: 2,
      targetPackage: 1,
      topK: 3,
    };
    const full = evaluate(options, 'full-corpus');
    const scoped = evaluate(options, 'workspace-prefiltered');

    expect(createMonorepoShareRecallStressFixture(options)).toEqual(full.fixture);
    expect(full.summary).toMatchObject({
      aliasCompressionRate: 2 / 3,
      duplicateResultCount: 0,
      duplicateResultRate: 0,
      logicalCandidates: 12,
      physicalCandidates: 36,
      relevantHitsAtK: 1,
      relevantMemories: 1,
      relevantRecallAtK: 1,
    });
    expect(full.summary.topMemoryIds[0]).toBe('tn_stress_p001_m0000');
    expect(scoped.summary).toMatchObject({
      aliasCompressionRate: 2 / 3,
      duplicateResultCount: 0,
      duplicateResultRate: 0,
      logicalCandidates: 4,
      physicalCandidates: 12,
      relevantHitsAtK: 1,
      relevantRecallAtK: 1,
    });
    expect(scoped.ranked.results[0]?.candidate.equivalentUris).toHaveLength(2);
  });

  it.prop(
    'keeps multiplicative alias shape deterministic and preserves target-package recall after scope admission',
    {
      logicalMemoriesPerPackage: FC.integer({max: 6, min: 1}),
      packages: FC.integer({max: 8, min: 1}),
      seed: FC.integer({max: 0x7fff_ffff, min: 1}),
      shareAliasesPerMemory: FC.integer({max: 4, min: 0}),
      targetSelector: FC.integer({max: 1_000, min: 0}),
      topK: FC.integer({max: 5, min: 1}),
    },
    ({logicalMemoriesPerPackage, packages, seed, shareAliasesPerMemory, targetSelector, topK}) => {
      const options: MonorepoShareRecallStressOptions = {
        logicalMemoriesPerPackage,
        packages,
        seed,
        shareAliasesPerMemory,
        targetPackage: targetSelector % packages,
        topK,
      };
      const fixture = createMonorepoShareRecallStressFixture(options);
      const repeated = createMonorepoShareRecallStressFixture(options);
      const scoped = evaluate(options, 'workspace-prefiltered');

      expect(fixture).toEqual(repeated);
      expect(fixture.candidates).toHaveLength(packages * logicalMemoriesPerPackage * (shareAliasesPerMemory + 1));
      expect(new Set(fixture.candidates.map(candidate => candidate.memoryId)).size).toBe(
        packages * logicalMemoriesPerPackage,
      );
      expect(scoped.summary.physicalCandidates).toBe(logicalMemoriesPerPackage * (shareAliasesPerMemory + 1));
      expect(scoped.summary.logicalCandidates).toBe(logicalMemoriesPerPackage);
      expect(scoped.summary.duplicateResultRate).toBe(0);
      expect(scoped.summary.relevantRecallAtK).toBe(1);
      expect(scoped.summary.topMemoryIds[0]).toBe(fixture.relevantMemoryIds[0]);
    },
    {fastCheck: {numRuns: 35}},
  );
});
