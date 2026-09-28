import fc from 'fast-check';
import {expect, it} from 'vitest';
import {dependencyClosure} from '../dependency-closure.mjs';

it('includes cycles and shared dependencies exactly once', () => {
  const graph = {a: ['b', 'c'], b: ['a', 'c'], c: []};
  expect(dependencyClosure('a', key => graph[key as keyof typeof graph])).toEqual(['a', 'b', 'c']);
});

it('matches reachability and is deterministic for bounded dependency graphs', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({min: 0, max: 7}), fc.integer({min: 0, max: 7})), {maxLength: 24}),
      edges => {
        const reach = Array.from({length: 8}, (_, from) => Array.from({length: 8}, (_, to) => from === to));
        for (const [from, to] of edges) reach[from][to] = true;
        for (let via = 0; via < 8; via++) {
          for (let from = 0; from < 8; from++) {
            for (let to = 0; to < 8; to++) reach[from][to] ||= reach[from][via] && reach[via][to];
          }
        }
        const dependencies = (key: string) =>
          edges.filter(([from]) => String(from) === key).map(([, to]) => String(to));
        const expected = reach[0].flatMap((reachable, to) => (reachable ? [String(to)] : []));
        expect(dependencyClosure('0', dependencies)).toEqual(expected);
        expect(dependencyClosure('0', key => dependencies(key).reverse())).toEqual(expected);
      },
    ),
    {numRuns: 50},
  );
});
