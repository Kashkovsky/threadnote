import {CODE_GRAPH_WORKSET_CATALOG_LIMITS, CodeGraphWorksetCatalogError} from './types.js';
import {codeGraphWorksetRoutingExactKeys} from './routing_normalization.js';
import type {CodeGraphWorksetRoutingSymbolV1} from './types.js';

const ROUTING_ROW_STORAGE_CHARGE_BYTES = 256;

/** Canonical additive charge for every routing row and derived exact-key row. */
export function codeGraphWorksetRoutingProjectionLogicalBytes(
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
): number {
  return codeGraphWorksetRoutingProjectionLogicalBytesAppend(0, symbols);
}

export function codeGraphWorksetRoutingProjectionLogicalBytesAppend(
  currentBytes: number,
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
): number {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0) {
    throw new CodeGraphWorksetCatalogError('invalid-input', 'Workset routing projection byte state is invalid.');
  }
  if (currentBytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum) {
    throw projectionCapacityError();
  }
  let bytes = currentBytes;
  for (const symbol of symbols) {
    bytes += Buffer.byteLength(JSON.stringify(symbol), 'utf8') + ROUTING_ROW_STORAGE_CHARGE_BYTES;
    for (const lookupKey of symbol.lookupKeys) {
      bytes += Buffer.byteLength(lookupKey, 'utf8') + ROUTING_ROW_STORAGE_CHARGE_BYTES;
    }
    for (const term of symbol.terms) {
      bytes += Buffer.byteLength(term.term, 'utf8') + 8 + ROUTING_ROW_STORAGE_CHARGE_BYTES;
    }
    for (const exactKey of codeGraphWorksetRoutingExactKeys(symbol)) {
      bytes +=
        Buffer.byteLength(exactKey.kind, 'utf8') +
        Buffer.byteLength(exactKey.exactKey, 'utf8') +
        ROUTING_ROW_STORAGE_CHARGE_BYTES;
    }
    if (!Number.isSafeInteger(bytes) || bytes > CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum) {
      throw projectionCapacityError();
    }
  }
  return bytes;
}

function projectionCapacityError(): CodeGraphWorksetCatalogError {
  return new CodeGraphWorksetCatalogError(
    'capacity',
    'Workset routing projection exceeds the supported aggregate byte bound.',
  );
}
