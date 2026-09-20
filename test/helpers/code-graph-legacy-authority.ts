import {CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL} from '../../src/code_graph/store/schema_core.js';
import {CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS} from '../../src/code_graph/store/query_indexes.js';
import {
  REMOVED_VIEWS_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_COLUMNS,
  REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  REMOVED_VIEW_CLEANUP_TABLE_SQL,
  REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS,
} from '../../src/code_graph/store/removed_view_schema_contracts.js';

/** Exact released r17 authority fixture; only call on canonical full-scope test rows. */
export const legacyCodeGraphAuthorityStatements = [
  ...CODE_GRAPH_SCOPE_QUERY_INDEX_DEFINITIONS.map(index => `DROP INDEX IF EXISTS ${index.name}`),
  ...REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => `DROP TRIGGER ${trigger.name}`),
  'DROP TRIGGER active_snapshots_require_current_extractor',
  'DROP TABLE scope_applicability',
  'DROP TABLE snapshot_scope_receipts',
  ...[
    {
      name: 'active_snapshots',
      columns: ['worktree_id', 'snapshot_id', 'activated_at'],
      sql: `CREATE TABLE active_snapshots (
      worktree_id TEXT PRIMARY KEY NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      activated_at TEXT NOT NULL
    )`,
    },
    {
      name: 'removed_views',
      columns: ['worktree_id', 'expected_snapshot_id', 'removed_at'],
      sql: REMOVED_VIEWS_TABLE_SQL,
    },
    {
      name: 'removed_view_cleanup',
      columns: REMOVED_VIEW_CLEANUP_COLUMNS.map(column => column.name),
      sql: REMOVED_VIEW_CLEANUP_TABLE_SQL,
    },
  ].flatMap(table => [
    `CREATE TEMP TABLE fixture_${table.name} AS SELECT ${table.columns.join(', ')} FROM ${table.name}`,
    `DROP TABLE ${table.name}`,
    table.sql,
    `INSERT INTO ${table.name} SELECT * FROM fixture_${table.name}`,
    `DROP TABLE fixture_${table.name}`,
  ]),
  'ALTER TABLE snapshots DROP COLUMN scope_id',
  'CREATE INDEX active_snapshots_snapshot_worktree ON active_snapshots(snapshot_id, worktree_id)',
  REMOVED_VIEW_CLEANUP_DUE_INDEX_SQL,
  ...REMOVED_VIEW_CLEANUP_TRIGGER_DEFINITIONS.map(trigger => trigger.sql),
  CODE_GRAPH_ACTIVE_SNAPSHOT_EXTRACTOR_TRIGGER_SQL,
  "UPDATE schema_metadata SET value = '17' WHERE key = 'persistent_extension_schema_revision'",
];
