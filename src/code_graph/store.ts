import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as SqlError from 'effect/unstable/sql/SqlError';
import {sha256HexSync} from '../crypto/sha256.js';
import {SystemInfo} from '../effect/system.js';
import {compareCodeUnits} from './ordering.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  CodeGraphQueryNode,
  RepositoryIdentity,
} from './types.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CODE_GRAPH_SCHEMA_VERSION, CodeGraphStoreError} from './types.js';
import type {
  CodeGraphWorkspace,
  CodeGraphWorkspaceBuildSystem,
  CodeGraphWorkspaceComponentKind,
  CodeGraphWorkspaceProvenance,
} from './languages/types.js';

interface SnapshotRow {
  readonly base_snapshot_id: unknown;
  readonly commit_id: string;
  readonly completed_at: unknown;
  readonly dirty: number;
  readonly edge_count: number;
  readonly extractor_set: string;
  readonly file_count: number;
  readonly id: string;
  readonly overlay_fingerprint: unknown;
  readonly repository_id: string;
  readonly state: CodeGraphSnapshot['state'];
  readonly symbol_count: number;
  readonly worktree_id: string;
}

interface SymbolRow {
  readonly arity: unknown;
  readonly content_hash: string;
  readonly documentation: unknown;
  readonly exported: number;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly lookup_keys_json: string;
  readonly package_name: unknown;
  readonly path: string;
  readonly qualified_name: string;
  readonly resolution_domain: unknown;
  readonly resolution_scope_id: unknown;
  readonly signature: unknown;
  readonly span_json: string;
}

interface EdgeRow {
  readonly confidence: number;
  readonly evidence_path: string;
  readonly evidence_span_json: string;
  readonly id: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly source_id: unknown;
  readonly source_name: string;
  readonly target_id: unknown;
  readonly target_name: string;
}

interface FileBlobRow {
  readonly content_hash: string;
  readonly facts_json: string;
}

export const CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION = 2 as const;

export interface CodeGraphReusableBaseReceiptInput {
  readonly fileSetFingerprint: string;
  readonly workspaceFingerprint: string;
}

export interface CodeGraphReusableBaseReceipt extends CodeGraphReusableBaseReceiptInput {
  readonly aliasCount: number;
  readonly formatVersion: number;
  readonly lookupCount: number;
  readonly resolutionSurfaceVersion: number;
  readonly reexportCount: number;
  readonly snapshotId: string;
}

export interface CodeGraphReusableReexport {
  readonly importedName: string;
  readonly localName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CodeGraphReusableReexportSeed {
  readonly name: string;
  readonly path: string;
}

interface CodeGraphActivationLease {
  readonly durationMilliseconds: number;
  readonly token: string;
}

export interface StoredCodeGraph {
  readonly edges: readonly CodeGraphEdge[];
  readonly snapshot: CodeGraphSnapshot;
  readonly symbols: readonly CodeGraphSymbol[];
}

export interface CodeGraphEdgeCursor {
  readonly id: string;
  readonly relation: string;
  readonly sourceName: string;
  readonly targetName: string;
}

export interface CodeGraphSymbolCursor {
  readonly id: string;
  readonly path: string;
  readonly qualifiedName: string;
}

export interface CodeGraphDatabaseHealth {
  readonly activeSnapshots: number;
  readonly buildingSnapshots: number;
  readonly cachedFileBlobs: number;
  readonly failedSnapshots: number;
  readonly foreignKeyViolations: number;
  readonly integrity: 'corrupt' | 'incompatible' | 'ok';
  readonly readySnapshots: number;
  readonly schemaVersion?: number;
}

export interface CodeGraphDatabaseRepair {
  readonly removedSnapshots: number;
}

export interface CodeGraphVisualizationProject {
  readonly buildSystem?: CodeGraphWorkspaceBuildSystem;
  readonly dependencies: readonly {
    readonly evidence?: string;
    readonly provenance: CodeGraphWorkspaceProvenance;
    readonly targetId: string;
  }[];
  readonly diagnostics: readonly string[];
  readonly fileCount: number;
  readonly id: string;
  readonly kind: CodeGraphWorkspaceComponentKind | 'documentation' | 'legacy-group';
  readonly label: string;
  readonly languages: readonly string[];
  readonly model: 'component' | 'facet' | 'legacy-fallback';
  readonly provenance: CodeGraphWorkspaceProvenance | 'legacy';
  readonly resolutionDomain?: string;
  readonly root?: string;
  readonly sourceRoots: readonly string[];
  readonly symbolCount: number;
  readonly workspaceId?: string;
  readonly workspaceRoots: readonly string[];
}

export interface CodeGraphVisualizationWorkspace {
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly root: string;
}

export interface CodeGraphVisualizationScopeEdge {
  readonly confidence: number;
  readonly count: number;
  readonly provenance: CodeGraphProvenance;
  readonly relation: CodeGraphEdge['relation'];
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: 'declared-build-dependency' | 'source-relationship';
}

export interface CodeGraphVisualizationCatalog {
  readonly accounting: {
    readonly attributedSymbols: number;
    readonly componentSymbols: number;
    readonly fallbackSymbols: number;
    readonly omittedSymbols: number;
    readonly totalSymbols: number;
  };
  readonly activatedAt?: string;
  readonly model: 'legacy-fallback' | 'workspace';
  readonly projects: readonly CodeGraphVisualizationProject[];
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly snapshot: CodeGraphSnapshot;
  readonly viewWorktreeId: string;
  readonly workspaces: readonly CodeGraphVisualizationWorkspace[];
}

export interface CodeGraphVisualizationRelationshipSummary {
  readonly incoming: number;
  readonly outgoing: number;
  readonly provenances: readonly {
    readonly count: number;
    readonly provenance: CodeGraphProvenance;
  }[];
  readonly relations: readonly {
    readonly count: number;
    readonly incoming: number;
    readonly outgoing: number;
    readonly relation: CodeGraphEdge['relation'];
  }[];
}

export type CodeGraphVisualizationScope =
  | {readonly type: 'all'}
  | {readonly type: 'component'; readonly value: string}
  | {readonly type: 'documentation-facet'}
  | {readonly type: 'package'; readonly value: string}
  | {readonly type: 'path'; readonly value: string};

export interface CodeGraphStoreShape {
  readonly withSession: <A, E, R>(
    databasePath: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CodeGraphStoreError, R>;
  readonly activate: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    files: readonly CodeGraphInventoryFile[],
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly activateStaged: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
    reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
    promotionLeaseDurationMilliseconds?: number,
  ) => Effect.Effect<Option.Option<string>, CodeGraphStoreError>;
  readonly cacheFacts: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
    extractorSet: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly acquireSnapshotLease: (
    databasePath: string,
    snapshotId: string,
    durationMilliseconds: number,
  ) => Effect.Effect<string, CodeGraphStoreError>;
  readonly promote: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshotId: string,
    activeWorktreeIds: ReadonlySet<string>,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly initialize: (databasePath: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly prepareActivation: (
    databasePath: string,
    files: readonly CodeGraphInventoryFile[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly preparePersistedIncrementalActivation: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly replaceStagedModifiedFiles: (
    databasePath: string,
    baseSnapshotId: string,
    files: readonly CodeGraphInventoryFile[],
    facts: readonly CodeGraphFileFacts[],
  ) => Effect.Effect<boolean, CodeGraphStoreError>;
  readonly diagnose: (databasePath: string) => Effect.Effect<CodeGraphDatabaseHealth | undefined, CodeGraphStoreError>;
  readonly cachedCommittedFileKeys: (
    databasePath: string,
    extractorSet: string,
  ) => Effect.Effect<ReadonlySet<string>, CodeGraphStoreError>;
  readonly loadCachedFacts: (
    databasePath: string,
    files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
    extractorSet: string,
  ) => Effect.Effect<ReadonlyMap<string, CodeGraphFileFacts>, CodeGraphStoreError>;
  readonly loadGraph: (databasePath: string, snapshotId: string) => Effect.Effect<StoredCodeGraph, CodeGraphStoreError>;
  readonly loadSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly loadEdgePage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphEdgeCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreError>;
  readonly loadSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly countEmbeddingSymbols: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<number, CodeGraphStoreError>;
  readonly loadEmbeddingSymbolPage: (
    databasePath: string,
    snapshotId: string,
    cursor: CodeGraphSymbolCursor | undefined,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly loadVisualizationCatalog: (
    databasePath: string,
  ) => Effect.Effect<CodeGraphVisualizationCatalog | undefined, CodeGraphStoreError>;
  readonly loadVisualizationCatalogs: (
    databasePath: string,
  ) => Effect.Effect<readonly CodeGraphVisualizationCatalog[], CodeGraphStoreError>;
  readonly loadVisualizationScopeEdges: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<readonly CodeGraphVisualizationScopeEdge[], CodeGraphStoreError>;
  readonly loadVisualizationSymbols: (
    databasePath: string,
    snapshotId: string,
    scope: CodeGraphVisualizationScope,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly edgesForNodes: (
    databasePath: string,
    snapshotId: string,
    nodeIds: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<readonly CodeGraphEdge[], CodeGraphStoreError>;
  readonly relationshipSummaryForNode: (
    databasePath: string,
    snapshotId: string,
    nodeId: string,
    allowedProvenances: readonly CodeGraphProvenance[],
  ) => Effect.Effect<CodeGraphVisualizationRelationshipSummary, CodeGraphStoreError>;
  readonly findSymbolsByPathAndName: (
    databasePath: string,
    snapshotId: string,
    path: string,
    name: string,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreError>;
  readonly markBuilding: (
    databasePath: string,
    identity: RepositoryIdentity,
    snapshot: CodeGraphSnapshot,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly markFailed: (
    databasePath: string,
    snapshotId: string,
    summary: string,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly readySnapshot: (
    databasePath: string,
    worktreeId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly readySnapshotById: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly readySnapshotForCommit: (
    databasePath: string,
    repositoryId: string,
    commit: string,
    extractorSet?: string,
  ) => Effect.Effect<CodeGraphSnapshot | undefined, CodeGraphStoreError>;
  readonly reusableBaseReceipt: (
    databasePath: string,
    snapshotId: string,
  ) => Effect.Effect<CodeGraphReusableBaseReceipt | undefined, CodeGraphStoreError>;
  readonly reusableReexports: (
    databasePath: string,
    snapshotId: string,
    seeds: readonly CodeGraphReusableReexportSeed[],
  ) => Effect.Effect<readonly CodeGraphReusableReexport[] | undefined, CodeGraphStoreError>;
  readonly reconcileWorktrees: (
    databasePath: string,
    activeWorktreeIds: ReadonlySet<string>,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly pruneCachedFacts: (
    databasePath: string,
    acceptedExtractorSets?: readonly string[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly repair: (
    databasePath: string,
    dryRun?: boolean,
  ) => Effect.Effect<CodeGraphDatabaseRepair | undefined, CodeGraphStoreError>;
  readonly releaseSnapshotLease: (databasePath: string, token: string) => Effect.Effect<void, CodeGraphStoreError>;
  readonly renewSnapshotLease: (
    databasePath: string,
    token: string,
    durationMilliseconds: number,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly searchSymbols: (
    databasePath: string,
    snapshotId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphQueryNode[], CodeGraphStoreError>;
  readonly searchSymbolsMany: (
    databasePath: string,
    snapshotId: string,
    queries: readonly string[],
    limit: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreError>;
  readonly searchSymbolsByPaths: (
    databasePath: string,
    snapshotId: string,
    paths: readonly string[],
    limitPerPath: number,
  ) => Effect.Effect<readonly (readonly CodeGraphQueryNode[])[], CodeGraphStoreError>;
  readonly symbolsByIds: (
    databasePath: string,
    snapshotId: string,
    ids: readonly string[],
  ) => Effect.Effect<readonly CodeGraphSymbol[], CodeGraphStoreError>;
  readonly stageActivationFacts: (
    databasePath: string,
    symbols: readonly CodeGraphSymbol[],
    edges: readonly CodeGraphEdge[],
    references?: readonly CodeGraphReference[],
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly stageWorkspaceCatalog: (
    databasePath: string,
    workspace: CodeGraphWorkspace,
  ) => Effect.Effect<void, CodeGraphStoreError>;
  readonly resolveStagedReferences: (
    databasePath: string,
  ) => Effect.Effect<{readonly resolved: number}, CodeGraphStoreError>;
  readonly stagedFactCounts: (
    databasePath: string,
  ) => Effect.Effect<{readonly edges: number; readonly symbols: number}, CodeGraphStoreError>;
}

interface CodeGraphDatabaseSessionShape {
  readonly databasePath: string;
  readonly sql: SqlClient.SqlClient;
}

class CodeGraphDatabaseSession extends Context.Service<CodeGraphDatabaseSession, CodeGraphDatabaseSessionShape>()(
  'threadnote/codeGraph/CodeGraphDatabaseSession',
) {}

export class CodeGraphStore extends Context.Service<CodeGraphStore, CodeGraphStoreShape>()(
  'threadnote/codeGraph/CodeGraphStore',
) {
  static readonly layer = Layer.effect(
    CodeGraphStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const prepare = (databasePath: string) =>
        fs
          .makeDirectory(path.dirname(databasePath), {recursive: true, mode: 0o700})
          .pipe(Effect.mapError(cause => storeError('prepare code graph database', cause)));
      return CodeGraphStore.of({
        withSession: (databasePath, effect) =>
          useDatabaseDirect(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* configureConnection(sql);
              return yield* effect.pipe(Effect.provideService(CodeGraphDatabaseSession, {databasePath, sql}));
            }),
          ).pipe(
            Effect.catchTag('SqlError', cause =>
              Effect.fail(storeError('use code graph database session', cause as SqlError.SqlError)),
            ),
          ),
        acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds) =>
          Effect.gen(function* () {
            const token = `${system.processId}:${yield* crypto.randomUUIDv4}`;
            return yield* prepare(databasePath).pipe(
              Effect.andThen(useDatabase(databasePath, acquireSnapshotLease(snapshotId, durationMilliseconds, token))),
              Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause)),
            );
          }).pipe(Effect.mapError(cause => storeError('acquire code graph snapshot lease', cause))),
        activate: (databasePath, identity, snapshot, files, symbols, edges) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* initializeSchema(sql);
                  yield* prepareActivationTables(sql);
                  yield* stageActivationFiles(sql, files);
                  yield* stageActivationSymbols(sql, symbols);
                  yield* stageActivationSymbolTerms(sql, symbols);
                  yield* stageActivationEdges(sql, edges);
                  yield* activateStagedSnapshot(sql, identity, snapshot);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('activate code graph snapshot', cause)),
          ),
        activateStaged: (databasePath, identity, snapshot, reusableBaseReceipt, promotionLeaseDurationMilliseconds) =>
          Effect.gen(function* () {
            const promotionLease =
              promotionLeaseDurationMilliseconds === undefined
                ? Option.none<CodeGraphActivationLease>()
                : Option.some({
                    durationMilliseconds: validatedSnapshotLeaseDuration(promotionLeaseDurationMilliseconds),
                    token: `${system.processId}:${yield* crypto.randomUUIDv4}`,
                  });
            yield* prepare(databasePath);
            yield* useDatabase(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const mode = yield* activationMode(sql);
                if (mode?.mode === 'persisted-delta') {
                  yield* activatePersistedIncrementalSnapshot(
                    sql,
                    identity,
                    snapshot,
                    mode.baseSnapshotId,
                    promotionLease,
                  );
                } else {
                  yield* activateStagedSnapshot(sql, identity, snapshot, reusableBaseReceipt, promotionLease);
                }
              }),
            );
            return Option.map(promotionLease, lease => lease.token);
          }).pipe(Effect.mapError(cause => storeError('activate staged code graph snapshot', cause))),
        cacheFacts: (databasePath, files, facts, extractorSet) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const session = yield* Effect.serviceOption(CodeGraphDatabaseSession);
                  if (Option.isNone(session) || session.value.databasePath !== databasePath) {
                    yield* initializeSchema(sql);
                  }
                  yield* sql.withTransaction(storeFreshFacts(sql, files, facts, extractorSet));
                }),
              ),
            ),
            Effect.mapError(cause => storeError('cache code graph file facts', cause)),
          ),
        promote: (databasePath, identity, snapshotId, activeWorktreeIds) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, promoteSnapshot(identity, snapshotId, activeWorktreeIds))),
            Effect.mapError(cause => storeError('promote code graph snapshot', cause)),
          ),
        initialize: databasePath =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  yield* initializeSchema(yield* SqlClient.SqlClient);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('initialize code graph database', cause)),
          ),
        prepareActivation: (databasePath, files) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* initializeSchema(sql);
                  yield* prepareActivationTables(sql);
                  yield* stageActivationFiles(sql, files);
                }),
              ),
            ),
            Effect.mapError(cause => storeError('prepare staged code graph activation', cause)),
          ),
        preparePersistedIncrementalActivation: (databasePath, baseSnapshotId, files, facts) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(databasePath, preparePersistedIncrementalActivation(baseSnapshotId, files, facts)),
            ),
            Effect.mapError(cause => storeError('prepare persisted incremental code graph activation', cause)),
          ),
        replaceStagedModifiedFiles: (databasePath, baseSnapshotId, files, facts) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, replaceStagedModifiedFiles(baseSnapshotId, files, facts))),
            Effect.mapError(cause => storeError('replace staged modified code graph files', cause)),
          ),
        diagnose: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, diagnoseDatabase()) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('diagnose code graph database', cause)),
          ),
        cachedCommittedFileKeys: (databasePath, extractorSet) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(databasePath, selectCachedCommittedFileKeys(extractorSet))
                : Effect.succeed(new Set<string>()),
            ),
            Effect.mapError(cause => storeError('load cached code graph file keys', cause)),
          ),
        edgesForNodes: (databasePath, snapshotId, nodeIds, direction, limit, allowedProvenances) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(databasePath, selectEdgesForNodes(snapshotId, nodeIds, direction, limit, allowedProvenances)),
            ),
            Effect.mapError(cause => storeError('load code graph adjacency', cause)),
          ),
        findSymbolsByPathAndName: (databasePath, snapshotId, sourcePath, name) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolsByPathAndName(snapshotId, sourcePath, name))),
            Effect.mapError(cause => storeError('resolve qualified code graph symbol', cause)),
          ),
        loadCachedFacts: (databasePath, files, extractorSet) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectCachedFacts(files, extractorSet))),
            Effect.mapError(cause => storeError('load cached code graph facts', cause)),
          ),
        loadGraph: (databasePath, snapshotId) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectStoredGraph(snapshotId))),
            Effect.mapError(cause => storeError('load code graph snapshot', cause)),
          ),
        loadSymbols: (databasePath, snapshotId) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectStoredSymbols(snapshotId))),
            Effect.mapError(cause => storeError('load code graph snapshot symbols', cause)),
          ),
        loadEdgePage: (databasePath, snapshotId, cursor, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectEdgePage(snapshotId, cursor, limit))),
            Effect.mapError(cause => storeError('load code graph edge page', cause)),
          ),
        loadSymbolPage: (databasePath, snapshotId, cursor, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolPage(snapshotId, cursor, limit))),
            Effect.mapError(cause => storeError('load code graph symbol page', cause)),
          ),
        countEmbeddingSymbols: (databasePath, snapshotId) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectEmbeddingSymbolCount(snapshotId))),
            Effect.mapError(cause => storeError('count code graph embedding symbols', cause)),
          ),
        loadEmbeddingSymbolPage: (databasePath, snapshotId, cursor, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectEmbeddingSymbolPage(snapshotId, cursor, limit))),
            Effect.mapError(cause => storeError('load code graph embedding symbol page', cause)),
          ),
        loadVisualizationCatalog: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectVisualizationCatalog()) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load code graph visualization catalog', cause)),
          ),
        loadVisualizationCatalogs: databasePath =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectVisualizationCatalogs()) : Effect.succeed([]),
            ),
            Effect.mapError(cause => storeError('load code graph visualization catalogs', cause)),
          ),
        loadVisualizationScopeEdges: (databasePath, snapshotId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectVisualizationScopeEdges(snapshotId)) : Effect.succeed([]),
            ),
            Effect.mapError(cause => storeError('load code graph visualization scope edges', cause)),
          ),
        loadVisualizationSymbols: (databasePath, snapshotId, scope, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectVisualizationSymbols(snapshotId, scope, limit))),
            Effect.mapError(cause => storeError('load code graph visualization symbols', cause)),
          ),
        markBuilding: (databasePath, identity, snapshot) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* initializeSchema(sql);
                  yield* upsertRepository(sql, identity);
                  yield* sql`
                    INSERT INTO snapshots (
                      id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
                      dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
                    ) VALUES (
                      ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
                      ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
                      ${snapshot.overlayFingerprint ?? null}, 'building', 0, 0, 0, ${new Date().toISOString()}
                    )
                    ON CONFLICT(id) DO NOTHING
                  `;
                }),
              ),
            ),
            Effect.mapError(cause => storeError('start code graph snapshot', cause)),
          ),
        markFailed: (databasePath, snapshotId, summary) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* configureConnection(sql);
                  const now = yield* Clock.currentTimeMillis;
                  yield* sql`
                    UPDATE snapshots
                    SET state = 'failed', failure_summary = ${summary.slice(0, 2_000)}, completed_at = ${new Date().toISOString()}
                    WHERE id = ${snapshotId}
                      AND state = 'building'
                      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
                      AND id NOT IN (
                        SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                      )
                  `;
                }),
              ),
            ),
            Effect.mapError(cause => storeError('fail code graph snapshot', cause)),
          ),
        readySnapshot: (databasePath, worktreeId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectReadySnapshot(worktreeId)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load ready code graph snapshot', cause)),
          ),
        readySnapshotById: (databasePath, snapshotId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectReadySnapshotById(snapshotId)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load ready code graph snapshot by identity', cause)),
          ),
        readySnapshotForCommit: (databasePath, repositoryId, commit, extractorSet) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(databasePath, selectReadySnapshotForCommit(repositoryId, commit, extractorSet))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load ready code graph snapshot for commit', cause)),
          ),
        reusableBaseReceipt: (databasePath, snapshotId) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, selectReusableBaseReceipt(snapshotId)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load reusable code graph base receipt', cause)),
          ),
        reusableReexports: (databasePath, snapshotId, seeds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(databasePath, selectReusableReexports(snapshotId, seeds))
                : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('load reusable code graph reexport provenance', cause)),
          ),
        relationshipSummaryForNode: (databasePath, snapshotId, nodeId, allowedProvenances) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(databasePath, selectRelationshipSummaryForNode(snapshotId, nodeId, allowedProvenances)),
            ),
            Effect.mapError(cause => storeError('summarize code graph relationships', cause)),
          ),
        reconcileWorktrees: (databasePath, activeWorktreeIds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* configureConnection(sql);
                      yield* sql.withTransaction(reconcileActiveWorktrees(sql, activeWorktreeIds));
                      yield* sql.unsafe('PRAGMA wal_checkpoint(PASSIVE)');
                    }),
                  )
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('reconcile code graph worktrees', cause)),
          ),
        pruneCachedFacts: (databasePath, acceptedExtractorSets) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(
                    databasePath,
                    Effect.gen(function* () {
                      const sql = yield* SqlClient.SqlClient;
                      yield* configureConnection(sql);
                      yield* sql.withTransaction(pruneCachedFileBlobs(sql, acceptedExtractorSets));
                    }),
                  )
                : Effect.void,
            ),
            Effect.mapError(cause => storeError('prune cached code graph facts', cause)),
          ),
        repair: (databasePath, dryRun = false) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists ? useDatabase(databasePath, repairDatabase(dryRun)) : Effect.succeed(undefined),
            ),
            Effect.mapError(cause => storeError('repair code graph database', cause)),
          ),
        releaseSnapshotLease: (databasePath, token) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists => (exists ? useDatabase(databasePath, releaseSnapshotLease(token)) : Effect.void)),
            Effect.mapError(cause => storeError('release code graph snapshot lease', cause)),
          ),
        renewSnapshotLease: (databasePath, token, durationMilliseconds) =>
          fs.exists(databasePath).pipe(
            Effect.flatMap(exists =>
              exists
                ? useDatabase(databasePath, renewSnapshotLease(token, durationMilliseconds))
                : Effect.fail(new CodeGraphStoreError('The code graph database disappeared while renewing a lease.')),
            ),
            Effect.mapError(cause => storeError('renew code graph snapshot lease', cause)),
          ),
        searchSymbols: (databasePath, snapshotId, query, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSearchSymbols(snapshotId, query, limit))),
            Effect.mapError(cause => storeError('search code graph symbols', cause)),
          ),
        searchSymbolsMany: (databasePath, snapshotId, queries, limit) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSearchSymbolsMany(snapshotId, queries, limit))),
            Effect.mapError(cause => storeError('search code graph symbols', cause)),
          ),
        searchSymbolsByPaths: (databasePath, snapshotId, sourcePaths, limitPerPath) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolsByPaths(snapshotId, sourcePaths, limitPerPath))),
            Effect.mapError(cause => storeError('search code graph symbols by path', cause)),
          ),
        symbolsByIds: (databasePath, snapshotId, ids) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, selectSymbolsByIds(snapshotId, ids))),
            Effect.mapError(cause => storeError('load code graph symbols', cause)),
          ),
        stageActivationFacts: (databasePath, symbols, edges, references = []) =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.withTransaction(
                    Effect.gen(function* () {
                      yield* stageActivationSymbols(sql, symbols);
                      yield* stageActivationSymbolTerms(sql, symbols);
                      yield* stageActivationEdges(sql, edges);
                      yield* stageActivationReferences(sql, references);
                    }),
                  );
                }),
              ),
            ),
            Effect.mapError(cause => storeError('stage code graph facts', cause)),
          ),
        stageWorkspaceCatalog: (databasePath, workspace) =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, stageActivationWorkspace(workspace))),
            Effect.mapError(cause => storeError('stage code graph workspace catalog', cause)),
          ),
        resolveStagedReferences: databasePath =>
          prepare(databasePath).pipe(
            Effect.andThen(useDatabase(databasePath, resolveActivationReferences())),
            Effect.mapError(cause => storeError('resolve staged code graph references', cause)),
          ),
        stagedFactCounts: databasePath =>
          prepare(databasePath).pipe(
            Effect.andThen(
              useDatabase(
                databasePath,
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  const mode = yield* activationMode(sql);
                  if (mode?.mode === 'persisted-delta') {
                    const counts = yield* persistedIncrementalFactCounts(sql, mode.baseSnapshotId);
                    return {edges: counts.edges, symbols: counts.symbols};
                  }
                  const [symbolRows, edgeRows] = yield* Effect.all([
                    sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM activation_symbols`,
                    sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM activation_edges`,
                  ]);
                  return {
                    edges: Number(edgeRows[0]?.count ?? 0),
                    symbols: Number(symbolRows[0]?.count ?? 0),
                  };
                }),
              ),
            ),
            Effect.mapError(cause => storeError('count staged code graph facts', cause)),
          ),
      });
    }),
  );
}

