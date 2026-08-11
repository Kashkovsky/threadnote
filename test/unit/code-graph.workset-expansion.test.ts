import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {selectCodeGraphWorksetAdaptiveExpansionBatch} from '../../src/code_graph/workset_expansion.js';
import type {CodeGraphWorksetRouterRepositoryCandidateV1} from '../../src/code_graph/workset_router.js';

describe('code graph workset adaptive expansion', () => {
  it('uses the 4/4/16 schedule without changing global repository order', () => {
    const repositories = candidates(40);
    const selected = new Set<string>();
    const batches = [0, 1, 2].map(phase => {
      const batch = selectCodeGraphWorksetAdaptiveExpansionBatch({
        alreadySelectedRepositoryKeys: selected,
        phase,
        remainingMilliseconds: 10_000,
        repositories,
      });
      for (const repository of batch.repositories) selected.add(repository.repositoryKey);
      return batch;
    });

    expect(batches.map(batch => batch.repositories.length)).toEqual([4, 4, 16]);
    expect(batches.flatMap(batch => batch.repositories.map(repository => repository.rank))).toEqual(
      Array.from({length: 24}, (_, index) => index + 1),
    );
  });

  it('returns truthful cancellation, deadline, and exhaustion receipts', () => {
    const repositories = candidates(2);
    expect(
      selectCodeGraphWorksetAdaptiveExpansionBatch({
        cancelled: true,
        phase: 0,
        remainingMilliseconds: 1_000,
        repositories,
      }),
    ).toMatchObject({repositories: [], stopReason: 'cancelled'});
    expect(
      selectCodeGraphWorksetAdaptiveExpansionBatch({phase: 0, remainingMilliseconds: 50, repositories}),
    ).toMatchObject({repositories: [], stopReason: 'deadline'});
    expect(
      selectCodeGraphWorksetAdaptiveExpansionBatch({
        alreadySelectedRepositoryKeys: new Set(repositories.map(repository => repository.repositoryKey)),
        phase: 0,
        remainingMilliseconds: 1_000,
        repositories,
      }),
    ).toMatchObject({repositories: [], stopReason: 'exhaustion'});
  });

  it('never expands a batch when deadline or resource pressure becomes stricter', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 1, max: 128}),
        fc.integer({min: 50, max: 20_000}),
        fc.integer({min: 0, max: 19_950}),
        (count, milliseconds, reduction) => {
          const repositories = candidates(count);
          const relaxed = selectCodeGraphWorksetAdaptiveExpansionBatch({
            memoryPressure: 'normal',
            openDatabaseBudget: 8,
            phase: 2,
            remainingMilliseconds: milliseconds,
            repositories,
          });
          const strict = selectCodeGraphWorksetAdaptiveExpansionBatch({
            activeGraphBuilds: 4,
            memoryPressure: 'high',
            openDatabaseBudget: 1,
            phase: 2,
            remainingMilliseconds: Math.max(0, milliseconds - reduction),
            repositories,
          });
          expect(strict.repositories.length).toBeLessThanOrEqual(relaxed.repositories.length);
          expect(strict.repositories).toEqual(relaxed.repositories.slice(0, strict.repositories.length));
        },
      ),
      {numRuns: 100},
    );
  });
});

function candidates(count: number): readonly CodeGraphWorksetRouterRepositoryCandidateV1[] {
  return Array.from({length: count}, (_, index) => ({
    bestSymbolKey: `symbol-${index}`,
    exactSymbolCount: 0,
    matchingSymbolCount: 1,
    projectionDigest: `${(index % 16).toString(16)}`.repeat(64),
    rank: index + 1,
    repositoryId: `${((index + 1) % 16).toString(16)}`.repeat(64),
    repositoryKey: `repository-${index}`,
    score: 1_000 - index,
    scoreReceipt: {
      bestSymbolContribution: 1_000 - index,
      exactMatchContribution: 0,
      supportingSymbolContribution: 0,
      total: 1_000 - index,
      version: 1,
    },
    snapshotId: `snapshot-${index}`,
  }));
}
