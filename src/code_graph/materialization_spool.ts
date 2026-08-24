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

export interface CodeGraphMaterializationSpoolBatchReceipt {
  readonly batchId: string;
  readonly batchIndex: number;
  readonly factBytes: number;
  readonly rowCount: number;
  readonly sourceBytes: number;
}

export interface CodeGraphMaterializationSpoolState {
  readonly appendedBatchCount: number;
  readonly expectedBatchCount?: number;
  readonly stage: 'appending' | 'sealed';
}

interface CodeGraphMaterializationSpoolHeaderRow {
  readonly checkout_id: string;
  readonly extractor_set: string;
  readonly format_version: number;
  readonly graph_content_id: string;
  readonly repository_id: string;
  readonly snapshot_id: string;
}

interface CodeGraphMaterializationSpoolBatchReceiptRow {
  readonly batch_id: string;
  readonly batch_index: number;
  readonly fact_bytes: number;
  readonly row_count: number;
  readonly source_bytes: number;
}

interface CodeGraphMaterializationSpoolStateRow {
  readonly appended_batch_count: number;
  readonly expected_batch_count: number | null;
  readonly stage: 'appending' | 'sealed';
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
    database.exec(`
      CREATE TABLE IF NOT EXISTS materialization_spool_state (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        stage TEXT NOT NULL CHECK (stage IN ('appending', 'sealed')),
        appended_batch_count INTEGER NOT NULL CHECK (appended_batch_count >= 0),
        expected_batch_count INTEGER CHECK (expected_batch_count >= 0),
        CHECK (
          (stage = 'appending' AND expected_batch_count IS NULL) OR
          (stage = 'sealed' AND expected_batch_count = appended_batch_count)
        )
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS materialization_spool_batches (
        batch_index INTEGER PRIMARY KEY NOT NULL CHECK (batch_index >= 0),
        batch_id TEXT NOT NULL CHECK (length(batch_id) = 64),
        fact_bytes INTEGER NOT NULL CHECK (fact_bytes >= 0),
        source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
        row_count INTEGER NOT NULL CHECK (row_count >= 0)
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
      database.exec(`
        INSERT INTO materialization_spool_state (
          singleton, stage, appended_batch_count, expected_batch_count
        ) VALUES (1, 'appending', 0, NULL)
      `);
      return 'created';
    }
    if (current.length !== 1 || !codeGraphMaterializationSpoolHeaderMatches(current[0]!, expected)) {
      throw new Error('Code graph materialization spool identity does not match the persistent build.');
    }
    assertCodeGraphMaterializationSpoolLedger(database);
    return 'resumed';
  })();
}

/**
 * Commits one deterministic append receipt. Exact replay is idempotent, while
 * gaps or different content at an already committed index fail closed.
 */
export function recordCodeGraphMaterializationSpoolBatch(
  database: Database,
  receipt: CodeGraphMaterializationSpoolBatchReceipt,
): 'appended' | 'resumed' {
  validateCodeGraphMaterializationSpoolBatchReceipt(receipt);
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    const current = database
      .prepare(
        `SELECT batch_index, batch_id, fact_bytes, source_bytes, row_count
         FROM materialization_spool_batches
         WHERE batch_index = ?`,
      )
      .get(receipt.batchIndex) as CodeGraphMaterializationSpoolBatchReceiptRow | null;
    if (current !== null) {
      if (!codeGraphMaterializationSpoolBatchReceiptMatches(current, receipt)) {
        throw new Error('Code graph materialization spool batch identity does not match the committed receipt.');
      }
      return 'resumed';
    }
    if (state.stage !== 'appending') {
      throw new Error('Code graph materialization spool is already sealed.');
    }
    if (receipt.batchIndex !== state.appendedBatchCount) {
      throw new Error('Code graph materialization spool batch sequence is not contiguous.');
    }
    database
      .prepare(
        `INSERT INTO materialization_spool_batches (
           batch_index, batch_id, fact_bytes, source_bytes, row_count
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(receipt.batchIndex, receipt.batchId, receipt.factBytes, receipt.sourceBytes, receipt.rowCount);
    database
      .prepare(
        `UPDATE materialization_spool_state
         SET appended_batch_count = appended_batch_count + 1
         WHERE singleton = 1 AND stage = 'appending' AND appended_batch_count = ?`,
      )
      .run(state.appendedBatchCount);
    return 'appended';
  })();
}

