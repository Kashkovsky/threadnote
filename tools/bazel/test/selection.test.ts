import fc from 'fast-check';
import {expect, it} from 'vitest';
import {selectTargets} from '../../ci/selection.mjs';

const inventory = ['//:graph_test', '//apps/website:build', '//apps/website:content_test'];
const select = (impacted: string[], changedFiles = ['apps/website/src/page.tsx'], failure?: string) =>
  selectTargets({
    inventory,
    impacted,
    changedFiles,
    knownInputs: ['apps/website/src/page.tsx'],
    targetInputs: {'//apps/website:build': ['apps/website/src/page.tsx']},
    failure,
  });

it('selects no graph target for website-only graph impact, independent of cache state', () => {
  expect(select(['//apps/website:content_test', '//apps/website:build']).targets).toEqual([
    '//apps/website:build',
    '//apps/website:content_test',
  ]);
});

it('falls back to every modeled target for absent evidence and unknown inputs', () => {
  expect(select([], [], 'missing baseline').targets).toEqual([...inventory].sort());
  expect(select([], ['new/unmodeled.ts']).mode).toBe('fallback');
  expect(select([], ['new/unmodeled.ts']).targets).toEqual([...inventory].sort());
});

it('selects inventory-only CI and native targets from their declared inputs', () => {
  const result = selectTargets({
    inventory: ['//:workflow_validation', '//infra/gateway:go_test'],
    impacted: [],
    changedFiles: ['.github/workflows/ci.yml'],
    knownInputs: ['.github/workflows/ci.yml', 'infra/gateway/main.go'],
    targetInputs: {
      '//:workflow_validation': ['.github/workflows/ci.yml'],
      '//infra/gateway:go_test': ['infra/gateway/main.go'],
    },
  });
  expect(result).toMatchObject({mode: 'selective', targets: ['//:workflow_validation']});
});

it('propagates impacted Bazel targets into dependent CI lanes', () => {
  const result = selectTargets({
    inventory: ['//:recall_quality', '//:release_matrix', '//:threadnote_build', '//packages/inference:test'],
    impacted: ['//:threadnote_build', '//packages/inference:test'],
    changedFiles: ['packages/inference/src/provider.ts'],
    knownInputs: ['packages/inference/src/provider.ts'],
    targetDependencies: {
      '//:recall_quality': ['//packages/inference:test'],
      '//:release_matrix': ['//:threadnote_build'],
    },
  });

  expect(result.targets).toEqual([
    '//:recall_quality',
    '//:release_matrix',
    '//:threadnote_build',
    '//packages/inference:test',
  ]);
});

it('is deterministic and monotone as additional impacted targets are discovered', () => {
  fc.assert(
    fc.property(fc.subarray(inventory), fc.subarray(inventory), (first, second) => {
      const result = select([...first, ...second], []).targets;
      expect(result).toEqual([...new Set([...first, ...second])].sort());
      expect(result).toEqual(select([...second, ...first, ...first], []).targets);
      expect(select(first, []).targets.every(target => result.includes(target))).toBe(true);
    }),
    {numRuns: 50},
  );
});
