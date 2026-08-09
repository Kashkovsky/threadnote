import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {
  codeGraphUtf8ByteLength,
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM} from './fact_budget.js';
import {compareCodeUnits} from './ordering.js';
import {
  type CodeGraphReusableReexport,
  type CodeGraphStagingBatch,
  type CodeGraphStagingStage,
} from './store_models.js';
import {
  type CodeGraphEdge,
  type CodeGraphInventoryFile,
  type CodeGraphProvenance,
  type CodeGraphReference,
  type CodeGraphSnapshot,
  type CodeGraphSymbol,
  CodeGraphStoreError,
} from './types.js';
import {type CodeGraphBuildWorkspace, type CodeGraphWorkspaceProject} from './languages/types.js';
import {chunk, lookupDomain, sortedBy, symbolTerms, uniqueBy} from './store_utilities.js';
import {lastStatementChangeCount} from './store_activation_core.js';
import {type EdgeRow} from './store_internal_models.js';

function persistentSnapshotBuildIdentityMatches(current: CodeGraphSnapshot, requested: CodeGraphSnapshot): boolean {
  return (
    current.repositoryId === requested.repositoryId &&
    current.commit === requested.commit &&
    (current.graphContentId ?? current.id) === (requested.graphContentId ?? requested.id) &&
    current.dirty === requested.dirty &&
    current.extractorSet === requested.extractorSet &&
    current.baseSnapshotId === requested.baseSnapshotId &&
    current.overlayFingerprint === requested.overlayFingerprint
  );
}

