import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphPersistentLookupMatchStatement,
  codeGraphPersistentReferencePageStatement,
  type PersistedLookupSummary,
  type PersistedReferenceResolutionInput,
  resolvePersistedReferenceSelections,
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

  it('probes exact lookup pairs through the durable primary key without a TEMP sort', () => {
    const database = lookupDatabase();
    try {
      const statement = codeGraphPersistentLookupMatchStatement(
        'snapshot',
        [
          ['typescript:name:alpha', 'typescript'],
          ['java:name:alpha', 'java'],
        ],
        1,
      );
      const plan = database
        .query(`EXPLAIN QUERY PLAN ${statement.text}`)
        .all(...statement.parameters)
        .map(row => (row as {readonly detail: string}).detail);
      expect(plan).toContain('SEARCH lookup USING PRIMARY KEY (snapshot_id=? AND lookup_key=?)');
      expect(plan.some(detail => detail.includes('USE TEMP B-TREE'))).toBe(false);
      expect(database.query(statement.text).all(...statement.parameters)).toHaveLength(2);
    } finally {
      database.close(false);
    }
  });

  it('matches an independent raw-row model across tiers, domains, exports, ambiguity, and overrides', () => {
    fc.assert(
      fc.property(resolutionCaseArbitrary, testCase => {
        const summaries = lookupSummaries(testCase.rows);
        const expected = rawResolutionModel(testCase.references, testCase.rows);
        const actual = resolvePersistedReferenceSelections(testCase.references, summaries);
        const reversed = resolvePersistedReferenceSelections(
          [...testCase.references]
            .reverse()
            .map(reference => ({...reference, lookupTiers: reference.lookupTiers.map(tier => [...tier].reverse())})),
          [...summaries].reverse(),
        );

        expect(normalizedSelections(actual)).toEqual(expected);
        expect(normalizedSelections(reversed)).toEqual(expected);
      }),
      {numRuns: 300},
    );
  });
});

const lookupKeys = ['key-a', 'key-b', 'key-c', 'key-d'] as const;
const resolutionDomains = ['java', 'typescript'] as const;
const symbolIds = ['symbol-0', 'symbol-1', 'symbol-2', 'symbol-3', 'symbol-4'] as const;

interface RawLookupRow {
  readonly exported: boolean;
  readonly lookupKey: (typeof lookupKeys)[number];
  readonly resolutionDomain: (typeof resolutionDomains)[number];
  readonly symbolId: (typeof symbolIds)[number];
}

const rawLookupRowsArbitrary = fc.uniqueArray(
  fc.record({
    exported: fc.boolean(),
    lookupKey: fc.constantFrom(...lookupKeys),
    resolutionDomain: fc.constantFrom(...resolutionDomains),
    symbolId: fc.constantFrom(...symbolIds),
  }),
  {maxLength: 20, selector: row => `${row.lookupKey}\0${row.symbolId}`},
);

const resolutionCaseArbitrary = rawLookupRowsArbitrary.chain(rows =>
  fc
    .array(
      fc.record({
        exportedOnly: fc.boolean(),
        lookupTiers: fc.array(fc.uniqueArray(fc.constantFrom(...lookupKeys), {maxLength: 4}), {maxLength: 4}),
        relation: fc.constantFrom('calls', 'overrides'),
        resolutionDomain: fc.constantFrom(...resolutionDomains),
        sourceId: fc.option(fc.constantFrom(...symbolIds), {nil: undefined}),
      }),
      {maxLength: 20},
    )
    .map(references => ({
      references: references.map((reference, index) => ({...reference, edgeId: `edge-${index}`})),
      rows,
    })),
);

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

function lookupDatabase(): Database {
  const database = new Database(':memory:', {strict: true});
  database.exec(`
    CREATE TABLE snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id)
    ) WITHOUT ROWID;
    INSERT INTO snapshot_symbol_lookup VALUES
      ('snapshot', 'typescript:name:alpha', 'symbol-a', 'typescript', 1),
      ('snapshot', 'typescript:name:alpha', 'symbol-b', 'typescript', 0),
      ('snapshot', 'java:name:alpha', 'symbol-c', 'java', 1);
  `);
  return database;
}

function lookupSummaries(rows: readonly RawLookupRow[]): readonly PersistedLookupSummary[] {
  const grouped = new Map<string, RawLookupRow[]>();
  for (const row of rows) {
    const key = `${row.lookupKey}\0${row.resolutionDomain}`;
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [row]);
    else group.push(row);
  }
  return [...grouped.values()].map(group => {
    const ids = group.map(row => row.symbolId).sort();
    const exportedIds = group
      .filter(row => row.exported)
      .map(row => row.symbolId)
      .sort();
    return {
      exportedSymbolCount: exportedIds.length,
      lookupKey: group[0]!.lookupKey,
      ...(exportedIds.at(-1) === undefined ? {} : {maximumExportedSymbolId: exportedIds.at(-1)}),
      ...(ids.at(-1) === undefined ? {} : {maximumSymbolId: ids.at(-1)}),
      ...(exportedIds[0] === undefined ? {} : {minimumExportedSymbolId: exportedIds[0]}),
      ...(ids[0] === undefined ? {} : {minimumSymbolId: ids[0]}),
      resolutionDomain: group[0]!.resolutionDomain,
      symbolCount: ids.length,
    };
  });
}

function rawResolutionModel(references: readonly PersistedReferenceResolutionInput[], rows: readonly RawLookupRow[]) {
  const resolved: Array<{readonly edgeId: string; readonly symbolId: string}> = [];
  for (const reference of references) {
    for (const tier of reference.lookupTiers) {
      const options = tier.map(lookupKey =>
        rows.filter(
          row =>
            row.lookupKey === lookupKey &&
            row.resolutionDomain === reference.resolutionDomain &&
            (!reference.exportedOnly || row.exported) &&
            (reference.relation !== 'overrides' || row.symbolId !== reference.sourceId),
        ),
      );
      if (options.every(option => option.length === 0)) continue;
      const symbolIds = new Set(options.flatMap(option => option.map(row => row.symbolId)));
      if (options.every(option => option.length <= 1) && symbolIds.size === 1) {
        resolved.push({edgeId: reference.edgeId, symbolId: symbolIds.values().next().value!});
      }
      break;
    }
  }
  return normalizedSelections(resolved);
}

function normalizedSelections(selections: readonly {readonly edgeId: string; readonly symbolId: string}[]) {
  return [...selections].sort(
    (left, right) => left.edgeId.localeCompare(right.edgeId) || left.symbolId.localeCompare(right.symbolId),
  );
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