function useDatabase<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.serviceOption(CodeGraphDatabaseSession).pipe(
    Effect.flatMap(session =>
      Option.isSome(session) && session.value.databasePath === databasePath
        ? effect.pipe(Effect.provideService(SqlClient.SqlClient, session.value.sql))
        : useDatabaseDirect(databasePath, effect),
    ),
  ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>;
}

function useDatabaseDirect<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(effect.pipe(Effect.provide(SqliteClient.layer({filename: databasePath})))) as Effect.Effect<
    A,
    E,
    Exclude<R, SqlClient.SqlClient>
  >;
}

const configureConnection = Effect.fn('codeGraph.configureConnection')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
});

const initializeSchema = Effect.fn('codeGraph.initializeSchema')(function* (sql: SqlClient.SqlClient) {
  yield* configureConnection(sql);
  yield* sql.unsafe('PRAGMA journal_mode = WAL');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      object_format TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      worktree_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      base_snapshot_id TEXT,
      extractor_set TEXT NOT NULL,
      dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
      overlay_fingerprint TEXT,
      state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed', 'retired')),
      file_count INTEGER NOT NULL CHECK (file_count >= 0),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
      edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_summary TEXT
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_extractor_generations (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS active_snapshots_require_current_extractor
    BEFORE INSERT ON active_snapshots
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1
      FROM snapshot_extractor_generations AS generation
      JOIN schema_metadata AS minimum
        ON minimum.key = 'minimum_extractor_generation'
      WHERE generation.snapshot_id = NEW.snapshot_id
        AND generation.generation >= CAST(minimum.value AS INTEGER)
    )
    BEGIN
      SELECT RAISE(ABORT, 'Code graph snapshot was built by an older extractor generation.');
    END
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_leases (
      token TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_files (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size >= 0),
      source TEXT NOT NULL CHECK (source IN ('commit', 'worktree')),
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_file_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, path)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS file_blobs (
      content_hash TEXT NOT NULL,
      extractor_set TEXT NOT NULL,
      path_hint TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, extractor_set, path_hint)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbols (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'symbols', 'resolution_scope_id', 'TEXT');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_scopes (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_components (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      source_roots_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS workspace_component_dependencies (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (snapshot_id, source_component_id, target_component_id, provenance)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS edges (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_edge_deletions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      edge_id TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, edge_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS symbol_terms (
      snapshot_id TEXT NOT NULL,
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (snapshot_id, term, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance IN ('alias', 'symbol')),
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id),
      FOREIGN KEY (snapshot_id, symbol_id) REFERENCES symbols(snapshot_id, id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_reuse_receipts (
      snapshot_id TEXT PRIMARY KEY NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      format_version INTEGER NOT NULL,
      resolution_surface_version INTEGER NOT NULL,
      extractor_set TEXT NOT NULL,
      workspace_fingerprint TEXT NOT NULL,
      file_set_fingerprint TEXT NOT NULL,
      lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
      alias_count INTEGER NOT NULL CHECK (alias_count >= 0),
      reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0),
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* ensureColumn(sql, 'snapshot_reuse_receipts', 'reexport_count', 'INTEGER NOT NULL DEFAULT 0');
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS snapshot_reexport_provenance (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_worktree_state ON snapshots(worktree_id, state)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshots_commit ON snapshots(repository_id, commit_id)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_leases_expiry ON snapshot_leases(expires_at)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS snapshot_files_blob ON snapshot_files(path, content_hash)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name ON symbols(snapshot_id, name)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path ON symbols(snapshot_id, path)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_resolution_scope ON symbols(snapshot_id, resolution_scope_id)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_name_nocase ON symbols(snapshot_id, name COLLATE NOCASE)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS symbols_qualified_nocase ON symbols(snapshot_id, qualified_name COLLATE NOCASE)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS symbols_path_nocase ON symbols(snapshot_id, path COLLATE NOCASE)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS symbols_export_order ON symbols(snapshot_id, path, qualified_name, id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS edges_source ON edges(snapshot_id, source_id, relation)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS edges_target ON edges(snapshot_id, target_id, relation)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS edges_export_order ON edges(snapshot_id, source_name, relation, target_name, id)',
  );
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS terms_lookup ON symbol_terms(snapshot_id, term, weight DESC)');
  yield* sql.unsafe('CREATE INDEX IF NOT EXISTS terms_symbol ON symbol_terms(snapshot_id, symbol_id)');
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshot_symbol_lookup_key ON snapshot_symbol_lookup(snapshot_id, lookup_key, resolution_domain, exported)',
  );
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS snapshot_reexport_source ON snapshot_reexport_provenance(snapshot_id, source_path, local_name)',
  );
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('minimum_extractor_generation', ${String(CODE_GRAPH_EXTRACTOR_GENERATION)})
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(MAX(CAST(schema_metadata.value AS INTEGER), ${CODE_GRAPH_EXTRACTOR_GENERATION}) AS TEXT)
  `;
  yield* sql`
    INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', ${String(CODE_GRAPH_SCHEMA_VERSION)})
    ON CONFLICT(key) DO NOTHING
  `;
  const rows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  if (rows[0]?.value !== String(CODE_GRAPH_SCHEMA_VERSION)) {
    return yield* Effect.fail(
      new CodeGraphStoreError(
        `Code graph schema ${rows[0]?.value ?? 'unknown'} is incompatible with ${CODE_GRAPH_SCHEMA_VERSION}.`,
      ),
    );
  }
});

const ensureColumn = Effect.fn('codeGraph.ensureColumn')(function* (
  sql: SqlClient.SqlClient,
  table: string,
  column: string,
  declaration: string,
) {
  const columns = yield* sql.unsafe<{readonly name: string}>(`PRAGMA table_info(${table})`);
  if (columns.some(candidate => candidate.name === column)) return;
  yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
});

const diagnoseDatabase = Effect.fn('codeGraph.diagnoseDatabase')(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('PRAGMA foreign_keys = ON');
  yield* sql.unsafe('PRAGMA busy_timeout = 5000');
  const integrityRows = yield* sql.unsafe<{readonly integrity_check: string}>('PRAGMA integrity_check(10)');
  const schemaRows = yield* sql<{readonly value: string}>`
    SELECT value FROM schema_metadata WHERE key = 'schema_version'
  `;
  const schemaVersion = Number.parseInt(schemaRows[0]?.value ?? '', 10);
  const stateRows = yield* sql<{readonly count: number; readonly state: CodeGraphSnapshot['state']}>`
    SELECT state, COUNT(*) AS count FROM snapshots GROUP BY state
  `;
  const activeRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM active_snapshots`;
  const cacheRows = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM file_blobs`;
  const foreignKeyRows = yield* sql.unsafe('PRAGMA foreign_key_check');
  const counts = new Map(stateRows.map(row => [row.state, Number(row.count)]));
  const integrityOk =
    integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' && foreignKeyRows.length === 0;
  return {
    activeSnapshots: Number(activeRows[0]?.count ?? 0),
    buildingSnapshots: counts.get('building') ?? 0,
    cachedFileBlobs: Number(cacheRows[0]?.count ?? 0),
    failedSnapshots: counts.get('failed') ?? 0,
    foreignKeyViolations: foreignKeyRows.length,
    integrity:
      !Number.isSafeInteger(schemaVersion) || schemaVersion !== CODE_GRAPH_SCHEMA_VERSION
        ? 'incompatible'
        : integrityOk
          ? 'ok'
          : 'corrupt',
    readySnapshots: counts.get('ready') ?? 0,
    schemaVersion: Number.isSafeInteger(schemaVersion) ? schemaVersion : undefined,
  } satisfies CodeGraphDatabaseHealth;
});

const repairDatabase = Effect.fn('codeGraph.repairDatabase')(function* (dryRun: boolean) {
  const sql = yield* SqlClient.SqlClient;
  const health = yield* diagnoseDatabase();
  if (health.integrity !== 'ok') {
    return yield* Effect.fail(
      new CodeGraphStoreError(`Code graph database is ${health.integrity}; discard and rebuild it.`),
    );
  }
  const now = yield* Clock.currentTimeMillis;
  if (dryRun) {
    const candidates = yield* sql<{readonly count: number}>`
      SELECT COUNT(*) AS count
      FROM snapshots AS snapshot
      WHERE snapshot.state IN ('building', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_leases AS lease
          WHERE lease.snapshot_id = snapshot.id AND lease.expires_at > ${now}
        )
    `;
    return {removedSnapshots: Number(candidates[0]?.count ?? 0)} satisfies CodeGraphDatabaseRepair;
  }
  let removedSnapshots = 0;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const removed = yield* sql<{readonly id: string}>`
        DELETE FROM snapshots
        WHERE state IN ('building', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_leases AS lease
            WHERE lease.snapshot_id = snapshots.id AND lease.expires_at > ${now}
          )
        RETURNING id
      `;
      removedSnapshots = removed.length;
      yield* pruneUnreferencedFileBlobs(sql);
    }),
  );
  return {removedSnapshots} satisfies CodeGraphDatabaseRepair;
});

const acquireSnapshotLease = Effect.fn('codeGraph.acquireSnapshotLease')(function* (
  snapshotId: string,
  durationMilliseconds: number,
  token: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM snapshot_leases WHERE expires_at <= ${now}`;
      const ready = yield* sql<{readonly id: string}>`
        SELECT id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
      `;
      if (!ready[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} is no longer available.`));
      }
      yield* sql`
        INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
        VALUES (${token}, ${snapshotId}, ${now + duration})
      `;
    }),
  );
  return token;
});

const releaseSnapshotLease = Effect.fn('codeGraph.releaseSnapshotLease')(function* (token: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  yield* sql`DELETE FROM snapshot_leases WHERE token = ${token}`;
});

const renewSnapshotLease = Effect.fn('codeGraph.renewSnapshotLease')(function* (
  token: string,
  durationMilliseconds: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const duration = Math.max(1_000, Math.min(60 * 60_000, Math.floor(durationMilliseconds)));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const active = yield* sql<{readonly token: string}>`
        SELECT token FROM snapshot_leases WHERE token = ${token} AND expires_at > ${now} LIMIT 1
      `;
      if (!active[0]) {
        return yield* Effect.fail(new CodeGraphStoreError('The code graph snapshot lease expired before renewal.'));
      }
      yield* sql`
        UPDATE snapshot_leases SET expires_at = ${now + duration} WHERE token = ${token}
      `;
    }),
  );
});

function validatedSnapshotLeaseDuration(durationMilliseconds: number): number {
  const finiteDuration = Number.isFinite(durationMilliseconds) ? Math.floor(durationMilliseconds) : 1_000;
  return Math.max(1_000, Math.min(60 * 60_000, finiteDuration));
}

const insertActivationLease = Effect.fn('codeGraph.insertActivationLease')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  lease: Option.Option<CodeGraphActivationLease>,
) {
  if (Option.isNone(lease)) return;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`
    INSERT INTO snapshot_leases (token, snapshot_id, expires_at)
    VALUES (${lease.value.token}, ${snapshotId}, ${now + lease.value.durationMilliseconds})
  `;
});

const recordSnapshotExtractorGeneration = Effect.fn('codeGraph.recordSnapshotExtractorGeneration')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  yield* sql`
    INSERT INTO snapshot_extractor_generations (snapshot_id, generation)
    VALUES (${snapshotId}, ${CODE_GRAPH_EXTRACTOR_GENERATION})
    ON CONFLICT(snapshot_id) DO UPDATE SET
      generation = MAX(snapshot_extractor_generations.generation, excluded.generation)
  `;
});

const activateStagedSnapshot = Effect.fn('codeGraph.activateStagedSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  reusableBaseReceipt?: CodeGraphReusableBaseReceiptInput,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
) {
  let activated = false;
  const baseSnapshotId = snapshot.baseSnapshotId;
  if (baseSnapshotId) {
    const base = yield* sql<{readonly id: string}>`
      SELECT id FROM snapshots WHERE id = ${baseSnapshotId} AND state = 'ready' LIMIT 1
    `;
    if (!base[0]) {
      return yield* Effect.fail(
        new CodeGraphStoreError(`Base snapshot ${baseSnapshotId} is not ready for a dirty overlay.`),
      );
    }
  }
  const invalidEdges = yield* sql<{readonly id: string}>`
    SELECT edge.id
    FROM activation_edges AS edge
    WHERE (edge.source_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM activation_symbols AS symbol WHERE symbol.id = edge.source_id
           ))
       OR (edge.target_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM activation_symbols AS symbol WHERE symbol.id = edge.target_id
           ))
    LIMIT 1
  `;
  if (invalidEdges[0]) {
    return yield* Effect.fail(
      new CodeGraphStoreError(`Code graph edge ${invalidEdges[0].id} references a missing symbol.`),
    );
  }
  const stagedCounts = yield* sql<{
    readonly edges: number;
    readonly files: number;
    readonly symbols: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM activation_edges) AS edges,
      (SELECT COUNT(*) FROM activation_files) AS files,
      (SELECT COUNT(*) FROM activation_symbols) AS symbols
  `;
  const counts = stagedCounts[0];
  if (
    !counts ||
    Number(counts.files) !== snapshot.fileCount ||
    Number(counts.symbols) !== snapshot.symbolCount ||
    Number(counts.edges) !== snapshot.edgeCount
  ) {
    return yield* Effect.fail(new CodeGraphStoreError('Staged code graph counts do not match the ready snapshot.'));
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* upsertRepository(sql, identity);
      const existing = yield* sql<{
        readonly started_at: string;
        readonly state: CodeGraphSnapshot['state'];
      }>`
        SELECT state, started_at FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
      `;
      if (existing[0]?.state !== 'ready') {
        const startedAt = existing[0]?.started_at ?? new Date().toISOString();
        yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
        yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${snapshot.baseSnapshotId ?? null}, ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
            ${snapshot.overlayFingerprint ?? null}, 'ready', ${snapshot.fileCount}, ${snapshot.symbolCount},
            ${snapshot.edgeCount},
            ${startedAt}, NULL
          )
        `;
        activated = true;
        yield* sql`
          INSERT INTO workspace_scopes (
            snapshot_id, id, build_system, name, root, provenance, diagnostics_json
          )
          SELECT ${snapshot.id}, id, build_system, name, root, provenance, diagnostics_json
          FROM activation_workspace_scopes
        `;
        yield* sql`
          INSERT INTO workspace_components (
            snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          )
          SELECT ${snapshot.id}, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          FROM activation_workspace_components
        `;
        yield* sql`
          INSERT INTO workspace_component_dependencies (
            snapshot_id, source_component_id, target_component_id, provenance, evidence
          )
          SELECT ${snapshot.id}, source_component_id, target_component_id, provenance, evidence
          FROM activation_workspace_dependencies
        `;
        if (!baseSnapshotId) {
          yield* sql`
            INSERT INTO snapshot_files (
              snapshot_id, path, content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, path, content_hash, language, mode, size, source
            FROM activation_files
          `;
          yield* sql`
            INSERT INTO symbols (
              snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
              arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported, signature,
              documentation, span_json
            )
            SELECT ${snapshot.id}, id, content_hash, kind, name, qualified_name, path, language,
              arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported, signature,
              documentation, span_json
            FROM activation_symbols
          `;
          yield* sql`
            INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
            SELECT ${snapshot.id}, term, symbol_id, weight
            FROM activation_symbol_terms
          `;
          yield* sql`
            INSERT INTO edges (
              snapshot_id, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            )
            SELECT ${snapshot.id}, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            FROM activation_edges
          `;
        } else {
          yield* identifyChangedSymbols(sql, baseSnapshotId);
          yield* sql`
            INSERT INTO snapshot_files (
              snapshot_id, path, content_hash, language, mode, size, source
            )
            SELECT ${snapshot.id}, current.path, current.content_hash, current.language,
              current.mode, current.size, current.source
            FROM activation_files AS current
            LEFT JOIN snapshot_files AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.path = current.path
            WHERE base.path IS NULL
               OR base.content_hash IS NOT current.content_hash
               OR base.language IS NOT current.language
               OR base.mode IS NOT current.mode
               OR base.size IS NOT current.size
               OR base.source IS NOT current.source
          `;
          yield* sql`
            INSERT INTO snapshot_file_deletions (snapshot_id, path)
            SELECT ${snapshot.id}, base.path
            FROM snapshot_files AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_files AS current WHERE current.path = base.path)
          `;
          yield* sql`
            INSERT INTO symbols (
              snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
              arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported, signature,
              documentation, span_json
            )
            SELECT ${snapshot.id}, current.id, current.content_hash, current.kind, current.name,
              current.qualified_name, current.path, current.language, current.arity,
              current.lookup_keys_json, current.resolution_domain, current.resolution_scope_id, current.package_name,
              current.exported, current.signature, current.documentation, current.span_json
            FROM activation_symbols AS current
            JOIN activation_changed_symbol_ids AS changed ON changed.id = current.id
          `;
          yield* sql`
            INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
            SELECT ${snapshot.id}, terms.term, terms.symbol_id, terms.weight
            FROM activation_symbol_terms AS terms
            JOIN activation_changed_symbol_ids AS changed ON changed.id = terms.symbol_id
          `;
          yield* sql`
            INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id)
            SELECT ${snapshot.id}, base.id
            FROM symbols AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id)
          `;
          yield* sql`
            INSERT INTO edges (
              snapshot_id, id, source_id, source_name, relation, target_id, target_name,
              provenance, confidence, evidence_path, evidence_span_json
            )
            SELECT ${snapshot.id}, current.id, current.source_id, current.source_name,
              current.relation, current.target_id, current.target_name, current.provenance,
              current.confidence, current.evidence_path, current.evidence_span_json
            FROM activation_edges AS current
            LEFT JOIN edges AS base
              ON base.snapshot_id = ${baseSnapshotId} AND base.id = current.id
            WHERE base.id IS NULL
               OR base.source_id IS NOT current.source_id
               OR base.source_name IS NOT current.source_name
               OR base.relation IS NOT current.relation
               OR base.target_id IS NOT current.target_id
               OR base.target_name IS NOT current.target_name
               OR base.provenance IS NOT current.provenance
               OR base.confidence IS NOT current.confidence
               OR base.evidence_path IS NOT current.evidence_path
               OR base.evidence_span_json IS NOT current.evidence_span_json
          `;
          yield* sql`
            INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id)
            SELECT ${snapshot.id}, base.id
            FROM edges AS base
            WHERE base.snapshot_id = ${baseSnapshotId}
              AND NOT EXISTS (SELECT 1 FROM activation_edges AS current WHERE current.id = base.id)
          `;
        }
      }
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
      if (activated && !baseSnapshotId && !snapshot.dirty && reusableBaseReceipt) {
        yield* sql`
          INSERT INTO snapshot_symbol_lookup (
            snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
            provenance, evidence_edge_id, evidence_path
          )
          SELECT ${snapshot.id}, lookup_key, symbol_id, resolution_domain, exported,
            provenance, evidence_edge_id, evidence_path
          FROM activation_symbol_lookup
        `;
        yield* sql`
          INSERT INTO snapshot_reexport_provenance (
            snapshot_id, source_path, local_name, target_path, imported_name
          )
          SELECT ${snapshot.id}, source_path, local_name, target_path, imported_name
          FROM activation_reexport_provenance
        `;
        yield* sql`
          INSERT INTO snapshot_reuse_receipts (
            snapshot_id, format_version, resolution_surface_version, extractor_set,
            workspace_fingerprint, file_set_fingerprint, lookup_count, alias_count,
            reexport_count, created_at
          )
          SELECT
            ${snapshot.id}, ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}, 1, ${snapshot.extractorSet},
            ${reusableBaseReceipt.workspaceFingerprint}, ${reusableBaseReceipt.fileSetFingerprint},
            COUNT(*), COALESCE(SUM(CASE WHEN provenance = 'alias' THEN 1 ELSE 0 END), 0),
            (SELECT COUNT(*) FROM activation_reexport_provenance),
            ${new Date().toISOString()}
          FROM activation_symbol_lookup
        `;
      }
      yield* insertActivationLease(sql, snapshot.id, promotionLease);
    }),
  );
  yield* sql.unsafe('PRAGMA wal_checkpoint(PASSIVE)');
  if (activated) {
    const completedAt = new Date().toISOString();
    yield* sql`
      UPDATE snapshots
      SET completed_at = ${completedAt}
      WHERE id = ${snapshot.id} AND state = 'ready'
    `;
    yield* sql.unsafe('PRAGMA wal_checkpoint(PASSIVE)');
  }
  yield* sql`
    INSERT OR REPLACE INTO activation_state (key, value)
    VALUES ('snapshot_id', ${snapshot.id})
  `;
});

const persistedIncrementalFactCounts = Effect.fn('codeGraph.persistedIncrementalFactCounts')(function* (
  sql: SqlClient.SqlClient,
  baseSnapshotId: string,
) {
  const rows = yield* sql<{
    readonly edges: number;
    readonly files: number;
    readonly symbols: number;
  }>`
    SELECT
      base.file_count AS files,
      base.symbol_count
        - (
            SELECT COUNT(*)
            FROM symbols AS symbol
            JOIN activation_files AS changed ON changed.path = symbol.path
            WHERE symbol.snapshot_id = base.id
          )
        + (SELECT COUNT(*) FROM activation_symbols) AS symbols,
      base.edge_count
        - (
            SELECT COUNT(*)
            FROM edges AS edge
            JOIN activation_files AS changed ON changed.path = edge.evidence_path
            WHERE edge.snapshot_id = base.id
          )
        + (SELECT COUNT(*) FROM activation_edges) AS edges
    FROM snapshots AS base
    WHERE base.id = ${baseSnapshotId} AND base.state = 'ready'
      AND base.dirty = 0 AND base.base_snapshot_id IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return yield* Effect.fail(new CodeGraphStoreError(`Reusable base ${baseSnapshotId} is unavailable.`));
  const counts = {
    edges: Number(row.edges),
    files: Number(row.files),
    symbols: Number(row.symbols),
  };
  if (Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) {
    return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental graph counts are invalid.'));
  }
  return counts;
});

