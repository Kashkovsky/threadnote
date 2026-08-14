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
  if (symbol.exported) return true;
  for (const key of symbol.lookupKeys ?? []) {
    if (!isOwnTypeScriptPathLookupKey(key, symbol)) return true;
  }
  return false;
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

function isOwnTypeScriptPathLookupKey(key: string, symbol: CodeGraphResolutionSurfaceSymbol): boolean {
  if (symbol.resolutionDomain !== 'typescript') return false;
  const match =
    /^typescript:(?:([^:]+):)?path:([^:]+):(?:name|qualified):[^:]+(?::(?:arity:\d+|implementation|merge-canonical))?$/.exec(
      key,
    );
  if (!match) return false;
  if (match[1] !== symbol.resolutionScopeId) return false;
  try {
    return decodeURIComponent(match[2]!) === symbol.path;
  } catch {
    return false;
  }
}
