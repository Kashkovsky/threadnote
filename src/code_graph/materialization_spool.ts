import type {Database} from 'bun:sqlite';
import type {Path} from 'effect';
import type {CodeGraphLayout} from './layout.js';

export const CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION = 1 as const;
export const CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS = 50_000;

const PERSISTENT_SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;

export interface CodeGraphMaterializationApplyPage {
  readonly afterRowid: number;
  readonly rowCount: number;
}

export interface CodeGraphMaterializationSpoolHeader {
  readonly checkoutId: string;
  readonly extractorSet: string;
  readonly graphContentId: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

interface CodeGraphMaterializationSpoolHeaderRow {
  readonly checkout_id: string;
  readonly extractor_set: string;
  readonly format_version: number;
  readonly graph_content_id: string;
  readonly repository_id: string;
  readonly snapshot_id: string;
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

/**
 * The spool is reconstructible but each append/sort stage must remain atomic
 * across interruption. Rollback journaling keeps that guarantee without a
 * second long-lived WAL competing with the final graph database.
 */
export function configureCodeGraphMaterializationSpoolDatabase(database: Database): void {
  database.exec('PRAGMA page_size = 8192');
  database.exec('PRAGMA journal_mode = DELETE');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA temp_store = FILE');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
}

/**
 * Creates or verifies the immutable identity header. A stale sidecar from any
 * other repository, snapshot, extractor, or graph content fails closed.
 */
export function initializeCodeGraphMaterializationSpoolDatabase(
  database: Database,
  expected: CodeGraphMaterializationSpoolHeader,
): 'created' | 'resumed' {
  validateCodeGraphMaterializationSpoolHeader(expected);
  return database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS materialization_spool_header (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        format_version INTEGER NOT NULL CHECK (format_version = ${CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION}),
        checkout_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        graph_content_id TEXT NOT NULL,
        extractor_set TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    const current = database
      .prepare(
        `SELECT format_version, checkout_id, repository_id, snapshot_id, graph_content_id, extractor_set
         FROM materialization_spool_header
         WHERE singleton = 1
         LIMIT 2`,
      )
      .all() as readonly CodeGraphMaterializationSpoolHeaderRow[];
    if (current.length === 0) {
      database
        .prepare(
          `INSERT INTO materialization_spool_header (
             singleton, format_version, checkout_id, repository_id, snapshot_id, graph_content_id, extractor_set
           ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION,
          expected.checkoutId,
          expected.repositoryId,
          expected.snapshotId,
          expected.graphContentId,
          expected.extractorSet,
        );
      return 'created';
    }
    if (current.length !== 1 || !codeGraphMaterializationSpoolHeaderMatches(current[0]!, expected)) {
      throw new Error('Code graph materialization spool identity does not match the persistent build.');
    }
    return 'resumed';
  })();
}

function codeGraphMaterializationSpoolHeaderMatches(
  current: CodeGraphMaterializationSpoolHeaderRow,
  expected: CodeGraphMaterializationSpoolHeader,
): boolean {
  return (
    current.format_version === CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION &&
    current.checkout_id === expected.checkoutId &&
    current.repository_id === expected.repositoryId &&
    current.snapshot_id === expected.snapshotId &&
    current.graph_content_id === expected.graphContentId &&
    current.extractor_set === expected.extractorSet
  );
}

function validateCodeGraphMaterializationSpoolHeader(header: CodeGraphMaterializationSpoolHeader): void {
  if (
    !/^[0-9a-f]{64}$/u.test(header.checkoutId) ||
    !/^[0-9a-f]{64}$/u.test(header.repositoryId) ||
    !PERSISTENT_SNAPSHOT_ID.test(header.snapshotId) ||
    !/^(?:cgc_[0-9a-f]{40}|cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?)$/u.test(header.graphContentId) ||
    header.extractorSet.length === 0 ||
    header.extractorSet.length > 4_096 ||
    header.extractorSet.includes('\0')
  ) {
    throw new Error('Code graph materialization spool header is invalid.');
  }
}