const activatePersistedIncrementalSnapshot = Effect.fn('codeGraph.activatePersistedIncrementalSnapshot')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  baseSnapshotId: string,
  promotionLease: Option.Option<CodeGraphActivationLease> = Option.none(),
) {
  yield* configureConnection(sql);
  if (!snapshot.dirty || snapshot.baseSnapshotId !== baseSnapshotId) {
    return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental activation has the wrong base snapshot.'));
  }
  const completedAt = new Date().toISOString();
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* selectReusableBaseReceipt(baseSnapshotId))) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Reusable base receipt ${baseSnapshotId} is unavailable or incomplete.`),
        );
      }
      if (!(yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId))) {
        return yield* Effect.fail(new CodeGraphStoreError('Persisted incremental resolution surface changed.'));
      }
      const changedPathsOnly = yield* sql<{readonly id: string}>`
        SELECT edge.id
        FROM activation_edges AS edge
        WHERE NOT EXISTS (SELECT 1 FROM activation_files AS file WHERE file.path = edge.evidence_path)
        UNION ALL
        SELECT symbol.id
        FROM activation_symbols AS symbol
        WHERE NOT EXISTS (SELECT 1 FROM activation_files AS file WHERE file.path = symbol.path)
        LIMIT 1
      `;
      if (changedPathsOnly[0]) {
        return yield* Effect.fail(new CodeGraphStoreError('Incremental facts escaped the changed-file boundary.'));
      }
      const invalidEdges = yield* sql<{readonly id: string}>`
        SELECT edge.id
        FROM activation_edges AS edge
        WHERE (edge.source_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = edge.source_id)
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS base
                 WHERE base.snapshot_id = ${baseSnapshotId} AND base.id = edge.source_id
               ))
           OR (edge.target_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = edge.target_id)
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS base
                 WHERE base.snapshot_id = ${baseSnapshotId} AND base.id = edge.target_id
               ))
        LIMIT 1
      `;
      if (invalidEdges[0]) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Code graph edge ${invalidEdges[0].id} references a missing effective symbol.`),
        );
      }
      const counts = yield* persistedIncrementalFactCounts(sql, baseSnapshotId);
      if (
        counts.files !== snapshot.fileCount ||
        counts.symbols !== snapshot.symbolCount ||
        counts.edges !== snapshot.edgeCount
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError('Persisted incremental counts do not match the ready snapshot.'),
        );
      }

      yield* upsertRepository(sql, identity);
      const existing = yield* sql<{readonly started_at: string; readonly state: CodeGraphSnapshot['state']}>`
        SELECT state, started_at FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
      `;
      if (existing[0]?.state !== 'ready') {
        const startedAt = existing[0]?.started_at ?? completedAt;
        yield* sql`DELETE FROM snapshots WHERE id = ${snapshot.id}`;
        yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
            started_at, completed_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.commit},
            ${baseSnapshotId}, ${snapshot.extractorSet}, 1, ${snapshot.overlayFingerprint ?? null},
            'ready', ${snapshot.fileCount}, ${snapshot.symbolCount}, ${snapshot.edgeCount},
            ${startedAt}, ${completedAt}
          )
        `;
        yield* sql`
          INSERT INTO workspace_scopes (
            snapshot_id, id, build_system, name, root, provenance, diagnostics_json
          )
          SELECT ${snapshot.id}, id, build_system, name, root, provenance, diagnostics_json
          FROM workspace_scopes WHERE snapshot_id = ${baseSnapshotId}
        `;
        yield* sql`
          INSERT INTO workspace_components (
            snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          )
          SELECT ${snapshot.id}, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          FROM workspace_components WHERE snapshot_id = ${baseSnapshotId}
        `;
        yield* sql`
          INSERT INTO workspace_component_dependencies (
            snapshot_id, source_component_id, target_component_id, provenance, evidence
          )
          SELECT ${snapshot.id}, source_component_id, target_component_id, provenance, evidence
          FROM workspace_component_dependencies WHERE snapshot_id = ${baseSnapshotId}
        `;
        yield* sql`
          INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
          SELECT ${snapshot.id}, path, content_hash, language, mode, size, source
          FROM activation_files
        `;
        yield* sql`
          INSERT INTO symbols (
            snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
            arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
            exported, signature, documentation, span_json
          )
          SELECT ${snapshot.id}, id, content_hash, kind, name, qualified_name, path, language,
            arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
            exported, signature, documentation, span_json
          FROM activation_symbols
        `;
        yield* sql`
          INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight)
          SELECT ${snapshot.id}, term, symbol_id, weight FROM activation_symbol_terms
        `;
        yield* sql`
          INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id)
          SELECT ${snapshot.id}, base.id
          FROM symbols AS base
          JOIN activation_files AS changed ON changed.path = base.path
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id)
        `;
        yield* sql`
          INSERT INTO edges (
            snapshot_id, id, source_id, source_name, relation, target_id, target_name,
            provenance, confidence, evidence_path, evidence_span_json
          )
          SELECT ${snapshot.id}, id, source_id, source_name, relation, target_id, target_name,
            provenance, confidence, evidence_path, evidence_span_json
          FROM activation_edges
        `;
        yield* sql`
          INSERT INTO snapshot_edge_deletions (snapshot_id, edge_id)
          SELECT ${snapshot.id}, base.id
          FROM edges AS base
          JOIN activation_files AS changed ON changed.path = base.evidence_path
          WHERE base.snapshot_id = ${baseSnapshotId}
            AND NOT EXISTS (SELECT 1 FROM activation_edges AS current WHERE current.id = base.id)
        `;
      }
      yield* recordSnapshotExtractorGeneration(sql, snapshot.id);
      yield* insertActivationLease(sql, snapshot.id, promotionLease);
    }),
  );
  yield* sql.unsafe('PRAGMA wal_checkpoint(PASSIVE)');
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql`
    INSERT INTO activation_state (key, value) VALUES ('snapshot_id', ${snapshot.id})
  `;
});

function storeFreshFacts(
  sql: SqlClient.SqlClient,
  files: readonly CodeGraphInventoryFile[],
  cacheFacts: readonly CodeGraphFileFacts[],
  cacheExtractorSet: string,
) {
  return Effect.gen(function* () {
    const createdAt = new Date().toISOString();
    const filesByPath = new Map(files.map(file => [file.path, file]));
    for (const fileFacts of cacheFacts) {
      const file = filesByPath.get(fileFacts.path);
      if (!file) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Fresh parser facts do not match the indexed file inventory: ${fileFacts.path}.`),
        );
      }
      yield* sql`
        INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
        VALUES (
          ${file.contentHash}, ${cacheExtractorSet}, ${file.path},
          ${JSON.stringify(fileFacts)}, ${createdAt}
        )
        ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET
          facts_json = excluded.facts_json,
          created_at = excluded.created_at
      `;
    }
  });
}

