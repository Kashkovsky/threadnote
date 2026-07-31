import type {Path} from 'effect';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';

export interface CodeGraphLayout {
  readonly databasePath: string;
  readonly lockPath: string;
  readonly repositoryRoot: string;
  readonly staleMarkerPath: string;
  readonly vectorRoot: string;
  readonly worktreeId: string;
}

export function codeGraphMaintenanceLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance.lock');
}

export function codeGraphMaintenanceIntentPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
}

export function codeGraphRepositoriesRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'indexes', 'code-graph', 'repositories');
}

export function codeGraphRepositoryRoot(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(codeGraphRepositoriesRoot(path, threadnoteHome), checkoutId);
}

export function codeGraphRepositoryLockPath(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', `${checkoutId}.lock`);
}

export function codeGraphLayout(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
): CodeGraphLayout {
  const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
  return {
    databasePath: path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`),
    lockPath: codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
    repositoryRoot,
    staleMarkerPath: path.join(repositoryRoot, 'stale', `${worktreeId}.stale`),
    vectorRoot: path.join(repositoryRoot, 'vectors'),
    worktreeId,
  };
}

function assertCheckoutId(checkoutId: string): void {
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) throw new Error('Code graph checkout identity is invalid.');
}
