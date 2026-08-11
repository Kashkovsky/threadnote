import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Effect, Exit, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {withExclusiveFileLock} from '../../effect/file_lock.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION,
  codeGraphWorksetCatalogLayout,
  type CodeGraphWorksetCatalogLayout,
} from './layout.js';
import {
  codeGraphWorksetCatalogGenerationDigest,
  codeGraphWorksetCatalogGenerationIdentity,
  validateCodeGraphWorksetRoutingProjection,
} from './projection.js';
import {
  configureCodeGraphWorksetCatalogReadConnection,
  initializeCodeGraphWorksetCatalogSchema,
  inspectCodeGraphWorksetCatalogSchemaVersion,
} from './schema.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationDigestMemberV1,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationReceiptV1,
  type CodeGraphWorksetCatalogHealthV1,
  type CodeGraphWorksetCatalogMaintenanceOptionsV1,
  type CodeGraphWorksetCatalogPublishedMemberV1,
  type CodeGraphWorksetCatalogRoutingSymbolCursorV1,
  type CodeGraphWorksetCatalogRoutingSymbolRecordV1,
  type CodeGraphWorksetRoutingProjectionV1,
  type CodeGraphWorksetRoutingSymbolV1,
  type CodeGraphWorksetRoutingTermV1,
} from './types.js';

const CATALOG_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;
const PROJECTION_INSERT_BATCH_SIZE = 256;
const CATALOG_RETIREMENT_LIMIT_MAXIMUM = 1_000;
const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;

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

export const ensureCodeGraphWorksetCatalog = Effect.fn('codeGraphWorksetCatalog.ensure')(function* (
  threadnoteHome: string,
) {
  yield* withCatalogWriter(threadnoteHome, () => Effect.void);
});

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

/** Atomically replace one workset's published pointer after validating every staged projection receipt. */
export const publishCodeGraphWorksetCatalogGeneration = Effect.fn('codeGraphWorksetCatalog.publishGeneration')(
  function* (threadnoteHome: string, input: {readonly generationId: string; readonly worksetName: string}) {
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
          if (projection.repositoryId !== member.repository_id || projection.snapshotId !== member.snapshot_id) {
            return yield* Effect.fail(corrupt('A staged workset member does not match its routing projection.'));
          }
          digestMembers.push({
            projectionDigest: projection.projectionDigest,
            repositoryId: projection.repositoryId,
            repositoryKey: member.repository_key,
            snapshotId: projection.snapshotId,
          });
        }
        const digest = yield* validateInput(() =>
          codeGraphWorksetCatalogGenerationDigest(generation.workset_name, generation.manifest_digest, digestMembers),
        );
        if (digest !== generation.generation_digest || `cgwg_${digest.slice(0, 40)}` !== generation.id) {
          return yield* Effect.fail(corrupt('Staged workset generation digest validation failed.'));
        }
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
          !/^cgs_[0-9a-f]{40}$/u.test(input.after.nodeId)
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

function withCatalogWriter<A, E, R>(threadnoteHome: string, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
    return yield* withExclusiveFileLock(
      fs,
      layout.lockPath,
      CATALOG_LOCK_OPTIONS,
      Effect.gen(function* () {
        yield* fs.makeDirectory(layout.root, {recursive: true, mode: 0o700});
        const result = yield* useCatalogWriteDatabase(
          layout.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* initializeCodeGraphWorksetCatalogSchema(sql);
            return yield* use(sql);
          }),
        );
        yield* fs.chmod(layout.databasePath, 0o600);
        return result;
      }),
    );
  }).pipe(mapCatalogError('write workset catalog'));
}

function withCatalogReader<A, E, R>(threadnoteHome: string, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = codeGraphWorksetCatalogLayout(path, threadnoteHome);
    if (!(yield* fs.exists(layout.databasePath))) return undefined;
    return yield* useCatalogReadDatabase(
      layout.databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* configureCodeGraphWorksetCatalogReadConnection(sql);
        return yield* use(sql);
      }),
    );
  }).pipe(mapCatalogError('read workset catalog'));
}

