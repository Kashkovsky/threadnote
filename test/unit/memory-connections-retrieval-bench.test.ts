import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  assertApprovedMemoryConnectionsRetrievalBenchFixture,
  MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES,
  MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH,
  memoryConnectionsRetrievalBenchFixtureHash,
  parseMemoryConnectionsRetrievalBenchFixtureV1,
} from '../../src/evaluation/memory-connections-retrieval-bench-contract.js';
import {runMemoryConnectionsRetrievalBench} from '../../src/evaluation/memory-connections-retrieval-bench.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const FIXTURE_URL = new URL(
  '../evaluation/fixtures/memory-connections-retrieval-bench-v1/fixture.json',
  import.meta.url,
);

describe('MemoryConnections retrieval benchmark', () => {
  effectIt.effect('freezes and passes the production one-hop/currentness contract', () =>
    Effect.gen(function* () {
      const result = yield* runMemoryConnectionsRetrievalBench();
      expect(result.gate).toEqual({failures: [], passed: true});
      expect(result.fixtureHash).toBe(MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH);
      expect(result.metrics).toMatchObject({
        authorizationLeaks: 0,
        currentnessAccuracy: 1,
        duplicateResults: 0,
        falseAuthorityClaims: 0,
        noAnswerAccuracy: 1,
        precision: 1,
        recall: 1,
      });
      expect(result.metrics.maximumEstimatedTokens).toBeLessThanOrEqual(1_500);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects fixture drift and covers every planned ability', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const raw = JSON.parse(yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE_URL))) as unknown;
      const fixture = parseMemoryConnectionsRetrievalBenchFixtureV1(raw);
      expect(fixture.abilities).toEqual(MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES);
      expect(memoryConnectionsRetrievalBenchFixtureHash(fixture)).toBe(
        MEMORY_CONNECTIONS_RETRIEVAL_BENCH_APPROVED_FIXTURE_HASH,
      );
      expect(() => assertApprovedMemoryConnectionsRetrievalBenchFixture(fixture)).not.toThrow();
      expect(() => parseMemoryConnectionsRetrievalBenchFixtureV1({...fixture, depth: 2})).toThrow(
        'unsupported or missing fields',
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('rejects an empty fixture before it can masquerade as passing evidence', () => {
    expect(() =>
      parseMemoryConnectionsRetrievalBenchFixtureV1({
        abilities: MEMORY_CONNECTIONS_RETRIEVAL_BENCH_ABILITIES,
        cases: [],
        documents: [],
        id: 'memory-connections-retrieval-bench-v1',
        version: 1,
      }),
    ).toThrow('documents must be non-empty');
  });
});
