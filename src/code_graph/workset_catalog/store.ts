import {Clock, Crypto, Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '../../crypto/sha256.js';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphQualifiedRefHandle,
  codeGraphWorksetContinuationHandle,
  type QualifiedCodeGraphRefV1,
} from '../workset_evidence.js';
import {codeGraphWorksetCatalogLayout} from './layout.js';
import {
  codeGraphWorksetCatalogGenerationDigest,
  codeGraphWorksetCatalogGenerationIdentity,
  codeGraphWorksetCatalogGenerationReceiptIdentity,
  codeGraphWorksetRoutingProjectionDigestAppendCanonical,
  codeGraphWorksetRoutingProjectionDigestStart,
  validateCodeGraphWorksetRoutingProjectionReceipt,
} from './projection.js';
import {
  codeGraphWorksetPersistedResultDigest,
  codeGraphWorksetResultSetId,
  decodeStoredCodeGraphWorksetResultCard,
  decodeStoredCodeGraphWorksetResultEnvelope,
  prepareCodeGraphWorksetResultEnvelope,
  prepareCodeGraphWorksetResultSequence,
} from './result_set.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationDigestMemberV1,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationReceiptInputV1,
  type CodeGraphWorksetCatalogMaintenanceOptionsV1,
  type CodeGraphWorksetCatalogPublishedMemberV1,
  type CodeGraphWorksetCatalogRoutingSymbolCursorV1,
  type CodeGraphWorksetCatalogRoutingSymbolRecordV1,
  type CodeGraphWorksetResultSetInputV1,
  type CodeGraphWorksetResultSetMaintenanceOptionsV1,
  type CodeGraphWorksetResultSetPageV1,
  type CodeGraphWorksetResultSetRegistrationV1,
  type CodeGraphWorksetRoutingProjectionReceiptV1,
  type CodeGraphWorksetRoutingSymbolV1,
  type CodeGraphWorksetRoutingTermV1,
} from './types.js';

import {
  withCatalogWriter,
  withCatalogReader,
  selectProjectionForSnapshot,
  selectProjectionByDigest,
  projectionState,
  insertProjectionHeader,
  stageProjection,
  insertRoutingSymbol,
  loadAndValidateProjection,
  decodeProjectionMetadata,
  decodeRoutingSymbol,
  decodeQualifiedRef,
  validateResultSetIdentityInput,
  validateGenerationIdentity,
  validateResultSetGenerationForRegistration,
  validateResultSetReferences,
  decodeResultSetRow,
  storedResultSetSequenceReceipt,
  readStoredResultSetCursor,
  deleteExpiredResultSets,
  resultSetCapacity,
  loadGenerationMembers,
  selectGeneration,
  decodeGenerationRow,
  generationReceipt,
  generationIsPublished,
  initializeCatalogLayout,
  inspectCatalogLayout,
  removeCatalogFiles,
  rowCount,
  changes,
  currentIsoInstant,
  readLimit,
  retirementLimit,
  resultSetTtlMilliseconds,
  resultSetProjectorVersion,
  resultSetPageLimit,
  resultSetMaintenanceLimit,
  canonicalIso,
  optionalIsoInstant,
  requiredText,
  requiredInteger,
  requiredNumber,
  assertInputText,
  routingRowKey,
  validateInput,
  validateStored,
  mapCatalogError,
  invalid,
  corrupt,
} from './store_support.js';
export {withCodeGraphWorksetCatalogReader, withCodeGraphWorksetCatalogWriter} from './store_support.js';

const CATALOG_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;
export const CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM = 512;
const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const CONTINUATION_CURSOR = /^cgwc_[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LOCAL_NODE_ID = /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u;

interface GenerationRow {
  readonly generation_digest: unknown;
  readonly id: unknown;
  readonly manifest_digest: unknown;
  readonly member_count: unknown;
  readonly state: unknown;
  readonly workset_name: unknown;
}

interface GenerationMemberRow {
  readonly ordinal: unknown;
  readonly projection_digest: unknown;
  readonly repository_id: unknown;
  readonly repository_key: unknown;
  readonly snapshot_id: unknown;
  readonly worktree_id: unknown;
}

interface ProjectionRow {
  readonly checkout_id: unknown;
  readonly commit_id: unknown;
  readonly component_count: unknown;
  readonly extractor_generation: unknown;
  readonly projection_digest: unknown;
  readonly projector_version: unknown;
  readonly repository_id: unknown;
  readonly snapshot_digest: unknown;
  readonly snapshot_id: unknown;
  readonly state: unknown;
  readonly symbol_count: unknown;
  readonly worktree_id: unknown;
}

interface RoutingSymbolRow {
  readonly exported: unknown;
  readonly kind: unknown;
  readonly language: unknown;
  readonly name: unknown;
  readonly node_id: unknown;
  readonly package_name: unknown;
  readonly path: unknown;
  readonly qualified_name: unknown;
  readonly span_column: unknown;
  readonly span_end_column: unknown;
  readonly span_end_line: unknown;
  readonly span_line: unknown;
}

interface RoutingLookupKeyRow {
  readonly lookup_key: unknown;
  readonly node_id: unknown;
}

interface RoutingTermRow {
  readonly node_id: unknown;
  readonly term: unknown;
  readonly weight: unknown;
}

interface QualifiedRefRow {
  readonly created_at: unknown;
  readonly node_id: unknown;
  readonly ref: unknown;
  readonly repository_id: unknown;
}

interface ResultSetRow {
  readonly card_count: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly envelope_bytes: unknown;
  readonly envelope_digest: unknown;
  readonly envelope_json: unknown;
  readonly generation_digest: unknown;
  readonly generation_id: unknown;
  readonly generation_state: unknown;
  readonly id: unknown;
  readonly offset: unknown;
  readonly projector_version: unknown;
  readonly result_set_token: unknown;
  readonly sequence_digest: unknown;
  readonly stored_generation_digest: unknown;
  readonly total_bytes: unknown;
  readonly workset_name: unknown;
}

interface ResultCardRow {
  readonly card_bytes: unknown;
  readonly card_digest: unknown;
  readonly card_id: unknown;
  readonly card_json: unknown;
  readonly ordinal: unknown;
  readonly qualified_ref: unknown;
  readonly repository_key: unknown;
}

export const ensureCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.ensure')(function* (
  threadnoteHome: string,
) {
  yield* withCatalogWriter(threadnoteHome, () => Effect.void);
});

