import {compareCodeUnits} from './ordering.js';

const CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS = 1_024;

/** @internal Streams canonical inventory rows without one repository-sized joined string. */
export function codeGraphInventorySha256Hex<A extends {readonly path: string}>(
  prefix: string,
  files: readonly A[],
  line: (file: A) => string,
): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(prefix);
  const canonical = codeGraphInventoryInStrictCanonicalOrder(files);
  if (canonical) {
    for (let offset = 0; offset < files.length; offset += CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS) {
      if (offset > 0) hasher.update('\n');
      hasher.update(
        files
          .slice(offset, offset + CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS)
          .map(line)
          .join('\n'),
      );
    }
  } else {
    const rows = files.map(line).sort(compareCodeUnits);
    for (let offset = 0; offset < rows.length; offset += CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS) {
      if (offset > 0) hasher.update('\n');
      hasher.update(rows.slice(offset, offset + CODE_GRAPH_INVENTORY_HASH_CHUNK_ROWS).join('\n'));
    }
  }
  return hasher.digest('hex');
}

function codeGraphInventoryInStrictCanonicalOrder(files: readonly {readonly path: string}[]): boolean {
  if (files[0]?.path.includes('\0')) return false;
  for (let index = 1; index < files.length; index += 1) {
    if (files[index]!.path.includes('\0') || compareCodeUnits(files[index - 1]!.path, files[index]!.path) >= 0) {
      return false;
    }
  }
  return true;
}