function stageProjection(sql: SqlClient.SqlClient, projection: CodeGraphWorksetRoutingProjectionV1, now: string) {
  return Effect.gen(function* () {
    const existing = yield* sql.unsafe<ProjectionRow>(
      `SELECT projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
              snapshot_digest, commit_id, extractor_generation, projector_version,
              component_count, symbol_count, state
       FROM repository_snapshots
       WHERE checkout_id = ? AND worktree_id = ? AND snapshot_id = ? AND projector_version = ?
       LIMIT 1`,
      [projection.checkoutId, projection.worktreeId, projection.snapshotId, projection.projectorVersion],
    );
    if (existing.length === 1) {
      const metadata = yield* decodeProjectionMetadata(existing[0]!);
      if (metadata.projection_digest !== projection.projectionDigest) {
        return yield* Effect.fail(
          new CodeGraphWorksetCatalogError(
            'invalid-input',
            'A ready snapshot produced different records for the same projector version.',
          ),
        );
      }
      if (metadata.state === 'ready') {
        yield* loadAndValidateProjection(sql, projection.projectionDigest, true);
        return;
      }
      yield* sql.withTransaction(
        sql.unsafe('DELETE FROM repository_snapshots WHERE projection_digest = ? AND state = ?', [
          projection.projectionDigest,
          'staging',
        ]),
      );
    }
    yield* sql.withTransaction(
      sql.unsafe(
        `INSERT INTO repository_snapshots (
           projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
           snapshot_digest, commit_id, extractor_generation, projector_version,
           component_count, symbol_count, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?)`,
        [
          projection.projectionDigest,
          projection.repositoryId,
          projection.checkoutId,
          projection.worktreeId,
          projection.snapshotId,
          projection.snapshotDigest,
          projection.commitId,
          projection.extractorGeneration,
          projection.projectorVersion,
          projection.componentCount,
          projection.symbols.length,
          now,
        ],
      ),
    );
    for (let offset = 0; offset < projection.symbols.length; offset += PROJECTION_INSERT_BATCH_SIZE) {
      const page = projection.symbols.slice(offset, offset + PROJECTION_INSERT_BATCH_SIZE);
      yield* sql.withTransaction(
        Effect.forEach(page, symbol => insertRoutingSymbol(sql, projection.projectionDigest, symbol), {
          concurrency: 1,
          discard: true,
        }),
      );
    }
    const stored = yield* loadAndValidateProjection(sql, projection.projectionDigest);
    if (stored.projectionDigest !== projection.projectionDigest) {
      return yield* Effect.fail(corrupt('Staged routing projection changed before publication.'));
    }
    yield* sql.withTransaction(
      sql.unsafe(
        `UPDATE repository_snapshots SET state = 'ready'
         WHERE projection_digest = ? AND state = 'staging'`,
        [projection.projectionDigest],
      ),
    );
    if ((yield* changes(sql)) !== 1) {
      return yield* Effect.fail(corrupt('Routing projection publication lost its staging state.'));
    }
  });
}

