import {sha256HexSync} from '../../crypto/sha256.js';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationIdentityV1,
  type CodeGraphWorksetCatalogGenerationDigestMemberV1,
  type CodeGraphWorksetCatalogGenerationMemberV1,
  type CodeGraphWorksetRoutingProjectionDraftV1,
  type CodeGraphWorksetRoutingProjectionV1,
  type CodeGraphWorksetRoutingSymbolV1,
} from './types.js';

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const NODE_ID = /^cgs_[0-9a-f]{40}$/u;

export function createCodeGraphWorksetRoutingProjection(
  input: CodeGraphWorksetRoutingProjectionDraftV1,
): CodeGraphWorksetRoutingProjectionV1 {
  const normalized = normalizeProjectionDraft(input);
  return {...normalized, projectionDigest: codeGraphWorksetRoutingProjectionDigest(normalized)};
}

export function validateCodeGraphWorksetRoutingProjection(
  input: CodeGraphWorksetRoutingProjectionV1,
): CodeGraphWorksetRoutingProjectionV1 {
  assertSha256(input.projectionDigest, 'projection digest');
  const normalized = normalizeProjectionDraft(input);
  const digest = codeGraphWorksetRoutingProjectionDigest(normalized);
  if (digest !== input.projectionDigest) {
    throw invalid('Workset routing projection digest does not match its normalized records.');
  }
  return {...normalized, projectionDigest: digest};
}

export function codeGraphWorksetRoutingProjectionDigest(input: CodeGraphWorksetRoutingProjectionDraftV1): string {
  const normalized = normalizeProjectionDraft(input);
  return sha256HexSync(
    JSON.stringify([
      'threadnote-workset-routing-projection-v1',
      normalized.repositoryId,
      normalized.checkoutId,
      normalized.worktreeId,
      normalized.snapshotId,
      normalized.snapshotDigest,
      normalized.commitId,
      normalized.extractorGeneration,
      normalized.projectorVersion,
      normalized.componentCount,
      normalized.symbols.map(symbol => [
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
        symbol.lookupKeys,
        symbol.terms.map(term => [term.term, term.weight]),
      ]),
    ]),
  );
}

export function codeGraphWorksetCatalogGenerationIdentity(
  input: CodeGraphWorksetCatalogGenerationInputV1,
): CodeGraphWorksetCatalogGenerationIdentityV1 {
  const worksetName = boundedText(input.worksetName, 'workset name', 256);
  assertSha256(input.manifestDigest, 'manifest digest');
  if (input.members.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
    throw invalid('Workset catalog generation has too many members.');
  }
  const members = input.members.map(normalizeGenerationMember).sort(compareMember);
  const seenKeys = new Set<string>();
  for (const member of members) {
    if (seenKeys.has(member.repositoryKey)) {
      throw invalid(`Workset catalog repository key ${member.repositoryKey} is duplicated.`);
    }
    seenKeys.add(member.repositoryKey);
  }
  const digest = codeGraphWorksetCatalogGenerationDigest(
    worksetName,
    input.manifestDigest,
    members.map(member => ({
      projectionDigest: member.projection.projectionDigest,
      repositoryId: member.projection.repositoryId,
      repositoryKey: member.repositoryKey,
      snapshotId: member.projection.snapshotId,
    })),
  );
  return {digest, id: `cgwg_${digest.slice(0, 40)}`, members};
}

export function codeGraphWorksetCatalogGenerationDigest(
  worksetName: string,
  manifestDigest: string,
  members: readonly CodeGraphWorksetCatalogGenerationDigestMemberV1[],
): string {
  const normalizedName = boundedText(worksetName, 'workset name', 256);
  assertSha256(manifestDigest, 'manifest digest');
  if (members.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration) {
    throw invalid('Workset catalog generation has too many members.');
  }
  const normalizedMembers = members
    .map(member => {
      assertSha256(member.repositoryId, 'repository identity');
      assertSha256(member.projectionDigest, 'projection digest');
      return {
        projectionDigest: member.projectionDigest,
        repositoryId: member.repositoryId,
        repositoryKey: boundedText(member.repositoryKey, 'repository key', 512),
        snapshotId: boundedText(member.snapshotId, 'snapshot identity', 256),
      };
    })
    .sort(
      (left, right) =>
        compareText(left.repositoryKey, right.repositoryKey) ||
        compareText(left.repositoryId, right.repositoryId) ||
        compareText(left.snapshotId, right.snapshotId) ||
        compareText(left.projectionDigest, right.projectionDigest),
    );
  for (let index = 1; index < normalizedMembers.length; index += 1) {
    if (normalizedMembers[index - 1]!.repositoryKey === normalizedMembers[index]!.repositoryKey) {
      throw invalid(`Workset catalog repository key ${normalizedMembers[index]!.repositoryKey} is duplicated.`);
    }
  }
  return sha256HexSync(
    JSON.stringify([
      'threadnote-workset-catalog-generation-v1',
      normalizedName,
      manifestDigest,
      normalizedMembers.map(member => [
        member.repositoryKey,
        member.repositoryId,
        member.snapshotId,
        member.projectionDigest,
      ]),
    ]),
  );
}

function normalizeGenerationMember(
  member: CodeGraphWorksetCatalogGenerationMemberV1,
): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {
    projection: validateCodeGraphWorksetRoutingProjection(member.projection),
    repositoryKey: boundedText(member.repositoryKey, 'repository key', 512),
  };
}

