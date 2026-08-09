import {codeGraphUtf8ByteLength} from './disk_capacity.js';
import {symbolTerms} from './store_utilities.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from './types.js';

export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES = 128;
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES = 16 * 1_048_576;
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES = 8 * 1_048_576;
export const CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS = 250_000;

export interface CodeGraphIncrementalWork {
  readonly changedFiles: number;
  readonly deletedFiles: number;
  /** Exact UTF-8 bytes of the final attributed facts entering incremental staging. */
  readonly factBytes: number;
  /** Exact rows presented to bounded staging, including changed-path markers. */
  readonly plannedRows: number;
  readonly sourceBytes: number;
  readonly totalFiles: number;
}

export function measureCodeGraphIncrementalWork(input: {
  readonly deletedPaths?: readonly string[];
  readonly facts: readonly CodeGraphFileFacts[];
  readonly files: readonly CodeGraphInventoryFile[];
  readonly totalFiles: number;
}): CodeGraphIncrementalWork {
  const deletedFiles = new Set(input.deletedPaths ?? []).size;
  const factBytes = input.facts.reduce((total, facts) => total + codeGraphUtf8ByteLength(JSON.stringify(facts)), 0);
  let factRows = 0;
  for (const facts of input.facts) {
    factRows += facts.symbols.length;
    factRows += facts.symbols.reduce((total, symbol) => total + (symbol.lookupKeys?.length ?? 0), 0);
    factRows += facts.symbols.reduce((total, symbol) => total + symbolTerms(symbol).length, 0);
    factRows += facts.edges.length;
    const references = facts.references ?? [];
    factRows += references.length;
    factRows += references.reduce(
      (total, reference) => total + reference.lookupTiers.reduce((tierTotal, tier) => tierTotal + tier.length, 0),
      0,
    );
  }
  return {
    changedFiles: input.files.length,
    deletedFiles,
    factBytes,
    plannedRows: input.files.length + deletedFiles + factRows,
    sourceBytes: input.files.reduce((total, file) => total + file.size, 0),
    totalFiles: input.totalFiles,
  };
}

export function codeGraphIncrementalWorkFitsBudget(work: CodeGraphIncrementalWork): boolean {
  return (
    Number.isSafeInteger(work.changedFiles) &&
    work.changedFiles > 0 &&
    work.changedFiles <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES &&
    Number.isSafeInteger(work.deletedFiles) &&
    work.deletedFiles >= 0 &&
    Number.isSafeInteger(work.totalFiles) &&
    work.totalFiles >= work.changedFiles &&
    Number.isSafeInteger(work.sourceBytes) &&
    work.sourceBytes >= 0 &&
    work.sourceBytes <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES &&
    Number.isSafeInteger(work.factBytes) &&
    work.factBytes >= 0 &&
    work.factBytes <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES &&
    Number.isSafeInteger(work.plannedRows) &&
    work.plannedRows > 0 &&
    work.plannedRows <= CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS
  );
}