const assertPersistentBuildOwner = Effect.fn('codeGraph.assertPersistentBuildOwner')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
) {
  const rows = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT snapshot.state
    FROM snapshots AS snapshot
    JOIN snapshot_build_owners AS owner ON owner.snapshot_id = snapshot.id
    WHERE snapshot.id = ${snapshotId} AND owner.owner_token = ${ownerToken}
    LIMIT 1
  `;
  if (!rows[0] || !['building', 'failed'].includes(rows[0].state)) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent build ownership changed.'));
  }
});

const registerPersistentMaterializationPlan = Effect.fn('codeGraph.registerPersistentMaterializationPlan')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  expectedBatchCount: number,
) {
  const registered = yield* sql<{readonly expected_batch_count: number}>`
      UPDATE snapshot_build_owners
      SET expected_batch_count = COALESCE(expected_batch_count, ${expectedBatchCount})
      WHERE snapshot_id = ${snapshotId}
        AND owner_token = ${ownerToken}
        AND (expected_batch_count IS NULL OR expected_batch_count = ${expectedBatchCount})
      RETURNING expected_batch_count
    `;
  if (Number(registered[0]?.expected_batch_count ?? -1) !== expectedBatchCount) {
    return yield* Effect.fail(
      new CodeGraphStoreError('Persisted full-build materialization plan changed; discard and rebuild it.'),
    );
  }
  yield* sql`
    INSERT INTO building_lexical_counters (
      snapshot_id, completed_batch_count, posting_count, symbol_count, term_count
    ) VALUES (${snapshotId}, 0, 0, 0, 0)
    ON CONFLICT(snapshot_id) DO NOTHING
  `;
});

const assertPersistentMaterializationComplete = Effect.fn('codeGraph.assertPersistentMaterializationComplete')(
  function* (sql: SqlClient.SqlClient, snapshotId: string, ownerToken: string) {
    const rows = yield* sql<{
      readonly analysis_receipts: number;
      readonly expected_batches: number;
      readonly invalid_analysis_receipts: number;
      readonly invalid_materialization_receipts: number;
      readonly lexical_batches: number;
      readonly materialization_receipts: number;
    }>`
      SELECT
        COALESCE(owner.expected_batch_count, -1) AS expected_batches,
        (
          SELECT COUNT(*) FROM building_materialization_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
        ) AS materialization_receipts,
        (
          SELECT COUNT(*) FROM building_materialization_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
            AND receipt.batch_index >= COALESCE(owner.expected_batch_count, -1)
        ) AS invalid_materialization_receipts,
        (
          SELECT COUNT(*) FROM building_analysis_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
        ) AS analysis_receipts,
        (
          SELECT COUNT(*) FROM building_analysis_batches AS receipt
          WHERE receipt.snapshot_id = owner.snapshot_id
            AND receipt.batch_index >= COALESCE(owner.expected_batch_count, -1)
        ) AS invalid_analysis_receipts,
        COALESCE((
          SELECT completed_batch_count FROM building_lexical_counters AS lexical
          WHERE lexical.snapshot_id = owner.snapshot_id
        ), -1) AS lexical_batches
      FROM snapshot_build_owners AS owner
      WHERE owner.snapshot_id = ${snapshotId} AND owner.owner_token = ${ownerToken}
      LIMIT 1
    `;
    const row = rows[0];
    const expected = Number(row?.expected_batches ?? -1);
    if (
      expected < 0 ||
      Number(row?.materialization_receipts ?? -1) !== expected ||
      Number(row?.analysis_receipts ?? -1) !== expected ||
      Number(row?.lexical_batches ?? -1) !== expected ||
      Number(row?.invalid_materialization_receipts ?? -1) !== 0 ||
      Number(row?.invalid_analysis_receipts ?? -1) !== 0
    ) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent full-build materialization has incomplete batch receipts.'),
      );
    }
  },
);

const assertPersistentMaterializationBatchPlanned = Effect.fn('codeGraph.assertPersistentMaterializationBatchPlanned')(
  function* (sql: SqlClient.SqlClient, snapshotId: string, ownerToken: string, batchIndex: number) {
    const rows = yield* sql<{
      readonly analysis_count: number;
      readonly analysis_maximum: number | null;
      readonly analysis_minimum: number | null;
      readonly expected_batch_count: number | null;
      readonly materialization_count: number;
      readonly materialization_maximum: number | null;
      readonly materialization_minimum: number | null;
    }>`
      SELECT owner.expected_batch_count,
        (SELECT COUNT(*) FROM building_materialization_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_count,
        (SELECT MIN(batch_index) FROM building_materialization_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_minimum,
        (SELECT MAX(batch_index) FROM building_materialization_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_maximum,
        (SELECT COUNT(*) FROM building_analysis_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_count,
        (SELECT MIN(batch_index) FROM building_analysis_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_minimum,
        (SELECT MAX(batch_index) FROM building_analysis_batches AS receipt
         WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_maximum
      FROM snapshot_build_owners AS owner
      WHERE owner.snapshot_id = ${snapshotId} AND owner.owner_token = ${ownerToken}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return yield* Effect.fail(new CodeGraphStoreError('Persistent build ownership changed.'));
    }
    if (row.expected_batch_count !== null) {
      if (batchIndex < Number(row.expected_batch_count)) return;
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent materialization batch is outside the registered plan.'),
      );
    }
    const materializationCount = Number(row.materialization_count);
    const analysisCount = Number(row.analysis_count);
    const contiguous = (count: number, minimum: number | null, maximum: number | null) =>
      count === 0 ? minimum === null && maximum === null : Number(minimum) === 0 && Number(maximum) === count - 1;
    if (
      materializationCount !== analysisCount ||
      !contiguous(materializationCount, row.materialization_minimum, row.materialization_maximum) ||
      !contiguous(analysisCount, row.analysis_minimum, row.analysis_maximum) ||
      batchIndex > materializationCount
    ) {
      return yield* Effect.fail(
        new CodeGraphStoreError('Persistent materialization batches must be staged in contiguous order.'),
      );
    }
  },
);

const preparePersistedFullResolutionViews = Effect.fn('codeGraph.preparePersistedFullResolutionViews')(function* (
  sql: SqlClient.SqlClient,
) {
  for (const name of [
    'activation_reference_candidates',
    'activation_references',
    'activation_edges',
    'activation_symbol_lookup',
    'activation_symbols',
  ] as const) {
    yield* sql.unsafe(`DROP VIEW IF EXISTS temp.${name}`);
  }
  for (const name of [
    'persisted_full_reference_candidate_delete',
    'persisted_full_reference_delete',
    'persisted_full_edge_delete',
    'persisted_full_edge_insert',
    'persisted_full_lookup_insert',
  ] as const) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS temp.${name}`);
  }
  // These views are read-only compatibility surfaces. Persistent resolution
  // writes directly to snapshot-prefixed tables in bounded set operations;
  // per-row INSTEAD OF triggers are intentionally not recreated.
  const snapshotSelector = `(SELECT value FROM activation_state WHERE key = 'snapshot_id')`;
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_symbols AS
    SELECT id, content_hash, kind, name, qualified_name, path, language, arity,
      lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
      exported, signature, documentation, span_json
    FROM symbols WHERE snapshot_id = ${snapshotSelector}
  `);
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_symbol_lookup AS
    SELECT lookup_key, symbol_id, resolution_domain, exported, provenance,
      evidence_edge_id, evidence_path
    FROM snapshot_symbol_lookup WHERE snapshot_id = ${snapshotSelector}
  `);
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_edges AS
    SELECT id, source_id, source_name, relation, target_id, target_name, provenance,
      confidence, evidence_path, evidence_span_json
    FROM edges WHERE snapshot_id = ${snapshotSelector}
  `);
  yield* sql.unsafe(`
    CREATE TEMP VIEW activation_references AS
    SELECT edge_id, resolution_domain, exported_only, alias_lookup_keys_json
    FROM building_references WHERE snapshot_id = ${snapshotSelector}
  `);
});

const prepareAnalysisResolutionTables = Effect.fn('codeGraph.prepareAnalysisResolutionTables')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_analysis_edge_affected_ids (
      id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_analysis_edge_before (
      id TEXT PRIMARY KEY,
      provenance TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      endpoint_state INTEGER NOT NULL CHECK (endpoint_state IN (0, 1, 2))
    ) WITHOUT ROWID
  `);
});

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.
const ACTIVATION_FILE_BATCH_ROWS = 2_500;

const ACTIVATION_SYMBOL_BATCH_ROWS = 1_000;

const ACTIVATION_LOOKUP_BATCH_ROWS = 4_000;

const ACTIVATION_TERM_BATCH_ROWS = 5_000;

const ACTIVATION_EDGE_BATCH_ROWS = 1_500;

const ACTIVATION_REFERENCE_BATCH_ROWS = 3_000;

const ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS = 5_000;

function persistentFullInventoryCapacityBoundary(
  snapshotId: string,
  files: readonly CodeGraphInventoryFile[],
): CodeGraphDirectPersistentCapacityBoundary {
  let finalFactBytes = saturatingCapacityMultiply(codeGraphUtf8ByteLength(snapshotId), files.length);
  for (const file of files) {
    finalFactBytes = saturatingCapacityAdd(
      finalFactBytes,
      codeGraphUtf8ByteLength(file.path),
      codeGraphUtf8ByteLength(file.contentHash),
      codeGraphUtf8ByteLength(file.language),
      codeGraphUtf8ByteLength(file.mode),
      codeGraphUtf8ByteLength(file.source),
    );
  }
  return {
    finalFactBytes,
    operation: 'stage persistent code graph inventory',
    // Numeric size values and SQLite/index overhead are covered by the
    // calibrated per-row floor rather than pretending their varint width is a
    // UTF-8 payload.
    rowCount: files.length,
  };
}

export const CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION = 1 as const;

type ActivationInsertMode = 'insert' | 'upsert';

type ActivationStagingObserver = (
  stage: CodeGraphStagingStage,
  chunkRows: number,
  force?: boolean,
) => Effect.Effect<void, unknown>;

function activationInsertClause(mode: ActivationInsertMode): 'INSERT' | 'INSERT OR REPLACE' {
  return mode === 'insert' ? 'INSERT' : 'INSERT OR REPLACE';
}

const activationMode = Effect.fn('codeGraph.activationMode')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{readonly key: string; readonly value: string}>`
    SELECT key, value
    FROM activation_state
    WHERE key IN ('base_snapshot_id', 'mode', 'owner_token', 'snapshot_id')
  `;
  const values = new Map(rows.map(row => [row.key, row.value]));
  const baseSnapshotId = values.get('base_snapshot_id');
  if (values.get('mode') === 'persisted-delta' && baseSnapshotId) {
    return {baseSnapshotId, mode: 'persisted-delta'} as const;
  }
  const snapshotId = values.get('snapshot_id');
  const ownerToken = values.get('owner_token');
  if (values.get('mode') === 'persisted-full' && snapshotId && ownerToken) {
    return {mode: 'persisted-full', ownerToken, snapshotId} as const;
  }
  return undefined;
});

function stageActivationFiles(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphInventoryFile[],
  mode: ActivationInsertMode = 'upsert',
) {
  return Effect.gen(function* () {
    for (const batch of chunk(
      sortedBy(files, file => file.path),
      ACTIVATION_FILE_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_files (
          path, content_hash, language, mode, size, source
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(file => [file.path, file.contentHash, file.language, file.mode, file.size, file.source]),
      );
    }
  });
}

interface PreparedPersistedFullWorkspaceScope {
  readonly diagnosticsJson: string;
  readonly scope: CodeGraphBuildWorkspace;
}

interface PreparedPersistedFullWorkspaceProject {
  readonly diagnosticsJson: string;
  readonly languagesJson: string;
  readonly project: CodeGraphWorkspaceProject;
  readonly sourceRootsJson: string;
  readonly workspaceRootsJson: string;
}

interface PreparedPersistedFullWorkspace {
  readonly capacity: CodeGraphDirectPersistentCapacityBoundary;
  readonly projects: readonly PreparedPersistedFullWorkspaceProject[];
  readonly workspaces: readonly PreparedPersistedFullWorkspaceScope[];
}

function persistentBoundTextBytes(total: number, values: readonly (string | undefined)[]): number {
  for (const value of values) {
    if (value !== undefined) total = saturatingCapacityAdd(total, codeGraphUtf8ByteLength(value));
  }
  return total;
}

function stageActivationSymbols(
  sql: SqlClient.SqlClient,
  symbols: readonly CodeGraphSymbol[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    yield* observer?.('symbols', 0, true) ?? Effect.void;
    for (const batch of chunk(
      sortedBy(symbols, symbol => symbol.id),
      ACTIVATION_SYMBOL_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_symbols (
          id, content_hash, kind, name, qualified_name, path, language, package_name,
          arity, lookup_keys_json, resolution_domain, resolution_scope_id, exported, signature,
          documentation, span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(symbol => [
          symbol.id,
          symbol.contentHash,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.path,
          symbol.language,
          symbol.packageName ?? null,
          symbol.arity ?? null,
          JSON.stringify(symbol.lookupKeys ?? []),
          symbol.resolutionDomain ?? null,
          symbol.resolutionScopeId ?? null,
          symbol.exported ? 1 : 0,
          symbol.signature ?? null,
          symbol.documentation ?? null,
          JSON.stringify(symbol.span),
        ]),
      );
      yield* observer?.('symbols', batch.length) ?? Effect.void;
      const lookupRows = [
        ...uniqueBy(
          batch.flatMap(symbol =>
            (symbol.lookupKeys ?? []).map(
              key =>
                [
                  key,
                  symbol.id,
                  lookupDomain(key, symbol.resolutionDomain),
                  symbol.exported ? 1 : 0,
                  'symbol',
                  null,
                  symbol.path,
                ] as const,
            ),
          ),
          row => `${row[0]}\0${row[1]}`,
        ),
      ].sort((left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]));
      yield* observer?.('lookup-keys', 0, true) ?? Effect.void;
      for (const lookupBatch of chunk(lookupRows, ACTIVATION_LOOKUP_BATCH_ROWS)) {
        yield* sql.unsafe(
          `${activationInsertClause(mode)} INTO activation_symbol_lookup (
            lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
          ) VALUES ${lookupBatch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          lookupBatch.flat(),
        );
        yield* observer?.('lookup-keys', lookupBatch.length) ?? Effect.void;
      }
    }
    yield* observer?.('symbols', 0, true) ?? Effect.void;
    yield* observer?.('lookup-keys', 0, true) ?? Effect.void;
  });
}