function insertRoutingSymbol(
  sql: SqlClient.SqlClient,
  projectionDigest: string,
  symbol: CodeGraphWorksetRoutingSymbolV1,
) {
  return Effect.gen(function* () {
    yield* sql.unsafe(
      `INSERT INTO routing_symbols (
         projection_digest, node_id, kind, language, exported, package_name, path,
         name, qualified_name, span_line, span_column, span_end_line, span_end_column
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectionDigest,
        symbol.nodeId,
        symbol.kind,
        symbol.language,
        symbol.exported ? 1 : 0,
        symbol.packageName ?? null,
        symbol.path,
        symbol.name,
        symbol.qualifiedName,
        symbol.span.line,
        symbol.span.column,
        symbol.span.endLine,
        symbol.span.endColumn,
      ],
    );
    yield* Effect.forEach(
      symbol.lookupKeys,
      lookupKey =>
        sql.unsafe(
          `INSERT INTO routing_lookup_keys (projection_digest, node_id, lookup_key)
           VALUES (?, ?, ?)`,
          [projectionDigest, symbol.nodeId, lookupKey],
        ),
      {concurrency: 1, discard: true},
    );
    yield* Effect.forEach(
      symbol.terms,
      term =>
        sql.unsafe(
          `INSERT INTO routing_terms (projection_digest, node_id, term, weight)
           VALUES (?, ?, ?, ?)`,
          [projectionDigest, symbol.nodeId, term.term, term.weight],
        ),
      {concurrency: 1, discard: true},
    );
  });
}

function loadAndValidateProjection(sql: SqlClient.SqlClient, projectionDigest: string, requireReady = false) {
  return Effect.gen(function* () {
    const projectionRows = yield* sql.unsafe<ProjectionRow>(
      `SELECT projection_digest, repository_id, checkout_id, worktree_id, snapshot_id,
              snapshot_digest, commit_id, extractor_generation, projector_version,
              component_count, symbol_count, state
       FROM repository_snapshots
       WHERE projection_digest = ?
       LIMIT 1`,
      [projectionDigest],
    );
    if (projectionRows.length !== 1) return yield* Effect.fail(corrupt('Routing projection metadata is missing.'));
    const metadata = yield* decodeProjectionMetadata(projectionRows[0]!);
    if (requireReady && metadata.state !== 'ready') {
      return yield* Effect.fail(corrupt('Routing projection is not ready for publication.'));
    }
    if (metadata.symbol_count > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
      return yield* Effect.fail(corrupt('Routing projection symbol count exceeds the supported bound.'));
    }
    const symbolRows = yield* sql.unsafe<RoutingSymbolRow>(
      `SELECT node_id, kind, language, exported, package_name, path, name, qualified_name,
              span_line, span_column, span_end_line, span_end_column
       FROM routing_symbols
       WHERE projection_digest = ?
       ORDER BY node_id
       LIMIT ?`,
      [projectionDigest, metadata.symbol_count + 1],
    );
    if (symbolRows.length !== metadata.symbol_count) {
      return yield* Effect.fail(corrupt('Routing projection symbol count is inconsistent.'));
    }
    const termRows = yield* sql.unsafe<RoutingTermRow>(
      `SELECT node_id, term, weight
       FROM routing_terms
       WHERE projection_digest = ?
       ORDER BY node_id, term
       LIMIT ?`,
      [projectionDigest, metadata.symbol_count * CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol + 1],
    );
    const lookupKeyRows = yield* sql.unsafe<RoutingLookupKeyRow>(
      `SELECT node_id, lookup_key
       FROM routing_lookup_keys
       WHERE projection_digest = ?
       ORDER BY node_id, lookup_key
       LIMIT ?`,
      [projectionDigest, metadata.symbol_count * CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol + 1],
    );
    const terms = new Map<string, CodeGraphWorksetRoutingTermV1[]>();
    for (const row of termRows) {
      const nodeId = requiredText(row.node_id, 'routing term node identity');
      const existing = terms.get(nodeId) ?? [];
      existing.push({term: requiredText(row.term, 'routing term'), weight: requiredNumber(row.weight, 'term weight')});
      terms.set(nodeId, existing);
    }
    const lookupKeys = new Map<string, string[]>();
    for (const row of lookupKeyRows) {
      const nodeId = requiredText(row.node_id, 'lookup key node identity');
      const existing = lookupKeys.get(nodeId) ?? [];
      existing.push(requiredText(row.lookup_key, 'lookup key'));
      lookupKeys.set(nodeId, existing);
    }
    const symbols: CodeGraphWorksetRoutingSymbolV1[] = [];
    for (const row of symbolRows) {
      const nodeId = requiredText(row.node_id, 'node identity');
      symbols.push(yield* decodeRoutingSymbol(row, lookupKeys.get(nodeId) ?? [], terms.get(nodeId) ?? []));
    }
    return yield* Effect.try({
      try: () =>
        validateCodeGraphWorksetRoutingProjection({
          checkoutId: metadata.checkout_id,
          commitId: metadata.commit_id,
          componentCount: metadata.component_count,
          extractorGeneration: metadata.extractor_generation,
          projectionDigest: metadata.projection_digest,
          projectorVersion: metadata.projector_version,
          repositoryId: metadata.repository_id,
          snapshotDigest: metadata.snapshot_digest,
          snapshotId: metadata.snapshot_id,
          symbols,
          worktreeId: metadata.worktree_id,
        }),
      catch: cause => corrupt('Routing projection integrity validation failed.', cause),
    });
  });
}

function decodeProjectionMetadata(row: ProjectionRow) {
  return validateStored(() => {
    const state = requiredText(row.state, 'projection state');
    if (state !== 'ready' && state !== 'staging') throw corrupt('Routing projection state is invalid.');
    const projectionDigest = requiredText(row.projection_digest, 'projection digest');
    const repositoryId = requiredText(row.repository_id, 'repository identity');
    const checkoutId = requiredText(row.checkout_id, 'checkout identity');
    const worktreeId = requiredText(row.worktree_id, 'worktree identity');
    const snapshotDigest = requiredText(row.snapshot_digest, 'snapshot digest');
    const commitId = requiredText(row.commit_id, 'commit identity');
    const projectorVersion = requiredInteger(row.projector_version, 'projector version');
    const extractorGeneration = requiredInteger(row.extractor_generation, 'extractor generation');
    const symbolCount = requiredInteger(row.symbol_count, 'symbol count');
    if (
      ![projectionDigest, repositoryId, checkoutId, worktreeId, snapshotDigest].every(value =>
        /^[0-9a-f]{64}$/u.test(value),
      ) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commitId) ||
      projectorVersion !== 1 ||
      extractorGeneration < 1 ||
      symbolCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection
    ) {
      throw corrupt('Routing projection metadata is invalid.');
    }
    return {
      checkout_id: checkoutId,
      commit_id: commitId,
      component_count: requiredInteger(row.component_count, 'component count'),
      extractor_generation: extractorGeneration,
      projection_digest: projectionDigest,
      projector_version: projectorVersion,
      repository_id: repositoryId,
      snapshot_digest: snapshotDigest,
      snapshot_id: requiredText(row.snapshot_id, 'snapshot identity'),
      state,
      symbol_count: symbolCount,
      worktree_id: worktreeId,
    } as const;
  });
}

function decodeRoutingSymbol(
  row: RoutingSymbolRow,
  lookupKeys: readonly string[],
  terms: readonly CodeGraphWorksetRoutingTermV1[],
) {
  return validateStored(() => {
    const exported = requiredInteger(row.exported, 'exported flag');
    if (exported !== 0 && exported !== 1) throw corrupt('Routing symbol exported flag is invalid.');
    return {
      exported: exported === 1,
      kind: requiredText(row.kind, 'symbol kind'),
      language: requiredText(row.language, 'symbol language'),
      lookupKeys,
      name: requiredText(row.name, 'symbol name'),
      nodeId: requiredText(row.node_id, 'node identity'),
      ...(row.package_name === null ? {} : {packageName: requiredText(row.package_name, 'package name')}),
      path: requiredText(row.path, 'evidence path'),
      qualifiedName: requiredText(row.qualified_name, 'qualified symbol name'),
      span: {
        column: requiredInteger(row.span_column, 'span column'),
        endColumn: requiredInteger(row.span_end_column, 'span end column'),
        endLine: requiredInteger(row.span_end_line, 'span end line'),
        line: requiredInteger(row.span_line, 'span line'),
      },
      terms,
    } satisfies CodeGraphWorksetRoutingSymbolV1;
  });
}

function loadGenerationMembers(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<GenerationMemberRow>(
      `SELECT ordinal, repository_key, repository_id, snapshot_id, projection_digest
       FROM workset_generation_members
       WHERE generation_id = ?
       ORDER BY ordinal
       LIMIT ?`,
      [generationId, CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration + 1],
    )
    .pipe(
      Effect.flatMap(rows =>
        validateStored(() =>
          rows.map((row, index) => {
            if (rows.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
              throw corrupt('Workset generation member count exceeds the supported bound.');
            }
            const ordinal = requiredInteger(row.ordinal, 'generation member ordinal');
            if (ordinal !== index) throw corrupt('Workset generation member ordinals are not contiguous.');
            return {
              ordinal,
              projection_digest: requiredText(row.projection_digest, 'projection digest'),
              repository_id: requiredText(row.repository_id, 'repository identity'),
              repository_key: requiredText(row.repository_key, 'repository key'),
              snapshot_id: requiredText(row.snapshot_id, 'snapshot identity'),
            };
          }),
        ),
      ),
    );
}

function selectGeneration(sql: SqlClient.SqlClient, generationId: string) {
  return sql
    .unsafe<GenerationRow>(
      `SELECT id, workset_name, manifest_digest, generation_digest, state, member_count
       FROM workset_generations WHERE id = ? LIMIT 1`,
      [generationId],
    )
    .pipe(Effect.flatMap(rows => (rows.length === 0 ? Effect.succeed(undefined) : decodeGenerationRow(rows[0]!))));
}

function decodeGenerationRow(row: GenerationRow) {
  return validateStored(() => {
    const state = requiredText(row.state, 'generation state');
    if (state !== 'ready' && state !== 'retired' && state !== 'staging') {
      throw corrupt('Workset generation state is invalid.');
    }
    const generationDigest = requiredText(row.generation_digest, 'generation digest');
    const id = requiredText(row.id, 'generation identity');
    const manifestDigest = requiredText(row.manifest_digest, 'manifest digest');
    const memberCount = requiredInteger(row.member_count, 'generation member count');
    if (
      !/^[0-9a-f]{64}$/u.test(generationDigest) ||
      !GENERATION_ID.test(id) ||
      !/^[0-9a-f]{64}$/u.test(manifestDigest) ||
      memberCount > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration
    ) {
      throw corrupt('Workset generation metadata is invalid.');
    }
    return {
      generation_digest: generationDigest,
      id,
      manifest_digest: manifestDigest,
      member_count: memberCount,
      state,
      workset_name: requiredText(row.workset_name, 'workset name'),
    } as const;
  });
}

function generationReceipt(
  generation: Effect.Success<ReturnType<typeof decodeGenerationRow>>,
): CodeGraphWorksetCatalogGenerationReceiptV1 {
  if (generation.state === 'retired') throw corrupt('Retired generation cannot produce an active receipt.');
  return {
    digest: generation.generation_digest,
    id: generation.id,
    manifestDigest: generation.manifest_digest,
    memberCount: generation.member_count,
    state: generation.state,
    worksetName: generation.workset_name,
  };
}

function generationIsPublished(sql: SqlClient.SqlClient, generationId: string, worksetName: string) {
  return rowCount(
    sql,
    'SELECT COUNT(*) AS count FROM published_worksets WHERE workset_name = ? AND generation_id = ?',
    [worksetName, generationId],
  ).pipe(Effect.map(count => count === 1));
}

function initializeCatalogLayout(fs: FileSystem.FileSystem, layout: CodeGraphWorksetCatalogLayout) {
  return Effect.gen(function* () {
    yield* fs.makeDirectory(layout.root, {recursive: true, mode: 0o700});
    yield* useCatalogWriteDatabase(
      layout.databasePath,
      Effect.gen(function* () {
        yield* initializeCodeGraphWorksetCatalogSchema(yield* SqlClient.SqlClient);
      }),
    );
    yield* fs.chmod(layout.databasePath, 0o600);
  });
}

function inspectCatalogLayout(
  fs: FileSystem.FileSystem,
  layout: CodeGraphWorksetCatalogLayout,
): Effect.Effect<CodeGraphWorksetCatalogHealthV1, unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(layout.databasePath))) return {state: 'missing'} as const;
    const inspected = yield* Effect.exit(
      useCatalogReadDatabase(
        layout.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* configureCodeGraphWorksetCatalogReadConnection(sql);
          const schemaVersion = yield* inspectCodeGraphWorksetCatalogSchemaVersion(sql);
          if (schemaVersion !== CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION) {
            return {schemaVersion: schemaVersion ?? 0, state: 'incompatible'} as const;
          }
          const quick = yield* sql.unsafe<{readonly quick_check: unknown}>('PRAGMA quick_check');
          if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') {
            return {detail: 'SQLite integrity validation failed.', state: 'corrupt'} as const;
          }
          const [projectionCount, publishedWorksets, readyGenerations, stagingGenerations] = yield* Effect.all(
            [
              rowCount(sql, 'SELECT COUNT(*) AS count FROM repository_snapshots'),
              rowCount(sql, 'SELECT COUNT(*) AS count FROM published_worksets'),
              rowCount(sql, "SELECT COUNT(*) AS count FROM workset_generations WHERE state = 'ready'"),
              rowCount(sql, "SELECT COUNT(*) AS count FROM workset_generations WHERE state = 'staging'"),
            ],
            {concurrency: 1},
          );
          return {
            projectionCount,
            publishedWorksets,
            readyGenerations,
            schemaVersion,
            stagingGenerations,
            state: 'ok',
          } as const;
        }),
      ),
    );
    if (Exit.isSuccess(inspected)) return inspected.value;
    const category = storageCauseCategory(inspected.cause);
    return category === 'corrupt'
      ? ({detail: 'SQLite reported malformed catalog data.', state: 'corrupt'} as const)
      : ({detail: 'The catalog could not be inspected safely.', state: 'unavailable'} as const);
  });
}

function removeCatalogFiles(fs: FileSystem.FileSystem, layout: CodeGraphWorksetCatalogLayout) {
  return Effect.forEach(
    [layout.databasePath, `${layout.databasePath}-wal`, `${layout.databasePath}-shm`, `${layout.databasePath}-journal`],
    candidate => fs.remove(candidate, {force: true}),
    {concurrency: 1, discard: true},
  );
}

function useCatalogWriteDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    effect.pipe(Effect.provide(SqliteClient.layer({disableWAL: true, filename: databasePath}))),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function useCatalogReadDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    effect.pipe(
      Effect.provide(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readonly: true,
          readwrite: false,
        }),
      ),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function rowCount(sql: SqlClient.SqlClient, statement: string, parameters: readonly unknown[] = []) {
  return sql.unsafe<{readonly count: unknown}>(statement, parameters).pipe(
    Effect.flatMap(rows =>
      validateStored(() => {
        if (rows.length !== 1) throw corrupt('Catalog count query returned an invalid row set.');
        return requiredInteger(rows[0]!.count, 'row count');
      }),
    ),
  );
}

function changes(sql: SqlClient.SqlClient) {
  return rowCount(sql, 'SELECT changes() AS count');
}

const currentIsoInstant = Clock.currentTimeMillis.pipe(
  Effect.map(milliseconds => new Date(milliseconds).toISOString()),
);

function readLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CODE_GRAPH_WORKSET_CATALOG_LIMITS.readPageMaximum) {
    throw invalid(
      `Workset catalog read limit must be between 1 and ${CODE_GRAPH_WORKSET_CATALOG_LIMITS.readPageMaximum}.`,
    );
  }
  return limit;
}

function retirementLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > CATALOG_RETIREMENT_LIMIT_MAXIMUM) {
    throw invalid(`Workset catalog retirement limit must be between 0 and ${CATALOG_RETIREMENT_LIMIT_MAXIMUM}.`);
  }
  return limit;
}

function optionalIsoInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalid('Workset catalog staging cutoff must be a canonical ISO instant.');
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw corrupt(`Catalog ${label} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw corrupt(`Catalog ${label} is invalid.`);
  }
  return parsed;
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw corrupt(`Catalog ${label} is invalid.`);
  return parsed;
}

function assertInputText(value: string, label: string, maximumBytes: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    containsControlCharacter(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalid(`Workset catalog ${label} is invalid.`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function routingRowKey(ordinal: number, nodeId: string): string {
  return `${ordinal}\0${nodeId}`;
}

function validateInput<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      cause instanceof CodeGraphWorksetCatalogError
        ? cause
        : new CodeGraphWorksetCatalogError('invalid-input', 'Workset catalog input is invalid.', {cause}),
  });
}

function validateStored<A>(evaluate: () => A): Effect.Effect<A, CodeGraphWorksetCatalogError> {
  return Effect.try({
    try: evaluate,
    catch: cause =>
      cause instanceof CodeGraphWorksetCatalogError
        ? cause
        : new CodeGraphWorksetCatalogError('corrupt', 'Workset catalog data is invalid.', {cause}),
  });
}

function mapCatalogError(operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(cause => {
        if (cause instanceof CodeGraphWorksetCatalogError) return cause;
        const category = storageCauseCategory(cause);
        return new CodeGraphWorksetCatalogError(
          category,
          category === 'busy'
            ? `Timed out waiting to ${operation}.`
            : category === 'corrupt'
              ? `Cannot ${operation} because the disposable catalog is corrupt.`
              : `Unable to ${operation}.`,
          {cause},
        );
      }),
    );
}

function storageCauseCategory(cause: unknown): 'busy' | 'corrupt' | 'storage' {
  const detail = String(cause).toLowerCase();
  if (detail.includes('locked') || detail.includes('busy') || detail.includes('filelocktimeout')) return 'busy';
  if (
    detail.includes('malformed') ||
    detail.includes('not a database') ||
    detail.includes('no such table') ||
    detail.includes('database disk image is malformed')
  ) {
    return 'corrupt';
  }
  return 'storage';
}

function invalid(message: string): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('invalid-input', message);
}

function corrupt(message: string, cause?: unknown): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('corrupt', message, cause === undefined ? undefined : {cause});
}
