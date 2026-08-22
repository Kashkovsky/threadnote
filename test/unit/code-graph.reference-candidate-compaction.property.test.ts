import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {codeGraphPersistentReferencePageStatement} from '../../src/code_graph/store.js';

interface CandidateMetadata {
  readonly candidateCount: number;
  readonly payloadBytes: number;
}

describe('persistent reference candidate compaction', () => {
  it('selects an ordered prefix bounded by references, candidates, and payload bytes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            candidateCount: fc.integer({max: 20, min: 0}),
            payloadBytes: fc.integer({max: 80, min: 1}),
          }),
          {maxLength: 60},
        ),
        fc.record({
          candidateCount: fc.integer({max: 80, min: 1}),
          cursorIndex: fc.integer({max: 60, min: 0}),
          payloadBytes: fc.integer({max: 240, min: 1}),
          references: fc.integer({max: 12, min: 1}),
        }),
        (metadata, limits) => {
          const database = candidateDatabase(metadata);
          try {
            const cursor = limits.cursorIndex === 0 ? '' : edgeId(Math.min(limits.cursorIndex, metadata.length));
            const statement = codeGraphPersistentReferencePageStatement('snapshot', cursor, limits);
            const actual = database.query(statement.text).all(...statement.parameters) as readonly {
              readonly candidate_count: number;
              readonly candidate_payload_bytes: number;
              readonly edge_id: string;
            }[];
            const eligible = metadata
              .map((value, index) => ({...value, edgeId: edgeId(index + 1)}))
              .filter(value => value.edgeId > cursor)
              .slice(0, limits.references);
            const expected = boundedPrefix(eligible, limits.candidateCount, limits.payloadBytes);

            expect(actual.map(row => row.edge_id)).toEqual(expected.map(row => row.edgeId));
            expect(actual.length).toBeLessThanOrEqual(limits.references);
            expect(actual.reduce((total, row) => total + row.candidate_count, 0)).toBeLessThanOrEqual(
              limits.candidateCount,
            );
            expect(actual.reduce((total, row) => total + row.candidate_payload_bytes, 0)).toBeLessThanOrEqual(
              limits.payloadBytes,
            );
          } finally {
            database.close(false);
          }
        },
      ),
      {numRuns: 200},
    );
  });

  it('accepts exact first-row limits and rejects either first-row overflow', () => {
    const database = candidateDatabase([
      {candidateCount: 7, payloadBytes: 11},
      {candidateCount: 1, payloadBytes: 1},
    ]);
    try {
      const exact = codeGraphPersistentReferencePageStatement('snapshot', '', {
        candidateCount: 7,
        payloadBytes: 11,
        references: 1,
      });
      expect(database.query(exact.text).all(...exact.parameters)).toHaveLength(1);
      const candidateOverflow = codeGraphPersistentReferencePageStatement('snapshot', '', {
        candidateCount: 6,
        payloadBytes: 11,
        references: 1,
      });
      expect(database.query(candidateOverflow.text).all(...candidateOverflow.parameters)).toEqual([]);
      const payloadOverflow = codeGraphPersistentReferencePageStatement('snapshot', '', {
        candidateCount: 7,
        payloadBytes: 10,
        references: 1,
      });
      expect(database.query(payloadOverflow.text).all(...payloadOverflow.parameters)).toEqual([]);
    } finally {
      database.close(false);
    }
  });
});

function candidateDatabase(metadata: readonly CandidateMetadata[]): Database {
  const database = new Database(':memory:', {strict: true});
  database.exec(`
    CREATE TABLE building_references (
      snapshot_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      lookup_tiers_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL,
      candidate_payload_bytes INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  const insert = database.prepare(
    `INSERT INTO building_references (
       snapshot_id, edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes
     ) VALUES ('snapshot', ?, '[]', ?, ?)`,
  );
  database.transaction(() => {
    for (const [index, value] of metadata.entries()) {
      insert.run(edgeId(index + 1), value.candidateCount, value.payloadBytes);
    }
  })();
  return database;
}

function boundedPrefix(
  values: readonly (CandidateMetadata & {readonly edgeId: string})[],
  candidateLimit: number,
  payloadLimit: number,
) {
  const selected: Array<CandidateMetadata & {readonly edgeId: string}> = [];
  let candidates = 0;
  let payloadBytes = 0;
  for (const value of values) {
    if (candidates + value.candidateCount > candidateLimit || payloadBytes + value.payloadBytes > payloadLimit) {
      break;
    }
    selected.push(value);
    candidates += value.candidateCount;
    payloadBytes += value.payloadBytes;
  }
  return selected;
}

function edgeId(index: number): string {
  return `edge-${String(index).padStart(3, '0')}`;
}