function stageActivationSymbolTerms(
  sql: SqlClient.SqlClient,
  symbols: readonly CodeGraphSymbol[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    yield* observer?.('terms', 0, true) ?? Effect.void;
    let termBatch: Array<readonly [string, string, number]> = [];
    const flush = () => {
      if (termBatch.length === 0) return Effect.void;
      const current = termBatch.sort(
        (left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]),
      );
      termBatch = [];
      return Effect.gen(function* () {
        yield* sql.unsafe(
          `${activationInsertClause(mode)} INTO activation_symbol_terms (term, symbol_id, weight)
           VALUES ${current.map(() => '(?, ?, ?)').join(', ')}`,
          current.flat(),
        );
        yield* observer?.('terms', current.length) ?? Effect.void;
      });
    };
    for (const symbol of sortedBy(symbols, symbol => symbol.id)) {
      for (const [term, weight] of symbolTerms(symbol)) {
        termBatch.push([term, symbol.id, weight]);
        if (termBatch.length >= ACTIVATION_TERM_BATCH_ROWS) yield* flush();
      }
    }
    yield* flush();
    yield* observer?.('terms', 0, true) ?? Effect.void;
  });
}

interface CompactLexicalSnapshotKeyRow {
  readonly snapshot_key: number | bigint;
}

