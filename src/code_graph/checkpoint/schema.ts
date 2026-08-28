import type {CodeGraphWorkspace} from '../languages/types.js';
import {parseCodeGraphFileFacts} from '../fact_validation.js';
import {
  CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
  CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
} from '../store/schema_revision.js';
import type {CodeGraphFileFacts} from '../types.js';
import {canonicalJson} from './canonical_json.js';
import {codeGraphCheckpointFileFactCacheIdentity} from './file_fact_identity.js';

export const CODE_GRAPH_CHECKPOINT_SCHEMA = 'threadnote.code-graph-checkpoint' as const;
export const CODE_GRAPH_CHECKPOINT_MEDIA_TYPE = 'application/vnd.threadnote.code-graph-checkpoint.v1' as const;
export {
  CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
  CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
};
export const CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE = 'threadnote-gzip-v1' as const;
export const CODE_GRAPH_CHECKPOINT_PATH_POLICY = 'repository-relative-posix-v1' as const;
export const CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM = 10_000;
export const CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM = 16 * 1_048_576;
export const CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM = 64 * 1_048_576;

export const CODE_GRAPH_CHECKPOINT_RECORD_KINDS = [
  'file',
  'file-fact',
  'workspace-scope',
  'workspace-component',
  'workspace-dependency',
  'workspace-external-dependency',
  'symbol',
  'symbol-lookup',
  'reexport',
  'edge',
  'moniker',
  'lexical',
  'pack-provenance',
] as const;

export type CodeGraphCheckpointRecordKind = (typeof CODE_GRAPH_CHECKPOINT_RECORD_KINDS)[number];
export type CodeGraphCheckpointSha256 = `sha256:${string}`;

const RECORD_KIND_ORDER = new Map(CODE_GRAPH_CHECKPOINT_RECORD_KINDS.map((kind, ordinal) => [kind, ordinal]));
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GRAPH_CONTENT_ID = /^cgc_[0-9a-f]{40}$/u;
const MATERIALIZED_FACT_IDENTITY = /^cgfd_[0-9a-f]{40}$/u;
const MAXIMUM_ARRAY_LENGTH = 1_000_000;
const MAXIMUM_SHORT_TEXT_LENGTH = 16_384;
const MAXIMUM_PATH_LENGTH = 4_096;
const UTF8 = new TextEncoder();

export class CodeGraphCheckpointSchemaError extends Error {
  override readonly name = 'CodeGraphCheckpointSchemaError';
}

export interface CodeGraphCheckpointDigestV1 {
  readonly algorithm: 'sha256';
  readonly digest: string;
}

export interface CodeGraphCheckpointDescriptorV1 {
  readonly digest: CodeGraphCheckpointSha256;
  readonly mediaType: typeof CODE_GRAPH_CHECKPOINT_MEDIA_TYPE;
  readonly size: number;
}

