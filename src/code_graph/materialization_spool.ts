import type {Path} from 'effect';
import type {CodeGraphLayout} from './layout.js';

export const CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION = 1 as const;
export const CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS = 50_000;

const PERSISTENT_SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;

export interface CodeGraphMaterializationApplyPage {
  readonly afterRowid: number;
  readonly rowCount: number;
}

/**
 * A sidecar belongs to one opaque persistent snapshot and lives beside its
 * main database so capacity accounting observes one durable filesystem.
 */
export function codeGraphMaterializationSpoolPath(
  path: Path.Path,
  layout: CodeGraphLayout,
  snapshotId: string,
): string {
  if (!PERSISTENT_SNAPSHOT_ID.test(snapshotId)) {
    throw new Error('Code graph materialization spool snapshot identity is invalid.');
  }
  return path.join(
    layout.repositoryRoot,
    `materialization-spool-v${CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION}-${snapshotId}.sqlite`,
  );
}

/**
 * Stable rowid pages let the main database commit final rows and its resume
 * cursor atomically without retaining a repository-sized decoded page.
 */
export function codeGraphMaterializationApplyPages(
  rowCount: number,
  pageRows = CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS,
): readonly CodeGraphMaterializationApplyPage[] {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('Code graph materialization spool row count is invalid.');
  }
  if (!Number.isSafeInteger(pageRows) || pageRows <= 0 || pageRows > CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS) {
    throw new Error('Code graph materialization spool page bound is invalid.');
  }
  const pages: CodeGraphMaterializationApplyPage[] = [];
  for (let afterRowid = 0; afterRowid < rowCount; afterRowid += pageRows) {
    pages.push({afterRowid, rowCount: Math.min(pageRows, rowCount - afterRowid)});
  }
  return pages;
}
