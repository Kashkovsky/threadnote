import {Effect} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {
  areCodeGraphLookupTiersWithinCandidateBudget,
  isCodeGraphReferenceWithinCandidateBudget,
} from './fact_budget.js';
import {compareCodeUnits} from './ordering.js';
import {configureConnection, tableExists} from './store_session.js';
import {type CodeGraphEdge, type CodeGraphReference, type CodeGraphSymbol, CodeGraphStoreError} from './types.js';
import {type SnapshotRow} from './store_internal_models.js';
import {snapshotFromRow} from './store_rows.js';
import {
  ACTIVATION_EDGE_BATCH_ROWS,
  ACTIVATION_LOOKUP_BATCH_ROWS,
  ACTIVATION_REFERENCE_BATCH_ROWS,
  ACTIVATION_SYMBOL_BATCH_ROWS,
  type ActivationResolutionRow,
  type ActivationStagingObserver,
  assertPersistentBuildOwner,
  assertPersistentMaterializationBatchPlanned,
  type CompactLexicalFormatReceipt,
  type PersistedFullReferencePageRow,
  type PersistedFullReferenceTotalsRow,
  PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
  PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
  PERSISTENT_FULL_RESOLUTION_PAGE_ROWS,
  persistentBoundTextBytes,
  type PersistentReexportAliasRow,
  type PreparedPersistedFullFactBatch,
  referenceCandidateEncoder,
  RESOLUTION_PAGE_ROWS,
  type ResolvableActivationReferenceRow,
  stageCompactLexicalFacts,
} from './store_build_core.js';
import {
  type CodeGraphPersistentReferencePageLimits,
  compactReferenceLookupTiers,
  normalizedReexportProvenance,
  persistedFullBatchFingerprint,
  type PersistedFullBatchReceipt,
  stagePersistedAnalysisBatch,
} from './store_staging_core.js';
import {chunk, lookupDomain, sortedBy, uniqueBy} from './store_utilities.js';
import {type CodeGraphSqlQueryStatement} from './store_visualization_sql.js';
import {CODE_GRAPH_SNAPSHOT_ID} from './store_reconciliation_core.js';

