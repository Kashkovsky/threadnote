import {CODE_GRAPH_WORKSET_CATALOG_LIMITS, CodeGraphWorksetCatalogError} from './types.js';
import {codeGraphWorksetRoutingExactKeys} from './routing_normalization.js';
import type {CodeGraphWorksetRoutingSymbolV1} from './types.js';

const ROUTING_ROW_STORAGE_CHARGE_BYTES = 256;
export const CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM = 512;

export interface CodeGraphWorksetRoutingProjectionPageOptions {
  readonly pageBytesMaximum?: number;
  readonly pageSymbolsMaximum?: number;
}

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
    throw CodeGraphWorksetCatalogError.of('invalid-input', 'Workset routing projection byte state is invalid.');
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

/** Lazily partition one source page by both catalog writer bounds. */
export function* codeGraphWorksetRoutingProjectionPages(
  symbols: readonly CodeGraphWorksetRoutingSymbolV1[],
  options: CodeGraphWorksetRoutingProjectionPageOptions = {},
): Generator<readonly CodeGraphWorksetRoutingSymbolV1[]> {
  const pageBytesMaximum = boundedPageLimit(
    options.pageBytesMaximum,
    CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionPageBytesMaximum,
    'byte',
  );
  const pageSymbolsMaximum = boundedPageLimit(
    options.pageSymbolsMaximum,
    CODE_GRAPH_WORKSET_CATALOG_PROJECTION_PAGE_MAXIMUM,
    'symbol',
  );
  let page: CodeGraphWorksetRoutingSymbolV1[] = [];
  let pageBytes = 0;
  for (const symbol of symbols) {
    // The charge is additive, so calculate each symbol once instead of
    // serializing its complete routing surface twice at every boundary.
    const symbolBytes = codeGraphWorksetRoutingProjectionLogicalBytes([symbol]);
    if (symbolBytes > pageBytesMaximum) {
      throw CodeGraphWorksetCatalogError.of(
        'capacity',
        'A routing symbol exceeds the supported projection page bound.',
      );
    }
    if (page.length > 0 && (page.length === pageSymbolsMaximum || pageBytes > pageBytesMaximum - symbolBytes)) {
      yield page;
      page = [];
      pageBytes = 0;
    }
    page.push(symbol);
    pageBytes += symbolBytes;
  }
  if (page.length > 0) yield page;
}

function boundedPageLimit(value: number | undefined, maximum: number, label: string): number {
  const selected = value ?? maximum;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw CodeGraphWorksetCatalogError.of(
      'invalid-input',
      `Workset routing projection page ${label} bound is invalid.`,
    );
  }
  return selected;
}

function projectionCapacityError(): CodeGraphWorksetCatalogError {
  return CodeGraphWorksetCatalogError.of(
    'capacity',
    'Workset routing projection exceeds the supported aggregate byte bound.',
  );
}