const prepareActivationTables = Effect.fn('codeGraph.prepareActivationTables')(function* (sql: SqlClient.SqlClient) {
  yield* sql.unsafe('PRAGMA temp_store = FILE');
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      mode TEXT NOT NULL,
      size INTEGER NOT NULL,
      source TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbols (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL,
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_scopes (
      id TEXT PRIMARY KEY,
      build_system TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_components (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      build_system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      source_roots_json TEXT NOT NULL,
      workspace_roots_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_workspace_dependencies (
      source_component_id TEXT NOT NULL,
      target_component_id TEXT NOT NULL,
      provenance TEXT NOT NULL,
      evidence TEXT,
      PRIMARY KEY (source_component_id, target_component_id, provenance)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbol_lookup (
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (lookup_key, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_references (
      edge_id TEXT PRIMARY KEY,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL,
      alias_lookup_keys_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reexport_provenance (
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      PRIMARY KEY (source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reference_candidates (
      edge_id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      lookup_key TEXT NOT NULL,
      PRIMARY KEY (edge_id, tier, lookup_key)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(
    'CREATE INDEX IF NOT EXISTS activation_reference_candidates_lookup ON activation_reference_candidates(lookup_key, edge_id, tier)',
  );
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_resolved_reference_batch (
      old_edge_id TEXT PRIMARY KEY,
      new_edge_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_symbol_terms (
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (term, symbol_id)
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe(
    'CREATE TEMP TABLE IF NOT EXISTS activation_changed_symbol_ids (id TEXT PRIMARY KEY) WITHOUT ROWID',
  );
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_incremental_paths (
      path TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  yield* sql.unsafe('DELETE FROM activation_state');
  yield* sql.unsafe('DELETE FROM activation_files');
  yield* sql.unsafe('DELETE FROM activation_workspace_scopes');
  yield* sql.unsafe('DELETE FROM activation_workspace_components');
  yield* sql.unsafe('DELETE FROM activation_workspace_dependencies');
  yield* sql.unsafe('DELETE FROM activation_symbols');
  yield* sql.unsafe('DELETE FROM activation_symbol_lookup');
  yield* sql.unsafe('DELETE FROM activation_edges');
  yield* sql.unsafe('DELETE FROM activation_references');
  yield* sql.unsafe('DELETE FROM activation_reexport_provenance');
  yield* sql.unsafe('DELETE FROM activation_reference_candidates');
  yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
  yield* sql.unsafe('DELETE FROM activation_symbol_terms');
  yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
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

const activationMode = Effect.fn('codeGraph.activationMode')(function* (sql: SqlClient.SqlClient) {
  const rows = yield* sql<{readonly key: string; readonly value: string}>`
    SELECT key, value
    FROM activation_state
    WHERE key IN ('base_snapshot_id', 'mode')
  `;
  const values = new Map(rows.map(row => [row.key, row.value]));
  const baseSnapshotId = values.get('base_snapshot_id');
  return values.get('mode') === 'persisted-delta' && baseSnapshotId
    ? {baseSnapshotId, mode: 'persisted-delta'}
    : undefined;
});

function stageActivationFiles(sql: SqlClient.SqlClient, files: readonly CodeGraphInventoryFile[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(files, ACTIVATION_FILE_BATCH_ROWS)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_files (
          path, content_hash, language, mode, size, source
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(file => [file.path, file.contentHash, file.language, file.mode, file.size, file.source]),
      );
    }
  });
}

function stageActivationWorkspace(workspace: CodeGraphWorkspace) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const scope of workspace.workspaces) {
      yield* sql`
        INSERT OR REPLACE INTO activation_workspace_scopes (
          id, build_system, name, root, provenance, diagnostics_json
        ) VALUES (
          ${scope.id}, ${scope.buildSystem}, ${scope.name}, ${scope.root},
          ${scope.provenance}, ${JSON.stringify(scope.diagnostics)}
        )
      `;
    }
    for (const component of workspace.projects) {
      yield* sql`
        INSERT OR REPLACE INTO activation_workspace_components (
          id, workspace_id, build_system, kind, name, root, resolution_domain,
          languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
        ) VALUES (
          ${component.id}, ${component.workspaceId}, ${component.buildSystem}, ${component.kind},
          ${component.name}, ${component.root}, ${component.resolutionDomain},
          ${JSON.stringify(component.languages)}, ${JSON.stringify(component.sourceRoots)},
          ${JSON.stringify(component.workspaceRoots)}, ${component.provenance},
          ${JSON.stringify(component.diagnostics)}
        )
      `;
      for (const dependency of component.dependencyDetails) {
        yield* sql`
          INSERT OR REPLACE INTO activation_workspace_dependencies (
            source_component_id, target_component_id, provenance, evidence
          ) VALUES (
            ${component.id}, ${dependency.targetId}, ${dependency.provenance}, ${dependency.evidence ?? null}
          )
        `;
      }
    }
  });
}

function stageActivationSymbols(sql: SqlClient.SqlClient, symbols: readonly CodeGraphSymbol[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(symbols, ACTIVATION_SYMBOL_BATCH_ROWS)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_symbols (
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
      const lookupRows = batch.flatMap(symbol =>
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
      );
      for (const lookupBatch of chunk(lookupRows, ACTIVATION_LOOKUP_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR REPLACE INTO activation_symbol_lookup (
            lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
          ) VALUES ${lookupBatch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          lookupBatch.flat(),
        );
      }
    }
  });
}

function stageActivationSymbolTerms(sql: SqlClient.SqlClient, symbols: readonly CodeGraphSymbol[]) {
  return Effect.gen(function* () {
    let termBatch: Array<readonly [string, string, number]> = [];
    const flush = () => {
      if (termBatch.length === 0) return Effect.void;
      const current = termBatch;
      termBatch = [];
      return sql.unsafe(
        `INSERT OR REPLACE INTO activation_symbol_terms (term, symbol_id, weight)
         VALUES ${current.map(() => '(?, ?, ?)').join(', ')}`,
        current.flat(),
      );
    };
    for (const symbol of symbols) {
      for (const [term, weight] of symbolTerms(symbol)) {
        termBatch.push([term, symbol.id, weight]);
        if (termBatch.length >= ACTIVATION_TERM_BATCH_ROWS) yield* flush();
      }
    }
    yield* flush();
  });
}

function stageActivationEdges(sql: SqlClient.SqlClient, edges: readonly CodeGraphEdge[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(edges, ACTIVATION_EDGE_BATCH_ROWS)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_edges (
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
    }
  });
}

function stageActivationReferences(sql: SqlClient.SqlClient, references: readonly CodeGraphReference[]) {
  return Effect.gen(function* () {
    for (const batch of chunk(references, ACTIVATION_REFERENCE_BATCH_ROWS)) {
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO activation_references (
          edge_id, resolution_domain, exported_only, alias_lookup_keys_json
        ) VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(reference => [
          reference.edgeId,
          reference.resolutionDomain,
          reference.exportedOnly === true ? 1 : 0,
          JSON.stringify(reference.aliasLookupKeys ?? []),
        ]),
      );
      const candidates = batch.flatMap(reference =>
        reference.lookupTiers.flatMap((tier, tierIndex) =>
          tier.map(key => [reference.edgeId, tierIndex, key] as const),
        ),
      );
      for (const candidateBatch of chunk(candidates, ACTIVATION_REFERENCE_CANDIDATE_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR REPLACE INTO activation_reference_candidates (
            edge_id, tier, lookup_key
          ) VALUES ${candidateBatch.map(() => '(?, ?, ?)').join(', ')}`,
          candidateBatch.flat(),
        );
      }
      const reexports = batch.flatMap(normalizedReexportProvenance);
      for (const reexportBatch of chunk(reexports, ACTIVATION_REFERENCE_BATCH_ROWS)) {
        yield* sql.unsafe(
          `INSERT OR IGNORE INTO activation_reexport_provenance (
            source_path, local_name, target_path, imported_name
          ) VALUES ${reexportBatch.map(() => '(?, ?, ?, ?)').join(', ')}`,
          reexportBatch.flatMap(reexport => [
            reexport.sourcePath,
            reexport.localName,
            reexport.targetPath,
            reexport.importedName,
          ]),
        );
      }
    }
  });
}

function normalizedReexportProvenance(reference: CodeGraphReference): readonly CodeGraphReusableReexport[] {
  if (reference.relation !== 'reexports' || reference.resolutionDomain !== 'typescript') return [];
  const aliases = uniqueBy(
    (reference.aliasLookupKeys ?? []).flatMap(key => {
      const parsed = parseTypeScriptPathNameLookupKey(key);
      return parsed && parsed.path === reference.evidencePath ? [parsed] : [];
    }),
    candidate => `${candidate.path}\0${candidate.name}`,
  );
  const targets = uniqueBy(
    reference.lookupTiers.flatMap(tier =>
      tier.flatMap(key => {
        const parsed = parseTypeScriptPathNameLookupKey(key);
        return parsed ? [parsed] : [];
      }),
    ),
    candidate => `${candidate.path}\0${candidate.name}`,
  );
  return aliases.flatMap(alias =>
    targets.map(target => ({
      importedName: target.name,
      localName: alias.name,
      sourcePath: alias.path,
      targetPath: target.path,
    })),
  );
}

function parseTypeScriptPathNameLookupKey(value: string): {readonly name: string; readonly path: string} | undefined {
  const match = /^typescript:path:([^:]+):name:([^:]+)(?::(?:arity:\d+|implementation|merge-canonical))?$/.exec(value);
  if (!match) return undefined;
  try {
    return {name: decodeURIComponent(match[2]!), path: decodeURIComponent(match[1]!)};
  } catch {
    return undefined;
  }
}

const preparePersistedIncrementalActivation = Effect.fn('codeGraph.preparePersistedIncrementalActivation')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* initializeSchema(sql);
  if (files.length === 0 || facts.length !== files.length) return false;
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length || facts.some(file => !paths.has(file.path))) return false;
  if (!(yield* selectReusableBaseReceipt(baseSnapshotId))) return false;

  yield* prepareActivationTables(sql);
  yield* stageActivationFiles(sql, files);
  const symbols = facts.flatMap(file => file.symbols);
  yield* stageActivationSymbols(sql, symbols);
  yield* stageActivationSymbolTerms(sql, symbols);
  yield* stageActivationEdges(
    sql,
    facts.flatMap(file => file.edges),
  );
  yield* stageActivationReferences(
    sql,
    facts.flatMap(file => file.references ?? []),
  );
  const safe = yield* persistedIncrementalSurfaceMatches(sql, baseSnapshotId);
  if (!safe) {
    yield* prepareActivationTables(sql);
    return false;
  }
  yield* sql`
    INSERT INTO activation_state (key, value)
    VALUES ('mode', 'persisted-delta'), ('base_snapshot_id', ${baseSnapshotId})
  `;
  return true;
});

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

const replaceStagedModifiedFiles = Effect.fn('codeGraph.replaceStagedModifiedFiles')(function* (
  baseSnapshotId: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const staged = yield* sql<{readonly value: string}>`
    SELECT value FROM activation_state WHERE key = 'snapshot_id' LIMIT 1
  `;
  if (staged[0]?.value !== baseSnapshotId || files.length === 0 || facts.length !== files.length) return false;
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length || facts.some(file => !paths.has(file.path))) return false;
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
  for (const batch of chunk([...paths], ACTIVATION_FILE_BATCH_ROWS)) {
    yield* sql.unsafe(
      `INSERT INTO activation_incremental_paths (path)
       VALUES ${batch.map(() => '(?)').join(', ')}`,
      batch,
    );
  }
  const existing = yield* sql<{readonly count: number}>`
    SELECT COUNT(*) AS count
    FROM activation_files AS file
    JOIN activation_incremental_paths AS changed ON changed.path = file.path
  `;
  if (Number(existing[0]?.count ?? 0) !== files.length) {
    yield* sql.unsafe('DELETE FROM activation_incremental_paths');
    return false;
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`
        DELETE FROM activation_reference_candidates
        WHERE edge_id IN (
          SELECT edge.id
          FROM activation_edges AS edge
          JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_references
        WHERE edge_id IN (
          SELECT edge.id
          FROM activation_edges AS edge
          JOIN activation_incremental_paths AS changed ON changed.path = edge.evidence_path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_edges
        WHERE evidence_path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_symbol_terms
        WHERE symbol_id IN (
          SELECT symbol.id
          FROM activation_symbols AS symbol
          JOIN activation_incremental_paths AS changed ON changed.path = symbol.path
        )
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_symbols
        WHERE path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* sql.unsafe(`
        DELETE FROM activation_files
        WHERE path IN (SELECT path FROM activation_incremental_paths)
      `);
      yield* stageActivationFiles(sql, files);
      const symbols = facts.flatMap(file => file.symbols);
      yield* stageActivationSymbols(sql, symbols);
      yield* stageActivationSymbolTerms(sql, symbols);
      yield* stageActivationEdges(
        sql,
        facts.flatMap(file => file.edges),
      );
      yield* stageActivationReferences(
        sql,
        facts.flatMap(file => file.references ?? []),
      );
      yield* sql.unsafe('DELETE FROM activation_changed_symbol_ids');
      yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
      yield* sql.unsafe('DELETE FROM activation_state');
    }),
  );
  yield* sql.unsafe('DELETE FROM activation_incremental_paths');
  return true;
});

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

const resolveActivationReferences = Effect.fn('codeGraph.resolveActivationReferences')(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mode = yield* activationMode(sql);
  const persistedBaseSnapshotId = mode?.mode === 'persisted-delta' ? mode.baseSnapshotId : undefined;
  const persistedBaseCtes = persistedBaseSnapshotId
    ? `effective_activation_lookup AS (
         SELECT lookup_key, symbol_id, resolution_domain, exported
         FROM activation_symbol_lookup
         UNION ALL
         SELECT base.lookup_key, base.symbol_id, base.resolution_domain, base.exported
         FROM snapshot_symbol_lookup AS base
         WHERE base.snapshot_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM activation_symbol_lookup AS current
             WHERE current.lookup_key = base.lookup_key AND current.symbol_id = base.symbol_id
           )
       ),
       effective_activation_symbols AS (
         SELECT * FROM activation_symbols
         UNION ALL
         SELECT base.id, base.content_hash, base.kind, base.name, base.qualified_name,
           base.path, base.language, base.arity, base.lookup_keys_json, base.resolution_domain,
           base.resolution_scope_id, base.package_name, base.exported, base.signature,
           base.documentation, base.span_json
         FROM symbols AS base
         WHERE base.snapshot_id = ?
           AND NOT EXISTS (SELECT 1 FROM activation_symbols AS current WHERE current.id = base.id)
       ),`
    : '';
  const lookupTable = persistedBaseSnapshotId ? 'effective_activation_lookup' : 'activation_symbol_lookup';
  const symbolTable = persistedBaseSnapshotId ? 'effective_activation_symbols' : 'activation_symbols';
  let resolved = 0;
  for (;;) {
    let cursor = '';
    let resolvedInPass = 0;
    let aliasesInPass = 0;
    for (;;) {
      const pending = yield* sql.unsafe<{readonly edge_id: string}>(
        `SELECT edge_id
         FROM activation_references
         WHERE edge_id > ?
         ORDER BY edge_id
         LIMIT 500`,
        [cursor],
      );
      if (pending.length === 0) break;
      const batchEnd = pending.at(-1)!.edge_id;
      const rows = yield* sql.unsafe<ResolvableActivationReferenceRow>(
        `
        WITH ${persistedBaseCtes}
        candidate_matches AS (
          SELECT DISTINCT
            candidate.edge_id,
            candidate.tier,
            lookup.symbol_id
          FROM activation_reference_candidates AS candidate
          JOIN activation_references AS reference ON reference.edge_id = candidate.edge_id
          JOIN activation_edges AS edge ON edge.id = candidate.edge_id AND edge.target_id IS NULL
          JOIN ${lookupTable} AS lookup
            ON lookup.lookup_key = candidate.lookup_key
           AND lookup.resolution_domain = reference.resolution_domain
           AND (reference.exported_only = 0 OR lookup.exported = 1)
           AND (edge.relation <> 'overrides' OR lookup.symbol_id IS NOT edge.source_id)
          WHERE candidate.edge_id > ? AND candidate.edge_id <= ?
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
          HAVING COUNT(DISTINCT match.symbol_id) = 1
        )
        SELECT
          edge.*,
          reference.alias_lookup_keys_json,
          symbol.id AS target_symbol_id,
          symbol.name AS target_symbol_name,
          symbol.exported AS symbol_exported,
          symbol.kind AS symbol_kind,
          symbol.resolution_domain AS symbol_resolution_domain
        FROM unique_candidates AS candidate
        JOIN activation_edges AS edge ON edge.id = candidate.edge_id
        JOIN activation_references AS reference ON reference.edge_id = candidate.edge_id
        JOIN ${symbolTable} AS symbol ON symbol.id = candidate.symbol_id
        ORDER BY candidate.edge_id
        LIMIT 500
        `,
        [...(persistedBaseSnapshotId ? [persistedBaseSnapshotId, persistedBaseSnapshotId] : []), cursor, batchEnd],
      );
      cursor = batchEnd;
      if (rows.length === 0) continue;
      const resolutions: ActivationResolutionRow[] = [];
      const aliases: Array<readonly [string, string, string, number, 'alias', string, string]> = [];
      for (const row of rows) {
        const provenance: CodeGraphProvenance =
          row.provenance === 'declared' ? 'declared' : row.relation === 'documents' ? 'syntactic' : 'resolved';
        const relation =
          row.relation === 'extends' && ['interface', 'protocol'].includes(row.symbol_kind)
            ? 'implements'
            : row.relation;
        resolutions.push({
          confidence: provenance === 'declared' || provenance === 'resolved' ? 1 : row.confidence,
          newEdgeId: activationEdgeId(
            Option.getOrUndefined(sqlTextOption(row.source_id)),
            row.source_name,
            relation,
            row.target_symbol_id,
            row.target_symbol_name,
            provenance,
            row.evidence_path,
          ),
          oldEdgeId: row.id,
          provenance,
          relation,
          targetId: row.target_symbol_id,
          targetName: row.target_symbol_name,
        });
        for (const alias of parseLookupKeys(row.alias_lookup_keys_json)) {
          aliases.push([
            alias,
            row.target_symbol_id,
            lookupDomain(alias, Option.getOrUndefined(sqlTextOption(row.symbol_resolution_domain))),
            row.symbol_exported,
            'alias',
            row.id,
            row.evidence_path,
          ]);
        }
      }
      aliasesInPass += aliases.length;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe('DELETE FROM activation_resolved_reference_batch');
          for (const batch of chunk(resolutions, 400)) {
            yield* sql.unsafe(
              `INSERT INTO activation_resolved_reference_batch (
                old_edge_id, new_edge_id, relation, target_id, target_name, provenance, confidence
              ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
              batch.flatMap(row => [
                row.oldEdgeId,
                row.newEdgeId,
                row.relation,
                row.targetId,
                row.targetName,
                row.provenance,
                row.confidence,
              ]),
            );
          }
          for (const batch of chunk(aliases, 500)) {
            yield* sql.unsafe(
              `INSERT OR IGNORE INTO activation_symbol_lookup (
                lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
              ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
              batch.flat(),
            );
          }
          yield* sql.unsafe(`
            INSERT OR REPLACE INTO activation_edges (
              id, source_id, source_name, relation, target_id, target_name, provenance,
              confidence, evidence_path, evidence_span_json
            )
            SELECT
              resolution.new_edge_id,
              edge.source_id,
              edge.source_name,
              resolution.relation,
              resolution.target_id,
              resolution.target_name,
              resolution.provenance,
              resolution.confidence,
              edge.evidence_path,
              edge.evidence_span_json
            FROM activation_resolved_reference_batch AS resolution
            JOIN activation_edges AS edge ON edge.id = resolution.old_edge_id
          `);
          yield* sql.unsafe(`
            DELETE FROM activation_edges
            WHERE id IN (
              SELECT old_edge_id
              FROM activation_resolved_reference_batch
              WHERE old_edge_id <> new_edge_id
            )
              AND id NOT IN (SELECT new_edge_id FROM activation_resolved_reference_batch)
          `);
          yield* sql.unsafe(`
            DELETE FROM activation_reference_candidates
            WHERE edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)
          `);
          yield* sql.unsafe(`
            DELETE FROM activation_references
            WHERE edge_id IN (SELECT old_edge_id FROM activation_resolved_reference_batch)
          `);
        }),
      );
      resolvedInPass += rows.length;
      resolved += rows.length;
    }
    if (resolvedInPass === 0 || aliasesInPass === 0) break;
  }
  return {resolved};
});

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

const promoteSnapshot = Effect.fn('codeGraph.promoteSnapshot')(function* (
  identity: RepositoryIdentity,
  snapshotId: string,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const retainedWorktreeIds = [...new Set([...activeWorktreeIds, identity.worktreeId])];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const candidate = yield* sql<{
        readonly generation: number | null;
        readonly id: string;
        readonly minimum_generation: number;
      }>`
        SELECT snapshot.id, generation.generation,
          CAST(minimum.value AS INTEGER) AS minimum_generation
        FROM snapshots AS snapshot
        JOIN schema_metadata AS minimum ON minimum.key = 'minimum_extractor_generation'
        LEFT JOIN snapshot_extractor_generations AS generation ON generation.snapshot_id = snapshot.id
        WHERE snapshot.id = ${snapshotId} AND snapshot.state = 'ready'
        LIMIT 1
      `;
      if (!candidate[0]) {
        return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} cannot be promoted.`));
      }
      if (
        candidate[0].generation === null ||
        Number(candidate[0].generation) < Number(candidate[0].minimum_generation)
      ) {
        return yield* Effect.fail(
          new CodeGraphStoreError(`Ready snapshot ${snapshotId} was built by an incompatible extractor generation.`),
        );
      }
      yield* sql`
        DELETE FROM active_snapshots
        WHERE NOT (${sql.in('worktree_id', retainedWorktreeIds)})
      `;
      yield* sql`
        INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at)
        VALUES (${identity.worktreeId}, ${snapshotId}, ${new Date().toISOString()})
        ON CONFLICT(worktree_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          activated_at = excluded.activated_at
      `;
      yield* retireUnusedSnapshots(sql);
    }),
  );
  yield* sql.unsafe('PRAGMA wal_checkpoint(PASSIVE)');
});

const reconcileActiveWorktrees = Effect.fn('codeGraph.reconcileActiveWorktrees')(function* (
  sql: SqlClient.SqlClient,
  activeWorktreeIds: ReadonlySet<string>,
) {
  const retained = [...activeWorktreeIds];
  if (retained.length === 0) yield* sql`DELETE FROM active_snapshots`;
  else {
    yield* sql`
      DELETE FROM active_snapshots
      WHERE NOT (${sql.in('worktree_id', retained)})
    `;
  }
  yield* retireUnusedSnapshots(sql);
});

const retireUnusedSnapshots = Effect.fn('codeGraph.retireUnusedSnapshots')(function* (sql: SqlClient.SqlClient) {
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM snapshot_leases WHERE expires_at <= ${now}`;
  yield* sql`
    UPDATE snapshots
    SET state = 'retired'
    WHERE state = 'ready'
      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
      AND id NOT IN (
        SELECT base_snapshot_id FROM snapshots
        WHERE base_snapshot_id IS NOT NULL
          AND id IN (SELECT snapshot_id FROM active_snapshots UNION SELECT snapshot_id FROM snapshot_leases)
      )
  `;
  for (const table of ['symbol_terms', 'edges', 'symbols', 'snapshot_files'] as const) {
    yield* sql.unsafe(`
      DELETE FROM ${table}
      WHERE snapshot_id IN (
        SELECT id FROM snapshots
        WHERE state = 'retired'
          AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
          AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
      )
    `);
  }
  yield* sql`
    DELETE FROM snapshots
    WHERE state = 'retired'
      AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
      AND id NOT IN (SELECT snapshot_id FROM snapshot_leases)
  `;
});

const pruneUnreferencedFileBlobs = Effect.fn('codeGraph.pruneUnreferencedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`
    DELETE FROM file_blobs
    WHERE NOT EXISTS (
      SELECT 1
      FROM snapshot_files
      WHERE snapshot_files.path = file_blobs.path_hint
        AND snapshot_files.content_hash = file_blobs.content_hash
    )
  `;
});

const pruneCachedFileBlobs = Effect.fn('codeGraph.pruneCachedFileBlobs')(function* (
  sql: SqlClient.SqlClient,
  acceptedExtractorSets?: readonly string[],
) {
  if (acceptedExtractorSets === undefined) {
    yield* pruneUnreferencedFileBlobs(sql);
    return;
  }
  if (acceptedExtractorSets.length === 0) {
    return yield* Effect.fail(new CodeGraphStoreError('At least one active extractor cache is required.'));
  }
  yield* sql.unsafe(
    `DELETE FROM file_blobs
     WHERE extractor_set NOT IN (${acceptedExtractorSets.map(() => '?').join(', ')})
        OR NOT EXISTS (
          SELECT 1
          FROM snapshot_files
          WHERE snapshot_files.path = file_blobs.path_hint
            AND snapshot_files.content_hash = file_blobs.content_hash
        )`,
    acceptedExtractorSets,
  );
});

const selectReadySnapshot = Effect.fn('codeGraph.selectReadySnapshot')(function* (worktreeId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT snapshots.*
    FROM active_snapshots
    JOIN snapshots ON snapshots.id = active_snapshots.snapshot_id
    WHERE active_snapshots.worktree_id = ${worktreeId}
      AND snapshots.state = 'ready'
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotById = Effect.fn('codeGraph.selectReadySnapshotById')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReadySnapshotForCommit = Effect.fn('codeGraph.selectReadySnapshotForCommit')(function* (
  repositoryId: string,
  commit: string,
  extractorSet?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow>`
    SELECT *
    FROM snapshots
    WHERE repository_id = ${repositoryId}
      AND commit_id = ${commit}
      AND dirty = 0
      AND (${extractorSet ?? null} IS NULL OR extractor_set = ${extractorSet ?? null})
      AND state = 'ready'
    ORDER BY completed_at DESC, id
    LIMIT 1
  `;
  return rows[0] ? snapshotFromRow(rows[0]) : undefined;
});

const selectReusableBaseReceipt = Effect.fn('codeGraph.selectReusableBaseReceipt')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<{
    readonly alias_count: number;
    readonly file_set_fingerprint: string;
    readonly format_version: number;
    readonly lookup_count: number;
    readonly reexport_count: number;
    readonly resolution_surface_version: number;
    readonly snapshot_id: string;
    readonly workspace_fingerprint: string;
  }>`
    SELECT receipt.*
    FROM snapshot_reuse_receipts AS receipt
    JOIN snapshots AS snapshot ON snapshot.id = receipt.snapshot_id
    WHERE receipt.snapshot_id = ${snapshotId}
      AND receipt.format_version = ${CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION}
      AND receipt.resolution_surface_version = 1
      AND receipt.extractor_set = snapshot.extractor_set
      AND snapshot.state = 'ready'
      AND snapshot.dirty = 0
      AND snapshot.base_snapshot_id IS NULL
      AND (
        receipt.lookup_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE lookup.snapshot_id = receipt.snapshot_id
        )
      )
      AND (
        receipt.alias_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS lookup
          WHERE lookup.snapshot_id = receipt.snapshot_id AND lookup.provenance = 'alias'
        )
      )
      AND (
        receipt.reexport_count = 0 OR EXISTS (
          SELECT 1 FROM snapshot_reexport_provenance AS provenance
          WHERE provenance.snapshot_id = receipt.snapshot_id
        )
      )
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const lookupCount = Number(row.lookup_count);
  const aliasCount = Number(row.alias_count);
  const reexportCount = Number(row.reexport_count);
  // Receipt rows and their lookup/provenance rows are committed in one SQLite
  // transaction. Avoid recounting the repository-wide lookup tables on every
  // one-file overlay; integrity checks belong to doctor/repair, not the hot path.
  if (
    !Number.isSafeInteger(lookupCount) ||
    lookupCount < 0 ||
    !Number.isSafeInteger(aliasCount) ||
    aliasCount < 0 ||
    aliasCount > lookupCount ||
    !Number.isSafeInteger(reexportCount) ||
    reexportCount < 0
  ) {
    return undefined;
  }
  return {
    aliasCount,
    fileSetFingerprint: row.file_set_fingerprint,
    formatVersion: Number(row.format_version),
    lookupCount,
    reexportCount,
    resolutionSurfaceVersion: Number(row.resolution_surface_version),
    snapshotId: row.snapshot_id,
    workspaceFingerprint: row.workspace_fingerprint,
  } satisfies CodeGraphReusableBaseReceipt;
});

const selectReusableReexports = Effect.fn('codeGraph.selectReusableReexports')(function* (
  snapshotId: string,
  seeds: readonly CodeGraphReusableReexportSeed[],
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (!(yield* selectReusableBaseReceipt(snapshotId))) return undefined;
  const uniqueSeeds = uniqueBy(seeds, seed => `${seed.path}\0${seed.name}`);
  if (uniqueSeeds.length === 0) return [];
  const output = new Map<string, CodeGraphReusableReexport>();
  for (const batch of chunk(uniqueSeeds, 200)) {
    const rows = yield* sql.unsafe<{
      readonly imported_name: string;
      readonly local_name: string;
      readonly source_path: string;
      readonly target_path: string;
    }>(
      `WITH RECURSIVE
       requested(path, name) AS (VALUES ${batch.map(() => '(?, ?)').join(', ')}),
       closure(source_path, local_name, target_path, imported_name) AS (
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM snapshot_reexport_provenance AS provenance
         JOIN requested
           ON requested.path = provenance.source_path AND requested.name = provenance.local_name
         WHERE provenance.snapshot_id = ?
         UNION
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM snapshot_reexport_provenance AS provenance
         JOIN closure
           ON closure.target_path = provenance.source_path
          AND closure.imported_name = provenance.local_name
         WHERE provenance.snapshot_id = ?
       )
       SELECT source_path, local_name, target_path, imported_name
       FROM closure
       ORDER BY source_path, local_name, target_path, imported_name`,
      [...batch.flatMap(seed => [seed.path, seed.name]), snapshotId, snapshotId],
    );
    for (const row of rows) {
      const value = {
        importedName: row.imported_name,
        localName: row.local_name,
        sourcePath: row.source_path,
        targetPath: row.target_path,
      } satisfies CodeGraphReusableReexport;
      output.set(`${value.sourcePath}\0${value.localName}\0${value.targetPath}\0${value.importedName}`, value);
    }
  }
  return [...output.values()].sort((left, right) =>
    compareCodeUnits(
      `${left.sourcePath}\0${left.localName}\0${left.targetPath}\0${left.importedName}`,
      `${right.sourcePath}\0${right.localName}\0${right.targetPath}\0${right.importedName}`,
    ),
  );
});

const selectCachedFacts = Effect.fn('codeGraph.selectCachedFacts')(function* (
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const output = new Map<string, CodeGraphFileFacts>();
  for (const batch of chunk(files, 300)) {
    const rows = yield* selectFileBlobBatch(sql, batch, extractorSet);
    for (const row of rows) {
      try {
        output.set(row.path_hint, JSON.parse(row.facts_json) as CodeGraphFileFacts);
      } catch {
        // A malformed cache row is disposable and will be replaced after extraction.
      }
    }
  }
  return output;
});

function selectFileBlobBatch(
  sql: SqlClient.SqlClient,
  files: readonly Pick<CodeGraphInventoryFile, 'contentHash' | 'path'>[],
  extractorSet: string,
) {
  if (files.length === 0) return Effect.succeed([] as readonly (FileBlobRow & {readonly path_hint: string})[]);
  return sql.unsafe<FileBlobRow & {readonly path_hint: string}>(
    `SELECT content_hash, path_hint, facts_json
     FROM file_blobs
     WHERE extractor_set = ?
       AND (${files.map(() => '(content_hash = ? AND path_hint = ?)').join(' OR ')})`,
    [extractorSet, ...files.flatMap(file => [file.contentHash, file.path])],
  );
}

const selectCachedCommittedFileKeys = Effect.fn('codeGraph.selectCachedCommittedFileKeys')(function* (
  extractorSet: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<{readonly content_hash: string; readonly path_hint: string}>`
    SELECT content_hash, path_hint
    FROM file_blobs
    WHERE extractor_set = ${extractorSet}
      AND json_valid(facts_json)
  `;
  return new Set(rows.map(row => `${row.path_hint}\0${row.content_hash}\0${extractorSet}`));
});

const selectStoredGraph = Effect.fn('codeGraph.selectStoredGraph')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const snapshots = yield* sql<SnapshotRow>`
    SELECT * FROM snapshots WHERE id = ${snapshotId} AND state = 'ready'
  `;
  const snapshot = snapshots[0];
  if (!snapshot) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(snapshot.base_snapshot_id));
  const [symbolRows, edgeRows] = yield* Effect.all(
    [
      selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId),
      selectAllEffectiveEdges(sql, snapshotId, baseSnapshotId),
    ],
    {concurrency: 1},
  );
  return {
    edges: edgeRows.map(edgeFromRow),
    snapshot: snapshotFromRow(snapshot),
    symbols: symbolRows.map(symbolFromRow),
  } satisfies StoredCodeGraph;
});

