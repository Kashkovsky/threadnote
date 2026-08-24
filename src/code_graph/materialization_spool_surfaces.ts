import type {Database} from 'bun:sqlite';

export interface CodeGraphMaterializationSpoolSurface {
  readonly columns: string;
  readonly name: string;
  readonly orderBy: string;
}

export const CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES = [
  {
    columns:
      'id, content_hash, kind, name, qualified_name, path, language, arity, lookup_keys_json, ' +
      'resolution_domain, resolution_scope_id, package_name, exported, signature, documentation, span_json',
    name: 'symbols',
    orderBy: 'id',
  },
  {
    columns: 'lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path',
    name: 'lookup',
    orderBy: 'lookup_key, symbol_id',
  },
  {
    columns:
      'id, source_id, source_name, relation, target_id, target_name, provenance, confidence, ' +
      'evidence_path, evidence_span_json',
    name: 'edges',
    orderBy: 'id',
  },
  {
    columns:
      'edge_id, resolution_domain, exported_only, alias_lookup_keys_json, lookup_tiers_json, candidate_count, ' +
      'candidate_payload_bytes, source_id, source_name, relation, target_name, provenance, confidence, ' +
      'evidence_path, evidence_span_json',
    name: 'references',
    orderBy: 'edge_id',
  },
  {
    columns: 'source_path, local_name, target_path, imported_name',
    name: 'reexports',
    orderBy: 'source_path, local_name, target_path, imported_name',
  },
  {
    columns:
      'id, version, scheme, role, kind, resolution_domain, identity, package_name, package_version, import_path, ' +
      'qualified_name, component_id, symbol_id, dependency_kind, evidence_path, evidence_span_json',
    name: 'monikers',
    orderBy: 'id',
  },
  {
    columns: 'term, symbol_id, weight',
    name: 'symbol_terms',
    orderBy: 'term, symbol_id',
  },
] as const satisfies readonly CodeGraphMaterializationSpoolSurface[];

export function initializeCodeGraphMaterializationSpoolSurfaces(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS materialization_raw_symbols (
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      path TEXT NOT NULL,
      language TEXT NOT NULL,
      arity INTEGER,
      lookup_keys_json TEXT NOT NULL,
      resolution_domain TEXT,
      resolution_scope_id TEXT,
      package_name TEXT,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      signature TEXT,
      documentation TEXT,
      span_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materialization_raw_lookup (
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance = 'symbol'),
      evidence_edge_id TEXT,
      evidence_path TEXT
    );
    CREATE TABLE IF NOT EXISTS materialization_raw_edges (
      id TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materialization_raw_references (
      edge_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported_only INTEGER NOT NULL CHECK (exported_only IN (0, 1)),
      alias_lookup_keys_json TEXT NOT NULL,
      lookup_tiers_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
      candidate_payload_bytes INTEGER NOT NULL CHECK (candidate_payload_bytes >= 0),
      source_id TEXT,
      source_name TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_name TEXT NOT NULL,
      provenance TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materialization_raw_reexports (
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materialization_raw_monikers (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      scheme TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      identity TEXT NOT NULL,
      package_name TEXT,
      package_version TEXT,
      import_path TEXT,
      qualified_name TEXT,
      component_id TEXT,
      symbol_id TEXT,
      dependency_kind TEXT,
      evidence_path TEXT NOT NULL,
      evidence_span_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materialization_raw_symbol_terms (
      term TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      weight REAL NOT NULL
    )
  `);
}

export function assertCodeGraphMaterializationSpoolSurfaceState(
  database: Database,
  stage: 'appending' | 'ready' | 'sealed' | 'sorting',
  sortedSurfaceCount: number,
): void {
  const tables = new Set(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND (name LIKE 'materialization_raw_%' OR name LIKE 'materialization_ordered_%')`,
        )
        .all() as readonly {readonly name: string}[]
    ).map(row => row.name),
  );
  for (let index = 0; index < CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length; index += 1) {
    const name = CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES[index]!.name;
    const raw = `materialization_raw_${name}`;
    const ordered = `materialization_ordered_${name}`;
    const expectsOrdered = stage === 'ready' || (stage === 'sorting' && index < sortedSurfaceCount);
    if (tables.delete(expectsOrdered ? ordered : raw) === false || tables.has(expectsOrdered ? raw : ordered)) {
      throw new Error('Code graph materialization spool fact surfaces are missing or corrupt.');
    }
  }
  if (tables.size !== 0) {
    throw new Error('Code graph materialization spool fact surfaces are missing or corrupt.');
  }
}

export function sortCodeGraphMaterializationSpoolSurface(
  database: Database,
  surface: CodeGraphMaterializationSpoolSurface,
): void {
  database.exec(
    `CREATE TABLE materialization_ordered_${surface.name} AS ` +
      `SELECT ${surface.columns} FROM materialization_raw_${surface.name} ORDER BY ${surface.orderBy}; ` +
      `DROP TABLE materialization_raw_${surface.name}`,
  );
}
