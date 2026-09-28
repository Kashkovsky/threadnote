import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {planBazelShards} from '../bazel-shards.mjs';

const targetArbitrary = fc
  .uniqueArray(
    fc.record({
      entries: fc.array(fc.string(), {maxLength: 20}),
      id: fc.integer({max: 100, min: 0}),
      inputs: fc.array(fc.string(), {maxLength: 100}),
      kind: fc.constantFrom('action', 'ci', 'library', 'test'),
      requiresNetwork: fc.boolean(),
      selected: fc.boolean(),
      timeout: fc.option(fc.constant('long'), {nil: null}),
    }),
    {maxLength: 30, selector: target => target.id},
  )
  .map(targets =>
    targets.map(target => ({
      ...target,
      label: `//generated:target_${target.id}`,
    })),
  );

describe('Bazel CI sharding', () => {
  it('isolates PostgreSQL targets and greedily balances the remaining work', () => {
    const inventory = [
      target('//apps/threadnote:test_1', 63),
      target('//apps/threadnote:test_2', 62),
      target('//packages/graph:test', 140),
      target('//packages/store:test', 2),
      {...target('//apps/threadnote:test_postgres', 11), requiresNetwork: true},
      {...target('//:recall_quality', 0), kind: 'ci'},
    ];

    const shards = planBazelShards({inventory, selected: inventory.map(candidate => candidate.label), maxShards: 4});

    expect(shards).toHaveLength(4);
    expect(shards.flatMap(shard => shard.targets).sort()).toEqual(
      inventory
        .filter(candidate => candidate.kind === 'test')
        .map(candidate => candidate.label)
        .sort(),
    );
    expect(shards.find(shard => shard.postgres)?.targets).toContain('//apps/threadnote:test_postgres');
  });

  it('is deterministic, bounded, complete, and duplicate-free for generated inventories', () => {
    fc.assert(
      fc.property(targetArbitrary, fc.integer({max: 8, min: 1}), (inventory, maxShards) => {
        const selected = inventory.filter(target => target.selected).map(target => target.label);
        const executable = inventory
          .filter(target => target.selected && (target.kind === 'action' || target.kind === 'test'))
          .map(target => target.label)
          .sort();
        const first = planBazelShards({inventory, selected, maxShards});
        const second = planBazelShards({
          inventory: [...inventory].reverse(),
          selected: [...selected].reverse(),
          maxShards,
        });
        const planned = first.flatMap(shard => shard.targets);

        expect(first).toEqual(second);
        expect(first.length).toBeLessThanOrEqual(maxShards);
        expect(planned.sort()).toEqual(executable);
        expect(new Set(planned).size).toBe(planned.length);
        for (const target of inventory.filter(
          candidate =>
            candidate.selected &&
            candidate.requiresNetwork &&
            (candidate.kind === 'action' || candidate.kind === 'test'),
        )) {
          expect(first.find(shard => shard.targets.includes(target.label))?.postgres).toBe(true);
        }
      }),
      {numRuns: 100},
    );
  });
});

function target(label: string, entryCount: number) {
  return {
    entries: Array.from({length: entryCount}, (_, index) => `test-${index}.ts`),
    inputs: [],
    kind: 'test',
    label,
    requiresNetwork: false,
    timeout: null,
  };
}
