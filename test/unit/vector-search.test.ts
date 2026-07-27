import {describe, expect, it} from 'vitest';
import {normalizeVector, searchExactVectors} from '../../src/search/vector-search.js';
import {decodeVectorSidecar, encodeVectorSidecar, VectorSidecarInvalid} from '../../src/search/vector-sidecar.js';

const modelSha256 = 'a'.repeat(64);

describe('exact vector search', () => {
  it('normalizes query vectors and applies deterministic score/id ordering', () => {
    const diagonal = normalizeVector([1, 1]);
    const results = searchExactVectors(
      [4, 0],
      [
        {id: 'z', vector: [1, 0]},
        {id: 'a', vector: [1, 0]},
        {id: 'diagonal', vector: diagonal},
        {id: 'opposite', vector: [-1, 0]},
      ],
      {dimensions: 2, limit: 3, minimumScore: 0},
    );
    expect(results.slice(0, 2)).toEqual([
      {id: 'a', score: 1},
      {id: 'z', score: 1},
    ]);
    expect(results[2]?.id).toBe('diagonal');
    expect(results[2]?.score).toBeCloseTo(Math.SQRT1_2);
  });

  it('rejects mixed dimensions, duplicate IDs, non-finite components, and zero queries', () => {
    expect(() => searchExactVectors([0, 0], [], {dimensions: 2, limit: 1})).toThrow('magnitude');
    expect(() =>
      searchExactVectors(
        [1, 0],
        [
          {id: 'same', vector: [1, 0]},
          {id: 'same', vector: [0, 1]},
        ],
        {dimensions: 2, limit: 1},
      ),
    ).toThrow('Duplicate');
    expect(() => searchExactVectors([1, 0], [{id: 'bad', vector: [1]}], {dimensions: 2, limit: 1})).toThrow(
      'dimensions',
    );
    expect(() => searchExactVectors([1, 0], [{id: 'bad', vector: [Number.NaN, 0]}], {dimensions: 2, limit: 1})).toThrow(
      'finite',
    );
  });

  it('keeps deterministic top-K results while validating every record at limit zero', () => {
    const records = Array.from({length: 2_000}, (_, index) => ({
      id: `record-${String(index).padStart(4, '0')}`,
      vector: normalizeVector([index + 1, 2_000 - index]),
    }));
    const expected = records
      .map(record => ({id: record.id, score: record.vector[0]!}))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, 7);

    expect(searchExactVectors([1, 0], records, {dimensions: 2, limit: 7})).toEqual(expected);
    expect(() =>
      searchExactVectors(
        [1, 0],
        [
          {id: 'same', vector: [1, 0]},
          {id: 'same', vector: [0, 1]},
        ],
        {dimensions: 2, limit: 0},
      ),
    ).toThrow('Duplicate');
  });
});

describe('packed vector sidecar', () => {
  it('round-trips versioned metadata and normalized float32 vectors', () => {
    const diagonal = normalizeVector([1, 1]);
    const encoded = encodeVectorSidecar({
      entries: [
        {
          fingerprint: 'doc-a-sha',
          id: 'doc-a#0',
          uri: 'viking://resources/repos/threadnote/doc-a.md',
          vector: [1, 0],
        },
        {
          fingerprint: 'doc-b-sha',
          id: 'doc-b#0',
          uri: 'viking://resources/repos/threadnote/doc-b.md',
          vector: diagonal,
        },
      ],
      metadata: {
        chunkerVersion: 1,
        dimensions: 2,
        modelId: 'embedding-fixture',
        modelSha256,
        normalized: 'l2',
      },
      version: 1,
    });
    const decoded = decodeVectorSidecar(encoded);
    expect(decoded.metadata).toEqual({
      chunkerVersion: 1,
      dimensions: 2,
      modelId: 'embedding-fixture',
      modelSha256,
      normalized: 'l2',
    });
    expect(
      decoded.entries.map(entry => ({...entry, vector: entry.vector.map(value => Number(value.toFixed(6)))})),
    ).toEqual([
      {
        fingerprint: 'doc-a-sha',
        id: 'doc-a#0',
        uri: 'viking://resources/repos/threadnote/doc-a.md',
        vector: [1, 0],
      },
      {
        fingerprint: 'doc-b-sha',
        id: 'doc-b#0',
        uri: 'viking://resources/repos/threadnote/doc-b.md',
        vector: [0.707107, 0.707107],
      },
    ]);
  });

  it('detects payload corruption and incompatible embedding metadata', () => {
    const encoded = encodeVectorSidecar({
      entries: [{fingerprint: 'sha', id: 'doc', uri: 'viking://doc', vector: [1, 0]}],
      metadata: {
        chunkerVersion: 1,
        dimensions: 2,
        modelId: 'fixture',
        modelSha256,
        normalized: 'l2',
      },
      version: 1,
    });
    encoded[encoded.length - 1] ^= 1;
    expect(() => decodeVectorSidecar(encoded)).toThrow(VectorSidecarInvalid);
    expect(() =>
      encodeVectorSidecar({
        entries: [{fingerprint: 'sha', id: 'doc', uri: 'viking://doc', vector: [0.5, 0]}],
        metadata: {
          chunkerVersion: 1,
          dimensions: 2,
          modelId: 'fixture',
          modelSha256,
          normalized: 'l2',
        },
        version: 1,
      }),
    ).toThrow('not L2-normalized');
  });
});
