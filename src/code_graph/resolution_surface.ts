import type {CodeGraphSymbol} from './types.js';

export type CodeGraphResolutionSurfaceSymbol = Pick<
  CodeGraphSymbol,
  | 'arity'
  | 'exported'
  | 'id'
  | 'kind'
  | 'language'
  | 'lookupKeys'
  | 'name'
  | 'packageName'
  | 'path'
  | 'qualifiedName'
  | 'resolutionDomain'
  | 'resolutionScopeId'
>;

export type CodeGraphResolutionPublicationGate =
  'exported' | 'non-typescript-domain' | 'own-path-local' | 'unknown-lookup-form' | 'foreign-path' | 'scope-mismatch';

export type CodeGraphResolutionLookupKeyForm =
  'none' | 'non-typescript' | 'typescript-other' | 'typescript-path-scoped' | 'typescript-path-unscoped';

export interface CodeGraphResolutionPublicationAssessment {
  /** Closed, path-free gate suitable for anonymous build telemetry. */
  readonly gate: CodeGraphResolutionPublicationGate;
  /** Closed lookup-key shape; never contains a symbol, scope, or repository path. */
  readonly lookupKeyForm: CodeGraphResolutionLookupKeyForm;
  readonly published: boolean;
}

export function hasSameCodeGraphResolutionSurface(
  left: readonly CodeGraphResolutionSurfaceSymbol[],
  right: readonly CodeGraphResolutionSurfaceSymbol[],
): boolean {
  const leftById = new Map<string, string>();
  const leftIds = new Set<string>();
  for (const symbol of left) {
    if (leftIds.has(symbol.id)) return false;
    leftIds.add(symbol.id);
    if (!isPublishedCodeGraphResolutionSymbol(symbol)) continue;
    leftById.set(symbol.id, symbolResolutionSurface(symbol));
  }
  const rightIds = new Set<string>();
  let rightPublishedCount = 0;
  for (const symbol of right) {
    if (rightIds.has(symbol.id)) return false;
    rightIds.add(symbol.id);
    if (!isPublishedCodeGraphResolutionSymbol(symbol)) continue;
    rightPublishedCount += 1;
    if (leftById.get(symbol.id) !== symbolResolutionSurface(symbol)) return false;
  }
  return leftById.size === rightPublishedCount;
}

/**
 * Published symbols can participate in lookup from outside the file whose
 * facts an overlay replaces. Unknown and non-path-local lookup-key forms fail
 * closed as published.
 */
export function isPublishedCodeGraphResolutionSymbol(symbol: CodeGraphResolutionSurfaceSymbol): boolean {
  return assessCodeGraphResolutionSymbolPublication(symbol).published;
}

/**
 * Classifies publication using only resolver lookup tiers. The closed gate and
 * key form intentionally expose enough evidence to diagnose fail-closed
 * fallbacks without recording paths, symbol names, or project identifiers.
 */
export function assessCodeGraphResolutionSymbolPublication(
  symbol: CodeGraphResolutionSurfaceSymbol,
): CodeGraphResolutionPublicationAssessment {
  if (symbol.exported) {
    return {gate: 'exported', lookupKeyForm: firstLookupKeyForm(symbol), published: true};
  }
  if (symbol.resolutionDomain !== 'typescript') {
    return {
      gate: 'non-typescript-domain',
      lookupKeyForm: symbol.lookupKeys?.length ? 'non-typescript' : 'none',
      published: true,
    };
  }
  let lookupKeyForm: CodeGraphResolutionLookupKeyForm = 'none';
  for (const key of symbol.lookupKeys ?? []) {
    const assessment = assessOwnTypeScriptPathLookupKey(key, symbol);
    lookupKeyForm = assessment.lookupKeyForm;
    if (assessment.gate !== 'own-path-local') {
      return {gate: assessment.gate, lookupKeyForm, published: true};
    }
  }
  return {gate: 'own-path-local', lookupKeyForm, published: false};
}

function symbolResolutionSurface(symbol: CodeGraphResolutionSurfaceSymbol): string {
  // Signature, content, documentation, and spans are replaced with the changed file's facts but do not affect
  // cross-file endpoint resolution. File-local unpublished declarations are replaced with the changed file too;
  // the current resolver's published lookup contract is serialized below.
  return JSON.stringify({
    arity: symbol.arity,
    exported: symbol.exported,
    id: symbol.id,
    kind: symbol.kind,
    language: symbol.language,
    lookupKeys: symbol.lookupKeys ?? [],
    name: symbol.name,
    packageName: symbol.packageName,
    path: symbol.path,
    qualifiedName: symbol.qualifiedName,
    resolutionDomain: symbol.resolutionDomain,
    resolutionScopeId: symbol.resolutionScopeId,
  });
}

function assessOwnTypeScriptPathLookupKey(
  key: string,
  symbol: CodeGraphResolutionSurfaceSymbol,
): Pick<CodeGraphResolutionPublicationAssessment, 'gate' | 'lookupKeyForm'> {
  const match =
    /^typescript:(?:([^:]+):)?path:([^:]+):(?:name|qualified):[^:]+(?::(?:arity:\d+|implementation|merge-canonical))?$/.exec(
      key,
    );
  if (!match) return {gate: 'unknown-lookup-form', lookupKeyForm: 'typescript-other'};
  const lookupKeyForm = match[1] === undefined ? 'typescript-path-unscoped' : 'typescript-path-scoped';
  if (match[1] !== undefined && match[1] !== symbol.resolutionScopeId) {
    return {gate: 'scope-mismatch', lookupKeyForm};
  }
  try {
    return decodeURIComponent(match[2]!) === symbol.path
      ? {gate: 'own-path-local', lookupKeyForm}
      : {gate: 'foreign-path', lookupKeyForm};
  } catch {
    return {gate: 'unknown-lookup-form', lookupKeyForm};
  }
}

function firstLookupKeyForm(symbol: CodeGraphResolutionSurfaceSymbol): CodeGraphResolutionLookupKeyForm {
  const key = symbol.lookupKeys?.[0];
  if (key === undefined) return 'none';
  if (symbol.resolutionDomain !== 'typescript') return 'non-typescript';
  if (/^typescript:path:/.test(key)) return 'typescript-path-unscoped';
  if (/^typescript:[^:]+:path:/.test(key)) return 'typescript-path-scoped';
  return 'typescript-other';
}