/** Create or reset one projection header before bounded symbol pages are appended. */
export const beginCodeGraphWorksetCatalogProjection = Effect.fn('codeGraphWorksetCatalog.beginProjection')(function* (
  threadnoteHome: string,
  input: CodeGraphWorksetRoutingProjectionReceiptV1,
) {
  const receipt = yield* validateInput(() => validateCodeGraphWorksetRoutingProjectionReceipt(input));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    Effect.gen(function* () {
      const now = yield* currentIsoInstant;
      const existing = yield* selectProjectionForSnapshot(sql, receipt);
      if (existing !== undefined) {
        if (existing.projection_digest !== receipt.projectionDigest) {
          return yield* Effect.fail(
            invalid('A ready snapshot produced different records for the same projector version.'),
          );
        }
        if (existing.state === 'ready') {
          yield* loadAndValidateProjection(sql, receipt.projectionDigest, true);
          return {receipt, state: 'ready' as const};
        }
        yield* sql.withTransaction(
          sql.unsafe('DELETE FROM repository_snapshots WHERE projection_digest = ? AND state = ?', [
            receipt.projectionDigest,
            'staging',
          ]),
        );
      }
      yield* insertProjectionHeader(sql, receipt, now);
      return {receipt, state: 'staging' as const};
    }),
  );
});

/** Append one canonical bounded symbol page in a short catalog transaction. */
export const appendCodeGraphWorksetCatalogProjectionPage = Effect.fn('codeGraphWorksetCatalog.appendProjectionPage')(
  function* (
    threadnoteHome: string,
    input: {readonly projectionDigest: string; readonly symbols: readonly CodeGraphWorksetRoutingSymbolV1[]},
  ) {
    yield* validateInput(() => {
      if (!SHA256_HEX.test(input.projectionDigest)) throw invalid('Workset projection digest is invalid.');
      if (input.symbols.length < 1 || input.symbols.length > CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM) {
        throw invalid('Workset projection page size is invalid.');
      }
      codeGraphWorksetRoutingProjectionDigestAppendCanonical(
        codeGraphWorksetRoutingProjectionDigestStart(),
        input.symbols,
      );
    });
    yield* withCatalogWriter(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* projectionState(sql, input.projectionDigest);
          if (state !== 'staging') {
            return yield* Effect.fail(new CodeGraphWorksetCatalogError('stale', 'Projection staging is not active.'));
          }
          yield* Effect.forEach(input.symbols, symbol => insertRoutingSymbol(sql, input.projectionDigest, symbol), {
            concurrency: 1,
            discard: true,
          });
        }),
      ),
    );
  },
);

/** Recompute streamed integrity and make one fully appended projection eligible for a generation. */
export const completeCodeGraphWorksetCatalogProjection = Effect.fn('codeGraphWorksetCatalog.completeProjection')(
  function* (threadnoteHome: string, projectionDigest: string) {
    yield* validateInput(() => {
      if (!SHA256_HEX.test(projectionDigest)) throw invalid('Workset projection digest is invalid.');
    });
    return yield* withCatalogWriter(threadnoteHome, sql =>
      Effect.gen(function* () {
        const projection = yield* loadAndValidateProjection(sql, projectionDigest);
        if (projection.state === 'ready') return projection.receipt;
        yield* sql.withTransaction(
          sql.unsafe(
            `UPDATE repository_snapshots SET state = 'ready'
             WHERE projection_digest = ? AND state = 'staging'`,
            [projectionDigest],
          ),
        );
        if ((yield* changes(sql)) !== 1) {
          return yield* Effect.fail(corrupt('Routing projection publication lost its staging state.'));
        }
        return projection.receipt;
      }),
    );
  },
);

/**
 * Materialize repository projections under a durable staging generation. Each
 * projection is committed independently, while published readers continue to
 * resolve only the existing generation pointer.
 */