const selectStoredSymbols = Effect.fn('codeGraph.selectStoredSymbols')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return (yield* selectAllEffectiveSymbols(sql, snapshotId, baseSnapshotId)).map(symbolFromRow);
});

function effectiveSymbolsCte(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  )`;
}

function effectiveEdgesCte(): string {
  return `WITH effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphCtes(): string {
  return `WITH effective_symbols AS (
    SELECT current_symbols.*
    FROM symbols AS current_symbols
    WHERE current_symbols.snapshot_id = ?
    UNION ALL
    SELECT base_symbols.*
    FROM symbols AS base_symbols
    WHERE base_symbols.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM symbols AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_symbols.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_symbol_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_symbols.id
      )
  ), effective_edges AS (
    SELECT current_edges.*
    FROM edges AS current_edges
    WHERE current_edges.snapshot_id = ?
    UNION ALL
    SELECT base_edges.*
    FROM edges AS base_edges
    WHERE base_edges.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM edges AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.id = base_edges.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM snapshot_edge_deletions AS deletions
        WHERE deletions.snapshot_id = ? AND deletions.edge_id = base_edges.id
      )
  )`;
}

function effectiveGraphParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
    ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  ];
}

function effectiveSnapshotParameters(snapshotId: string, baseSnapshotId: string | undefined): readonly string[] {
  return [snapshotId, baseSnapshotId ?? '', snapshotId, snapshotId];
}

