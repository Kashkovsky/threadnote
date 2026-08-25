import {Context, Effect, Layer} from 'effect';
import {makeCodeGraphStoreRuntime} from './store_runtime.js';
import {makeCodeGraphStoreDataMethods} from './store_service_data.js';
import {makeCodeGraphStoreLifecycleMethods} from './store_service_lifecycle.js';
import {makeCodeGraphStoreMaintenanceMethods} from './store_service_maintenance.js';
import {makeCodeGraphStoreStagingMethods} from './store_service_staging.js';
import {type CodeGraphStoreShape} from './store_shape.js';

export {
  canonicalCodeGraphMonikers,
  codeGraphPackageMoniker,
  codeGraphProtobufMoniker,
  compareCodeGraphMonikers,
  normalizeNpmPackageName,
  normalizeProtobufImportPath,
  normalizeProtobufName,
  parseCodeGraphMonikerV1,
  type CodeGraphPackageMonikerInput,
  type CodeGraphProtobufMonikerInput,
} from './cross_repository/monikers.js';
export {
  CODE_GRAPH_EXTERNAL_DEPENDENCY_KINDS,
  CODE_GRAPH_MONIKER_STRICT_PARSE_OPTIONS,
  CODE_GRAPH_MONIKER_VERSION,
  CodeGraphExternalDependencySchemaV1,
  CodeGraphMonikerSchemaV1,
  CodeGraphPackageMonikerSchemaV1,
  CodeGraphProtobufMonikerSchemaV1,
  type CodeGraphExternalDependencyKind,
  type CodeGraphExternalDependencyV1,
  type CodeGraphMonikerRole,
  type CodeGraphMonikerV1,
  type CodeGraphPackageMonikerV1,
  type CodeGraphProtobufMonikerKind,
  type CodeGraphProtobufMonikerV1,
  type CodeGraphSourceEvidenceV1,
} from './cross_repository/types.js';

export * from './store_models.js';
export type {
  CodeGraphDatabaseSessionOptions,
  CodeGraphSqliteWriterSettings,
  CodeGraphSqliteWriterTuning,
  CodeGraphStoreShape,
} from './store_shape.js';
export {
  CODE_GRAPH_PERSISTENT_EXTENSION_TABLE_NAMES,
  type CodeGraphPersistentSchemaMigrationPhase,
} from './store_schema_contracts.js';
export {codeGraphPersistentExtensionSchemaCompatible} from './store_schema_inspection.js';
export {CODE_GRAPH_FILE_BLOB_AUTHORITY_TABLE} from './store_cache_authority.js';
export {CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES} from './store_schema_initialization.js';
export {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION} from './types.js';
export {nextPersistentActivationBatchRows} from './store_activation_core.js';
export {codeGraphPersistedEndpointValidationPageStatement} from './store_activation_persistent.js';
export {persistentFullShardPublicationPlan} from './store_activation_persistent.js';
export {
  codeGraphAnalysisEdgeAggregatePageStatement,
  codeGraphAnalysisSummaryDigest,
  codeGraphAnalysisSymbolAggregatePageStatement,
} from './store_analysis.js';
export {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from './store_build_core.js';
export {codeGraphCompactLexicalDeepAuditStatement} from './store_build_preparation.js';
export {
  codeGraphMaterializedShardAssociationPageStatement,
  materializedBatchShardDerivationIdentity,
  materializedFileShardIdentity,
  materializedShardRepositorySemanticEnvelope,
  materializedShardDerivationIdentity,
  shardDonorIds,
} from './store_cache.js';
export {
  codeGraphCompactLexicalCleanupPageStatement,
  codeGraphExactSnapshotRetirementStatement,
} from './store_cleanup_core.js';
export {
  codeGraphRoutineFileBlobCleanupPageStatement,
  codeGraphRoutineMaterializedShardCleanupPageStatement,
} from './store_maintenance_core.js';
export {
  codeGraphAdjacencyQueryStatement,
  codeGraphCachedCommittedFileKeysStatement,
  codeGraphExactSymbolQueryStatement,
  codeGraphSymbolPathClass,
  codeGraphSymbolPathScoreMultiplier,
  codeGraphSymbolSearchScoreMultiplier,
  codeGraphSymbolsByIdsQueryStatement,
  isCanonicalAbsoluteBazelLabel,
  type CodeGraphSymbolPathClass,
} from './store_query_core.js';
export {
  codeGraphCompleteMaterializedShardDonorStatement,
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphTermCandidateQueryStatement,
} from './store_queries.js';
export {
  codeGraphRemovedViewCleanupAdmissionPageStatement,
  codeGraphRemovedViewCleanupDuePageStatement,
} from './store_reconciliation.js';
export {codeGraphWorktreeReconciliationCandidatePageStatement} from './store_reconciliation_core.js';
export {
  codeGraphPersistentReferencePageStatement,
  codeGraphPersistedDeltaResolutionPageStatement,
  partitionPersistedReferenceEdges,
  type PersistedReferenceEdgePartition,
} from './store_resolution_core.js';
export {
  codeGraphPersistentLookupMatchStatement,
  resolvePersistedReferenceSelections,
  type PersistedLookupPair,
  type PersistedLookupSummary,
  type PersistedReferenceResolutionInput,
  type PersistedReferenceResolutionSelection,
} from './store_resolution_matching.js';
export {codeGraphRemovedViewCleanupSchemaAdmission} from './store_schema_migration.js';
export {type CodeGraphPersistentReferencePageLimits} from './store_staging_core.js';
export {normalizedTerms, sanitizeCodeGraphStoreDiagnostic} from './store_utilities.js';
export {
  codeGraphVisualizationCatalogComponentStatement,
  codeGraphVisualizationScopeEndpointStatement,
  codeGraphVisualizationScopeSummaryStatementCount,
  codeGraphVisualizationSymbolsQueryStatement,
  type CodeGraphSqlQueryStatement,
} from './store_visualization_sql.js';
export {
  codeGraphVisualizationScopeEdgeSampleStatements,
  codeGraphVisualizationScopeSymbolSampleStatements,
} from './store_visualization.js';

export class CodeGraphStore extends Context.Service<CodeGraphStore, CodeGraphStoreShape>()(
  'threadnote/codeGraph/CodeGraphStore',
) {
  static readonly layer = Layer.effect(
    CodeGraphStore,
    Effect.gen(function* () {
      const runtime = yield* makeCodeGraphStoreRuntime;
      return CodeGraphStore.of({
        ...makeCodeGraphStoreLifecycleMethods(runtime),
        ...makeCodeGraphStoreDataMethods(runtime),
        ...makeCodeGraphStoreMaintenanceMethods(runtime),
        ...makeCodeGraphStoreStagingMethods(runtime),
      });
    }),
  );
}
