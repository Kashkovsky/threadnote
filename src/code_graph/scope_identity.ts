import {sha256HexSync} from '../crypto/sha256.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, type ResolvedCodeGraphIndexScope} from './index_scope.js';

/** Logical selection and effective workspace closure are separate identity dimensions. */
export type CodeGraphScopeIdentity = Pick<
  ResolvedCodeGraphIndexScope,
  'closureDigest' | 'definitionDigest' | 'scopeKey'
>;

export function codeGraphScopeIdentitySuffix(scope: CodeGraphScopeIdentity | undefined): string {
  if (scope === undefined || scope.scopeKey === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) return '';
  return `\nscope-v1:${JSON.stringify([scope.scopeKey, scope.definitionDigest, scope.closureDigest])}\n`;
}

/** Missing scope is the historical full-repository contract, never an unknown wildcard. */
export function codeGraphScopeIdentityCompatible(
  left: CodeGraphScopeIdentity | undefined,
  right: CodeGraphScopeIdentity | undefined,
): boolean {
  return codeGraphScopeIdentitySuffix(left) === codeGraphScopeIdentitySuffix(right);
}

/** Stable sidecar identity for one logical view; changing its definition replaces only that view. */
export function codeGraphScopeViewKey(
  worktreeId: string,
  scopeKey: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
): string {
  if (!/^[0-9a-f]{64}$/u.test(worktreeId)) throw new Error('Invalid code graph worktree identity.');
  if (scopeKey === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) return worktreeId;
  if (!/^code-graph-scope:[0-9a-f]{64}$/u.test(scopeKey)) throw new Error('Invalid code graph scope identity.');
  return `${worktreeId}.scope-${sha256HexSync(scopeKey)}`;
}
