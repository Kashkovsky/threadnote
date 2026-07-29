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

export function codeGraphLayout(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
): CodeGraphLayout {
  const repositoryRoot = path.join(codeGraphRepositoriesRoot(path, threadnoteHome), checkoutId);
  return {
    databasePath: path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`),
    lockPath: path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', `${checkoutId}.lock`),
    repositoryRoot,
    staleMarkerPath: path.join(repositoryRoot, 'stale', `${worktreeId}.stale`),
    vectorRoot: path.join(repositoryRoot, 'vectors'),
    worktreeId,
  };
}
