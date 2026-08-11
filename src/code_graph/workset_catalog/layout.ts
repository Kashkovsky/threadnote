import type {Path} from 'effect';

export const CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION = 2 as const;

export interface CodeGraphWorksetCatalogLayout {
  readonly databasePath: string;
  readonly lockPath: string;
  readonly root: string;
}

/**
 * The workset catalog is home-global derived data. It deliberately lives
 * outside every checkout-owned graph-v3 database so its schema can be rebuilt
 * or replaced without migrating authoritative repository snapshots.
 */
export function codeGraphWorksetCatalogRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'indexes', 'code-graph', 'worksets');
}

export function codeGraphWorksetCatalogDatabasePath(path: Path.Path, threadnoteHome: string): string {
  return path.join(
    codeGraphWorksetCatalogRoot(path, threadnoteHome),
    `catalog-v${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}.sqlite`,
  );
}

export function codeGraphWorksetCatalogLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'worksets', 'catalog.lock');
}

export function codeGraphWorksetCatalogLayout(path: Path.Path, threadnoteHome: string): CodeGraphWorksetCatalogLayout {
  return {
    databasePath: codeGraphWorksetCatalogDatabasePath(path, threadnoteHome),
    lockPath: codeGraphWorksetCatalogLockPath(path, threadnoteHome),
    root: codeGraphWorksetCatalogRoot(path, threadnoteHome),
  };
}