const selectBaseSnapshotId = Effect.fn('codeGraph.selectBaseSnapshotId')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
) {
  const rows = yield* sql<{readonly base_snapshot_id: unknown}>`
    SELECT base_snapshot_id FROM snapshots WHERE id = ${snapshotId} AND state = 'ready' LIMIT 1
  `;
  if (!rows[0]) return yield* Effect.fail(new CodeGraphStoreError(`Ready snapshot ${snapshotId} was not found.`));
  return Option.getOrUndefined(sqlTextOption(rows[0].base_snapshot_id));
});

function selectAllEffectiveSymbols(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT * FROM effective_symbols
     ORDER BY path, qualified_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

function selectAllEffectiveEdges(sql: SqlClient.SqlClient, snapshotId: string, baseSnapshotId: string | undefined) {
  return sql.unsafe<EdgeRow>(
    `${effectiveEdgesCte()}
     SELECT * FROM effective_edges
     ORDER BY source_name, relation, target_name, id`,
    effectiveSnapshotParameters(snapshotId, baseSnapshotId),
  );
}

const selectSymbolPage = Effect.fn('codeGraph.selectSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.path,
          cursor.qualifiedName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

const EMBEDDING_SYMBOL_KINDS = [
  'class',
  'document',
  'function',
  'heading',
  'interface',
  'method',
  'module',
  'package',
  'type',
] as const;

const selectEmbeddingSymbolCount = Effect.fn('codeGraph.selectEmbeddingSymbolCount')(function* (snapshotId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<{readonly count: number}>(
    `${effectiveSymbolsCte()}
     SELECT COUNT(*) AS count
     FROM effective_symbols
     WHERE exported = 1 OR kind IN (${EMBEDDING_SYMBOL_KINDS.map(() => '?').join(', ')})`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...EMBEDDING_SYMBOL_KINDS],
  );
  return Number(rows[0]?.count ?? 0);
});

const selectEmbeddingSymbolPage = Effect.fn('codeGraph.selectEmbeddingSymbolPage')(function* (
  snapshotId: string,
  cursor: CodeGraphSymbolCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const eligibility = `exported = 1 OR kind IN (${EMBEDDING_SYMBOL_KINDS.map(() => '?').join(', ')})`;
  const parameters = [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...EMBEDDING_SYMBOL_KINDS];
  const rows = cursor
    ? yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE (${eligibility})
           AND (path, qualified_name, id) > (?, ?, ?)
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...parameters, cursor.path, cursor.qualifiedName, cursor.id, boundedPageLimit(limit)],
      )
    : yield* sql.unsafe<SymbolRow>(
        `${effectiveSymbolsCte()}
         SELECT * FROM effective_symbols
         WHERE ${eligibility}
         ORDER BY path, qualified_name, id
         LIMIT ?`,
        [...parameters, boundedPageLimit(limit)],
      );
  return rows.map(symbolFromRow);
});

