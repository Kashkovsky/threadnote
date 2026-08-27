import {Effect} from 'effect';
import {type CodeGraphStoreShape} from './store.js';
import {type CodeGraphQueryNode} from './types.js';

export interface CodeGraphEndpointSelector {
  readonly original: string;
  readonly path?: string;
  readonly symbol: string;
}

export function codeGraphEndpointMatches(
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotId: string,
  selector: CodeGraphEndpointSelector,
): Effect.Effect<readonly CodeGraphQueryNode[], unknown> {
  if (!selector.path && isStableCodeGraphNodeId(selector.symbol)) {
    return store
      .symbolsByIds(databasePath, snapshotId, [selector.symbol])
      .pipe(Effect.map(symbols => symbols.map(symbol => ({...symbol, score: 1}))));
  }
  return selector.path
    ? store.findSymbolsByPathAndName(databasePath, snapshotId, selector.path, selector.symbol)
    : store.searchSymbols(databasePath, snapshotId, selector.symbol, 20);
}

export function isStableCodeGraphNodeId(value: string): boolean {
  return /^cgs_[a-f0-9]{32,64}$/u.test(value);
}

export function parseCodeGraphEndpointSelector(value: string): CodeGraphEndpointSelector {
  const separator = value.lastIndexOf('#');
  if (separator <= 0 || separator >= value.length - 1) {
    return {original: value, symbol: value};
  }
  return {
    original: value,
    path: value
      .slice(0, separator)
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, ''),
    symbol: value.slice(separator + 1),
  };
}

export function exactCodeGraphImpactSelectorMatches(
  selector: CodeGraphEndpointSelector,
  matches: readonly CodeGraphQueryNode[],
): readonly CodeGraphQueryNode[] {
  if (!selector.path && isStableCodeGraphNodeId(selector.symbol)) return matches;
  const normalizedSymbol = selector.symbol.toLocaleLowerCase('en-US');
  const normalizedPath = (selector.path ?? selector.symbol)
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .toLocaleLowerCase('en-US');
  return matches.filter(node => {
    const nodePath = node.path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
    if (selector.path && nodePath !== normalizedPath) return false;
    return (
      node.name.toLocaleLowerCase('en-US') === normalizedSymbol ||
      node.qualifiedName.toLocaleLowerCase('en-US') === normalizedSymbol ||
      (!selector.path && nodePath === normalizedPath)
    );
  });
}

export function selectCodeGraphEndpoint(
  matches: readonly CodeGraphQueryNode[],
  selector: CodeGraphEndpointSelector,
): {readonly node?: CodeGraphQueryNode; readonly warnings: readonly string[]} {
  const normalizedSymbol = selector.symbol.toLocaleLowerCase('en-US');
  const candidates = matches.filter(node => {
    if (selector.path && node.path.replaceAll('\\', '/') !== selector.path) return false;
    return (
      node.name.toLocaleLowerCase('en-US') === normalizedSymbol ||
      node.qualifiedName.toLocaleLowerCase('en-US') === normalizedSymbol
    );
  });
  if (candidates.length === 1) return {node: candidates[0], warnings: []};
  if (candidates.length === 0 && matches.length === 1 && !selector.path) {
    return {node: matches[0], warnings: []};
  }
  const visible = (candidates.length > 0 ? candidates : matches)
    .slice(0, 5)
    .map(node => `${node.path}#${node.qualifiedName}`)
    .join(', ');
  return {
    warnings: [
      visible.length > 0
        ? `Path endpoint "${selector.original}" is ambiguous; use path#symbol. Candidates: ${visible}.`
        : `Path endpoint "${selector.original}" was not found.`,
    ],
  };
}