export const stageCodeGraphWorksetCatalogGeneration = Effect.fn('codeGraphWorksetCatalog.stageGeneration')(function* (
  threadnoteHome: string,
  input: CodeGraphWorksetCatalogGenerationInputV1,
) {
  const identity = yield* validateInput(() => codeGraphWorksetCatalogGenerationIdentity(input));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    Effect.gen(function* () {
      const now = yield* currentIsoInstant;
      const existing = yield* selectGeneration(sql, identity.id);
      if (existing?.state === 'ready') {
        const published = yield* generationIsPublished(sql, identity.id, input.worksetName);
        if (!published) {
          return yield* Effect.fail(corrupt('A ready workset generation has no matching published pointer.'));
        }
        return generationReceipt(existing);
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (existing !== undefined) {
            yield* sql.unsafe('DELETE FROM workset_generations WHERE id = ?', [identity.id]);
          }
          yield* sql.unsafe(
            `INSERT INTO workset_generations (
                 id, workset_name, manifest_digest, generation_digest, state,
                 member_count, created_at, published_at
               ) VALUES (?, ?, ?, ?, 'staging', ?, ?, NULL)`,
            [identity.id, input.worksetName, input.manifestDigest, identity.digest, identity.members.length, now],
          );
        }),
      );

      for (let ordinal = 0; ordinal < identity.members.length; ordinal += 1) {
        const member = identity.members[ordinal]!;
        yield* stageProjection(sql, member.projection, now);
        yield* sql.withTransaction(
          sql.unsafe(
            `INSERT INTO workset_generation_members (
                 generation_id, ordinal, repository_key, repository_id, snapshot_id, projection_digest
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              identity.id,
              ordinal,
              member.repositoryKey,
              member.projection.repositoryId,
              member.projection.snapshotId,
              member.projection.projectionDigest,
            ],
          ),
        );
      }
      const count = yield* rowCount(
        sql,
        'SELECT COUNT(*) AS count FROM workset_generation_members WHERE generation_id = ?',
        [identity.id],
      );
      if (count !== identity.members.length) {
        return yield* Effect.fail(corrupt('Staged workset generation member count is inconsistent.'));
      }
      return {
        digest: identity.digest,
        id: identity.id,
        manifestDigest: input.manifestDigest,
        memberCount: identity.members.length,
        state: 'staging' as const,
        worksetName: input.worksetName,
      };
    }),
  );
});

/** Stage a deterministic generation from lightweight, already-streamed projection receipts. */
export const stageCodeGraphWorksetCatalogGenerationFromReceipts = Effect.fn(
  'codeGraphWorksetCatalog.stageGenerationFromReceipts',
)(function* (threadnoteHome: string, input: CodeGraphWorksetCatalogGenerationReceiptInputV1) {
  const identity = yield* validateInput(() => codeGraphWorksetCatalogGenerationReceiptIdentity(input));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    Effect.gen(function* () {
      const now = yield* currentIsoInstant;
      const existing = yield* selectGeneration(sql, identity.id);
      if (existing?.state === 'ready') {
        if (!(yield* generationIsPublished(sql, identity.id, input.worksetName))) {
          return yield* Effect.fail(corrupt('A ready workset generation has no matching published pointer.'));
        }
        return generationReceipt(existing);
      }
      for (const member of identity.members) {
        const projection = yield* selectProjectionByDigest(sql, member.projectionDigest);
        if (
          projection === undefined ||
          projection.state !== 'ready' ||
          projection.repository_id !== member.repositoryId ||
          projection.snapshot_id !== member.snapshotId
        ) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError('missing', 'A streamed workset projection is not ready for staging.'),
          );
        }
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (existing !== undefined) yield* sql.unsafe('DELETE FROM workset_generations WHERE id = ?', [identity.id]);
          yield* sql.unsafe(
            `INSERT INTO workset_generations (
               id, workset_name, manifest_digest, generation_digest, state,
               member_count, created_at, published_at
             ) VALUES (?, ?, ?, ?, 'staging', ?, ?, NULL)`,
            [identity.id, input.worksetName, input.manifestDigest, identity.digest, identity.members.length, now],
          );
        }),
      );
      for (let ordinal = 0; ordinal < identity.members.length; ordinal += 1) {
        const member = identity.members[ordinal]!;
        yield* sql.withTransaction(
          sql.unsafe(
            `INSERT INTO workset_generation_members (
               generation_id, ordinal, repository_key, repository_id, snapshot_id, projection_digest
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              identity.id,
              ordinal,
              member.repositoryKey,
              member.repositoryId,
              member.snapshotId,
              member.projectionDigest,
            ],
          ),
        );
      }
      return {
        digest: identity.digest,
        id: identity.id,
        manifestDigest: input.manifestDigest,
        memberCount: identity.members.length,
        state: 'staging' as const,
        worksetName: input.worksetName,
      };
    }),
  );
});

/** Atomically replace one workset's published pointer after validating every staged projection receipt. */
export const publishCodeGraphWorksetCatalogGeneration = Effect.fn('codeGraphWorksetCatalog.publishGeneration')(
  function* <E, R>(
    threadnoteHome: string,
    input: {
      /** Final lease/snapshot guard run under the writer lock before the pointer transaction. */
      readonly beforePointerSwap?: () => Effect.Effect<void, E, R>;
      readonly generationId: string;
      readonly worksetName: string;
    },
  ) {
    yield* validateInput(() => {
      if (!GENERATION_ID.test(input.generationId)) throw invalid('Workset catalog generation identity is invalid.');
      assertInputText(input.worksetName, 'workset name', 256);
    });
    return yield* withCatalogWriter(threadnoteHome, sql =>
      Effect.gen(function* () {
        const generation = yield* selectGeneration(sql, input.generationId);
        if (generation === undefined || generation.workset_name !== input.worksetName) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError('missing', 'The staged workset catalog generation does not exist.'),
          );
        }
        if (generation.state === 'ready') {
          if (!(yield* generationIsPublished(sql, input.generationId, input.worksetName))) {
            return yield* Effect.fail(corrupt('A ready workset generation has no matching published pointer.'));
          }
          return generationReceipt(generation);
        }
        if (generation.state !== 'staging') {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError('invalid-input', 'A retired workset generation cannot be published.'),
          );
        }
        const members = yield* loadGenerationMembers(sql, input.generationId);
        if (members.length !== generation.member_count) {
          return yield* Effect.fail(corrupt('Staged workset generation is incomplete.'));
        }
        const digestMembers: CodeGraphWorksetCatalogGenerationDigestMemberV1[] = [];
        for (const member of members) {
          // Projection validation can read a complete repository projection,
          // so it intentionally runs before the short pointer transaction.
          // The home-global writer lock fences every supported catalog writer.
          const projection = yield* loadAndValidateProjection(sql, member.projection_digest, true);
          if (
            projection.receipt.repositoryId !== member.repository_id ||
            projection.receipt.snapshotId !== member.snapshot_id
          ) {
            return yield* Effect.fail(corrupt('A staged workset member does not match its routing projection.'));
          }
          digestMembers.push({
            projectionDigest: projection.receipt.projectionDigest,
            repositoryId: projection.receipt.repositoryId,
            repositoryKey: member.repository_key,
            snapshotId: projection.receipt.snapshotId,
          });
        }
        const digest = yield* validateInput(() =>
          codeGraphWorksetCatalogGenerationDigest(generation.workset_name, generation.manifest_digest, digestMembers),
        );
        if (digest !== generation.generation_digest || `cgwg_${digest.slice(0, 40)}` !== generation.id) {
          return yield* Effect.fail(corrupt('Staged workset generation digest validation failed.'));
        }
        if (input.beforePointerSwap !== undefined) yield* input.beforePointerSwap();
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const fenced = yield* selectGeneration(sql, input.generationId);
            if (
              fenced === undefined ||
              fenced.state !== 'staging' ||
              fenced.generation_digest !== digest ||
              fenced.member_count !== members.length
            ) {
              return yield* Effect.fail(corrupt('Workset generation changed before pointer publication.'));
            }
            const now = yield* currentIsoInstant;
            yield* sql.unsafe(
              `UPDATE workset_generations
             SET state = 'retired'
             WHERE id = (
               SELECT generation_id FROM published_worksets WHERE workset_name = ?
             ) AND id <> ?`,
              [input.worksetName, input.generationId],
            );
            yield* sql.unsafe(
              `UPDATE workset_generations
             SET state = 'ready', published_at = ?
             WHERE id = ? AND state = 'staging'`,
              [now, input.generationId],
            );
            if ((yield* changes(sql)) !== 1) {
              return yield* Effect.fail(corrupt('Workset generation publication lost its staging state.'));
            }
            yield* sql.unsafe(
              `INSERT INTO published_worksets (workset_name, generation_id, published_at)
             VALUES (?, ?, ?)
             ON CONFLICT(workset_name) DO UPDATE SET
               generation_id = excluded.generation_id,
               published_at = excluded.published_at`,
              [input.worksetName, input.generationId, now],
            );
            return {...generationReceipt(generation), state: 'ready' as const};
          }),
        );
      }),
    );
  },
);