function validatedCompactLexicalCount(
  value: number | bigint,
  description: string,
): Effect.Effect<number, CodeGraphStoreError> {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0
    ? Effect.succeed(count)
    : Effect.fail(new CodeGraphStoreError(`Compact lexical ${description} is invalid.`));
}

const ensureCompactLexicalSnapshot = Effect.fn('codeGraph.ensureCompactLexicalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`
    INSERT INTO lexical_compact_snapshots (snapshot_id)
    VALUES (${snapshotId})
    ON CONFLICT(snapshot_id) DO NOTHING
  `;
  const rows = yield* sql<CompactLexicalSnapshotKeyRow>`
    SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ${snapshotId} LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return yield* Effect.fail(new CodeGraphStoreError(`Compact lexical snapshot ${snapshotId} was not allocated.`));
  }
  return yield* validatedCompactLexicalCount(row.snapshot_key, 'snapshot key');
});

const stageCompactLexicalFacts = Effect.fn('codeGraph.stageCompactLexicalFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  symbols: readonly CodeGraphSymbol[],
  observer?: ActivationStagingObserver,
  preparedTerms?: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>,
) {
  const snapshotKey = yield* ensureCompactLexicalSnapshot(sql, snapshotId);
  const orderedSymbols = sortedBy(symbols, symbol => symbol.id);
  let symbolCount = 0;
  for (const batch of chunk(orderedSymbols, ACTIVATION_SYMBOL_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id)
       VALUES ${batch.map(() => '(?, ?)').join(', ')}`,
      batch.flatMap(symbol => [snapshotKey, symbol.id]),
    );
    const inserted = yield* lastStatementChangeCount(sql);
    if (inserted !== batch.length) {
      return yield* Effect.fail(new CodeGraphStoreError('Compact lexical symbol dictionary lost rows.'));
    }
    symbolCount += inserted;
  }

  yield* observer?.('terms', 0, true) ?? Effect.void;
  let postingCount = 0;
  let termCount = 0;
  let termBatch: Array<readonly [string, string, number]> = [];
  const flush = () => {
    if (termBatch.length === 0) return Effect.void;
    const current = termBatch.sort(
      (left, right) => compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]),
    );
    termBatch = [];
    return Effect.gen(function* () {
      const terms = [...new Set(current.map(row => row[0]))].sort(compareCodeUnits);
      for (const termRows of chunk(terms, ACTIVATION_TERM_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO lexical_compact_terms (snapshot_key, term)
           VALUES ${termRows.map(() => '(?, ?)').join(', ')}`,
          termRows.flatMap(term => [snapshotKey, term]),
        );
        termCount += yield* lastStatementChangeCount(sql);
      }
      yield* sql.unsafe(
        `WITH input(term, symbol_id, weight) AS (
           VALUES ${current.map(() => '(?, ?, ?)').join(', ')}
         )
         INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
         SELECT ?, terms.term_key, symbols.symbol_key, input.weight
         FROM input
         JOIN lexical_compact_terms AS terms
           ON terms.snapshot_key = ? AND terms.term = input.term
         JOIN lexical_compact_symbols AS symbols
           ON symbols.snapshot_key = ? AND symbols.symbol_id = input.symbol_id
         ORDER BY terms.term_key, symbols.symbol_key`,
        [...current.flat(), snapshotKey, snapshotKey, snapshotKey],
      );
      const inserted = yield* lastStatementChangeCount(sql);
      if (inserted !== current.length) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Compact lexical dictionary join lost ${current.length - inserted} posting(s).`),
        );
      }
      postingCount += inserted;
      yield* observer?.('terms', inserted) ?? Effect.void;
    });
  };
  for (const symbol of orderedSymbols) {
    for (const [term, weight] of preparedTerms?.get(symbol) ?? symbolTerms(symbol)) {
      termBatch.push([term, symbol.id, weight]);
      if (termBatch.length >= ACTIVATION_TERM_BATCH_ROWS) yield* flush();
    }
  }
  yield* flush();
  yield* observer?.('terms', 0, true) ?? Effect.void;
  return {postingCount, symbolCount, termCount} satisfies CompactLexicalFormatReceipt;
});

type CompactActivationSymbolSelection = 'all' | 'changed';

interface CompactLexicalFormatReceipt {
  readonly postingCount: number;
  readonly symbolCount: number;
  readonly termCount: number;
}

function validatedCompactLexicalReceipt(
  receipt: CompactLexicalFormatReceipt,
  expectedPostingCount: number,
  expectedSymbolCount: number,
): Effect.Effect<CompactLexicalFormatReceipt, CodeGraphStoreError> {
  const counts = [receipt.postingCount, receipt.symbolCount, receipt.termCount];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) {
    return Effect.fail(new CodeGraphStoreError('Compact lexical receipt contains an invalid count.'));
  }
  if (receipt.postingCount !== expectedPostingCount || receipt.symbolCount !== expectedSymbolCount) {
    return Effect.fail(
      new CodeGraphStoreError(
        `Compact lexical receipt mismatch (${receipt.postingCount}/${expectedPostingCount} postings, ` +
          `${receipt.symbolCount}/${expectedSymbolCount} symbols).`,
      ),
    );
  }
  return Effect.succeed(receipt);
}

const publishCompactLexicalFormat = Effect.fn('codeGraph.publishCompactLexicalFormat')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  receipt: CompactLexicalFormatReceipt,
) {
  yield* sql`
    INSERT INTO lexical_storage_formats (
      snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
    ) VALUES (
      ${snapshotId}, ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}, ${receipt.postingCount},
      ${receipt.symbolCount}, ${receipt.termCount}, ${new Date().toISOString()}
    )
    ON CONFLICT(snapshot_id) DO UPDATE SET
      format_version = excluded.format_version,
      posting_count = excluded.posting_count,
      symbol_count = excluded.symbol_count,
      term_count = excluded.term_count,
      created_at = excluded.created_at
  `;
});

const recordCompactLexicalFormat = Effect.fn('codeGraph.recordCompactLexicalFormat')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  receipt: CompactLexicalFormatReceipt,
  expectedPostingCount: number,
  expectedSymbolCount: number,
) {
  yield* publishCompactLexicalFormat(
    sql,
    snapshotId,
    yield* validatedCompactLexicalReceipt(receipt, expectedPostingCount, expectedSymbolCount),
  );
});

function stageActivationEdges(
  sql: SqlClient.SqlClient,
  edges: readonly CodeGraphEdge[],
  mode: ActivationInsertMode = 'upsert',
  observer?: ActivationStagingObserver,
) {
  return Effect.gen(function* () {
    yield* observer?.('edges', 0, true) ?? Effect.void;
    for (const batch of chunk(
      sortedBy(edges, edge => edge.id),
      ACTIVATION_EDGE_BATCH_ROWS,
    )) {
      yield* sql.unsafe(
        `${activationInsertClause(mode)} INTO activation_edges (
          id, source_id, source_name, relation, target_id, target_name, provenance,
          confidence, evidence_path, evidence_span_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(edge => [
          edge.id,
          edge.sourceId ?? null,
          edge.sourceName,
          edge.relation,
          edge.targetId ?? null,
          edge.targetName,
          edge.provenance,
          edge.confidence,
          edge.evidencePath,
          JSON.stringify(edge.evidenceSpan),
        ]),
      );
      yield* observer?.('edges', batch.length) ?? Effect.void;
    }
    yield* observer?.('edges', 0, true) ?? Effect.void;
  });
}