function normalizeProjectionDraft(
  input: CodeGraphWorksetRoutingProjectionDraftV1,
): CodeGraphWorksetRoutingProjectionDraftV1 {
  assertSha256(input.repositoryId, 'repository identity');
  assertSha256(input.checkoutId, 'checkout identity');
  assertSha256(input.worktreeId, 'worktree identity');
  assertSha256(input.snapshotDigest, 'snapshot digest');
  if (!COMMIT_ID.test(input.commitId)) throw invalid('Workset projection commit identity is invalid.');
  const snapshotId = boundedText(input.snapshotId, 'snapshot identity', 256);
  if (!Number.isSafeInteger(input.extractorGeneration) || input.extractorGeneration < 1) {
    throw invalid('Workset projection extractor generation is invalid.');
  }
  if (input.projectorVersion !== CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION) {
    throw invalid('Workset routing projection version is incompatible.');
  }
  if (!Number.isSafeInteger(input.componentCount) || input.componentCount < 0) {
    throw invalid('Workset projection component count is invalid.');
  }
  if (input.symbols.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.symbolsPerProjection) {
    throw invalid('Workset routing projection has too many symbols.');
  }
  const symbols = input.symbols.map(normalizeSymbol).sort((left, right) => compareText(left.nodeId, right.nodeId));
  for (let index = 1; index < symbols.length; index += 1) {
    if (symbols[index - 1]!.nodeId === symbols[index]!.nodeId) {
      throw invalid(`Workset routing symbol ${symbols[index]!.nodeId} is duplicated.`);
    }
  }
  return {
    checkoutId: input.checkoutId,
    commitId: input.commitId,
    componentCount: input.componentCount,
    extractorGeneration: input.extractorGeneration,
    projectorVersion: input.projectorVersion,
    repositoryId: input.repositoryId,
    snapshotDigest: input.snapshotDigest,
    snapshotId,
    symbols,
    worktreeId: input.worktreeId,
  };
}

function normalizeSymbol(symbol: CodeGraphWorksetRoutingSymbolV1): CodeGraphWorksetRoutingSymbolV1 {
  if (!NODE_ID.test(symbol.nodeId)) throw invalid('Workset routing node identity is invalid.');
  const path = repositoryRelativePath(symbol.path);
  const lookupKeys = [...new Set(symbol.lookupKeys.map(key => boundedText(key, 'lookup key', 2_048)))].sort(
    compareText,
  );
  if (lookupKeys.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.lookupKeysPerSymbol) {
    throw invalid(`Workset routing symbol ${symbol.nodeId} has too many lookup keys.`);
  }
  const terms = new Map<string, number>();
  for (const candidate of symbol.terms) {
    const term = boundedText(candidate.term, 'routing term', 256);
    if (!Number.isFinite(candidate.weight) || candidate.weight <= 0 || candidate.weight > 1_000) {
      throw invalid(`Workset routing symbol ${symbol.nodeId} has an invalid term weight.`);
    }
    terms.set(term, Math.max(terms.get(term) ?? 0, candidate.weight));
  }
  if (terms.size > CODE_GRAPH_WORKSET_CATALOG_LIMITS.termsPerSymbol) {
    throw invalid(`Workset routing symbol ${symbol.nodeId} has too many routing terms.`);
  }
  const span = symbol.span;
  if (
    ![span.line, span.column, span.endLine, span.endColumn].every(value => Number.isSafeInteger(value) && value >= 0) ||
    span.endLine < span.line ||
    (span.endLine === span.line && span.endColumn < span.column)
  ) {
    throw invalid(`Workset routing symbol ${symbol.nodeId} has an invalid evidence span.`);
  }
  return {
    exported: symbol.exported,
    kind: boundedText(symbol.kind, 'symbol kind', 256),
    language: boundedText(symbol.language, 'symbol language', 256),
    lookupKeys,
    name: boundedText(symbol.name, 'symbol name', 2_048),
    nodeId: symbol.nodeId,
    ...(symbol.packageName === undefined ? {} : {packageName: boundedText(symbol.packageName, 'package name', 2_048)}),
    path,
    qualifiedName: boundedText(symbol.qualifiedName, 'qualified symbol name', 4_096),
    span: {...span},
    terms: [...terms].sort(([left], [right]) => compareText(left, right)).map(([term, weight]) => ({term, weight})),
  };
}

function repositoryRelativePath(value: string): string {
  const path = boundedText(value, 'evidence path', 4_096);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/u.test(path) ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalid('Workset routing evidence path must be repository-relative and slash-normalized.');
  }
  return path;
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) throw invalid(`Workset ${label} is invalid.`);
}

function boundedText(value: string, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    containsControlCharacter(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalid(`Workset ${label} is invalid.`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function compareMember(
  left: CodeGraphWorksetCatalogGenerationMemberV1,
  right: CodeGraphWorksetCatalogGenerationMemberV1,
): number {
  return (
    compareText(left.repositoryKey, right.repositoryKey) ||
    compareText(left.projection.repositoryId, right.projection.repositoryId) ||
    compareText(left.projection.snapshotId, right.projection.snapshotId) ||
    compareText(left.projection.projectionDigest, right.projection.projectionDigest)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError('invalid-input', message);
}