const selectVisualizationCatalog = Effect.fn('codeGraph.selectVisualizationCatalog')(function* (
  viewWorktreeId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const rows = yield* sql<SnapshotRow & {readonly activated_at: unknown; readonly display_name: string}>`
    SELECT snapshots.*, repositories.display_name, active_snapshots.activated_at
     FROM snapshots
     JOIN repositories ON repositories.id = snapshots.repository_id
     LEFT JOIN active_snapshots ON active_snapshots.snapshot_id = snapshots.id
     WHERE snapshots.state = 'ready'
       AND (
         ${viewWorktreeId ?? null} IS NULL
         OR active_snapshots.worktree_id = ${viewWorktreeId ?? null}
         OR (active_snapshots.worktree_id IS NULL AND snapshots.worktree_id = ${viewWorktreeId ?? null})
       )
     ORDER BY
       CASE WHEN active_snapshots.snapshot_id IS NULL THEN 1 ELSE 0 END,
       active_snapshots.activated_at DESC,
       snapshots.completed_at DESC,
       snapshots.id
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return undefined;
  const baseSnapshotId = Option.getOrUndefined(sqlTextOption(row.base_snapshot_id));
  const activatedAt = Option.getOrUndefined(sqlTextOption(row.activated_at));
  const hasWorkspaceCatalog =
    (yield* tableExists(sql, 'workspace_components')) &&
    Number(
      (yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${row.id}
        `)[0]?.count ?? 0,
    ) > 0;
  if (hasWorkspaceCatalog) {
    const [workspaces, components, unscopedGroups, dependencies] = yield* Effect.all(
      [
        sql<{
          readonly build_system: CodeGraphWorkspaceBuildSystem;
          readonly diagnostics_json: string;
          readonly id: string;
          readonly name: string;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly root: string;
        }>`
          SELECT id, build_system, name, root, provenance, diagnostics_json
          FROM workspace_scopes
          WHERE snapshot_id = ${row.id}
          ORDER BY root, id
        `,
        sql.unsafe<{
          readonly build_system: CodeGraphWorkspaceBuildSystem;
          readonly diagnostics_json: string;
          readonly file_count: number;
          readonly id: string;
          readonly kind: CodeGraphWorkspaceComponentKind;
          readonly languages_json: string;
          readonly name: string;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly resolution_domain: string;
          readonly root: string;
          readonly source_roots_json: string;
          readonly symbol_count: number;
          readonly workspace_id: string;
          readonly workspace_roots_json: string;
        }>(
          `${effectiveSymbolsCte()}
           SELECT component.id, component.workspace_id, component.build_system, component.kind,
             component.name, component.root, component.resolution_domain, component.languages_json,
             component.source_roots_json, component.workspace_roots_json, component.provenance,
             component.diagnostics_json,
             COUNT(symbol.id) AS symbol_count, COUNT(DISTINCT symbol.path) AS file_count
           FROM workspace_components AS component
           LEFT JOIN effective_symbols AS symbol ON symbol.resolution_scope_id = component.id
           WHERE component.snapshot_id = ?
           GROUP BY component.id, component.workspace_id, component.build_system, component.kind,
             component.name, component.root, component.resolution_domain, component.languages_json,
             component.source_roots_json, component.workspace_roots_json, component.provenance,
             component.diagnostics_json
           ORDER BY component.name, component.root, component.id`,
          [...effectiveSnapshotParameters(row.id, baseSnapshotId), row.id],
        ),
        sql.unsafe<{
          readonly file_count: number;
          readonly languages: string;
          readonly scope_type: 'documentation' | 'package' | 'path';
          readonly scope_value: string;
          readonly symbol_count: number;
        }>(
          `${effectiveSymbolsCte()}
           SELECT
             CASE
               WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'documentation'
               WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package'
               ELSE 'path'
             END AS scope_type,
             CASE
               WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'unscoped-documentation'
               WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN package_name
               WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
               ELSE '(root)'
             END AS scope_value,
             GROUP_CONCAT(DISTINCT language) AS languages,
             COUNT(*) AS symbol_count,
             COUNT(DISTINCT path) AS file_count
           FROM effective_symbols
           WHERE resolution_scope_id IS NULL
           GROUP BY 1, 2
           ORDER BY symbol_count DESC, scope_type, scope_value`,
          effectiveSnapshotParameters(row.id, baseSnapshotId),
        ),
        sql<{
          readonly evidence: unknown;
          readonly provenance: CodeGraphWorkspaceProvenance;
          readonly source_component_id: string;
          readonly target_component_id: string;
        }>`
          SELECT source_component_id, target_component_id, provenance, evidence
          FROM workspace_component_dependencies
          WHERE snapshot_id = ${row.id}
          ORDER BY source_component_id, target_component_id, provenance
        `,
      ],
      {concurrency: 1},
    );
    const dependenciesBySource = new Map<string, typeof dependencies>();
    for (const dependency of dependencies) {
      const current = dependenciesBySource.get(dependency.source_component_id) ?? [];
      dependenciesBySource.set(dependency.source_component_id, [...current, dependency]);
    }
    const projects: CodeGraphVisualizationProject[] = components.map(component => ({
      buildSystem: component.build_system,
      dependencies: (dependenciesBySource.get(component.id) ?? []).map(dependency => ({
        ...(typeof dependency.evidence === 'string' ? {evidence: dependency.evidence} : {}),
        provenance: dependency.provenance,
        targetId: dependency.target_component_id,
      })),
      diagnostics: parseStringArray(component.diagnostics_json),
      fileCount: Number(component.file_count),
      id: component.id,
      kind: component.kind,
      label: component.name,
      languages: parseStringArray(component.languages_json),
      model: 'component',
      provenance: component.provenance,
      resolutionDomain: component.resolution_domain,
      root: component.root,
      sourceRoots: parseStringArray(component.source_roots_json),
      symbolCount: Number(component.symbol_count),
      workspaceId: component.workspace_id,
      workspaceRoots: parseStringArray(component.workspace_roots_json),
    }));
    projects.push(
      ...unscopedGroups.map(group => ({
        dependencies: [],
        diagnostics: [],
        fileCount: Number(group.file_count),
        id:
          group.scope_type === 'documentation'
            ? 'facet:unscoped-documentation'
            : `${group.scope_type}:${group.scope_value}`,
        kind: group.scope_type === 'documentation' ? ('documentation' as const) : ('legacy-group' as const),
        label: group.scope_type === 'documentation' ? 'Unscoped documentation' : group.scope_value,
        languages: group.languages ? group.languages.split(',').sort(compareCodeUnits) : [],
        model: 'facet' as const,
        provenance: 'inferred' as const,
        sourceRoots: [],
        symbolCount: Number(group.symbol_count),
        workspaceRoots: [],
      })),
    );
    const componentSymbols = components.reduce((total, component) => total + Number(component.symbol_count), 0);
    const fallbackSymbols = unscopedGroups.reduce((total, group) => total + Number(group.symbol_count), 0);
    const totalSymbols = Number(row.symbol_count);
    const attributedSymbols = componentSymbols + fallbackSymbols;
    return {
      accounting: {
        attributedSymbols,
        componentSymbols,
        fallbackSymbols,
        omittedSymbols: Math.max(0, totalSymbols - attributedSymbols),
        totalSymbols,
      },
      ...(activatedAt ? {activatedAt} : {}),
      model: 'workspace',
      projects,
      repository: {displayName: row.display_name, repositoryId: row.repository_id},
      snapshot: snapshotFromRow(row),
      viewWorktreeId: viewWorktreeId ?? row.worktree_id,
      workspaces: workspaces.map(workspace => ({
        buildSystem: workspace.build_system,
        diagnostics: parseStringArray(workspace.diagnostics_json),
        id: workspace.id,
        name: workspace.name,
        provenance: workspace.provenance,
        root: workspace.root,
      })),
    } satisfies CodeGraphVisualizationCatalog;
  }
  const projects = yield* sql.unsafe<{
    readonly file_count: number;
    readonly scope_type: 'package' | 'path';
    readonly scope_value: string;
    readonly symbol_count: number;
  }>(
    `${effectiveSymbolsCte()}
     SELECT
       CASE
         WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package'
         ELSE 'path'
       END AS scope_type,
       CASE
         WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN package_name
         WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1)
         ELSE '(root)'
       END AS scope_value,
       COUNT(*) AS symbol_count,
       COUNT(DISTINCT path) AS file_count
     FROM effective_symbols
     GROUP BY 1, 2
     ORDER BY symbol_count DESC, scope_value`,
    effectiveSnapshotParameters(row.id, baseSnapshotId),
  );
  return {
    accounting: {
      attributedSymbols: Number(row.symbol_count),
      componentSymbols: 0,
      fallbackSymbols: Number(row.symbol_count),
      omittedSymbols: 0,
      totalSymbols: Number(row.symbol_count),
    },
    projects: projects.map(project => ({
      dependencies: [],
      diagnostics: [],
      fileCount: Number(project.file_count),
      id: `${project.scope_type}:${project.scope_value}`,
      kind: 'legacy-group',
      label: project.scope_value,
      languages: [],
      model: 'legacy-fallback',
      provenance: 'legacy',
      sourceRoots: [],
      symbolCount: Number(project.symbol_count),
      workspaceRoots: [],
    })),
    ...(activatedAt ? {activatedAt} : {}),
    model: 'legacy-fallback',
    repository: {
      displayName: row.display_name,
      repositoryId: row.repository_id,
    },
    snapshot: snapshotFromRow(row),
    viewWorktreeId: viewWorktreeId ?? row.worktree_id,
    workspaces: [],
  } satisfies CodeGraphVisualizationCatalog;
});

const selectVisualizationCatalogs = Effect.fn('codeGraph.selectVisualizationCatalogs')(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const worktrees = yield* sql<{readonly worktree_id: string}>`
    SELECT DISTINCT COALESCE(active_snapshots.worktree_id, snapshots.worktree_id) AS worktree_id
    FROM snapshots
    LEFT JOIN active_snapshots ON active_snapshots.snapshot_id = snapshots.id
    WHERE snapshots.state = 'ready'
    ORDER BY worktree_id
  `;
  return (yield* Effect.forEach(worktrees, row => selectVisualizationCatalog(row.worktree_id), {
    concurrency: 1,
  })).flatMap(catalog => (catalog ? [catalog] : []));
});

const selectVisualizationScopeEdges = Effect.fn('codeGraph.selectVisualizationScopeEdges')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const hasWorkspaceCatalog =
    (yield* tableExists(sql, 'workspace_components')) &&
    Number(
      (yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ${snapshotId}
        `)[0]?.count ?? 0,
    ) > 0;
  const graphRows = yield* sql.unsafe<{
    readonly confidence: number;
    readonly count: number;
    readonly provenance: CodeGraphProvenance;
    readonly relation: CodeGraphEdge['relation'];
    readonly source_scope_id: string;
    readonly target_scope_id: string;
  }>(
    `${effectiveGraphCtes()}
     , scoped_symbols AS (
       SELECT id,
         ${hasWorkspaceCatalog ? "CASE WHEN resolution_scope_id IS NOT NULL THEN resolution_scope_id WHEN language = 'markdown' OR kind IN ('document', 'heading', 'section') THEN 'facet:unscoped-documentation' WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END" : "CASE WHEN package_name IS NOT NULL AND trim(package_name) <> '' THEN 'package:' || package_name WHEN instr(path, '/') > 0 THEN 'path:' || substr(path, 1, instr(path, '/') - 1) ELSE 'path:(root)' END"} AS scope_id
       FROM effective_symbols
     )
     SELECT source.scope_id AS source_scope_id, target.scope_id AS target_scope_id,
       edge.provenance, edge.relation, COUNT(*) AS count, MAX(edge.confidence) AS confidence
     FROM effective_edges AS edge
     JOIN scoped_symbols AS source ON source.id = edge.source_id
     JOIN scoped_symbols AS target ON target.id = edge.target_id
     WHERE source.scope_id IS NOT NULL AND target.scope_id IS NOT NULL
       AND source.scope_id <> target.scope_id
     GROUP BY source.scope_id, target.scope_id, edge.provenance, edge.relation
     ORDER BY source.scope_id, target.scope_id, edge.provenance, edge.relation`,
    effectiveGraphParameters(snapshotId, baseSnapshotId),
  );
  const sourceRelationships: CodeGraphVisualizationScopeEdge[] = graphRows.map(row => ({
    confidence: Number(row.confidence),
    count: Number(row.count),
    provenance: row.provenance,
    relation: row.relation,
    sourceId: row.source_scope_id,
    targetId: row.target_scope_id,
    type: 'source-relationship',
  }));
  if (!hasWorkspaceCatalog) return sourceRelationships;
  const dependencies = yield* sql<{
    readonly provenance: CodeGraphWorkspaceProvenance;
    readonly source_component_id: string;
    readonly target_component_id: string;
  }>`
    SELECT source_component_id, target_component_id, provenance
    FROM workspace_component_dependencies
    WHERE snapshot_id = ${snapshotId}
    ORDER BY source_component_id, target_component_id, provenance
  `;
  return [
    ...dependencies.map(
      dependency =>
        ({
          confidence: 1,
          count: 1,
          provenance: 'declared',
          relation: 'depends_on',
          sourceId: dependency.source_component_id,
          targetId: dependency.target_component_id,
          type: 'declared-build-dependency',
        }) satisfies CodeGraphVisualizationScopeEdge,
    ),
    ...sourceRelationships,
  ];
});

const selectVisualizationSymbols = Effect.fn('codeGraph.selectVisualizationSymbols')(function* (
  snapshotId: string,
  scope: CodeGraphVisualizationScope,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const pathScope = "CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '(root)' END";
  const predicate =
    scope.type === 'component'
      ? 'resolution_scope_id = ?'
      : scope.type === 'documentation-facet'
        ? "resolution_scope_id IS NULL AND (language = 'markdown' OR kind IN ('document', 'heading', 'section'))"
        : scope.type === 'package'
          ? 'resolution_scope_id IS NULL AND package_name = ?'
          : scope.type === 'path'
            ? `resolution_scope_id IS NULL AND (package_name IS NULL OR trim(package_name) = '') AND ${pathScope} = ?`
            : '1 = 1';
  const scopeParameters = scope.type === 'all' || scope.type === 'documentation-facet' ? [] : [scope.value];
  const rows = yield* sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT *
     FROM effective_symbols
     WHERE ${predicate}
     ORDER BY
       exported DESC,
       CASE kind
         WHEN 'package' THEN 0
         WHEN 'module' THEN 1
         WHEN 'class' THEN 2
         WHEN 'interface' THEN 3
         WHEN 'function' THEN 4
         WHEN 'method' THEN 5
         ELSE 6
       END,
       path,
       qualified_name,
       id
     LIMIT ?`,
    [
      ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
      ...scopeParameters,
      Math.max(1, Math.min(500, Math.floor(limit))),
    ],
  );
  return rows.map(symbolFromRow);
});

