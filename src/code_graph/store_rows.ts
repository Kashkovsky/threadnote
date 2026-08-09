import {Option} from 'effect';
import {type CodeGraphEdge, type CodeGraphSnapshot, type CodeGraphSymbol} from './types.js';
import {type EdgeRow, type SnapshotRow, type SymbolRow} from './store_internal_models.js';
import {parseLookupKeys, sqlTextOption} from './store_utilities.js';

function snapshotFromRow(row: SnapshotRow): CodeGraphSnapshot {
  return {
    baseSnapshotId: Option.getOrUndefined(sqlTextOption(row.base_snapshot_id)),
    commit: row.commit_id,
    completedAt: Option.getOrUndefined(sqlTextOption(row.completed_at)),
    dirty: row.dirty === 1,
    edgeCount: row.edge_count,
    extractorSet: row.extractor_set,
    fileCount: row.file_count,
    graphContentId: Option.getOrUndefined(sqlTextOption(row.graph_content_id)),
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

export {snapshotFromRow, symbolFromRow, edgeFromRow};
