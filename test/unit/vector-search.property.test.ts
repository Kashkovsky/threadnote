import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  normalizeVector,
  searchExactVectors,
  type VectorRecord,
  type VectorSearchResult,
} from '../../src/search/vector-search.js';

const componentArbitrary = FC.integer({max: 100, min: -100});
const nonZeroComponentArbitrary = FC.oneof(FC.integer({max: -1, min: -100}), FC.integer({max: 100, min: 1}));
const VECTOR_ID_LABELS = [
  '!bang',
  '-dash',
  '0digit',
  'A-upper',
  '_under',
  'a-lower',
  'é-accent',
  'Ω-greek',
  '中-cjk',
  '😀-emoji',
] as const;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonZeroVectorArbitrary(dimensions: number): FC.Arbitrary<readonly number[]> {
  return FC.tuple(
    nonZeroComponentArbitrary,
    FC.array(componentArbitrary, {maxLength: dimensions - 1, minLength: dimensions - 1}),
  ).map(([head, tail]) => [head, ...tail]);
}

function oracleNormalize(vector: readonly number[]): readonly number[] {
  const inverseMagnitude = 1 / Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  return vector.map(component => component * inverseMagnitude);
}

function oracleSearch(
  query: readonly number[],
  records: readonly VectorRecord[],
  options: {readonly limit: number; readonly minimumScore: number},
): readonly VectorSearchResult[] {
  const normalizedQuery = oracleNormalize(query);
  return records
    .map(record => {
      const dotProduct = record.vector.reduce(
        (score, component, index) => score + component * normalizedQuery[index]!,
        0,
      );
      return {id: record.id, score: Math.max(-1, Math.min(1, dotProduct))};
    })
    .filter(result => result.score >= options.minimumScore)
    .sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id))
    .slice(0, options.limit);
}

const vectorSearchCaseArbitrary = FC.integer({max: 8, min: 1}).chain(dimensions =>
  FC.uniqueArray(FC.integer({max: 999, min: 0}), {maxLength: 24, minLength: 0}).chain(ids =>
    FC.tuple(
      nonZeroVectorArbitrary(dimensions),
      FC.array(nonZeroVectorArbitrary(dimensions).map(oracleNormalize), {
        maxLength: ids.length,
        minLength: ids.length,
      }),
      FC.array(FC.constantFrom(...VECTOR_ID_LABELS), {
        maxLength: ids.length,
        minLength: ids.length,
      }),
      FC.integer({max: 28, min: 0}),
      FC.integer({max: 100, min: -100}),
    ).chain(([query, vectors, labels, limit, minimumScorePercent]) => {
      const records = ids.map((id, index): VectorRecord => ({
        id: `${labels[index]}-${String(id).padStart(3, '0')}`,
        vector: vectors[index]!,
      }));
      return FC.shuffledSubarray(records, {maxLength: records.length, minLength: records.length}).map(permutation => ({
        dimensions,
        limit,
        minimumScore: minimumScorePercent / 100,
        permutation,
        query,
        records,
      }));
    }),
  ),
);

describe('exact vector search properties', () => {
  it.prop(
    'normalization produces a finite unit vector and is invariant under positive scaling',
    {
      scale: FC.constantFrom(0.25, 0.5, 2, 4, 8),
      vector: FC.integer({max: 8, min: 1}).chain(nonZeroVectorArbitrary),
    },
    ({scale, vector}) => {
      const input = [...vector];
      const normalized = normalizeVector(vector);
      const renormalized = normalizeVector(normalized);
      const scaled = normalizeVector(vector.map(component => component * scale));

      expect(vector).toEqual(input);
      expect(normalized).toHaveLength(vector.length);
      expect(normalized.every(Number.isFinite)).toBe(true);
      expect(Math.sqrt(normalized.reduce((sum, component) => sum + component * component, 0))).toBeCloseTo(1, 12);
      normalized.forEach((component, index) => {
        expect(renormalized[index]).toBeCloseTo(component, 12);
        expect(scaled[index]).toBeCloseTo(component, 12);
      });
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'matches a full-sort oracle and is independent of record permutation',
    {searchCase: vectorSearchCaseArbitrary},
    ({searchCase}) => {
      const {dimensions, limit, minimumScore, permutation, query, records} = searchCase;
      const options = {dimensions, limit, minimumScore};
      const expected = oracleSearch(query, records, {limit, minimumScore});
      const actual = searchExactVectors(query, records, options);
      const permuted = searchExactVectors(query, permutation, options);

      expect(actual).toEqual(expected);
      expect(permuted).toEqual(expected);
      expect(actual).toHaveLength(Math.min(expected.length, limit));
      expect(actual.length).toBeLessThanOrEqual(records.length);
      expect(new Set(actual.map(result => result.id)).size).toBe(actual.length);
      for (const result of actual) {
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(-1);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.score).toBeGreaterThanOrEqual(minimumScore);
      }
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'orders exact score ties by locale-independent ID regardless of input order',
    {
      ids: FC.uniqueArray(FC.constantFrom(...VECTOR_ID_LABELS), {
        maxLength: VECTOR_ID_LABELS.length,
        minLength: 2,
      }),
    },
    ({ids}) => {
      const records = ids.map((id): VectorRecord => ({
        id,
        vector: [1, 0],
      }));
      const expectedIds = records.map(record => record.id).sort(compareCodeUnits);

      expect(
        searchExactVectors([1, 0], records, {dimensions: 2, limit: records.length}).map(result => result.id),
      ).toEqual(expectedIds);
      expect(
        searchExactVectors([1, 0], [...records].reverse(), {dimensions: 2, limit: records.length}).map(
          result => result.id,
        ),
      ).toEqual(expectedIds);
    },
    {fastCheck: {numRuns: 75}},
  );
});
