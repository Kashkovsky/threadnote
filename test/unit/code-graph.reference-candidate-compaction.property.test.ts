import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphPersistentReferencePageStatement,
  codeGraphPruneLookupSummariesStatement,
} from '../../src/code_graph/store.js';

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

  it('prunes prior summaries through lookup-key primary-key probes', () => {
    const database = lookupSummaryDatabase();
    try {
      const plan = database
        .query(`EXPLAIN QUERY PLAN ${codeGraphPruneLookupSummariesStatement()}`)
        .all()
        .map(row => (row as {readonly detail: string}).detail);
      expect(plan).toContain('SEARCH candidate USING PRIMARY KEY (lookup_key=?)');
    } finally {
      database.close(false);
    }
  });

  it('retains exactly prior summaries requested by the current page regardless of candidate order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            domain: fc.stringMatching(/^[x-z]{1,3}$/u),
            lookupKey: fc.stringMatching(/^[a-f]{1,5}$/u),
            symbolCount: fc.integer({max: 5, min: 0}),
          }),
          {
            maxLength: 300,
            selector: row => `${row.lookupKey}\0${row.domain}`,
          },
        ),
        fc.uniqueArray(
          fc.record({
            edgeId: fc.integer({max: 30, min: 0}).map(index => `edge-${index}`),
            lookupKey: fc.stringMatching(/^[a-f]{1,5}$/u),
            tier: fc.integer({max: 5, min: 0}),
          }),
          {
            maxLength: 300,
            selector: row => `${row.lookupKey}\0${row.edgeId}\0${row.tier}`,
          },
        ),
        (summaries, candidates) => {
          const currentKeys = new Set(candidates.map(candidate => candidate.lookupKey));
          const expected = summaries
            .filter(summary => currentKeys.has(summary.lookupKey))
            .sort(
              (left, right) => left.lookupKey.localeCompare(right.lookupKey) || left.domain.localeCompare(right.domain),
            );
          expect(prunedLookupSummaries(summaries, candidates)).toEqual(expected);
          expect(prunedLookupSummaries(summaries, [...candidates].reverse())).toEqual(expected);
          expect(expected.length).toBeLessThanOrEqual(summaries.length);
        },
      ),
      {numRuns: 200},
    );
  });
});

interface LookupCandidate {
  readonly edgeId: string;
  readonly lookupKey: string;
  readonly tier: number;
}

interface LookupSummary {
  readonly domain: string;
  readonly lookupKey: string;
  readonly symbolCount: number;
}

function prunedLookupSummaries(
  summaries: readonly LookupSummary[],
  candidates: readonly LookupCandidate[],
): readonly LookupSummary[] {
  const database = lookupSummaryDatabase();
  try {
    const insertCandidate = database.prepare(
      'INSERT INTO activation_resolution_candidate_page (lookup_key, edge_id, tier) VALUES (?, ?, ?)',
    );
    const insertSummary = database.prepare(
      `INSERT INTO activation_resolution_lookup_page (lookup_key, resolution_domain, symbol_count)
       VALUES (?, ?, ?)`,
    );
    database.transaction(() => {
      for (const summary of summaries) insertSummary.run(summary.lookupKey, summary.domain, summary.symbolCount);
      for (const candidate of candidates) insertCandidate.run(candidate.lookupKey, candidate.edgeId, candidate.tier);
    })();
    database.exec(codeGraphPruneLookupSummariesStatement());
    return database
      .query<{readonly lookup_key: string; readonly resolution_domain: string; readonly symbol_count: number}, []>(
        `SELECT lookup_key, resolution_domain, symbol_count
         FROM activation_resolution_lookup_page
         ORDER BY lookup_key, resolution_domain`,
      )
      .all()
      .map(row => ({domain: row.resolution_domain, lookupKey: row.lookup_key, symbolCount: row.symbol_count}));
  } finally {
    database.close(false);
  }
}

function lookupSummaryDatabase(): Database {
  const database = new Database(':memory:', {strict: true});
  database.exec(`
    CREATE TEMP TABLE activation_resolution_candidate_page (
      lookup_key TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      PRIMARY KEY (lookup_key, edge_id, tier)
    ) WITHOUT ROWID;
    CREATE TEMP TABLE activation_resolution_lookup_page (
      lookup_key TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      symbol_count INTEGER NOT NULL,
      PRIMARY KEY (lookup_key, resolution_domain)
    ) WITHOUT ROWID
  `);
  return database;
}

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