export const readPublishedCodeGraphWorksetCatalogGeneration = Effect.fn(
  'codeGraphWorksetCatalog.readPublishedGeneration',
)(function* (threadnoteHome: string, worksetName: string) {
  yield* validateInput(() => assertInputText(worksetName, 'workset name', 256));
  return yield* withCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<GenerationRow>(
          `SELECT g.id, g.workset_name, g.manifest_digest, g.generation_digest, g.state, g.member_count
           FROM published_worksets AS p
           JOIN workset_generations AS g ON g.id = p.generation_id
           WHERE p.workset_name = ? AND g.state = 'ready'
           LIMIT 1`,
          [worksetName],
        );
        if (rows.length === 0) return undefined;
        const generation = yield* decodeGenerationRow(rows[0]!);
        const memberRows = yield* loadGenerationMembers(sql, generation.id);
        if (memberRows.length !== generation.member_count) {
          return yield* Effect.fail(corrupt('Published workset generation is incomplete.'));
        }
        const members: CodeGraphWorksetCatalogPublishedMemberV1[] = [];
        for (const member of memberRows) {
          const projections = yield* sql.unsafe<ProjectionRow>(
            `SELECT projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
                    snapshot_digest, commit_id, extractor_generation, projector_version,
                    component_count, symbol_count, state
             FROM repository_snapshots
             WHERE projection_digest = ? AND state = 'ready'
             LIMIT 1`,
            [member.projection_digest],
          );
          if (projections.length !== 1) {
            return yield* Effect.fail(corrupt('Published workset projection is missing.'));
          }
          const projection = yield* decodeProjectionMetadata(projections[0]!);
          members.push({
            checkoutId: projection.checkout_id,
            commitId: projection.commit_id,
            ordinal: member.ordinal,
            projectionDigest: projection.projection_digest,
            repositoryId: projection.repository_id,
            repositoryKey: member.repository_key,
            snapshotDigest: projection.snapshot_digest,
            snapshotId: projection.snapshot_id,
            symbolCount: projection.symbol_count,
            worktreeId: projection.worktree_id,
          });
        }
        return {
          digest: generation.generation_digest,
          id: generation.id,
          manifestDigest: generation.manifest_digest,
          members,
          worksetName: generation.workset_name,
        };
      }),
    ),
  );
});

