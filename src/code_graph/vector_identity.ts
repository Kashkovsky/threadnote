import {sha256HexSync} from '../crypto/sha256.js';
import {codeGraphScopeViewKey} from './scope_identity.js';

/**
 * The legacy vector worktree column stores a bounded logical-view identity.
 * Full graphs keep their existing key; scoped pointers and retirement markers
 * bind the worktree and scope without changing immutable generation payloads.
 */
export function codeGraphVectorViewId(worktreeId: string, scopeId?: string): string {
  const viewKey = codeGraphScopeViewKey(worktreeId, scopeId);
  return viewKey === worktreeId ? worktreeId : sha256HexSync(`code-graph-vector-view-v1\n${viewKey}`);
}