const selectEdgePage = Effect.fn('codeGraph.selectEdgePage')(function* (
  snapshotId: string,
  cursor: CodeGraphEdgeCursor | undefined,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = cursor
    ? yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         WHERE (source_name, relation, target_name, id) > (?, ?, ?, ?)
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [
          ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
          cursor.sourceName,
          cursor.relation,
          cursor.targetName,
          cursor.id,
          boundedPageLimit(limit),
        ],
      )
    : yield* sql.unsafe<EdgeRow>(
        `${effectiveEdgesCte()}
         SELECT * FROM effective_edges
         ORDER BY source_name, relation, target_name, id
         LIMIT ?`,
        [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), boundedPageLimit(limit)],
      );
  return rows.map(edgeFromRow);
});

const selectSearchSymbols = Effect.fn('codeGraph.selectSearchSymbols')(function* (
  snapshotId: string,
  query: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit);
});

const selectSearchSymbolsWithSql = Effect.fn('codeGraph.selectSearchSymbolsWithSql')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  baseSnapshotId: string | undefined,
  query: string,
  limit: number,
) {
  const effectiveParameters = effectiveSnapshotParameters(snapshotId, baseSnapshotId);
  const terms = normalizedTerms(query).slice(0, 24);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const candidateLimit = Math.min(2_000, Math.max(100, safeLimit * 20));
  const termRows =
    terms.length === 0
      ? []
      : yield* sql.unsafe<SymbolRow & {readonly score: number}>(
          `${effectiveSymbolsCte()},
           effective_terms AS (
             SELECT current_terms.*
             FROM symbol_terms AS current_terms
             WHERE current_terms.snapshot_id = ?
             UNION ALL
             SELECT base_terms.*
             FROM symbol_terms AS base_terms
             WHERE base_terms.snapshot_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM symbols AS overrides
                 WHERE overrides.snapshot_id = ? AND overrides.id = base_terms.symbol_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM snapshot_symbol_deletions AS deletions
                 WHERE deletions.snapshot_id = ? AND deletions.symbol_id = base_terms.symbol_id
               )
           ),
           candidates AS (
             SELECT symbol_id, SUM(weight) AS score
             FROM effective_terms
             WHERE term IN (${terms.map(() => '?').join(', ')})
             GROUP BY symbol_id
             ORDER BY score DESC, symbol_id
             LIMIT ?
           )
           SELECT symbols.*, candidates.score
           FROM candidates
           JOIN effective_symbols AS symbols
             ON symbols.id = candidates.symbol_id`,
          [...effectiveParameters, ...effectiveParameters, ...terms, candidateLimit],
        );
  const exactRows = yield* sql.unsafe<SymbolRow & {readonly score: number}>(
    `${effectiveSymbolsCte()}
     SELECT symbols.*,
       CASE
         WHEN name = ? COLLATE NOCASE THEN 100
         WHEN qualified_name = ? COLLATE NOCASE THEN 90
         ELSE 80
       END AS score
     FROM effective_symbols AS symbols
     WHERE (
         name = ? COLLATE NOCASE OR
         qualified_name = ? COLLATE NOCASE OR
         path = ? COLLATE NOCASE
       )
     LIMIT ?`,
    [...effectiveParameters, query, query, query, query, query, safeLimit],
  );
  const byId = new Map<string, SymbolRow & {readonly score: number}>();
  for (const row of [...termRows, ...exactRows]) {
    const current = byId.get(row.id);
    if (!current || row.score > current.score) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.exported - left.exported ||
        compareCodeUnits(left.name, right.name) ||
        compareCodeUnits(left.path, right.path) ||
        compareCodeUnits(left.id, right.id),
    )
    .slice(0, safeLimit)
    .map(row => ({...symbolFromRow(row), score: Math.max(0, Math.min(1, row.score / 100))}));
});

const selectSearchSymbolsMany = Effect.fn('codeGraph.selectSearchSymbolsMany')(function* (
  snapshotId: string,
  queries: readonly string[],
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  return yield* Effect.forEach(
    queries,
    query => selectSearchSymbolsWithSql(sql, snapshotId, baseSnapshotId, query, limit),
    {concurrency: 1},
  );
});

const selectSymbolsByPaths = Effect.fn('codeGraph.selectSymbolsByPaths')(function* (
  snapshotId: string,
  paths: readonly string[],
  limitPerPath: number,
) {
  if (paths.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const normalizedPaths = [...new Set(paths)];
  const grouped = new Map<string, CodeGraphQueryNode[]>();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limitPerPath)));
  for (const pathBatch of chunk(normalizedPaths, 300)) {
    const rows = yield* sql.unsafe<SymbolRow & {readonly path_rank: number}>(
      `${effectiveSymbolsCte()},
       ranked_symbols AS (
         SELECT effective_symbols.*,
           ROW_NUMBER() OVER (
             PARTITION BY path
             ORDER BY exported DESC, qualified_name, id
           ) AS path_rank
         FROM effective_symbols
         WHERE path IN (${pathBatch.map(() => '?').join(', ')})
       )
       SELECT * FROM ranked_symbols
       WHERE path_rank <= ?
       ORDER BY path, path_rank`,
      [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...pathBatch, safeLimit],
    );
    for (const row of rows) {
      const values = grouped.get(row.path) ?? [];
      values.push({...symbolFromRow(row), score: 1});
      grouped.set(row.path, values);
    }
  }
  return paths.map(sourcePath => grouped.get(sourcePath) ?? []);
});

const selectSymbolsByPathAndName = Effect.fn('codeGraph.selectSymbolsByPathAndName')(function* (
  snapshotId: string,
  sourcePath: string,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT *
     FROM effective_symbols
     WHERE path = ? COLLATE NOCASE
       AND (name = ? COLLATE NOCASE OR qualified_name = ? COLLATE NOCASE)
     ORDER BY exported DESC, qualified_name, id
     LIMIT 20`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), sourcePath, name, name],
  );
  return rows.map(row => ({...symbolFromRow(row), score: 1}));
});

const selectSymbolsByIds = Effect.fn('codeGraph.selectSymbolsByIds')(function* (
  snapshotId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const output: CodeGraphSymbol[] = [];
  for (const values of chunk([...new Set(ids)], 400)) {
    const rows = yield* sql.unsafe<SymbolRow>(
      `${effectiveSymbolsCte()}
       SELECT * FROM effective_symbols
       WHERE id IN (${values.map(() => '?').join(', ')})
       ORDER BY path, qualified_name, id`,
      [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), ...values],
    );
    output.push(...rows.map(symbolFromRow));
  }
  return output;
});

const selectEdgesForNodes = Effect.fn('codeGraph.selectEdgesForNodes')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'both' | 'incoming' | 'outgoing',
  limit: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (nodeIds.length === 0 || limit <= 0 || allowedProvenances.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const ids = [...new Set(nodeIds)].slice(0, 500);
  const sourceClause = `source_id IN (${ids.map(() => '?').join(', ')})`;
  const targetClause = `target_id IN (${ids.map(() => '?').join(', ')})`;
  const adjacency =
    direction === 'incoming'
      ? {parameters: ids, where: targetClause}
      : direction === 'outgoing'
        ? {parameters: ids, where: sourceClause}
        : {parameters: [...ids, ...ids], where: `(${sourceClause} OR ${targetClause})`};
  const authority = `AND provenance IN (${allowedProvenances.map(() => '?').join(', ')})`;
  const rows = yield* sql.unsafe<EdgeRow>(
    `${effectiveEdgesCte()}
     SELECT * FROM effective_edges
     WHERE ${adjacency.where}
       ${authority}
     ORDER BY
       CASE provenance WHEN 'declared' THEN 0 WHEN 'resolved' THEN 1 WHEN 'syntactic' THEN 2 ELSE 3 END,
       confidence DESC, source_name, relation, target_name, id
     LIMIT ?`,
    [
      ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
      ...adjacency.parameters,
      ...allowedProvenances,
      Math.min(5_000, Math.floor(limit)),
    ],
  );
  return rows.map(edgeFromRow);
});

const selectRelationshipSummaryForNode = Effect.fn('codeGraph.selectRelationshipSummaryForNode')(function* (
  snapshotId: string,
  nodeId: string,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  if (allowedProvenances.length === 0) {
    return {incoming: 0, outgoing: 0, provenances: [], relations: []};
  }
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const rows = yield* sql.unsafe<{
    readonly count: number;
    readonly incoming: number;
    readonly outgoing: number;
    readonly provenance: CodeGraphProvenance;
    readonly relation: CodeGraphEdge['relation'];
  }>(
    `${effectiveEdgesCte()}
     SELECT relation, provenance, COUNT(*) AS count,
       SUM(CASE WHEN target_id = ? THEN 1 ELSE 0 END) AS incoming,
       SUM(CASE WHEN source_id = ? THEN 1 ELSE 0 END) AS outgoing
     FROM effective_edges
     WHERE (source_id = ? OR target_id = ?)
       AND provenance IN (${allowedProvenances.map(() => '?').join(', ')})
     GROUP BY relation, provenance
     ORDER BY count DESC, relation, provenance`,
    [...effectiveSnapshotParameters(snapshotId, baseSnapshotId), nodeId, nodeId, nodeId, nodeId, ...allowedProvenances],
  );
  const relationCounts = new Map<CodeGraphEdge['relation'], {count: number; incoming: number; outgoing: number}>();
  const provenanceCounts = new Map<CodeGraphProvenance, number>();
  let incoming = 0;
  let outgoing = 0;
  for (const row of rows) {
    const relation = relationCounts.get(row.relation) ?? {count: 0, incoming: 0, outgoing: 0};
    relation.count += row.count;
    relation.incoming += row.incoming;
    relation.outgoing += row.outgoing;
    relationCounts.set(row.relation, relation);
    provenanceCounts.set(row.provenance, (provenanceCounts.get(row.provenance) ?? 0) + row.count);
    incoming += row.incoming;
    outgoing += row.outgoing;
  }
  return {
    incoming,
    outgoing,
    provenances: [...provenanceCounts]
      .map(([provenance, count]) => ({count, provenance}))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.provenance, right.provenance)),
    relations: [...relationCounts]
      .map(([relation, counts]) => ({...counts, relation}))
      .sort((left, right) => right.count - left.count || compareCodeUnits(left.relation, right.relation)),
  };
});

const upsertRepository = Effect.fn('codeGraph.upsertRepository')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
) {
  const now = new Date().toISOString();
  yield* sql`
    INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
    VALUES (${identity.repositoryId}, ${identity.displayName}, ${identity.objectFormat}, ${now}, ${now})
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      object_format = excluded.object_format,
      last_used_at = excluded.last_used_at
  `;
});

function symbolTerms(symbol: CodeGraphSymbol): readonly (readonly [string, number])[] {
  const weighted = new Map<string, number>();
  addTerms(weighted, symbol.name, 5);
  addTerms(weighted, symbol.qualifiedName, 4);
  addTerms(weighted, symbol.path, 3);
  addTerms(weighted, symbol.packageName ?? '', 3);
  addTerms(weighted, symbol.signature ?? '', 2);
  addTerms(weighted, symbol.documentation ?? '', 1);
  return [...weighted].sort(([left], [right]) => compareCodeUnits(left, right));
}

function addTerms(target: Map<string, number>, value: string, weight: number): void {
  for (const term of normalizedTerms(value)) {
    target.set(term, Math.max(target.get(term) ?? 0, weight));
  }
}

export function normalizedTerms(value: string): readonly string[] {
  const expanded = value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return [...new Set(expanded.match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? [])].slice(0, 32);
}

function snapshotFromRow(row: SnapshotRow): CodeGraphSnapshot {
  return {
    baseSnapshotId: Option.getOrUndefined(sqlTextOption(row.base_snapshot_id)),
    commit: row.commit_id,
    completedAt: Option.getOrUndefined(sqlTextOption(row.completed_at)),
    dirty: row.dirty === 1,
    edgeCount: row.edge_count,
    extractorSet: row.extractor_set,
    fileCount: row.file_count,
    id: row.id,
    overlayFingerprint: Option.getOrUndefined(sqlTextOption(row.overlay_fingerprint)),
    repositoryId: row.repository_id,
    state: row.state,
    symbolCount: row.symbol_count,
    worktreeId: row.worktree_id,
  };
}

function symbolFromRow(row: SymbolRow): CodeGraphSymbol {
  const arity = typeof row.arity === 'number' && Number.isSafeInteger(row.arity) ? row.arity : undefined;
  const resolutionDomain = Option.getOrUndefined(sqlTextOption(row.resolution_domain));
  const resolutionScopeId = Option.getOrUndefined(sqlTextOption(row.resolution_scope_id));
  return {
    ...(arity === undefined ? {} : {arity}),
    contentHash: row.content_hash,
    documentation: Option.getOrUndefined(sqlTextOption(row.documentation)),
    exported: row.exported === 1,
    id: row.id,
    kind: row.kind,
    language: row.language,
    lookupKeys: parseLookupKeys(row.lookup_keys_json),
    name: row.name,
    packageName: Option.getOrUndefined(sqlTextOption(row.package_name)),
    path: row.path,
    qualifiedName: row.qualified_name,
    ...(resolutionDomain === undefined ? {} : {resolutionDomain}),
    ...(resolutionScopeId === undefined ? {} : {resolutionScopeId}),
    signature: Option.getOrUndefined(sqlTextOption(row.signature)),
    span: JSON.parse(row.span_json) as CodeGraphSymbol['span'],
  };
}

function edgeFromRow(row: EdgeRow): CodeGraphEdge {
  return {
    confidence: row.confidence,
    evidencePath: row.evidence_path,
    evidenceSpan: JSON.parse(row.evidence_span_json) as CodeGraphEdge['evidenceSpan'],
    id: row.id,
    provenance: row.provenance,
    relation: row.relation,
    sourceId: Option.getOrUndefined(sqlTextOption(row.source_id)),
    sourceName: row.source_name,
    targetId: Option.getOrUndefined(sqlTextOption(row.target_id)),
    targetName: row.target_name,
  };
}

function sqlTextOption(value: unknown): Option.Option<string> {
  return typeof value === 'string' ? Option.some(value) : Option.none();
}

function boundedPageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(2_000, value)) : 500;
}

function* chunk<const Value>(values: readonly Value[], size: number): Generator<readonly Value[]> {
  for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size);
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): readonly Value[] {
  const output = new Map<string, Value>();
  for (const value of values) {
    const identity = key(value);
    if (!output.has(identity)) output.set(identity, value);
  }
  return [...output.values()];
}

function parseLookupKeys(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 4_096))]
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}

function tableExists(sql: SqlClient.SqlClient, table: string): Effect.Effect<boolean, SqlError.SqlError> {
  return sql<{readonly name: string}>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table} LIMIT 1
  `.pipe(Effect.map(rows => rows.length > 0));
}

function lookupDomain(key: string, fallback: string | undefined): string {
  const separator = key.indexOf(':');
  return separator > 0 ? key.slice(0, separator) : (fallback ?? 'generic');
}

function activationEdgeId(
  sourceId: string | undefined,
  sourceName: string,
  relation: string,
  targetId: string | undefined,
  targetName: string,
  provenance: string,
  path: string,
): string {
  return `cge_${sha256HexSync(
    `edge-v1\n${sourceId ?? sourceName}\n${relation}\n${targetId ?? targetName}\n${provenance}\n${path}`,
  ).slice(0, 32)}`;
}

function storeError(operation: string, cause: unknown): CodeGraphStoreError {
  if (cause instanceof CodeGraphStoreError) return cause;
  return new CodeGraphStoreError(`${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}