/** Bounded deterministic keyset read for future global routing queries. */
export const readCodeGraphWorksetCatalogRoutingSymbols = Effect.fn('codeGraphWorksetCatalog.readRoutingSymbols')(
  function* (
    threadnoteHome: string,
    input: {
      readonly after?: CodeGraphWorksetCatalogRoutingSymbolCursorV1;
      readonly limit?: number;
      readonly worksetName: string;
    },
  ) {
    const limit = yield* validateInput(() => readLimit(input.limit));
    yield* validateInput(() => {
      assertInputText(input.worksetName, 'workset name', 256);
      if (input.after !== undefined) {
        if (
          !Number.isSafeInteger(input.after.ordinal) ||
          input.after.ordinal < 0 ||
          !LOCAL_NODE_ID.test(input.after.nodeId)
        ) {
          throw invalid('Workset catalog routing cursor is invalid.');
        }
      }
    });
    return yield* withCatalogReader(threadnoteHome, sql =>
      sql.withTransaction(
        Effect.gen(function* () {
          const generationRows = yield* sql.unsafe<{readonly generation_id: unknown}>(
            `SELECT p.generation_id
           FROM published_worksets AS p
           JOIN workset_generations AS g ON g.id = p.generation_id
           WHERE p.workset_name = ? AND g.state = 'ready'
           LIMIT 1`,
            [input.worksetName],
          );
          if (generationRows.length === 0) return undefined;
          const generationId = requiredText(generationRows[0]!.generation_id, 'published generation identity');
          const afterOrdinal = input.after?.ordinal ?? -1;
          const afterNodeId = input.after?.nodeId ?? '';
          const selectionSql = `
          SELECT m.ordinal, m.repository_key, m.repository_id, m.snapshot_id, m.projection_digest,
                 s.node_id, s.kind, s.language, s.exported, s.package_name, s.path,
                 s.name, s.qualified_name, s.span_line, s.span_column, s.span_end_line,
                 s.span_end_column
          FROM workset_generation_members AS m
          JOIN routing_symbols AS s ON s.projection_digest = m.projection_digest
          WHERE m.generation_id = ?
            AND (m.ordinal > ? OR (m.ordinal = ? AND s.node_id > ?))
          ORDER BY m.ordinal, s.node_id
          LIMIT ?`;
          const rows = yield* sql.unsafe<GenerationMemberRow & RoutingSymbolRow>(selectionSql, [
            generationId,
            afterOrdinal,
            afterOrdinal,
            afterNodeId,
            limit + 1,
          ]);
          const visible = rows.slice(0, limit);
          const terms =
            visible.length === 0
              ? []
              : yield* sql.unsafe<RoutingTermRow & {readonly ordinal: unknown}>(
                  `WITH selected AS (
                   SELECT m.ordinal, m.projection_digest, s.node_id
                   FROM workset_generation_members AS m
                   JOIN routing_symbols AS s ON s.projection_digest = m.projection_digest
                   WHERE m.generation_id = ?
                     AND (m.ordinal > ? OR (m.ordinal = ? AND s.node_id > ?))
                   ORDER BY m.ordinal, s.node_id
                   LIMIT ?
                 )
                 SELECT selected.ordinal, selected.node_id, t.term, t.weight
                 FROM selected
                 JOIN routing_terms AS t
                   ON t.projection_digest = selected.projection_digest AND t.node_id = selected.node_id
                 ORDER BY selected.ordinal, selected.node_id, t.term
                 LIMIT ?`,
                  [
                    generationId,
                    afterOrdinal,
                    afterOrdinal,
                    afterNodeId,
                    limit,
                    limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol + 1,
                  ],
                );
          const lookupKeys =
            visible.length === 0
              ? []
              : yield* sql.unsafe<RoutingLookupKeyRow & {readonly ordinal: unknown}>(
                  `WITH selected AS (
                   SELECT m.ordinal, m.projection_digest, s.node_id
                   FROM workset_generation_members AS m
                   JOIN routing_symbols AS s ON s.projection_digest = m.projection_digest
                   WHERE m.generation_id = ?
                     AND (m.ordinal > ? OR (m.ordinal = ? AND s.node_id > ?))
                   ORDER BY m.ordinal, s.node_id
                   LIMIT ?
                 )
                 SELECT selected.ordinal, selected.node_id, k.lookup_key
                 FROM selected
                 JOIN routing_lookup_keys AS k
                   ON k.projection_digest = selected.projection_digest AND k.node_id = selected.node_id
                 ORDER BY selected.ordinal, selected.node_id, k.lookup_key
                 LIMIT ?`,
                  [
                    generationId,
                    afterOrdinal,
                    afterOrdinal,
                    afterNodeId,
                    limit,
                    limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol + 1,
                  ],
                );
          if (terms.length > limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol) {
            return yield* Effect.fail(corrupt('Routing symbol term count exceeds the supported bound.'));
          }
          if (lookupKeys.length > limit * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol) {
            return yield* Effect.fail(corrupt('Routing symbol lookup-key count exceeds the supported bound.'));
          }
          const termsBySymbol = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
          for (const row of terms) {
            const key = routingRowKey(
              requiredInteger(row.ordinal, 'routing ordinal'),
              requiredText(row.node_id, 'node identity'),
            );
            const entries = termsBySymbol.get(key) ?? [];
            entries.push({
              term: requiredText(row.term, 'routing term'),
              weight: requiredNumber(row.weight, 'term weight'),
            });
            termsBySymbol.set(key, entries);
          }
          const lookupKeysBySymbol = new Map<string, string[]>();
          for (const row of lookupKeys) {
            const key = routingRowKey(
              requiredInteger(row.ordinal, 'routing ordinal'),
              requiredText(row.node_id, 'node identity'),
            );
            const entries = lookupKeysBySymbol.get(key) ?? [];
            entries.push(requiredText(row.lookup_key, 'lookup key'));
            lookupKeysBySymbol.set(key, entries);
          }
          const symbols: CodeGraphWorksetCatalogRoutingSymbolRecordV1[] = [];
          for (const row of visible) {
            const ordinal = requiredInteger(row.ordinal, 'routing ordinal');
            const nodeId = requiredText(row.node_id, 'node identity');
            const key = routingRowKey(ordinal, nodeId);
            const symbol = yield* decodeRoutingSymbol(
              row,
              lookupKeysBySymbol.get(key) ?? [],
              termsBySymbol.get(key) ?? [],
            );
            symbols.push({
              ...symbol,
              ordinal,
              projectionDigest: requiredText(row.projection_digest, 'projection digest'),
              repositoryId: requiredText(row.repository_id, 'repository identity'),
              repositoryKey: requiredText(row.repository_key, 'repository key'),
              snapshotId: requiredText(row.snapshot_id, 'snapshot identity'),
            });
          }
          const last = symbols.at(-1);
          return {
            generationId,
            ...(rows.length > limit && last !== undefined ? {next: {nodeId: last.nodeId, ordinal: last.ordinal}} : {}),
            symbols,
            worksetName: input.worksetName,
          };
        }),
      ),
    );
  },
);

/** Verify that one stable node belongs to an exact published projection surface. */
export const codeGraphWorksetCatalogProjectionContainsNode = Effect.fn(
  'codeGraphWorksetCatalog.projectionContainsNode',
)(function* (threadnoteHome: string, input: {readonly nodeId: string; readonly projectionDigest: string}) {
  yield* validateInput(() => {
    if (!LOCAL_NODE_ID.test(input.nodeId)) throw invalid('Workset projection node identity is invalid.');
    if (!SHA256_HEX.test(input.projectionDigest)) throw invalid('Workset projection digest is invalid.');
  });
  return yield* withCatalogReader(threadnoteHome, sql =>
    sql
      .unsafe<{readonly present: unknown}>(
        `SELECT 1 AS present
         FROM routing_symbols
         WHERE projection_digest = ? AND node_id = ?
         LIMIT 1`,
        [input.projectionDigest, input.nodeId],
      )
      .pipe(Effect.map(rows => rows.length === 1)),
  );
});