export interface CodeGraphCheckpointSpanV1 {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface CodeGraphCheckpointLanguagePackV1 {
  readonly cacheIdentity: string;
  readonly derivationIdentity: string;
  readonly id: string;
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
}

export interface CodeGraphCheckpointAbiInputV1 {
  readonly checkpointSemanticVersion: typeof CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION;
  readonly graphSchemaVersion: number;
  readonly inventoryPolicyVersion: number;
  readonly languagePacks: readonly CodeGraphCheckpointLanguagePackV1[];
  readonly lexicalLogicalFormatVersion: number;
  readonly pathPolicy: typeof CODE_GRAPH_CHECKPOINT_PATH_POLICY;
  readonly referenceResolutionVersion: string;
  readonly workspaceModelVersion: string;
}

export interface CodeGraphCheckpointAbiV1 {
  readonly algorithm: 'sha256';
  readonly digest: string;
  readonly input: CodeGraphCheckpointAbiInputV1;
}

export interface CodeGraphCheckpointCoverageReasonV1 {
  readonly bytes: number;
  readonly code: string;
  readonly files: number;
}

export interface CodeGraphCheckpointCoverageV1 {
  readonly eligibleFiles: number;
  readonly excludedFiles: number;
  readonly reasons: readonly CodeGraphCheckpointCoverageReasonV1[];
  readonly state: 'complete' | 'partial';
}

export interface CodeGraphCheckpointAttributionFileV1 {
  readonly blobId: string;
  /** Exact byte size of the source Git blob before deterministic context compaction. */
  readonly blobSize: number;
  readonly contentHash: string;
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
  readonly source: 'commit';
}

export interface CodeGraphCheckpointPolicyExclusionReasonV1 {
  readonly bytes: number;
  readonly files: number;
  readonly reason: string;
}

export interface CodeGraphCheckpointPolicyExclusionsV1 {
  readonly bytes: number;
  readonly files: number;
  readonly policyVersion: number;
  readonly reasons: readonly CodeGraphCheckpointPolicyExclusionReasonV1[];
}

export interface CodeGraphCheckpointPortableInventoryV1 {
  readonly attributionFiles: readonly CodeGraphCheckpointAttributionFileV1[];
  readonly contract: string;
  readonly diagnostics?: readonly string[];
  readonly includeOpaqueCorpusAssets: boolean;
  readonly policyExclusions: CodeGraphCheckpointPolicyExclusionsV1;
  readonly skipped: number;
  readonly version: number;
  readonly workspace: CodeGraphWorkspace;
}

export interface CodeGraphCheckpointReuseV1 {
  readonly fileSetFingerprint: string;
  readonly formatVersion: number;
  readonly inventory?: CodeGraphCheckpointPortableInventoryV1;
  readonly resolutionSurfaceVersion: number;
  readonly workspaceFingerprint: string;
}

export interface CodeGraphCheckpointMetadataV1 {
  readonly abi: CodeGraphCheckpointAbiInputV1;
  readonly coverage: CodeGraphCheckpointCoverageV1;
  readonly repository: {
    readonly caseMode: 'insensitive' | 'sensitive';
    readonly displayName: string;
    readonly objectFormat: 'sha1' | 'sha256';
    readonly repositoryId: string;
  };
  readonly reuse?: CodeGraphCheckpointReuseV1;
  readonly source: {
    readonly commit: string;
    readonly extractorSet: string;
    readonly graphContentId: string;
  };
}

export interface CodeGraphCheckpointChunkDescriptorV1 {
  readonly compressedBytes: number;
  readonly digest: CodeGraphCheckpointDigestV1;
  readonly ordinal: number;
  readonly recordCount: number;
  readonly uncompressedBytes: number;
}

export type CodeGraphCheckpointCountsV1 = Readonly<Record<CodeGraphCheckpointRecordKind, number>>;

export interface CodeGraphCheckpointHeaderV1 {
  readonly abi: CodeGraphCheckpointAbiV1;
  readonly chunks: readonly CodeGraphCheckpointChunkDescriptorV1[];
  readonly compressionProfile: typeof CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE;
  readonly counts: CodeGraphCheckpointCountsV1;
  readonly coverage: CodeGraphCheckpointCoverageV1;
  readonly formatVersion: typeof CODE_GRAPH_CHECKPOINT_FORMAT_VERSION;
  readonly logical: CodeGraphCheckpointDigestV1;
  readonly mediaType: typeof CODE_GRAPH_CHECKPOINT_MEDIA_TYPE;
  readonly recordSchemaVersion: typeof CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION;
  readonly repository: CodeGraphCheckpointMetadataV1['repository'];
  readonly reuse?: CodeGraphCheckpointReuseV1;
  readonly schema: typeof CODE_GRAPH_CHECKPOINT_SCHEMA;
  readonly source: CodeGraphCheckpointMetadataV1['source'];
}

export interface CodeGraphCheckpointFileRecordV1 {
  readonly blobId: string;
  readonly contentHash: string;
  readonly kind: 'file';
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  readonly rawContentHash?: string;
  readonly size: number;
  readonly source: 'commit';
}

export interface CodeGraphCheckpointFileFactRecordV1 {
  readonly cacheIdentity: string;
  readonly factRole: 'materialized';
  readonly facts: CodeGraphFileFacts;
  readonly kind: 'file-fact';
  readonly path: string;
}

export interface CodeGraphCheckpointWorkspaceScopeRecordV1 {
  readonly buildSystem: string;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly kind: 'workspace-scope';
  readonly name: string;
  readonly provenance: 'declared' | 'inferred';
  readonly root: string;
}

export interface CodeGraphCheckpointWorkspaceComponentRecordV1 {
  readonly buildSystem: string;
  readonly componentKind: 'module' | 'package' | 'project' | 'target';
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly kind: 'workspace-component';
  readonly languages: readonly string[];
  readonly name: string;
  readonly provenance: 'declared' | 'inferred';
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceId: string;
  readonly workspaceRoots: readonly string[];
}

export interface CodeGraphCheckpointWorkspaceDependencyRecordV1 {
  readonly evidence?: string;
  readonly kind: 'workspace-dependency';
  readonly provenance: 'declared' | 'inferred';
  readonly sourceComponentId: string;
  readonly targetComponentId: string;
}

export interface CodeGraphCheckpointWorkspaceExternalDependencyRecordV1 {
  readonly dependencyKind: 'development' | 'optional' | 'peer' | 'runtime';
  readonly ecosystem: 'npm';
  readonly evidencePath: string;
  readonly evidenceSpan?: CodeGraphCheckpointSpanV1;
  readonly importAlias: string;
  readonly kind: 'workspace-external-dependency';
  readonly packageName: string;
  readonly sourceComponentId: string;
  readonly versionConstraint: string;
}

export interface CodeGraphCheckpointSymbolRecordV1 {
  readonly arity?: number;
  readonly contentHash: string;
  readonly documentation?: string;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: 'symbol';
  readonly language: string;
  readonly lookupKeys?: readonly string[];
  readonly name: string;
  readonly packageName?: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly resolutionDomain?: string;
  readonly resolutionScopeId?: string;
  readonly signature?: string;
  readonly span: CodeGraphCheckpointSpanV1;
  readonly symbolKind: string;
}

export interface CodeGraphCheckpointSymbolLookupRecordV1 {
  readonly evidenceEdgeId?: string;
  readonly evidencePath?: string;
  readonly exported: boolean;
  readonly kind: 'symbol-lookup';
  readonly lookupKey: string;
  readonly provenance: 'alias' | 'symbol';
  readonly resolutionDomain: string;
  readonly symbolId: string;
}

export interface CodeGraphCheckpointReexportRecordV1 {
  readonly importedName: string;
  readonly kind: 'reexport';
  readonly localName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CodeGraphCheckpointEdgeRecordV1 {
  readonly confidence: number;
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphCheckpointSpanV1;
  readonly id: string;
  readonly kind: 'edge';
  readonly provenance: 'declared' | 'heuristic' | 'model' | 'resolved' | 'syntactic';
  readonly relation:
    | 'calls'
    | 'configures'
    | 'constructs'
    | 'contains'
    | 'declares'
    | 'depends_on'
    | 'documents'
    | 'exports'
    | 'extends'
    | 'implements'
    | 'imports'
    | 'overrides'
    | 'reads_or_writes'
    | 'references'
    | 'reexports'
    | 'semantic_association'
    | 'tests';
  readonly sourceId?: string;
  readonly sourceName: string;
  readonly targetId?: string;
  readonly targetName: string;
}

export interface CodeGraphCheckpointMonikerRecordV1 {
  readonly componentId?: string;
  readonly dependencyKind?: 'development' | 'optional' | 'peer' | 'runtime';
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphCheckpointSpanV1;
  readonly id: string;
  readonly identity: string;
  readonly importPath?: string;
  readonly kind: 'moniker';
  readonly monikerKind: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly qualifiedName?: string;
  readonly resolutionDomain: string;
  readonly role: 'export' | 'import';
  readonly scheme: 'package' | 'protobuf';
  readonly symbolId?: string;
  readonly version: number;
}

export interface CodeGraphCheckpointLexicalRecordV1 {
  readonly kind: 'lexical';
  readonly symbolId: string;
  readonly term: string;
  readonly weight: number;
}

export interface CodeGraphCheckpointPackProvenanceRecordV1 {
  readonly cacheIdentity: string;
  readonly derivationIdentity: string;
  readonly id: string;
  readonly kind: 'pack-provenance';
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
}

export type CodeGraphCheckpointRecordV1 =
  | CodeGraphCheckpointFileRecordV1
  | CodeGraphCheckpointFileFactRecordV1
  | CodeGraphCheckpointWorkspaceScopeRecordV1
  | CodeGraphCheckpointWorkspaceComponentRecordV1
  | CodeGraphCheckpointWorkspaceDependencyRecordV1
  | CodeGraphCheckpointWorkspaceExternalDependencyRecordV1
  | CodeGraphCheckpointSymbolRecordV1
  | CodeGraphCheckpointSymbolLookupRecordV1
  | CodeGraphCheckpointReexportRecordV1
  | CodeGraphCheckpointEdgeRecordV1
  | CodeGraphCheckpointMonikerRecordV1
  | CodeGraphCheckpointLexicalRecordV1
  | CodeGraphCheckpointPackProvenanceRecordV1;

export interface CodeGraphCheckpointRecordOrderKeyV1 {
  readonly identity: readonly string[];
  readonly kind: CodeGraphCheckpointRecordKind;
}

export function emptyCodeGraphCheckpointCounts(): Record<CodeGraphCheckpointRecordKind, number> {
  return Object.fromEntries(CODE_GRAPH_CHECKPOINT_RECORD_KINDS.map(kind => [kind, 0])) as Record<
    CodeGraphCheckpointRecordKind,
    number
  >;
}

export function parseCodeGraphCheckpointMetadataV1(value: unknown): CodeGraphCheckpointMetadataV1 {
  const input = object(value, 'Checkpoint metadata');
  canonicalJson(input);
  exactKeys(input, ['abi', 'coverage', 'repository', 'source'], ['reuse'], 'Checkpoint metadata');
  const metadata: CodeGraphCheckpointMetadataV1 = {
    abi: parseAbiInput(input.abi),
    coverage: parseCoverage(input.coverage),
    repository: parseRepository(input.repository),
    ...(input.reuse === undefined ? {} : {reuse: parseReuse(input.reuse)}),
    source: parseSource(input.source),
  };
  canonicalJson(metadata);
  return metadata;
}

export function parseCodeGraphCheckpointHeaderV1(value: unknown): CodeGraphCheckpointHeaderV1 {
  const input = object(value, 'Checkpoint header');
  canonicalJson(input);
  exactKeys(
    input,
    [
      'abi',
      'chunks',
      'compressionProfile',
      'counts',
      'coverage',
      'formatVersion',
      'logical',
      'mediaType',
      'recordSchemaVersion',
      'repository',
      'schema',
      'source',
    ],
    ['reuse'],
    'Checkpoint header',
  );
  literal(input.schema, CODE_GRAPH_CHECKPOINT_SCHEMA, 'Checkpoint schema');
  literal(input.mediaType, CODE_GRAPH_CHECKPOINT_MEDIA_TYPE, 'Checkpoint media type');
  literal(input.formatVersion, CODE_GRAPH_CHECKPOINT_FORMAT_VERSION, 'Checkpoint format version');
  literal(input.recordSchemaVersion, CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION, 'Checkpoint record schema version');
  literal(input.compressionProfile, CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE, 'Checkpoint compression profile');
  const abi = parseAbi(input.abi);
  const metadata = parseCodeGraphCheckpointMetadataV1({
    abi: abi.input,
    coverage: input.coverage,
    repository: input.repository,
    ...(input.reuse === undefined ? {} : {reuse: input.reuse}),
    source: input.source,
  });
  const chunks = array(input.chunks, 'Checkpoint chunks').map((chunk, ordinal) => parseChunk(chunk, ordinal));
  const counts = parseCounts(input.counts);
  const chunkRecords = checkedSum(
    chunks.map(chunk => chunk.recordCount),
    'Checkpoint chunk record count',
  );
  const countedRecords = checkedSum(Object.values(counts), 'Checkpoint record count');
  if (chunkRecords !== countedRecords) {
    throw new CodeGraphCheckpointSchemaError('Checkpoint chunk and kind counts do not match.');
  }
  if (counts.file !== metadata.coverage.eligibleFiles) {
    throw new CodeGraphCheckpointSchemaError('Checkpoint file count does not match eligible coverage.');
  }
  return {
    abi,
    chunks,
    compressionProfile: CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE,
    counts,
    coverage: metadata.coverage,
    formatVersion: CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
    logical: parseDigest(input.logical, 'Checkpoint logical digest'),
    mediaType: CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
    recordSchemaVersion: CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
    repository: metadata.repository,
    ...(metadata.reuse === undefined ? {} : {reuse: metadata.reuse}),
    schema: CODE_GRAPH_CHECKPOINT_SCHEMA,
    source: metadata.source,
  };
}

export function parseCodeGraphCheckpointRecordV1(value: unknown): CodeGraphCheckpointRecordV1 {
  const input = object(value, 'Checkpoint record');
  canonicalJson(input);
  const kind = text(input.kind, 'Checkpoint record kind');
  switch (kind) {
    case 'file':
      exactKeys(
        input,
        ['blobId', 'contentHash', 'kind', 'language', 'mode', 'path', 'size', 'source'],
        ['rawContentHash'],
        'File record',
      );
      gitObjectId(input.blobId, 'File blob ID');
      sha256(input.contentHash, 'File content hash');
      optionalSha256(input.rawContentHash, 'File raw content hash');
      shortText(input.language, 'File language');
      mode(input.mode, 'File mode');
      repositoryPath(input.path, 'File path');
      nonNegativeInteger(input.size, 'File size');
      literal(input.source, 'commit', 'File source');
      break;
    case 'file-fact':
      exactKeys(input, ['cacheIdentity', 'factRole', 'facts', 'kind', 'path'], [], 'File-fact record');
      if (typeof input.cacheIdentity !== 'string' || !MATERIALIZED_FACT_IDENTITY.test(input.cacheIdentity)) {
        throw new CodeGraphCheckpointSchemaError('File-fact cache identity is not a materialized derivation ID.');
      }
      literal(input.factRole, 'materialized', 'File-fact role');
      repositoryPath(input.path, 'File-fact path');
      if (
        input.cacheIdentity !==
        codeGraphCheckpointFileFactCacheIdentity(parseFileFacts(input.facts, input.path as string))
      ) {
        throw new CodeGraphCheckpointSchemaError('File-fact cache identity does not match its payload.');
      }
      break;
    case 'workspace-scope':
      exactKeys(
        input,
        ['buildSystem', 'diagnostics', 'id', 'kind', 'name', 'provenance', 'root'],
        [],
        'Workspace-scope record',
      );
      workspaceBuildSystem(input.buildSystem, 'Workspace build system');
      stringArray(input.diagnostics, 'Workspace diagnostics');
      shortText(input.id, 'Workspace ID');
      workspaceName(input.name, input.root, 'Workspace name');
      workspaceProvenance(input.provenance, 'Workspace provenance');
      workspaceRoot(input.root, 'Workspace root');
      break;
    case 'workspace-component':
      exactKeys(
        input,
        [
          'buildSystem',
          'componentKind',
          'diagnostics',
          'id',
          'kind',
          'languages',
          'name',
          'provenance',
          'resolutionDomain',
          'root',
          'sourceRoots',
          'workspaceId',
          'workspaceRoots',
        ],
        [],
        'Workspace-component record',
      );
      workspaceBuildSystem(input.buildSystem, 'Component build system');
      oneOf(input.componentKind, ['module', 'package', 'project', 'target'], 'Component kind');
      stringArray(input.diagnostics, 'Component diagnostics');
      shortText(input.id, 'Component ID');
      stringArray(input.languages, 'Component languages');
      shortText(input.name, 'Component name');
      workspaceProvenance(input.provenance, 'Component provenance');
      shortText(input.resolutionDomain, 'Component resolution domain');
      workspaceRoot(input.root, 'Component root');
      pathArray(input.sourceRoots, 'Component source roots', true);
      shortText(input.workspaceId, 'Component workspace ID');
      pathArray(input.workspaceRoots, 'Component workspace roots', true);
      break;
    case 'workspace-dependency':
      exactKeys(
        input,
        ['kind', 'provenance', 'sourceComponentId', 'targetComponentId'],
        ['evidence'],
        'Workspace-dependency record',
      );
      optionalShortText(input.evidence, 'Workspace dependency evidence');
      workspaceProvenance(input.provenance, 'Workspace dependency provenance');
      shortText(input.sourceComponentId, 'Workspace dependency source');
      shortText(input.targetComponentId, 'Workspace dependency target');
      break;
    case 'workspace-external-dependency':
      exactKeys(
        input,
        [
          'dependencyKind',
          'ecosystem',
          'evidencePath',
          'importAlias',
          'kind',
          'packageName',
          'sourceComponentId',
          'versionConstraint',
        ],
        ['evidenceSpan'],
        'Workspace external-dependency record',
      );
      dependencyKind(input.dependencyKind, 'External dependency kind');
      literal(input.ecosystem, 'npm', 'External dependency ecosystem');
      repositoryPath(input.evidencePath, 'External dependency evidence path');
      if (input.evidenceSpan !== undefined) parseSpan(input.evidenceSpan, 'External dependency evidence span');
      shortText(input.importAlias, 'External dependency alias');
      shortText(input.packageName, 'External dependency package');
      shortText(input.sourceComponentId, 'External dependency component');
      shortText(input.versionConstraint, 'External dependency version');
      break;
    case 'symbol':
      parseSymbol(input);
      break;
    case 'symbol-lookup':
      exactKeys(
        input,
        ['exported', 'kind', 'lookupKey', 'provenance', 'resolutionDomain', 'symbolId'],
        ['evidenceEdgeId', 'evidencePath'],
        'Symbol-lookup record',
      );
      boolean(input.exported, 'Symbol lookup exported');
      shortText(input.lookupKey, 'Symbol lookup key');
      oneOf(input.provenance, ['alias', 'symbol'], 'Symbol lookup provenance');
      shortText(input.resolutionDomain, 'Symbol lookup resolution domain');
      shortText(input.symbolId, 'Symbol lookup symbol ID');
      optionalShortText(input.evidenceEdgeId, 'Symbol lookup evidence edge');
      if (input.evidencePath !== undefined) repositoryPath(input.evidencePath, 'Symbol lookup evidence path');
      break;
    case 'reexport':
      exactKeys(input, ['importedName', 'kind', 'localName', 'sourcePath', 'targetPath'], [], 'Reexport record');
      shortText(input.importedName, 'Reexport imported name');
      shortText(input.localName, 'Reexport local name');
      repositoryPath(input.sourcePath, 'Reexport source path');
      repositoryPath(input.targetPath, 'Reexport target path');
      break;
    case 'edge':
      parseEdge(input);
      break;
    case 'moniker':
      parseMoniker(input);
      break;
    case 'lexical':
      exactKeys(input, ['kind', 'symbolId', 'term', 'weight'], [], 'Lexical record');
      shortText(input.symbolId, 'Lexical symbol ID');
      shortText(input.term, 'Lexical term');
      positiveInteger(input.weight, 'Lexical weight', 1_000);
      break;
    case 'pack-provenance':
      exactKeys(
        input,
        ['cacheIdentity', 'derivationIdentity', 'id', 'kind', 'resolutionDomain', 'resolutionVersion'],
        [],
        'Pack-provenance record',
      );
      sha256(input.cacheIdentity, 'Pack cache identity');
      sha256(input.derivationIdentity, 'Pack derivation identity');
      shortText(input.id, 'Pack ID');
      shortText(input.resolutionDomain, 'Pack resolution domain');
      shortText(input.resolutionVersion, 'Pack resolution version');
      break;
    default:
      throw new CodeGraphCheckpointSchemaError(`Unknown checkpoint record kind: ${kind}.`);
  }
  canonicalJson(input);
  return input as unknown as CodeGraphCheckpointRecordV1;
}

export function codeGraphCheckpointRecordIdentity(record: CodeGraphCheckpointRecordV1): string {
  return canonicalJson([record.kind, ...codeGraphCheckpointRecordIdentityTuple(record)]);
}

export function codeGraphCheckpointRecordIdentityTuple(record: CodeGraphCheckpointRecordV1): readonly string[] {
  switch (record.kind) {
    case 'file':
      return [record.path];
    case 'file-fact':
      return [record.path, record.cacheIdentity];
    case 'workspace-scope':
    case 'workspace-component':
    case 'symbol':
    case 'edge':
    case 'moniker':
    case 'pack-provenance':
      return [record.id];
    case 'workspace-dependency':
      return [record.sourceComponentId, record.targetComponentId, record.provenance];
    case 'workspace-external-dependency':
      return [
        record.sourceComponentId,
        record.ecosystem,
        record.packageName,
        record.importAlias,
        record.dependencyKind,
        record.versionConstraint,
        record.evidencePath,
      ];
    case 'symbol-lookup':
      return [record.lookupKey, record.symbolId];
    case 'reexport':
      return [record.sourcePath, record.localName, record.targetPath, record.importedName];
    case 'lexical':
      return [record.term, record.symbolId];
  }
}

export function compareCodeGraphCheckpointRecords(
  left: CodeGraphCheckpointRecordV1,
  right: CodeGraphCheckpointRecordV1,
): number {
  return compareCodeGraphCheckpointRecordOrderKeys(
    codeGraphCheckpointRecordOrderKey(left),
    codeGraphCheckpointRecordOrderKey(right),
  );
}

export function codeGraphCheckpointRecordOrderKey(
  record: CodeGraphCheckpointRecordV1,
): CodeGraphCheckpointRecordOrderKeyV1 {
  return {identity: codeGraphCheckpointRecordIdentityTuple(record), kind: record.kind};
}

export function compareCodeGraphCheckpointRecordOrderKeys(
  left: CodeGraphCheckpointRecordOrderKeyV1,
  right: CodeGraphCheckpointRecordOrderKeyV1,
): number {
  const kind = RECORD_KIND_ORDER.get(left.kind)! - RECORD_KIND_ORDER.get(right.kind)!;
  if (kind !== 0) return kind;
  for (let index = 0; index < left.identity.length; index += 1) {
    const order = compareUtf8(left.identity[index]!, right.identity[index]!);
    if (order !== 0) return order;
  }
  return left.identity.length - right.identity.length;
}

export function isSafeCodeGraphCheckpointPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_PATH_LENGTH ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    containsControlCharacter(value)
  ) {
    return false;
  }
  return !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseAbiInput(value: unknown): CodeGraphCheckpointAbiInputV1 {
  const input = object(value, 'Checkpoint ABI input');
  exactKeys(
    input,
    [
      'checkpointSemanticVersion',
      'graphSchemaVersion',
      'inventoryPolicyVersion',
      'languagePacks',
      'lexicalLogicalFormatVersion',
      'pathPolicy',
      'referenceResolutionVersion',
      'workspaceModelVersion',
    ],
    [],
    'Checkpoint ABI input',
  );
  literal(input.checkpointSemanticVersion, CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION, 'Checkpoint semantic version');
  nonNegativeInteger(input.graphSchemaVersion, 'Graph schema version');
  nonNegativeInteger(input.inventoryPolicyVersion, 'Inventory policy version');
  const languagePacks = array(input.languagePacks, 'ABI language packs').map(parseLanguagePack);
  ensureSortedUnique(languagePacks, pack => pack.id, 'ABI language packs');
  nonNegativeInteger(input.lexicalLogicalFormatVersion, 'Lexical logical format version');
  literal(input.pathPolicy, CODE_GRAPH_CHECKPOINT_PATH_POLICY, 'Checkpoint path policy');
  shortText(input.referenceResolutionVersion, 'Reference resolution version');
  shortText(input.workspaceModelVersion, 'Workspace model version');
  return input as unknown as CodeGraphCheckpointAbiInputV1;
}

function parseAbi(value: unknown): CodeGraphCheckpointAbiV1 {
  const input = object(value, 'Checkpoint ABI');
  exactKeys(input, ['algorithm', 'digest', 'input'], [], 'Checkpoint ABI');
  literal(input.algorithm, 'sha256', 'Checkpoint ABI algorithm');
  sha256(input.digest, 'Checkpoint ABI digest');
  return {algorithm: 'sha256', digest: input.digest as string, input: parseAbiInput(input.input)};
}

function parseLanguagePack(value: unknown): CodeGraphCheckpointLanguagePackV1 {
  const input = object(value, 'ABI language pack');
  exactKeys(
    input,
    ['cacheIdentity', 'derivationIdentity', 'id', 'resolutionDomain', 'resolutionVersion'],
    [],
    'ABI language pack',
  );
  sha256(input.cacheIdentity, 'Language-pack cache identity');
  sha256(input.derivationIdentity, 'Language-pack derivation identity');
  shortText(input.id, 'Language-pack ID');
  shortText(input.resolutionDomain, 'Language-pack resolution domain');
  shortText(input.resolutionVersion, 'Language-pack resolution version');
  return input as unknown as CodeGraphCheckpointLanguagePackV1;
}

function parseRepository(value: unknown): CodeGraphCheckpointMetadataV1['repository'] {
  const input = object(value, 'Checkpoint repository');
  exactKeys(input, ['caseMode', 'displayName', 'objectFormat', 'repositoryId'], [], 'Checkpoint repository');
  oneOf(input.caseMode, ['insensitive', 'sensitive'], 'Repository case mode');
  shortText(input.displayName, 'Repository display name');
  oneOf(input.objectFormat, ['sha1', 'sha256'], 'Repository object format');
  sha256(input.repositoryId, 'Repository ID');
  return input as unknown as CodeGraphCheckpointMetadataV1['repository'];
}

function parseSource(value: unknown): CodeGraphCheckpointMetadataV1['source'] {
  const input = object(value, 'Checkpoint source');
  exactKeys(input, ['commit', 'extractorSet', 'graphContentId'], [], 'Checkpoint source');
  gitObjectId(input.commit, 'Checkpoint commit');
  shortText(input.extractorSet, 'Checkpoint extractor set');
  if (typeof input.graphContentId !== 'string' || !GRAPH_CONTENT_ID.test(input.graphContentId)) {
    throw new CodeGraphCheckpointSchemaError('Checkpoint graph content ID is invalid.');
  }
  return input as unknown as CodeGraphCheckpointMetadataV1['source'];
}

function parseCoverage(value: unknown): CodeGraphCheckpointCoverageV1 {
  const input = object(value, 'Checkpoint coverage');
  exactKeys(input, ['eligibleFiles', 'excludedFiles', 'reasons', 'state'], [], 'Checkpoint coverage');
  nonNegativeInteger(input.eligibleFiles, 'Coverage eligible files');
  nonNegativeInteger(input.excludedFiles, 'Coverage excluded files');
  const reasons = array(input.reasons, 'Coverage reasons').map(reason => {
    const candidate = object(reason, 'Coverage reason');
    exactKeys(candidate, ['bytes', 'code', 'files'], [], 'Coverage reason');
    nonNegativeInteger(candidate.bytes, 'Coverage reason bytes');
    shortText(candidate.code, 'Coverage reason code');
    nonNegativeInteger(candidate.files, 'Coverage reason files');
    return candidate as unknown as CodeGraphCheckpointCoverageReasonV1;
  });
  ensureSortedUnique(reasons, reason => reason.code, 'Coverage reasons');
  oneOf(input.state, ['complete', 'partial'], 'Coverage state');
  const explainedFiles = checkedSum(
    reasons.map(reason => reason.files),
    'Coverage reason file count',
  );
  if (explainedFiles !== input.excludedFiles) {
    throw new CodeGraphCheckpointSchemaError('Coverage reasons do not account for every excluded file.');
  }
  if ((input.excludedFiles === 0) !== (input.state === 'complete')) {
    throw new CodeGraphCheckpointSchemaError('Coverage state does not match the excluded-file count.');
  }
  return input as unknown as CodeGraphCheckpointCoverageV1;
}

function parseReuse(value: unknown): CodeGraphCheckpointReuseV1 {
  const input = object(value, 'Checkpoint reuse');
  exactKeys(
    input,
    ['fileSetFingerprint', 'formatVersion', 'resolutionSurfaceVersion', 'workspaceFingerprint'],
    ['inventory'],
    'Checkpoint reuse',
  );
  sha256(input.fileSetFingerprint, 'Reuse file-set fingerprint');
  positiveInteger(input.formatVersion, 'Reuse format version');
  positiveInteger(input.resolutionSurfaceVersion, 'Reuse resolution-surface version');
  sha256(input.workspaceFingerprint, 'Reuse workspace fingerprint');
  if (input.inventory !== undefined) {
    const inventory = parsePortableInventory(input.inventory);
    if (inventory.workspace.fingerprint !== input.workspaceFingerprint) {
      throw new CodeGraphCheckpointSchemaError('Portable workspace fingerprint does not match reuse metadata.');
    }
  }
  return input as unknown as CodeGraphCheckpointReuseV1;
}

function parsePortableInventory(value: unknown): CodeGraphCheckpointPortableInventoryV1 {
  const input = object(value, 'Portable inventory');
  exactKeys(
    input,
    [
      'attributionFiles',
      'contract',
      'includeOpaqueCorpusAssets',
      'policyExclusions',
      'skipped',
      'version',
      'workspace',
    ],
    ['diagnostics'],
    'Portable inventory',
  );
  const attributionFiles = array(input.attributionFiles, 'Attribution files').map(parseAttributionFile);
  if (attributionFiles.length > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM) {
    throw new CodeGraphCheckpointSchemaError('Attribution file count exceeds the portable boundary.');
  }
  ensureSortedUnique(attributionFiles, file => file.path, 'Attribution files');
  const attributionContentBytes = checkedSum(
    attributionFiles.map(file => file.size),
    'Attribution compact content bytes',
  );
  const attributionSourceBytes = checkedSum(
    attributionFiles.map(file => file.blobSize),
    'Attribution source bytes',
  );
  if (
    attributionContentBytes > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM ||
    attributionSourceBytes > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM
  ) {
    throw new CodeGraphCheckpointSchemaError('Attribution context exceeds the portable byte boundary.');
  }
  sha256(input.contract, 'Inventory contract');
  if (input.diagnostics !== undefined) stringArray(input.diagnostics, 'Inventory diagnostics');
  boolean(input.includeOpaqueCorpusAssets, 'Inventory opaque-corpus policy');
  parsePolicyExclusions(input.policyExclusions);
  nonNegativeInteger(input.skipped, 'Inventory skipped files');
  positiveInteger(input.version, 'Inventory version');
  parseWorkspace(input.workspace);
  return input as unknown as CodeGraphCheckpointPortableInventoryV1;
}

function parseAttributionFile(value: unknown): CodeGraphCheckpointAttributionFileV1 {
  const input = object(value, 'Attribution file');
  exactKeys(
    input,
    ['blobId', 'blobSize', 'contentHash', 'language', 'mode', 'path', 'size', 'source'],
    [],
    'Attribution file',
  );
  gitObjectId(input.blobId, 'Attribution blob ID');
  nonNegativeInteger(input.blobSize, 'Attribution blob size');
  sha256(input.contentHash, 'Attribution content hash');
  shortText(input.language, 'Attribution language');
  mode(input.mode, 'Attribution mode');
  repositoryPath(input.path, 'Attribution path');
  nonNegativeInteger(input.size, 'Attribution size');
  literal(input.source, 'commit', 'Attribution source');
  return input as unknown as CodeGraphCheckpointAttributionFileV1;
}

function parsePolicyExclusions(value: unknown): CodeGraphCheckpointPolicyExclusionsV1 {
  const input = object(value, 'Policy exclusions');
  exactKeys(input, ['bytes', 'files', 'policyVersion', 'reasons'], [], 'Policy exclusions');
  nonNegativeInteger(input.bytes, 'Policy exclusion bytes');
  nonNegativeInteger(input.files, 'Policy exclusion files');
  positiveInteger(input.policyVersion, 'Policy exclusion version');
  const reasons = array(input.reasons, 'Policy exclusion reasons').map(value => {
    const reason = object(value, 'Policy exclusion reason');
    exactKeys(reason, ['bytes', 'files', 'reason'], [], 'Policy exclusion reason');
    nonNegativeInteger(reason.bytes, 'Policy exclusion reason bytes');
    nonNegativeInteger(reason.files, 'Policy exclusion reason files');
    shortText(reason.reason, 'Policy exclusion reason');
    return reason as unknown as CodeGraphCheckpointPolicyExclusionReasonV1;
  });
  ensureSortedUnique(reasons, reason => reason.reason, 'Policy exclusion reasons');
  return input as unknown as CodeGraphCheckpointPolicyExclusionsV1;
}

function parseWorkspace(value: unknown): CodeGraphWorkspace {
  const input = object(value, 'Portable workspace');
  exactKeys(input, ['diagnostics', 'fingerprint', 'projects', 'workspaces'], [], 'Portable workspace');
  stringArray(input.diagnostics, 'Workspace diagnostics');
  sha256(input.fingerprint, 'Workspace fingerprint');
  const projects = array(input.projects, 'Workspace projects');
  const workspaces = array(input.workspaces, 'Build workspaces');
  for (const project of projects) parseWorkspaceProject(project);
  for (const workspace of workspaces) parseBuildWorkspace(workspace);
  ensureSortedUnique(
    projects.map(project => project as {readonly id: string}),
    project => project.id,
    'Workspace projects',
  );
  ensureSortedUnique(
    workspaces.map(workspace => workspace as {readonly id: string}),
    workspace => workspace.id,
    'Build workspaces',
  );
  canonicalJson(input);
  return input as unknown as CodeGraphWorkspace;
}

function parseWorkspaceProject(value: unknown): void {
  const input = object(value, 'Workspace project');
  exactKeys(
    input,
    [
      'buildSystem',
      'dependencies',
      'dependencyDetails',
      'diagnostics',
      'id',
      'kind',
      'languages',
      'name',
      'provenance',
      'resolutionDomain',
      'root',
      'sourceRoots',
      'workspaceId',
      'workspaceRoots',
    ],
    ['externalDependencies', 'monikers'],
    'Workspace project',
  );
  workspaceBuildSystem(input.buildSystem, 'Project build system');
  stringArray(input.dependencies, 'Project dependencies');
  for (const detail of array(input.dependencyDetails, 'Project dependency details')) {
    const candidate = object(detail, 'Project dependency detail');
    exactKeys(candidate, ['provenance', 'targetId'], ['evidence'], 'Project dependency detail');
    workspaceProvenance(candidate.provenance, 'Project dependency provenance');
    shortText(candidate.targetId, 'Project dependency target');
    optionalShortText(candidate.evidence, 'Project dependency evidence');
  }
  stringArray(input.diagnostics, 'Project diagnostics');
  shortText(input.id, 'Project ID');
  oneOf(input.kind, ['module', 'package', 'project', 'target'], 'Project kind');
  stringArray(input.languages, 'Project languages');
  shortText(input.name, 'Project name');
  workspaceProvenance(input.provenance, 'Project provenance');
  shortText(input.resolutionDomain, 'Project resolution domain');
  workspaceRoot(input.root, 'Project root');
  pathArray(input.sourceRoots, 'Project source roots', true);
  shortText(input.workspaceId, 'Project workspace ID');
  pathArray(input.workspaceRoots, 'Project workspace roots', true);
  if (input.externalDependencies !== undefined) {
    for (const dependency of array(input.externalDependencies, 'Project external dependencies')) {
      const candidate = object(dependency, 'Project external dependency');
      exactKeys(
        candidate,
        ['ecosystem', 'evidence', 'importAlias', 'kind', 'name', 'versionConstraint'],
        [],
        'Project external dependency',
      );
      literal(candidate.ecosystem, 'npm', 'Project external dependency ecosystem');
      const evidence = object(candidate.evidence, 'Project external dependency evidence');
      exactKeys(evidence, ['path'], ['span'], 'Project external dependency evidence');
      repositoryPath(evidence.path, 'Project external dependency path');
      if (evidence.span !== undefined) parseSpan(evidence.span, 'Project external dependency span');
      shortText(candidate.importAlias, 'Project external dependency alias');
      dependencyKind(candidate.kind, 'Project external dependency kind');
      shortText(candidate.name, 'Project external dependency name');
      shortText(candidate.versionConstraint, 'Project external dependency version');
    }
  }
  if (input.monikers !== undefined) {
    for (const moniker of array(input.monikers, 'Project monikers')) canonicalJson(moniker);
  }
}

function parseBuildWorkspace(value: unknown): void {
  const input = object(value, 'Build workspace');
  exactKeys(input, ['buildSystem', 'diagnostics', 'id', 'name', 'provenance', 'root'], [], 'Build workspace');
  workspaceBuildSystem(input.buildSystem, 'Build workspace system');
  stringArray(input.diagnostics, 'Build workspace diagnostics');
  shortText(input.id, 'Build workspace ID');
  workspaceName(input.name, input.root, 'Build workspace name');
  workspaceProvenance(input.provenance, 'Build workspace provenance');
  workspaceRoot(input.root, 'Build workspace root');
}

function parseChunk(value: unknown, expectedOrdinal: number): CodeGraphCheckpointChunkDescriptorV1 {
  const input = object(value, 'Checkpoint chunk');
  exactKeys(
    input,
    ['compressedBytes', 'digest', 'ordinal', 'recordCount', 'uncompressedBytes'],
    [],
    'Checkpoint chunk',
  );
  positiveInteger(input.compressedBytes, 'Chunk compressed bytes');
  const digest = parseDigest(input.digest, 'Chunk digest');
  nonNegativeInteger(input.ordinal, 'Chunk ordinal');
  if (input.ordinal !== expectedOrdinal) throw new CodeGraphCheckpointSchemaError('Chunk ordinals are not contiguous.');
  positiveInteger(input.recordCount, 'Chunk record count');
  positiveInteger(input.uncompressedBytes, 'Chunk uncompressed bytes');
  return {...(input as unknown as Omit<CodeGraphCheckpointChunkDescriptorV1, 'digest'>), digest};
}

function parseCounts(value: unknown): CodeGraphCheckpointCountsV1 {
  const input = object(value, 'Checkpoint counts');
  exactKeys(input, [...CODE_GRAPH_CHECKPOINT_RECORD_KINDS], [], 'Checkpoint counts');
  for (const kind of CODE_GRAPH_CHECKPOINT_RECORD_KINDS) nonNegativeInteger(input[kind], `${kind} count`);
  return input as CodeGraphCheckpointCountsV1;
}

function parseDigest(value: unknown, label: string): CodeGraphCheckpointDigestV1 {
  const input = object(value, label);
  exactKeys(input, ['algorithm', 'digest'], [], label);
  literal(input.algorithm, 'sha256', `${label} algorithm`);
  sha256(input.digest, label);
  return input as unknown as CodeGraphCheckpointDigestV1;
}

function parseFileFacts(value: unknown, expectedPath: string): CodeGraphFileFacts {
  let facts: CodeGraphFileFacts;
  try {
    facts = parseCodeGraphFileFacts(value);
  } catch (cause) {
    throw new CodeGraphCheckpointSchemaError('File-fact payload is invalid.', {cause});
  }
  if (facts.path !== expectedPath)
    throw new CodeGraphCheckpointSchemaError('File-fact payload path does not match its key.');
  canonicalJson(facts);
  return facts;
}

function parseSymbol(input: Record<string, unknown>): void {
  exactKeys(
    input,
    ['contentHash', 'exported', 'id', 'kind', 'language', 'name', 'path', 'qualifiedName', 'span', 'symbolKind'],
    ['arity', 'documentation', 'lookupKeys', 'packageName', 'resolutionDomain', 'resolutionScopeId', 'signature'],
    'Symbol record',
  );
  optionalNonNegativeInteger(input.arity, 'Symbol arity');
  sha256(input.contentHash, 'Symbol content hash');
  optionalText(input.documentation, 'Symbol documentation');
  boolean(input.exported, 'Symbol exported');
  shortText(input.id, 'Symbol ID');
  shortText(input.language, 'Symbol language');
  if (input.lookupKeys !== undefined) stringArray(input.lookupKeys, 'Symbol lookup keys');
  shortText(input.name, 'Symbol name');
  optionalShortText(input.packageName, 'Symbol package name');
  repositoryPath(input.path, 'Symbol path');
  shortText(input.qualifiedName, 'Symbol qualified name');
  optionalShortText(input.resolutionDomain, 'Symbol resolution domain');
  optionalShortText(input.resolutionScopeId, 'Symbol resolution scope');
  optionalText(input.signature, 'Symbol signature');
  parseSpan(input.span, 'Symbol span');
  shortText(input.symbolKind, 'Symbol kind');
}

function parseEdge(input: Record<string, unknown>): void {
  exactKeys(
    input,
    ['confidence', 'evidencePath', 'evidenceSpan', 'id', 'kind', 'provenance', 'relation', 'sourceName', 'targetName'],
    ['sourceId', 'targetId'],
    'Edge record',
  );
  finiteRange(input.confidence, 'Edge confidence', 0, 1);
  repositoryPath(input.evidencePath, 'Edge evidence path');
  parseSpan(input.evidenceSpan, 'Edge evidence span');
  shortText(input.id, 'Edge ID');
  oneOf(input.provenance, ['declared', 'heuristic', 'model', 'resolved', 'syntactic'], 'Edge provenance');
  oneOf(
    input.relation,
    [
      'calls',
      'configures',
      'constructs',
      'contains',
      'declares',
      'depends_on',
      'documents',
      'exports',
      'extends',
      'implements',
      'imports',
      'overrides',
      'reads_or_writes',
      'references',
      'reexports',
      'semantic_association',
      'tests',
    ],
    'Edge relation',
  );
  optionalShortText(input.sourceId, 'Edge source ID');
  shortText(input.sourceName, 'Edge source name');
  optionalShortText(input.targetId, 'Edge target ID');
  shortText(input.targetName, 'Edge target name');
}

function parseMoniker(input: Record<string, unknown>): void {
  exactKeys(
    input,
    [
      'evidencePath',
      'evidenceSpan',
      'id',
      'identity',
      'kind',
      'monikerKind',
      'resolutionDomain',
      'role',
      'scheme',
      'version',
    ],
    ['componentId', 'dependencyKind', 'importPath', 'packageName', 'packageVersion', 'qualifiedName', 'symbolId'],
    'Moniker record',
  );
  optionalShortText(input.componentId, 'Moniker component ID');
  if (input.dependencyKind !== undefined) dependencyKind(input.dependencyKind, 'Moniker dependency kind');
  repositoryPath(input.evidencePath, 'Moniker evidence path');
  parseSpan(input.evidenceSpan, 'Moniker evidence span');
  shortText(input.id, 'Moniker ID');
  shortText(input.identity, 'Moniker identity');
  if (input.importPath !== undefined) repositoryPath(input.importPath, 'Moniker import path');
  shortText(input.monikerKind, 'Moniker kind');
  optionalShortText(input.packageName, 'Moniker package name');
  optionalShortText(input.packageVersion, 'Moniker package version');
  optionalShortText(input.qualifiedName, 'Moniker qualified name');
  shortText(input.resolutionDomain, 'Moniker resolution domain');
  oneOf(input.role, ['export', 'import'], 'Moniker role');
  oneOf(input.scheme, ['package', 'protobuf'], 'Moniker scheme');
  optionalShortText(input.symbolId, 'Moniker symbol ID');
  positiveInteger(input.version, 'Moniker version');
  if (input.scheme === 'package' && (input.componentId === undefined || input.packageName === undefined)) {
    throw new CodeGraphCheckpointSchemaError('Package moniker is missing component or package identity.');
  }
  if (input.scheme === 'protobuf' && input.symbolId === undefined) {
    throw new CodeGraphCheckpointSchemaError('Protobuf moniker is missing its symbol identity.');
  }
}

function parseSpan(value: unknown, label: string): CodeGraphCheckpointSpanV1 {
  const input = object(value, label);
  exactKeys(input, ['column', 'endColumn', 'endLine', 'line'], [], label);
  positiveInteger(input.column, `${label} column`);
  positiveInteger(input.endColumn, `${label} end column`);
  positiveInteger(input.endLine, `${label} end line`);
  positiveInteger(input.line, `${label} line`);
  if (
    (input.endLine as number) < (input.line as number) ||
    (input.endLine === input.line && (input.endColumn as number) < (input.column as number))
  ) {
    throw new CodeGraphCheckpointSchemaError(`${label} ends before it starts.`);
  }
  return input as unknown as CodeGraphCheckpointSpanV1;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_ARRAY_LENGTH) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a bounded array.`);
  }
  return value;
}

function exactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(input, key)) throw new CodeGraphCheckpointSchemaError(`${label} is missing ${key}.`);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new CodeGraphCheckpointSchemaError(`${label} contains unknown field ${key}.`);
  }
}

function literal<T extends boolean | number | string>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) throw new CodeGraphCheckpointSchemaError(`${label} is invalid.`);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
  label: string,
): asserts value is T[number] {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    throw new CodeGraphCheckpointSchemaError(`${label} is invalid.`);
  }
}

function text(value: unknown, label: string, maximum = 8 * 1_048_576): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a bounded string.`);
  }
  return value;
}