const selectResumableForcedBuild = Effect.fn('codeGraph.selectResumableForcedBuild')(function* (
  logicalSnapshotId: string,
) {
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    return yield* Effect.fail(new CodeGraphStoreError('Logical snapshot identity is invalid.'));
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE state = 'building'
      AND id GLOB ${`${logicalSnapshotId}-full-[0-9a-f]*`}
      AND length(id) = ${logicalSnapshotId.length + '-full-'.length + 16}
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectResumableBuildById = Effect.fn('codeGraph.selectResumableBuildById')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* tableExists(sql, 'snapshots'))) return undefined;
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'building' LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const stagePersistedFullFacts = Effect.fn('codeGraph.stagePersistedFullFacts')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  batchIndex: number,
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
  observer: ActivationStagingObserver,
  withinTransaction = false,
  prepared?: PreparedPersistedFullFactBatch,
) {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Persistent materialization batch identity is invalid.'));
  }
  const boundedReferences = prepared?.boundedReferences ?? references.filter(isCodeGraphReferenceWithinCandidateBudget);
  const batchFingerprint = yield* persistedFullBatchFingerprint(symbols, edges, boundedReferences);

  let lookupCount = 0;
  let termCount = 0;
  let candidateCount = 0;
  let reexportCount = 0;
  let compactBatchCounts: CompactLexicalFormatReceipt = {postingCount: 0, symbolCount: 0, termCount: 0};
  const runTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withinTransaction ? effect : sql.withTransaction(effect);
  const resumed = yield* runTransaction(
    Effect.gen(function* () {
      yield* observer('validating', 0, true);
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      yield* assertPersistentMaterializationBatchPlanned(sql, snapshotId, ownerToken, batchIndex);
      const existing = yield* sql<PersistedFullBatchReceipt>`
        SELECT batch_fingerprint, symbol_count, edge_count, term_count, lookup_count,
          reference_count, candidate_count, reexport_count
        FROM building_materialization_batches
        WHERE snapshot_id = ${snapshotId} AND batch_index = ${batchIndex}
        LIMIT 1
      `;
      yield* observer('validating', 3, true);
      if (existing[0]) {
        if (existing[0].batch_fingerprint !== batchFingerprint) {
          return yield* Effect.fail(
            new CodeGraphStoreError('Persisted full-build batch contents changed; discard and rebuild it.'),
          );
        }
        // Beta databases may have a durable materialization receipt created
        // before compact analysis summaries existed. Repair that batch from
        // the fingerprint-verified caller facts without replaying fact rows.
        yield* observer('analysis', 0, true);
        yield* stagePersistedAnalysisBatch(sql, snapshotId, batchIndex, batchFingerprint, symbols, edges);
        yield* observer('analysis', symbols.length + edges.length, true);
        return existing[0];
      }
      yield* observer('symbols', 0, true);
      for (const batch of chunk(
        sortedBy(symbols, symbol => symbol.id),
        ACTIVATION_SYMBOL_BATCH_ROWS,
      )) {
        yield* sql.unsafe(
          `INSERT INTO symbols (
            snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
            arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
            exported, signature, documentation, span_json
          ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          batch.flatMap(symbol => [
            snapshotId,
            symbol.id,
            symbol.contentHash,
            symbol.kind,
            symbol.name,
            symbol.qualifiedName,
            symbol.path,
            symbol.language,
            symbol.arity ?? null,
            JSON.stringify(symbol.lookupKeys ?? []),
            symbol.resolutionDomain ?? null,
            symbol.resolutionScopeId ?? null,
            symbol.packageName ?? null,
            symbol.exported ? 1 : 0,
            symbol.signature ?? null,
            symbol.documentation ?? null,
            JSON.stringify(symbol.span),
          ]),
        );
        yield* observer('symbols', batch.length);
        const lookupRows = [
          ...uniqueBy(
            batch.flatMap(symbol =>
              (symbol.lookupKeys ?? []).map(
                key =>
                  [
                    snapshotId,
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
            row => `${row[1]}\0${row[2]}`,
          ),
        ].sort((left, right) => compareCodeUnits(left[1], right[1]) || compareCodeUnits(left[2], right[2]));
        yield* observer('lookup-keys', 0, true);
        for (const lookupBatch of chunk(lookupRows, ACTIVATION_LOOKUP_BATCH_ROWS)) {
          yield* sql.unsafe(
            `INSERT INTO snapshot_symbol_lookup (
              snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
              provenance, evidence_edge_id, evidence_path
            ) VALUES ${lookupBatch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            lookupBatch.flat(),
          );
          lookupCount += lookupBatch.length;
          yield* observer('lookup-keys', lookupBatch.length);
        }
      }
      yield* observer('symbols', 0, true);
      yield* observer('lookup-keys', 0, true);

      compactBatchCounts = yield* stageCompactLexicalFacts(sql, snapshotId, symbols, observer, prepared?.symbolTerms);
      termCount = compactBatchCounts.postingCount;

      yield* observer('edges', 0, true);
      for (const batch of chunk(
        sortedBy(edges, edge => edge.id),
        ACTIVATION_EDGE_BATCH_ROWS,
      )) {
        yield* sql.unsafe(
          `INSERT INTO edges (
            snapshot_id, id, source_id, source_name, relation, target_id, target_name,
            provenance, confidence, evidence_path, evidence_span_json
          ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          batch.flatMap(edge => [
            snapshotId,
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
        yield* observer('edges', batch.length);
      }
      yield* observer('edges', 0, true);

      yield* observer('references', 0, true);
      const referenceBatches = [
        ...chunk(
          prepared ? boundedReferences : sortedBy(boundedReferences, reference => reference.edgeId),
          ACTIVATION_REFERENCE_BATCH_ROWS,
        ),
      ];
      for (let referenceBatchIndex = 0; referenceBatchIndex < referenceBatches.length; referenceBatchIndex += 1) {
        const batch = referenceBatches[referenceBatchIndex]!;
        const compacted = batch.map(reference => ({
          candidates: compactReferenceLookupTiers(reference.lookupTiers),
          reference,
        }));
        yield* sql.unsafe(
          `INSERT INTO building_references (
            snapshot_id, edge_id, resolution_domain, exported_only, alias_lookup_keys_json,
            lookup_tiers_json, candidate_count, candidate_payload_bytes
          ) VALUES ${compacted.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          compacted.flatMap(({candidates, reference}) => [
            snapshotId,
            reference.edgeId,
            reference.resolutionDomain,
            reference.exportedOnly === true ? 1 : 0,
            JSON.stringify(reference.aliasLookupKeys ?? []),
            candidates.json,
            candidates.candidateCount,
            candidates.payloadBytes,
          ]),
        );
        yield* observer('references', batch.length);
        const candidates = compacted.reduce((total, entry) => total + entry.candidates.candidateCount, 0);
        yield* observer('reference-candidates', 0, true);
        candidateCount += candidates;
        yield* observer('reference-candidates', candidates);
        const reexports =
          prepared?.reexportsByReferenceBatch[referenceBatchIndex] ??
          [
            ...uniqueBy(batch.flatMap(normalizedReexportProvenance), reexport =>
              [reexport.sourcePath, reexport.localName, reexport.targetPath, reexport.importedName].join('\0'),
            ),
          ].sort(
            (left, right) =>
              compareCodeUnits(left.sourcePath, right.sourcePath) ||
              compareCodeUnits(left.localName, right.localName) ||
              compareCodeUnits(left.targetPath, right.targetPath) ||
              compareCodeUnits(left.importedName, right.importedName),
          );
        yield* observer('reexports', 0, true);
        for (const reexportBatch of chunk(reexports, ACTIVATION_REFERENCE_BATCH_ROWS)) {
          yield* sql.unsafe(
            `INSERT OR IGNORE INTO snapshot_reexport_provenance (
              snapshot_id, source_path, local_name, target_path, imported_name
            ) VALUES ${reexportBatch.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
            reexportBatch.flatMap(reexport => [
              snapshotId,
              reexport.sourcePath,
              reexport.localName,
              reexport.targetPath,
              reexport.importedName,
            ]),
          );
          reexportCount += reexportBatch.length;
          yield* observer('reexports', reexportBatch.length);
        }
      }
      yield* observer('references', 0, true);
      yield* observer('reference-candidates', 0, true);
      yield* observer('reexports', 0, true);
      yield* observer('analysis', 0, true);
      yield* stagePersistedAnalysisBatch(sql, snapshotId, batchIndex, batchFingerprint, symbols, edges);
      yield* observer('analysis', symbols.length + edges.length, true);
      yield* observer('receipt', 0, true);
      yield* sql`
        INSERT INTO building_materialization_batches (
          snapshot_id, batch_index, batch_fingerprint, symbol_count, edge_count, term_count, lookup_count,
          reference_count, candidate_count, reexport_count, completed_at
        ) VALUES (
          ${snapshotId}, ${batchIndex}, ${batchFingerprint}, ${symbols.length}, ${edges.length}, ${termCount}, ${lookupCount},
          ${boundedReferences.length}, ${candidateCount}, ${reexportCount}, ${new Date().toISOString()}
        )
      `;
      const lexicalCounter = yield* sql<{
        readonly completed_batch_count: number;
        readonly posting_count: number;
        readonly symbol_count: number;
        readonly term_count: number;
      }>`
        INSERT INTO building_lexical_counters (
          snapshot_id, completed_batch_count, posting_count, symbol_count, term_count
        ) VALUES (
          ${snapshotId}, 1, ${compactBatchCounts.postingCount}, ${compactBatchCounts.symbolCount},
          ${compactBatchCounts.termCount}
        )
        ON CONFLICT(snapshot_id) DO UPDATE SET
          completed_batch_count = building_lexical_counters.completed_batch_count + 1,
          posting_count = building_lexical_counters.posting_count + excluded.posting_count,
          symbol_count = building_lexical_counters.symbol_count + excluded.symbol_count,
          term_count = building_lexical_counters.term_count + excluded.term_count
        RETURNING completed_batch_count, posting_count, symbol_count, term_count
      `;
      if (Number(lexicalCounter[0]?.completed_batch_count ?? -1) !== batchIndex + 1) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Compact lexical counters no longer match contiguous batch receipts.'),
        );
      }
      yield* observer('receipt', 1, true);
      if (!withinTransaction) yield* observer('committing', 0, true);
      return undefined;
    }),
  );
  if (resumed) {
    for (const [stage, rows] of [
      ['symbols', Number(resumed.symbol_count)],
      ['lookup-keys', Number(resumed.lookup_count)],
      ['terms', Number(resumed.term_count)],
      ['edges', Number(resumed.edge_count)],
      ['references', Number(resumed.reference_count)],
      ['reference-candidates', Number(resumed.candidate_count)],
      ['reexports', Number(resumed.reexport_count)],
      ['receipt', 1],
    ] as const) {
      yield* observer(stage, rows, true);
    }
  }
  if (!withinTransaction) yield* observer('committed', 0, true);
});

// A sampled 232k-file graph resolved a 5,000-reference page with roughly 80k
// candidate matches in less than four seconds once persistent writes bypassed
// row triggers. Keep connection-private/delta pages conservative, while clean
// full-build pages are independently bounded by reference count, candidate
// count, and encoded payload bytes before their lookup tiers are decoded.

/** @internal Exposed so property tests can verify all three page bounds. */
export function codeGraphPersistentReferencePageStatement(
  snapshotId: string,
  cursor: string,
  limits: CodeGraphPersistentReferencePageLimits = {
    candidateCount: PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES,
    payloadBytes: PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES,
    references: PERSISTENT_FULL_RESOLUTION_PAGE_ROWS,
  },
): CodeGraphSqlQueryStatement {
  const references = positivePageLimit(limits.references, PERSISTENT_FULL_RESOLUTION_PAGE_ROWS);
  const candidateCount = positivePageLimit(limits.candidateCount, PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES);
  const payloadBytes = positivePageLimit(limits.payloadBytes, PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES);
  return {
    parameters: [snapshotId, cursor, references, candidateCount, payloadBytes],
    text: `WITH bounded AS MATERIALIZED (
        SELECT edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes
        FROM building_references
        WHERE snapshot_id = ? AND edge_id > ?
        ORDER BY edge_id
        LIMIT ?
      ),
      measured AS (
        SELECT edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes,
          ROW_NUMBER() OVER (ORDER BY edge_id) AS ordinal,
          SUM(candidate_count) OVER (
            ORDER BY edge_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative_candidate_count,
          SUM(candidate_payload_bytes) OVER (
            ORDER BY edge_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative_payload_bytes
        FROM bounded
      )
      SELECT edge_id, lookup_tiers_json, candidate_count, candidate_payload_bytes
      FROM measured
      WHERE cumulative_candidate_count <= ? AND cumulative_payload_bytes <= ?
      ORDER BY edge_id`,
  };
}

function positivePageLimit(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function persistentFullReferencePageTotal(row: PersistedFullReferenceTotalsRow): number {
  const references = Number(row.count);
  if (!Number.isSafeInteger(references) || references <= 0) return 0;
  const candidates = Math.max(0, Number(row.candidate_count));
  const payloadBytes = Math.max(0, Number(row.payload_bytes));
  return Math.max(
    Math.ceil(references / PERSISTENT_FULL_RESOLUTION_PAGE_ROWS),
    Math.ceil(candidates / PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES),
    Math.ceil(payloadBytes / PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES),
  );
}

function decodePersistedReferenceCandidateRows(
  references: readonly PersistedFullReferencePageRow[],
): Effect.Effect<readonly (readonly [string, string, number])[], CodeGraphStoreError> {
  return Effect.try({
    try: () => {
      const rows: Array<readonly [string, string, number]> = [];
      for (const reference of references) {
        if (
          !Number.isSafeInteger(reference.candidate_count) ||
          reference.candidate_count < 0 ||
          reference.candidate_count > PERSISTENT_FULL_RESOLUTION_PAGE_CANDIDATES ||
          !Number.isSafeInteger(reference.candidate_payload_bytes) ||
          reference.candidate_payload_bytes < 0 ||
          reference.candidate_payload_bytes > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES
        ) {
          throw new CodeGraphStoreError('Stored reference candidate metadata is invalid.');
        }
        // Metadata makes the SQL page selection cheap, but is not a trust
        // boundary. Measure the actual UTF-8 payload before JSON.parse so a
        // corrupt row cannot turn a compact page into an unbounded decode.
        if (reference.lookup_tiers_json.length > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES) {
          throw new CodeGraphStoreError('Stored reference candidate payload exceeds its byte budget.');
        }
        const actualPayloadBytes = referenceCandidateEncoder.encode(reference.lookup_tiers_json).byteLength;
        if (
          actualPayloadBytes > PERSISTENT_FULL_RESOLUTION_PAGE_PAYLOAD_BYTES ||
          actualPayloadBytes !== reference.candidate_payload_bytes
        ) {
          throw new CodeGraphStoreError('Stored reference candidate metadata does not match its payload.');
        }
        const parsed: unknown = JSON.parse(reference.lookup_tiers_json);
        if (
          !Array.isArray(parsed) ||
          !parsed.every(tier => Array.isArray(tier) && tier.every(lookupKey => typeof lookupKey === 'string'))
        ) {
          throw new CodeGraphStoreError('Stored reference lookup tiers are invalid.');
        }
        if (!areCodeGraphLookupTiersWithinCandidateBudget(parsed)) {
          throw new CodeGraphStoreError('Stored reference candidate payload exceeds its cardinality budget.');
        }
        const compacted = compactReferenceLookupTiers(parsed);
        if (
          compacted.json !== reference.lookup_tiers_json ||
          compacted.candidateCount !== reference.candidate_count ||
          compacted.payloadBytes !== reference.candidate_payload_bytes
        ) {
          throw new CodeGraphStoreError('Stored reference candidate metadata does not match its payload.');
        }
        for (const [tier, lookupKeys] of compacted.tiers.entries()) {
          for (const lookupKey of lookupKeys) rows.push([lookupKey, reference.edge_id, tier]);
        }
      }
      return rows.sort(
        (left, right) =>
          compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1], right[1]) || left[2] - right[2],
      );
    },
    catch: cause =>
      cause instanceof CodeGraphStoreError
        ? cause
        : new CodeGraphStoreError('Stored reference candidate payload could not be decoded.'),
  });
}

/** @internal Exposed so regression tests can verify the SQLite access plan. */
export function codeGraphPersistedDeltaResolutionPageStatement(
  baseSnapshotId: string,
  cursor: string,
  batchEnd: string,
): CodeGraphSqlQueryStatement {
  return {
    parameters: [cursor, batchEnd, baseSnapshotId, baseSnapshotId],
    text: `WITH page_candidates AS MATERIALIZED (
        SELECT DISTINCT candidate.edge_id, candidate.tier, candidate.lookup_key,
          reference.resolution_domain, reference.exported_only,
          edge.relation, edge.source_id
        FROM activation_reference_candidates AS candidate
        CROSS JOIN activation_references AS reference
          ON reference.edge_id = candidate.edge_id
        CROSS JOIN activation_edges AS edge
          ON edge.id = candidate.edge_id AND edge.target_id IS NULL
        WHERE candidate.edge_id > ? AND candidate.edge_id <= ?
      ),
      candidate_matches AS (
        SELECT DISTINCT
          candidate.edge_id,
          candidate.tier,
          lookup.symbol_id,
          0 AS ambiguous
        FROM page_candidates AS candidate
        CROSS JOIN activation_symbol_lookup AS lookup
          INDEXED BY sqlite_autoindex_activation_symbol_lookup_1
          ON lookup.lookup_key = candidate.lookup_key
         AND lookup.resolution_domain = candidate.resolution_domain
         AND (candidate.exported_only = 0 OR lookup.exported = 1)
         AND (candidate.relation <> 'overrides' OR lookup.symbol_id IS NOT candidate.source_id)
        UNION ALL
        SELECT DISTINCT
          candidate.edge_id,
          candidate.tier,
          lookup.symbol_id,
          0 AS ambiguous
        FROM page_candidates AS candidate
        CROSS JOIN snapshot_symbol_lookup AS lookup
          INDEXED BY sqlite_autoindex_snapshot_symbol_lookup_1
          ON lookup.snapshot_id = ?
         AND lookup.lookup_key = candidate.lookup_key
         AND lookup.resolution_domain = candidate.resolution_domain
         AND (candidate.exported_only = 0 OR lookup.exported = 1)
         AND (candidate.relation <> 'overrides' OR lookup.symbol_id IS NOT candidate.source_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM activation_incremental_paths AS changed
          WHERE changed.path = lookup.evidence_path
        )
          AND NOT EXISTS (
          SELECT 1
          FROM activation_symbol_lookup AS current
            INDEXED BY sqlite_autoindex_activation_symbol_lookup_1
          WHERE current.lookup_key = lookup.lookup_key AND current.symbol_id = lookup.symbol_id
        )
      ),
      first_tiers AS (
        SELECT edge_id, MIN(tier) AS tier
        FROM candidate_matches
        GROUP BY edge_id
      ),
      unique_candidates AS (
        SELECT match.edge_id, MIN(match.symbol_id) AS symbol_id
        FROM candidate_matches AS match
        JOIN first_tiers AS first
          ON first.edge_id = match.edge_id AND first.tier = match.tier
        GROUP BY match.edge_id
        HAVING MAX(match.ambiguous) = 0 AND COUNT(DISTINCT match.symbol_id) = 1
      ),
      resolved_candidates AS (
        SELECT candidate.edge_id,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        CROSS JOIN activation_symbols AS symbol
          INDEXED BY sqlite_autoindex_activation_symbols_1
          ON symbol.id = candidate.symbol_id
        UNION ALL
        SELECT candidate.edge_id,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        CROSS JOIN symbols AS symbol
          INDEXED BY sqlite_autoindex_symbols_1
          ON symbol.snapshot_id = ? AND symbol.id = candidate.symbol_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM activation_symbols AS current INDEXED BY sqlite_autoindex_activation_symbols_1
          WHERE current.id = symbol.id
        )
      )
      SELECT
        edge.*,
        reference.alias_lookup_keys_json,
        candidate.target_symbol_id,
        candidate.target_symbol_name,
        candidate.symbol_exported,
        candidate.symbol_kind,
        candidate.symbol_resolution_domain
      FROM resolved_candidates AS candidate
      CROSS JOIN activation_edges AS edge ON edge.id = candidate.edge_id
      CROSS JOIN activation_references AS reference ON reference.edge_id = candidate.edge_id
      ORDER BY candidate.edge_id
      LIMIT ${RESOLUTION_PAGE_ROWS}`,
  };
}

interface ReexportClosureRow {
  readonly imported_name: string;
  readonly local_name: string;
  readonly source_path: string;
  readonly target_path: string;
}

function persistentReexportAliasCapacityBoundary(
  snapshotId: string,
  rows: readonly PersistentReexportAliasRow[],
  temporary = false,
): CodeGraphDirectPersistentCapacityBoundary {
  let finalFactBytes = 0;
  for (const row of rows) {
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      row.lookup_key,
      row.symbol_id,
      'typescript',
      'alias',
      row.evidence_path,
    ]);
  }
  return {
    finalFactBytes,
    operation: temporary
      ? 'resolve temporary code graph reexport aliases'
      : 'resolve persistent code graph reexport aliases',
    rowCount: rows.length,
    ...(temporary ? {mainFilesystem: 'temporary' as const, transientFilesystem: 'temporary' as const} : {}),
  };
}

const capturePersistedAnalysisResolutionEdges = Effect.fn('codeGraph.capturePersistedAnalysisResolutionEdges')(
  function* (sql: SqlClient.SqlClient, snapshotId: string) {
    yield* sql.unsafe('DELETE FROM activation_analysis_edge_affected_ids');
    yield* sql.unsafe('DELETE FROM activation_analysis_edge_before');
    yield* sql.unsafe(`
    INSERT OR IGNORE INTO activation_analysis_edge_affected_ids (id)
    SELECT old_edge_id FROM activation_resolved_reference_batch
    UNION
    SELECT new_edge_id FROM activation_resolved_reference_batch
  `);
    yield* sql.unsafe(
      `
    INSERT INTO activation_analysis_edge_before (id, provenance, relation, confidence, endpoint_state)
    SELECT edge.id, edge.provenance, edge.relation, edge.confidence,
      CASE
        WHEN edge.source_id IS NULL OR edge.target_id IS NULL THEN 1
        WHEN edge.source_id = edge.target_id THEN 2
        ELSE 0
      END
    FROM activation_analysis_edge_affected_ids AS affected
    CROSS JOIN edges AS edge ON edge.snapshot_id = ? AND edge.id = affected.id
  `,
      [snapshotId],
    );
  },
);

const adjustPersistedAnalysisResolutionEdges = Effect.fn('codeGraph.adjustPersistedAnalysisResolutionEdges')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql.unsafe(
    `INSERT INTO snapshot_analysis_edge_histogram (
       snapshot_id, provenance, relation, confidence, endpoint_state, count
     )
     SELECT ?, provenance, relation, confidence, endpoint_state, -COUNT(*)
     FROM activation_analysis_edge_before
     GROUP BY provenance, relation, confidence, endpoint_state
     ON CONFLICT(snapshot_id, provenance, relation, confidence, endpoint_state) DO UPDATE SET
       count = snapshot_analysis_edge_histogram.count + excluded.count`,
    [snapshotId],
  );
  yield* sql.unsafe(
    `INSERT INTO snapshot_analysis_edge_histogram (
       snapshot_id, provenance, relation, confidence, endpoint_state, count
     )
     SELECT ?, edge.provenance, edge.relation, edge.confidence,
       CASE
         WHEN edge.source_id IS NULL OR edge.target_id IS NULL THEN 1
         WHEN edge.source_id = edge.target_id THEN 2
         ELSE 0
       END,
       COUNT(*)
     FROM activation_analysis_edge_affected_ids AS affected
     CROSS JOIN edges AS edge ON edge.snapshot_id = ? AND edge.id = affected.id
     GROUP BY edge.provenance, edge.relation, edge.confidence,
       CASE
         WHEN edge.source_id IS NULL OR edge.target_id IS NULL THEN 1
         WHEN edge.source_id = edge.target_id THEN 2
         ELSE 0
       END
     ON CONFLICT(snapshot_id, provenance, relation, confidence, endpoint_state) DO UPDATE SET
       count = snapshot_analysis_edge_histogram.count + excluded.count`,
    [snapshotId, snapshotId],
  );
  const invalid = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM snapshot_analysis_edge_histogram
    WHERE snapshot_id = ${snapshotId} AND count < 0
  `;
  if (Number(invalid[0]?.count ?? 0) > 0) {
    return yield* Effect.fail(new CodeGraphStoreError('Reference resolution produced a negative analysis delta.'));
  }
  yield* sql`
    DELETE FROM snapshot_analysis_edge_histogram
    WHERE snapshot_id = ${snapshotId} AND count = 0
  `;
});

function persistentReferenceResolutionCapacityBoundary(
  snapshotId: string,
  rows: readonly ResolvableActivationReferenceRow[],
  resolutions: readonly ActivationResolutionRow[],
  aliases: readonly (readonly [string, string, string, number, 'alias', string, string])[],
  temporary = false,
): CodeGraphDirectPersistentCapacityBoundary {
  let finalFactBytes = 0;
  for (const [index, resolution] of resolutions.entries()) {
    const row = rows[index];
    if (row === undefined)
      return {finalFactBytes: Number.NaN, operation: 'resolve persistent code graph references', rowCount: Number.NaN};
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      resolution.newEdgeId,
      typeof row.source_id === 'string' ? row.source_id : undefined,
      row.source_name,
      resolution.relation,
      resolution.targetId,
      resolution.targetName,
      resolution.provenance,
      row.evidence_path,
      row.evidence_span_json,
      // Both the before and after analysis histogram updates carry this
      // snapshot/group identity. Counting them per resolution is deliberately
      // conservative when many edges collapse into one aggregate row.
      snapshotId,
      row.provenance,
      row.relation,
      snapshotId,
      resolution.provenance,
      resolution.relation,
    ]);
  }
  for (const alias of aliases) {
    finalFactBytes = persistentBoundTextBytes(finalFactBytes, [
      snapshotId,
      alias[0],
      alias[1],
      alias[2],
      alias[4],
      alias[5],
      alias[6],
    ]);
  }
  return {
    finalFactBytes,
    operation: temporary ? 'resolve temporary code graph references' : 'resolve persistent code graph references',
    // Per resolved edge: replacement insert, old-edge delete, reference
    // delete, two histogram upserts, bounded zero-group cleanup, and ample
    // headroom for SQLite replace/index row work. Alias attempts are exact.
    rowCount: saturatingCapacityAdd(saturatingCapacityMultiply(resolutions.length, 10), aliases.length),
    ...(temporary ? {mainFilesystem: 'temporary' as const, transientFilesystem: 'temporary' as const} : {}),
  };
}

const identifyChangedSymbols = Effect.fn('codeGraph.identifyChangedSymbols')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string | undefined,
) {
  if (!baseSnapshotId) {
    yield* sql.unsafe('INSERT INTO activation_changed_symbol_ids (id) SELECT id FROM activation_symbols');
    return;
  }
  yield* sql`
    INSERT INTO activation_changed_symbol_ids (id)
    SELECT current.id
    FROM activation_symbols AS current
    LEFT JOIN symbols AS base
      ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
    WHERE base.id IS NULL
       OR base.content_hash IS NOT current.content_hash
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
       OR base.signature IS NOT current.signature
       OR base.documentation IS NOT current.documentation
       OR base.span_json IS NOT current.span_json
  `;
});

const promotionRemovedSnapshotId = Effect.fn('codeGraph.promotionRemovedSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  worktreeId: string,
) {
  const rows = yield* sql.unsafe<{readonly expected_snapshot_id: unknown}>(
    `SELECT CASE
       WHEN typeof(expected_snapshot_id) = 'text'
            AND length(CAST(expected_snapshot_id AS BLOB)) BETWEEN 45 AND 67
       THEN expected_snapshot_id ELSE NULL END AS expected_snapshot_id
     FROM removed_views
     WHERE worktree_id = ?
     LIMIT 2`,
    [worktreeId],
  );
  if (rows.length === 0) return undefined;
  if (
    rows.length !== 1 ||
    typeof rows[0]?.expected_snapshot_id !== 'string' ||
    !CODE_GRAPH_SNAPSHOT_ID.test(rows[0].expected_snapshot_id)
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Code graph removed view authority is invalid.'));
  }
  return rows[0].expected_snapshot_id;
});

export {
  stagePersistedFullFacts,
  positivePageLimit,
  persistentFullReferencePageTotal,
  decodePersistedReferenceCandidateRows,
  ReexportClosureRow,
  persistentReexportAliasCapacityBoundary,
  capturePersistedAnalysisResolutionEdges,
  adjustPersistedAnalysisResolutionEdges,
  persistentReferenceResolutionCapacityBoundary,
  identifyChangedSymbols,
  promotionRemovedSnapshotId,
  selectResumableForcedBuild,
  selectResumableBuildById,
};
