import type {CodeGraphWorksetCatalogError} from '../code_graph/workset_catalog/types.js';

const CATALOG_MESSAGES = {
  busy: 'The workset catalog is busy. Retry shortly.',
  capacity: 'The workset catalog has reached its safe capacity.',
  corrupt: 'The workset catalog needs repair before this operation can continue.',
  expired: 'The saved continuation expired. Run the query again.',
  incompatible: 'The workset catalog is incompatible with this runtime.',
  'invalid-input': 'The workset request is invalid.',
  missing: 'No published workset catalog is available. Prepare the workset first.',
  stale: 'The published workset catalog is stale. Prepare the workset again.',
  storage: 'The workset catalog could not complete the storage operation.',
} as const satisfies Record<CodeGraphWorksetCatalogError['reason'], string>;

const CATALOG_STATUSES = {
  busy: 409,
  capacity: 507,
  corrupt: 500,
  expired: 410,
  incompatible: 500,
  'invalid-input': 400,
  missing: 409,
  stale: 409,
  storage: 500,
} as const satisfies Record<CodeGraphWorksetCatalogError['reason'], number>;

export function managerWorksetCatalogHttp(reason: CodeGraphWorksetCatalogError['reason']): {
  readonly code: string;
  readonly error: string;
  readonly status: number;
} {
  return {
    code: `catalog-${reason}`,
    error: CATALOG_MESSAGES[reason],
    status: CATALOG_STATUSES[reason],
  };
}