function shortText(value: unknown, label: string): string {
  const result = text(value, label, MAXIMUM_SHORT_TEXT_LENGTH);
  if (result.length === 0) throw new CodeGraphCheckpointSchemaError(`${label} cannot be empty.`);
  return result;
}

function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label);
}

function optionalShortText(value: unknown, label: string): void {
  if (value !== undefined) shortText(value, label);
}

function boolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new CodeGraphCheckpointSchemaError(`${label} must be boolean.`);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a non-negative safe integer.`);
  }
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a bounded positive safe integer.`);
  }
}

function optionalNonNegativeInteger(value: unknown, label: string): void {
  if (value !== undefined) nonNegativeInteger(value, label);
}

function finiteRange(value: unknown, label: string, minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a finite number between ${minimum} and ${maximum}.`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function optionalSha256(value: unknown, label: string): void {
  if (value !== undefined) sha256(value, label);
}

function gitObjectId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a lowercase Git object ID.`);
  }
}

function mode(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^\d{6}$/u.test(value)) {
    throw new CodeGraphCheckpointSchemaError(`${label} is invalid.`);
  }
}

function repositoryPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !isSafeCodeGraphCheckpointPath(value)) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a safe repository-relative POSIX path.`);
  }
}

function workspaceRoot(value: unknown, label: string): void {
  // The workspace model uses the empty repository-relative path as its
  // canonical repository root. Keep `.` readable for older/projected models,
  // but never rewrite either representation at the checkpoint boundary.
  if (value !== '' && value !== '.' && (typeof value !== 'string' || !isSafeCodeGraphCheckpointPath(value))) {
    throw new CodeGraphCheckpointSchemaError(`${label} must be a safe repository-relative POSIX root.`);
  }
}

function workspaceName(value: unknown, root: unknown, label: string): void {
  // Existing workspace receipts represent the repository-wide build scope as
  // the pair {root: '', name: ''}. Admit only that paired empty identity;
  // nested workspace names remain non-empty bounded text.
  if (value === '' && root === '') return;
  shortText(value, label);
}

function stringArray(value: unknown, label: string): void {
  for (const entry of array(value, label)) text(entry, `${label} entry`, MAXIMUM_SHORT_TEXT_LENGTH);
}

function pathArray(value: unknown, label: string, allowRoot: boolean): void {
  for (const entry of array(value, label)) {
    if (allowRoot) workspaceRoot(entry, `${label} entry`);
    else repositoryPath(entry, `${label} entry`);
  }
}

function workspaceBuildSystem(value: unknown, label: string): void {
  oneOf(value, ['bazel', 'gradle', 'inferred', 'maven', 'node', 'nx', 'pnpm', 'swiftpm', 'typescript', 'xcode'], label);
}

function workspaceProvenance(value: unknown, label: string): void {
  oneOf(value, ['declared', 'inferred'], label);
}

function dependencyKind(value: unknown, label: string): void {
  oneOf(value, ['development', 'optional', 'peer', 'runtime'], label);
}

function ensureSortedUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  let previous: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (previous !== undefined && current <= previous) {
      throw new CodeGraphCheckpointSchemaError(`${label} must be strictly sorted and unique.`);
    }
    previous = current;
  }
}

function checkedSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) throw new CodeGraphCheckpointSchemaError(`${label} overflows.`);
    total += value;
  }
  return total;
}

function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}