interface PersistedAnalysisBatchReceipt {
  readonly batch_fingerprint: string;
  readonly edge_count: number;
  readonly symbol_count: number;
}

const referenceCandidateEncoder = new TextEncoder();

interface PreparedPersistedFullFactBatch {
  readonly batch: CodeGraphStagingBatch;
  readonly boundedReferences: readonly CodeGraphReference[];
  readonly reexportsByReferenceBatch: readonly (readonly CodeGraphReusableReexport[])[];
  readonly symbolTerms: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>;
}

const persistedIncrementalSurfaceMatches = Effect.fn('codeGraph.persistedIncrementalSurfaceMatches')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const changedFiles = yield* sql<{readonly expected: number; readonly present: number}>`
    SELECT
      (SELECT COUNT(*) FROM activation_files) AS expected,
      (
        SELECT COUNT(*)
        FROM activation_files AS current
        JOIN snapshot_files AS base
          ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
      ) AS present
  `;
  if (Number(changedFiles[0]?.expected ?? 0) !== Number(changedFiles[0]?.present ?? -1)) return false;
  const mismatches = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM (
      SELECT current.id
      FROM activation_symbols AS current
      LEFT JOIN symbols AS base
        ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
      WHERE base.id IS NULL
         OR base.kind IS NOT current.kind
         OR base.name IS NOT current.name
         OR base.qualified_name IS NOT current.qualified_name
         OR base.path IS NOT current.path
         OR base.language IS NOT current.language
         OR base.arity IS NOT current.arity
         OR base.lookup_keys_json IS NOT current.lookup_keys_json
         OR base.resolution_domain IS NOT current.resolution_domain
         OR base.resolution_scope_id IS NOT current.resolution_scope_id
         OR base.package_name IS NOT current.package_name
         OR base.exported IS NOT current.exported
      UNION ALL
      SELECT base.id
      FROM symbols AS base
      JOIN activation_files AS changed ON changed.path = base.path
      LEFT JOIN activation_symbols AS current ON current.id = base.id
      WHERE base.snapshot_id = ${baseSnapshotId} AND current.id IS NULL
    ) AS mismatch
  `;
  return Number(mismatches[0]?.count ?? 0) === 0;
});

const persistedIncrementalProjectFilesMatch = Effect.fn('codeGraph.persistedIncrementalProjectFilesMatch')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const invalid = yield* sql<{readonly path: string}>`
      SELECT changed.path
      FROM activation_incremental_paths AS changed
      LEFT JOIN activation_files AS current ON current.path = changed.path
      WHERE current.path IS NULL
      UNION ALL
      SELECT current.path
      FROM activation_files AS current
      LEFT JOIN snapshot_files AS base
        ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
      WHERE base.path IS NULL
         OR base.language IS NOT current.language
         OR base.mode IS NOT current.mode
      LIMIT 1
    `;
  return invalid.length === 0;
});

function isPersistedIncrementalResolutionClosure(value: unknown): value is 'changed' | 'full' | 'project' {
  return value === 'changed' || value === 'project' || value === 'full';
}

interface ResolvableActivationReferenceRow extends EdgeRow {
  readonly alias_lookup_keys_json: string;
  readonly symbol_exported: number;
  readonly symbol_kind: string;
  readonly symbol_resolution_domain: unknown;
  readonly target_symbol_id: string;
  readonly target_symbol_name: string;
}

interface ActivationResolutionRow {
  readonly confidence: number;
  readonly newEdgeId: string;
  readonly oldEdgeId: string;
  readonly provenance: CodeGraphProvenance;
  readonly relation: string;
  readonly targetId: string;
  readonly targetName: string;
}

const RESOLUTION_PAGE_ROWS = 500;

// A sampled 232k-file graph resolved a 5,000-reference page with roughly 80k
// candidate matches in less than four seconds once persistent writes bypassed
// row triggers. Keep connection-private/delta pages conservative, while clean
// full-build pages are independently bounded by reference count, candidate
// count, and encoded payload bytes before their lookup tiers are decoded.
const PERSISTENT_FULL_RESOLUTION_PAGE_ROWS = 5_000;

const PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES = CODE_GRAPH_REFERENCE_CANDIDATES_PER_REFERENCE_MAXIMUM;

const PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES = 8 * 1_024 * 1_024;

interface PersistedFullReferencePageRow {
  readonly candidate_count: number;
  readonly candidate_payload_bytes: number;
  readonly edge_id: string;
  readonly lookup_tiers_json: string;
}

interface PersistedFullReferenceTotalsRow {
  readonly candidate_count: number;
  readonly count: number;
  readonly payload_bytes: number;
}

type CodeGraphWriterGate = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | unknown, R>;

interface PersistentReexportAliasRow {
  readonly evidence_path: string;
  readonly exported: number;
  readonly lookup_key: string;
  readonly symbol_id: string;
}

interface SnapshotPromotionCapacityPlan {
  readonly activatedAt: string;
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly maximumLeaseFactBytes: number;
  readonly maximumLeaseRows: number;
}

export {
  CodeGraphWriterGate,
  assertPersistentBuildOwner,
  CompactLexicalFormatReceipt,
  ActivationStagingObserver,
  validatedCompactLexicalCount,
  ActivationInsertMode,
  activationInsertClause,
  CompactLexicalSnapshotKeyRow,
  ACTIVATION_FILE_BATCH_ROWS,
  persistentBoundTextBytes,
  assertPersistentMaterializationComplete,
  ACTIVATION_SYMBOL_BATCH_ROWS,
  ACTIVATION_REFERENCE_BATCH_ROWS,
  publishCompactLexicalFormat,
  PreparedPersistedFullFactBatch,
  PERSISTENT_FULL_RESOLUTION_PAGE_ROWS,
  PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
  PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
  registerPersistentMaterializationPlan,
  prepareAnalysisResolutionTables,
  ACTIVATION_LOOKUP_BATCH_ROWS,
  ACTIVATION_TERM_BATCH_ROWS,
  ACTIVATION_EDGE_BATCH_ROWS,
  ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS,
  stageActivationFiles,
  stageActivationSymbols,
  stageActivationSymbolTerms,
  ensureCompactLexicalSnapshot,
  validatedCompactLexicalReceipt,
  recordCompactLexicalFormat,
  stageActivationEdges,
  referenceCandidateEncoder,
  persistedIncrementalSurfaceMatches,
  persistedIncrementalProjectFilesMatch,
  isPersistedIncrementalResolutionClosure,
  ResolvableActivationReferenceRow,
  ActivationResolutionRow,
  RESOLUTION_PAGE_ROWS,
  PersistedFullReferencePageRow,
  PersistedFullReferenceTotalsRow,
  PersistentReexportAliasRow,
  SnapshotPromotionCapacityPlan,
  persistentSnapshotBuildIdentityMatches,
  assertPersistentMaterializationBatchPlanned,
  preparePersistedFullResolutionViews,
  persistentFullInventoryCapacityBoundary,
  activationMode,
  PreparedPersistedFullWorkspaceScope,
  PreparedPersistedFullWorkspaceProject,
  PreparedPersistedFullWorkspace,
  stageCompactLexicalFacts,
  CompactActivationSymbolSelection,
  PersistedAnalysisBatchReceipt,
};