/** Register the deterministic home-local mapping for one repository-qualified graph node. */
export const registerCodeGraphQualifiedRef = Effect.fn('codeGraphWorksetCatalog.registerQualifiedRef')(function* (
  threadnoteHome: string,
  input: QualifiedCodeGraphRefV1,
) {
  const ref = yield* validateInput(() => codeGraphQualifiedRefHandle(input));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const createdAt = yield* currentIsoInstant;
        yield* sql.unsafe(
          `INSERT INTO qualified_refs (ref, repository_id, node_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [ref, input.repositoryId, input.nodeId, createdAt],
        );
        const rows = yield* sql.unsafe<QualifiedRefRow>(
          `SELECT ref, repository_id, node_id, created_at
           FROM qualified_refs WHERE ref = ? LIMIT 1`,
          [ref],
        );
        if (rows.length !== 1) return yield* Effect.fail(corrupt('Qualified reference registration disappeared.'));
        const record = yield* decodeQualifiedRef(rows[0]!);
        if (record.repositoryId !== input.repositoryId || record.nodeId !== input.nodeId) {
          return yield* Effect.fail(corrupt('Qualified reference identity collision detected.'));
        }
        return record;
      }),
    ),
  );
});

/** Resolve one qualified handle, optionally fencing it to an expected repository. */
export const resolveCodeGraphQualifiedRef = Effect.fn('codeGraphWorksetCatalog.resolveQualifiedRef')(function* (
  threadnoteHome: string,
  input: {readonly ref: string; readonly repositoryId?: string},
) {
  yield* validateInput(() => {
    if (!QUALIFIED_REF.test(input.ref)) throw invalid('Qualified code graph reference is invalid.');
    if (input.repositoryId !== undefined && !SHA256_HEX.test(input.repositoryId)) {
      throw invalid('Qualified code graph repository identity is invalid.');
    }
  });
  const record = yield* withCatalogReader(threadnoteHome, sql =>
    Effect.gen(function* () {
      const rows = yield* sql.unsafe<QualifiedRefRow>(
        `SELECT ref, repository_id, node_id, created_at
         FROM qualified_refs
         WHERE ref = ?${input.repositoryId === undefined ? '' : ' AND repository_id = ?'}
         LIMIT 1`,
        input.repositoryId === undefined ? [input.ref] : [input.ref, input.repositoryId],
      );
      return rows.length === 0 ? undefined : yield* decodeQualifiedRef(rows[0]!);
    }),
  );
  if (record === undefined) {
    return yield* Effect.fail(
      new CodeGraphWorksetCatalogError('missing', 'The repository-qualified graph reference is not registered.'),
    );
  }
  return record;
});

/**
 * Persist one globally ranked evidence sequence and every bounded cursor
 * boundary. Old catalog generations remain pinned until their result sets are
 * pruned, so continuation never re-ranks against a newer generation.
 */
export const registerCodeGraphWorksetResultSet = Effect.fn('codeGraphWorksetCatalog.registerResultSet')(function* (
  threadnoteHome: string,
  input: CodeGraphWorksetResultSetInputV1,
) {
  const envelope = yield* validateInput(() => prepareCodeGraphWorksetResultEnvelope(input.result));
  const result = envelope.result;
  const sequence = yield* validateInput(() => prepareCodeGraphWorksetResultSequence(result.cards));
  const totalBytes = envelope.bytes + sequence.totalBytes;
  if (totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetBytesMaximum) {
    return yield* Effect.fail(
      new CodeGraphWorksetCatalogError('invalid-input', 'Workset persisted result bytes exceed the supported bound.'),
    );
  }
  const persistedDigest = codeGraphWorksetPersistedResultDigest(envelope.digest, sequence.digest);
  const ttlMilliseconds = yield* validateInput(() => resultSetTtlMilliseconds(input.ttlMilliseconds));
  yield* validateInput(() => validateResultSetIdentityInput(result, input.projectorVersion));
  const crypto = yield* Crypto.Crypto;
  const resultSetToken = sha256HexSync(yield* crypto.randomBytes(32));
  const resultSetId = codeGraphWorksetResultSetId(resultSetToken);
  const cursors = Array.from({length: sequence.cards.length + 1}, (_, offset) =>
    codeGraphWorksetContinuationHandle({
      generationDigest: result.workset.generation.digest,
      offset,
      projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
      resultSetToken,
    }),
  );
  const createdAtMilliseconds = yield* Clock.currentTimeMillis;
  const createdAt = new Date(createdAtMilliseconds).toISOString();
  const expiresAt = new Date(createdAtMilliseconds + ttlMilliseconds).toISOString();
  yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* validateResultSetGenerationForRegistration(sql, result);
        yield* validateResultSetReferences(sql, result.workset.generation.id, sequence);
        yield* deleteExpiredResultSets(sql, createdAt, CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum);
        const capacity = yield* resultSetCapacity(sql);
        if (
          capacity.count + 1 > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum ||
          capacity.bytes + totalBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsBytesMaximum
        ) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError(
              'capacity',
              'The bounded workset result-set cache is full; prune expired cursors or repeat the small request later.',
            ),
          );
        }
        yield* sql.unsafe(
          `INSERT INTO result_sets (
             id, workset_name, generation_id, generation_digest, projector_version,
             result_set_token, sequence_digest, envelope_json, envelope_bytes, envelope_digest,
             card_count, total_bytes, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resultSetId,
            result.workset.name,
            result.workset.generation.id,
            result.workset.generation.digest,
            input.projectorVersion,
            resultSetToken,
            persistedDigest,
            envelope.json,
            envelope.bytes,
            envelope.digest,
            sequence.cards.length,
            totalBytes,
            createdAt,
            expiresAt,
          ],
        );
        yield* Effect.forEach(
          sequence.cards,
          (card, ordinal) =>
            sql.unsafe(
              `INSERT INTO result_cards (
                 result_set_id, ordinal, card_id, qualified_ref, repository_key,
                 card_json, card_bytes, card_digest
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                resultSetId,
                ordinal,
                card.card.id,
                card.card.ref,
                card.card.repositoryKey,
                card.json,
                card.bytes,
                card.digest,
              ],
            ),
          {concurrency: 1, discard: true},
        );
        yield* Effect.forEach(
          cursors,
          (cursor, offset) =>
            sql.unsafe('INSERT INTO result_set_cursors (cursor, result_set_id, offset) VALUES (?, ?, ?)', [
              cursor,
              resultSetId,
              offset,
            ]),
          {concurrency: 1, discard: true},
        );
        const stored = yield* storedResultSetSequenceReceipt(sql, resultSetId);
        if (
          stored.count !== sequence.cards.length ||
          stored.bytes + envelope.bytes !== totalBytes ||
          codeGraphWorksetPersistedResultDigest(envelope.digest, stored.digest) !== persistedDigest ||
          (yield* rowCount(sql, 'SELECT COUNT(*) AS count FROM result_set_cursors WHERE result_set_id = ?', [
            resultSetId,
          ])) !== cursors.length
        ) {
          return yield* Effect.fail(corrupt('Stored workset result-set receipt is inconsistent.'));
        }
      }),
    ),
  );
  return {
    cardCount: sequence.cards.length,
    continuationForOffset: (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= cursors.length) {
        throw invalid('Workset result-set continuation offset is invalid.');
      }
      return cursors[offset]!;
    },
    createdAt,
    expiresAt,
    generation: result.workset.generation,
    id: resultSetId,
    initialCursor: cursors[0]!,
    projectorVersion: input.projectorVersion,
    totalBytes,
    worksetName: result.workset.name,
  } satisfies CodeGraphWorksetResultSetRegistrationV1;
});

/** Resolve a persisted keyset page without re-running routing or ranking. */
export const readCodeGraphWorksetResultSetPage = Effect.fn('codeGraphWorksetCatalog.readResultSetPage')(function* (
  threadnoteHome: string,
  input: {
    readonly cursor: string;
    readonly expectedGeneration?: {readonly digest: string; readonly id: string};
    readonly expectedProjectorVersion?: number;
    readonly limit?: number;
  },
) {
  const limit = yield* validateInput(() => resultSetPageLimit(input.limit));
  const expectedProjectorVersion = yield* validateInput(() =>
    resultSetProjectorVersion(input.expectedProjectorVersion ?? CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION),
  );
  yield* validateInput(() => {
    if (!CONTINUATION_CURSOR.test(input.cursor)) throw invalid('Workset continuation cursor is invalid.');
    if (input.expectedGeneration !== undefined) validateGenerationIdentity(input.expectedGeneration);
  });
  const now = yield* currentIsoInstant;
  const page = yield* withCatalogReader(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<ResultSetRow>(
          `SELECT c.offset, r.id, r.workset_name, r.generation_id, r.generation_digest,
                  r.projector_version, r.result_set_token, r.sequence_digest, r.card_count,
                  r.envelope_json, r.envelope_bytes, r.envelope_digest,
                  r.total_bytes, r.created_at, r.expires_at,
                  g.generation_digest AS stored_generation_digest, g.state AS generation_state
           FROM result_set_cursors AS c
           JOIN result_sets AS r ON r.id = c.result_set_id
           JOIN workset_generations AS g ON g.id = r.generation_id
           WHERE c.cursor = ?
           LIMIT 1`,
          [input.cursor],
        );
        if (rows.length === 0) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError(
              'missing',
              'The workset continuation cursor is missing; repeat the original small request.',
            ),
          );
        }
        const resultSet = yield* decodeResultSetRow(rows[0]!);
        if (resultSet.expiresAt <= now) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError(
              'expired',
              'The workset continuation cursor expired; repeat the original small request.',
            ),
          );
        }
        if (
          resultSet.projectorVersion !== CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION ||
          resultSet.projectorVersion !== expectedProjectorVersion
        ) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError(
              'incompatible',
              'The workset continuation projector version is incompatible; repeat the original small request.',
            ),
          );
        }
        if (
          input.expectedGeneration !== undefined &&
          (input.expectedGeneration.id !== resultSet.generation.id ||
            input.expectedGeneration.digest !== resultSet.generation.digest)
        ) {
          return yield* Effect.fail(
            new CodeGraphWorksetCatalogError(
              'stale',
              'The workset continuation belongs to a different catalog generation.',
            ),
          );
        }
        const expectedCursor = codeGraphWorksetContinuationHandle({
          generationDigest: resultSet.generation.digest,
          offset: resultSet.offset,
          projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
          resultSetToken: resultSet.resultSetToken,
        });
        if (expectedCursor !== input.cursor || codeGraphWorksetResultSetId(resultSet.resultSetToken) !== resultSet.id) {
          return yield* Effect.fail(corrupt('Workset continuation identity validation failed.'));
        }
        const sequence = yield* storedResultSetSequenceReceipt(sql, resultSet.id);
        const envelope = yield* validateStored(() =>
          decodeStoredCodeGraphWorksetResultEnvelope(
            resultSet.envelopeJson,
            resultSet.envelopeBytes,
            resultSet.envelopeDigest,
          ),
        );
        if (
          sequence.count !== resultSet.cardCount ||
          sequence.bytes + resultSet.envelopeBytes !== resultSet.totalBytes ||
          codeGraphWorksetPersistedResultDigest(resultSet.envelopeDigest, sequence.digest) !==
            resultSet.sequenceDigest ||
          envelope.workset.name !== resultSet.worksetName ||
          envelope.workset.generation.id !== resultSet.generation.id ||
          envelope.workset.generation.digest !== resultSet.generation.digest
        ) {
          return yield* Effect.fail(corrupt('Workset continuation sequence receipt is inconsistent.'));
        }
        const cardRows = yield* sql.unsafe<ResultCardRow>(
          `SELECT ordinal, card_id, qualified_ref, repository_key, card_json, card_bytes, card_digest
           FROM result_cards
           WHERE result_set_id = ? AND ordinal >= ?
           ORDER BY ordinal
           LIMIT ?`,
          [resultSet.id, resultSet.offset, limit + 1],
        );
        const visible = cardRows.slice(0, limit);
        const cards = [];
        for (let index = 0; index < visible.length; index += 1) {
          const row = visible[index]!;
          const ordinal = requiredInteger(row.ordinal, 'result card ordinal');
          if (ordinal !== resultSet.offset + index) {
            return yield* Effect.fail(corrupt('Workset result-set page ordinals are not contiguous.'));
          }
          const card = yield* validateStored(() =>
            decodeStoredCodeGraphWorksetResultCard(
              requiredText(row.card_json, 'result card JSON'),
              requiredInteger(row.card_bytes, 'result card byte count'),
              requiredText(row.card_digest, 'result card digest'),
            ),
          );
          if (
            card.id !== requiredText(row.card_id, 'result card identity') ||
            card.ref !== requiredText(row.qualified_ref, 'result card qualified reference') ||
            card.repositoryKey !== requiredText(row.repository_key, 'result card repository key')
          ) {
            return yield* Effect.fail(corrupt('Workset result-set card columns do not match their payload.'));
          }
          cards.push(card);
        }
        const nextOffset = resultSet.offset + cards.length;
        const hasMore = cardRows.length > limit;
        const next = hasMore ? yield* readStoredResultSetCursor(sql, resultSet, nextOffset) : undefined;
        return {
          cards,
          continuationForOffset: (offset: number) => {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > resultSet.cardCount) {
              throw invalid('Workset result-set continuation offset is invalid.');
            }
            return codeGraphWorksetContinuationHandle({
              generationDigest: resultSet.generation.digest,
              offset,
              projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
              resultSetToken: resultSet.resultSetToken,
            });
          },
          cursor: input.cursor,
          expiresAt: resultSet.expiresAt,
          generation: resultSet.generation,
          ...(next === undefined ? {} : {next}),
          offset: resultSet.offset,
          projectorVersion: resultSet.projectorVersion,
          result: {...envelope, cards},
          resultSetId: resultSet.id,
          totalCards: resultSet.cardCount,
          totalBytes: resultSet.totalBytes,
          worksetName: resultSet.worksetName,
        } satisfies CodeGraphWorksetResultSetPageV1;
      }),
    ),
  );
  if (page === undefined) {
    return yield* Effect.fail(
      new CodeGraphWorksetCatalogError(
        'missing',
        'The workset continuation catalog is missing; repeat the original small request.',
      ),
    );
  }
  return page;
});

/** Bounded expiry and capacity maintenance for the home-global result cache. */
export const maintainCodeGraphWorksetResultSets = Effect.fn('codeGraphWorksetCatalog.maintainResultSets')(function* (
  threadnoteHome: string,
  options: CodeGraphWorksetResultSetMaintenanceOptionsV1 = {},
) {
  const limit = yield* validateInput(() => resultSetMaintenanceLimit(options.limit));
  const now =
    options.now === undefined ? yield* currentIsoInstant : yield* validateInput(() => canonicalIso(options.now));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        const expiredResultSetsDeleted = yield* deleteExpiredResultSets(sql, now, limit);
        let capacityResultSetsDeleted = 0;
        let capacity = yield* resultSetCapacity(sql);
        while (
          capacityResultSetsDeleted < limit - expiredResultSetsDeleted &&
          (capacity.count > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsMaximum ||
            capacity.bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.resultSetsBytesMaximum)
        ) {
          const candidates = yield* sql.unsafe<{readonly id: unknown}>(
            'SELECT id FROM result_sets ORDER BY expires_at, created_at, id LIMIT 1',
          );
          if (candidates.length === 0) break;
          yield* sql.unsafe('DELETE FROM result_sets WHERE id = ?', [
            requiredText(candidates[0]!.id, 'result set identity'),
          ]);
          capacityResultSetsDeleted += yield* changes(sql);
          capacity = yield* resultSetCapacity(sql);
        }
        return {
          capacityResultSetsDeleted,
          expiredResultSetsDeleted,
          remainingBytes: capacity.bytes,
          remainingResultSets: capacity.count,
        };
      }),
    ),
  );
});

export const inspectCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.inspect')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* inspectCatalogLayout(fs, codeGraphWorksetCatalogLayout(path, threadnoteHome));
});

/** Delete only bounded retired/staging catalog rows; repository graph databases are never in scope. */
export const maintainCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.maintain')(function* (
  threadnoteHome: string,
  options: CodeGraphWorksetCatalogMaintenanceOptionsV1 = {},
) {
  const generationLimit = yield* validateInput(() => retirementLimit(options.generationLimit, 32));
  const projectionLimit = yield* validateInput(() => retirementLimit(options.projectionLimit, 32));
  const stagingBefore = yield* validateInput(() => optionalIsoInstant(options.stagingBefore));
  return yield* withCatalogWriter(threadnoteHome, sql =>
    sql.withTransaction(
      Effect.gen(function* () {
        let stagingGenerationsRetired = 0;
        if (stagingBefore !== undefined && generationLimit > 0) {
          yield* sql.unsafe(
            `UPDATE workset_generations
             SET state = 'retired'
             WHERE id IN (
               SELECT id FROM workset_generations
               WHERE state = 'staging' AND created_at < ?
               ORDER BY created_at, id
               LIMIT ?
             )`,
            [stagingBefore, generationLimit],
          );
          stagingGenerationsRetired = yield* changes(sql);
        }
        let retiredGenerationsDeleted = 0;
        if (generationLimit > 0) {
          yield* sql.unsafe(
            `DELETE FROM workset_generations
             WHERE id IN (
               SELECT g.id FROM workset_generations AS g
               WHERE g.state = 'retired'
                 AND NOT EXISTS (
                   SELECT 1 FROM published_worksets AS p WHERE p.generation_id = g.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM result_sets AS r WHERE r.generation_id = g.id
                 )
               ORDER BY g.created_at, g.id
               LIMIT ?
             )`,
            [generationLimit],
          );
          retiredGenerationsDeleted = yield* changes(sql);
        }
        let projectionsDeleted = 0;
        if (projectionLimit > 0) {
          yield* sql.unsafe(
            `DELETE FROM repository_snapshots
             WHERE projection_digest IN (
               SELECT p.projection_digest FROM repository_snapshots AS p
               WHERE NOT EXISTS (
                 SELECT 1 FROM workset_generation_members AS m
                 WHERE m.projection_digest = p.projection_digest
               )
               ORDER BY p.created_at, p.projection_digest
               LIMIT ?
             )`,
            [projectionLimit],
          );
          projectionsDeleted = yield* changes(sql);
        }
        return {projectionsDeleted, retiredGenerationsDeleted, stagingGenerationsRetired};
      }),
    ),
  );
});

/** Inspect and reconstruct only the disposable catalog when corruption or schema drift is proven. */
export const recoverCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.recover')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    layout.lockPath,
    CATALOG_LOCK_OPTIONS,
    Effect.gen(function* () {
      const health = yield* inspectCatalogLayout(fs, layout);
      if (health.state === 'ok') return {previousState: health.state, rebuilt: false};
      if (health.state === 'unavailable') {
        return yield* Effect.fail(
          new CodeGraphWorksetCatalogError('storage', 'The workset catalog is unavailable and was not rebuilt.'),
        );
      }
      if (health.state !== 'missing') yield* removeCatalogFiles(fs, layout);
      yield* initializeCatalogLayout(fs, layout);
      return {previousState: health.state, rebuilt: health.state !== 'missing'};
    }),
  ).pipe(mapCatalogError('recover workset catalog'));
});

/** Explicit exact-target rebuild for repair and tests. */
export const rebuildCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.rebuild')(function* (
  threadnoteHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
  return yield* withExclusiveFileLock(
    fs,
    layout.lockPath,
    CATALOG_LOCK_OPTIONS,
    Effect.gen(function* () {
      yield* removeCatalogFiles(fs, layout);
      yield* initializeCatalogLayout(fs, layout);
    }),
  ).pipe(mapCatalogError('rebuild workset catalog'));
});
