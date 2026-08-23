import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS,
  CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES,
  codeGraphIncrementalWorkFitsBudget,
  measureCodeGraphIncrementalWork,
} from '../../src/code_graph/incremental_work.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';

describe('incremental rewrite work', () => {
  it('measures final fact bytes and every row presented to incremental staging', () => {
    const file: CodeGraphInventoryFile = {
      blobId: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      language: 'typescript',
      mode: '100644',
      path: 'src/value.ts',
      size: 123,
      source: 'commit',
    };
    const facts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path: file.path,
      references: [],
      symbols: [
        {
          contentHash: file.contentHash,
          exported: true,
          id: 'symbol',
          kind: 'function',
          language: file.language,
          lookupKeys: ['typescript:name:value'],
          name: 'value',
          path: file.path,
          qualifiedName: 'value',
          span: {column: 1, endColumn: 6, endLine: 1, line: 1},
        },
      ],
    };

    const measured = measureCodeGraphIncrementalWork({
      deletedPaths: ['src/removed.ts', 'src/removed.ts'],
      facts: [facts],
      files: [file],
      totalFiles: 10_000,
    });

    expect(measured).toMatchObject({
      attributionContextFiles: 0,
      baseFactsLoaded: 1,
      changedFiles: 1,
      deletedFiles: 1,
      inventoryFilesInspected: 10_000,
      probedDependencyPaths: 0,
      sourceBytes: 123,
      totalFiles: 10_000,
    });
    expect(measured.factBytes).toBe(new TextEncoder().encode(JSON.stringify(facts)).byteLength);
    expect(measured.plannedRows).toBeGreaterThanOrEqual(4);
    expect(codeGraphIncrementalWorkFitsBudget(measured)).toBe(true);
  });

  it('is independent of unrelated repository size, downward closed, and fails every exact budget overflow', () => {
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES, min: 1}),
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES, min: 0}),
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES, min: 0}),
        fc.integer({max: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS, min: 1}),
        fc.integer({max: 1_000_000, min: 0}),
        (changedFiles, sourceBytes, factBytes, plannedRows, unrelatedFiles) => {
          const work = {
            attributionContextFiles: 0,
            baseFactsLoaded: changedFiles,
            changedFiles,
            deletedFiles: 0,
            factBytes,
            plannedRows,
            probedDependencyPaths: 0,
            sourceBytes,
            totalFiles: changedFiles + unrelatedFiles,
            inventoryFilesInspected: changedFiles + unrelatedFiles,
          };
          expect(codeGraphIncrementalWorkFitsBudget(work)).toBe(true);
          expect(codeGraphIncrementalWorkFitsBudget({...work, totalFiles: work.totalFiles + 10_000_000})).toBe(true);
          expect(
            codeGraphIncrementalWorkFitsBudget({
              ...work,
              changedFiles: Math.max(1, Math.floor(changedFiles / 2)),
              factBytes: Math.floor(factBytes / 2),
              plannedRows: Math.max(1, Math.floor(plannedRows / 2)),
              sourceBytes: Math.floor(sourceBytes / 2),
            }),
          ).toBe(true);
        },
      ),
      {numRuns: 250},
    );

    const boundary = {
      attributionContextFiles: 10_000,
      baseFactsLoaded: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
      changedFiles: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
      deletedFiles: 0,
      factBytes: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FACT_BYTES,
      plannedRows: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_ROWS,
      probedDependencyPaths: 4_096,
      sourceBytes: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_SOURCE_BYTES,
      totalFiles: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
      inventoryFilesInspected: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES,
    };
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, changedFiles: boundary.changedFiles + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, factBytes: boundary.factBytes + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, plannedRows: boundary.plannedRows + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, sourceBytes: boundary.sourceBytes + 1})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, attributionContextFiles: 10_001})).toBe(false);
    expect(
      codeGraphIncrementalWorkFitsBudget({
        ...boundary,
        baseFactsLoaded: CODE_GRAPH_INCREMENTAL_REWRITE_MAX_FILES + 1,
      }),
    ).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, probedDependencyPaths: 4_097})).toBe(false);
    expect(codeGraphIncrementalWorkFitsBudget({...boundary, inventoryFilesInspected: boundary.totalFiles + 1})).toBe(
      false,
    );
  });
});
