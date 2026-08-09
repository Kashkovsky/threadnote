import type {Path} from 'effect';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';

export interface CodeGraphLayout {
  readonly checkoutId: string;
  readonly databaseWriteLockPath: string;
  readonly databasePath: string;
  readonly lockPath: string;
  readonly repositoryRoot: string;
  readonly staleMarkerPath: string;
  readonly vectorRoot: string;
  readonly worktreeLockRoot: string;
  readonly worktreeId: string;
}

export function codeGraphMaintenanceLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance.lock');
}

export function codeGraphMaintenanceIntentPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
}

export function codeGraphMaintenanceStatusPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance-status-v1.json');
}

/** Home-global receipts coordinate capacity before any checkout writer is acquired. */
export function codeGraphDiskReservationRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'disk-capacity-reservations');
}

/** The ledger lock is a sibling so scanning the receipt directory has a closed grammar. */
export function codeGraphDiskReservationLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'disk-capacity-reservations.lock');
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

export function codeGraphDatabaseWriteLockPath(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
}

export function codeGraphSnapshotBuildLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  logicalSnapshotId: string,
): string {
  assertCheckoutId(checkoutId);
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    throw new Error('Code graph logical snapshot identity is invalid.');
  }
  return path.join(
    threadnoteHome,
    'locks',
    'indexes',
    'code-graph',
    'snapshot-builds',
    checkoutId,
    `${logicalSnapshotId}.lock`,
  );
}

export function codeGraphRequestBuildLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  requestKey: string,
): string {
  assertCheckoutId(checkoutId);
  if (!/^[0-9a-f]{64}$/.test(requestKey)) throw new Error('Code graph build request identity is invalid.');
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'requests', checkoutId, `${requestKey}.lock`);
}

export function codeGraphWorktreeLockRoot(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'worktrees', checkoutId);
}

export function codeGraphVectorWriteLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  modelKey: string,
): string {
  assertCheckoutId(checkoutId);
  if (!/^[0-9a-f]{64}$/.test(modelKey)) throw new Error('Code graph vector model identity is invalid.');
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'vector-writes', checkoutId, `${modelKey}.lock`);
}

/** Durable ordinary-retirement cursor serialization outside the replaceable vector root. */
export function codeGraphVectorRetirementCursorLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'vector-retirement-cursors', `${checkoutId}.lock`);
}

export function codeGraphLocalProvenanceLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  return path.join(
    threadnoteHome,
    'locks',
    'indexes',
    'code-graph',
    'local-provenance',
    checkoutId,
    `${worktreeId}.lock`,
  );
}

export function codeGraphWorktreeLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  return path.join(codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId), `${worktreeId}.lock`);
}

export function codeGraphLayout(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
): CodeGraphLayout {
  const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
  const worktreeLockRoot = codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId);
  return {
    checkoutId,
    databaseWriteLockPath: codeGraphDatabaseWriteLockPath(path, threadnoteHome, checkoutId),
    databasePath: path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`),
    lockPath: codeGraphWorktreeLockPath(path, threadnoteHome, checkoutId, worktreeId),
    repositoryRoot,
    staleMarkerPath: path.join(repositoryRoot, 'stale', `${worktreeId}.stale`),
    vectorRoot: path.join(repositoryRoot, 'vectors'),
    worktreeLockRoot,
    worktreeId,
  };
}

function assertCheckoutId(checkoutId: string): void {
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) throw new Error('Code graph checkout identity is invalid.');
}

function assertWorktreeId(worktreeId: string): void {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) throw new Error('Code graph worktree identity is invalid.');
}