/** Seals the append surface only when every expected contiguous batch exists. */
export function sealCodeGraphMaterializationSpool(
  database: Database,
  expectedBatchCount: number,
): 'sealed' | 'resumed' {
  validateNonNegativeSafeInteger(expectedBatchCount, 'expected batch count');
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    if (state.stage === 'sealed') {
      if (state.expectedBatchCount !== expectedBatchCount) {
        throw new Error('Code graph materialization spool sealed batch count does not match.');
      }
      return 'resumed';
    }
    if (state.appendedBatchCount !== expectedBatchCount) {
      throw new Error('Code graph materialization spool cannot seal before every expected batch is committed.');
    }
    database
      .prepare(
        `UPDATE materialization_spool_state
         SET stage = 'sealed', expected_batch_count = ?
         WHERE singleton = 1 AND stage = 'appending' AND appended_batch_count = ?`,
      )
      .run(expectedBatchCount, expectedBatchCount);
    return 'sealed';
  })();
}

export function readCodeGraphMaterializationSpoolState(database: Database): CodeGraphMaterializationSpoolState {
  const rows = database
    .prepare(
      `SELECT stage, appended_batch_count, expected_batch_count
       FROM materialization_spool_state
       WHERE singleton = 1
       LIMIT 2`,
    )
    .all() as readonly CodeGraphMaterializationSpoolStateRow[];
  if (rows.length !== 1) {
    throw new Error('Code graph materialization spool state is missing or corrupt.');
  }
  const row = rows[0]!;
  if (
    !Number.isSafeInteger(row.appended_batch_count) ||
    row.appended_batch_count < 0 ||
    (row.stage === 'appending' && row.expected_batch_count !== null) ||
    (row.stage === 'sealed' && row.expected_batch_count !== row.appended_batch_count)
  ) {
    throw new Error('Code graph materialization spool state is missing or corrupt.');
  }
  return {
    appendedBatchCount: row.appended_batch_count,
    ...(row.expected_batch_count === null ? {} : {expectedBatchCount: row.expected_batch_count}),
    stage: row.stage,
  };
}

function assertCodeGraphMaterializationSpoolLedger(database: Database): void {
  const state = readCodeGraphMaterializationSpoolState(database);
  const receipts = database
    .prepare(
      `SELECT batch_index, batch_id, fact_bytes, source_bytes, row_count
       FROM materialization_spool_batches
       ORDER BY batch_index`,
    )
    .all() as readonly CodeGraphMaterializationSpoolBatchReceiptRow[];
  if (
    receipts.length !== state.appendedBatchCount ||
    receipts.some((receipt, index) => receipt.batch_index !== index || !/^[0-9a-f]{64}$/u.test(receipt.batch_id))
  ) {
    throw new Error('Code graph materialization spool batch ledger is corrupt.');
  }
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

function codeGraphMaterializationSpoolBatchReceiptMatches(
  current: CodeGraphMaterializationSpoolBatchReceiptRow,
  expected: CodeGraphMaterializationSpoolBatchReceipt,
): boolean {
  return (
    current.batch_index === expected.batchIndex &&
    current.batch_id === expected.batchId &&
    current.fact_bytes === expected.factBytes &&
    current.source_bytes === expected.sourceBytes &&
    current.row_count === expected.rowCount
  );
}

function validateCodeGraphMaterializationSpoolBatchReceipt(receipt: CodeGraphMaterializationSpoolBatchReceipt): void {
  if (!/^[0-9a-f]{64}$/u.test(receipt.batchId)) {
    throw new Error('Code graph materialization spool batch receipt is invalid.');
  }
  for (const [value, field] of [
    [receipt.batchIndex, 'batch index'],
    [receipt.factBytes, 'fact bytes'],
    [receipt.sourceBytes, 'source bytes'],
    [receipt.rowCount, 'row count'],
  ] as const) {
    validateNonNegativeSafeInteger(value, field);
  }
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Code graph materialization spool ${field} is invalid.`);
  }
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
