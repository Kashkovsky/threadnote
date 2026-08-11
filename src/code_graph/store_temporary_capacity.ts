import {
  codeGraphUtf8ByteLength,
  saturatingCapacityAdd,
  saturatingCapacityMultiply,
  type CodeGraphDirectPersistentCapacityBoundary,
} from './disk_capacity.js';
import {isCodeGraphReferenceWithinCandidateBudget} from './fact_budget.js';
import {symbolTerms} from './store_utilities.js';
import {type CodeGraphWorkspace} from './languages/types.js';
import type {CodeGraphMonikerV1} from './cross_repository/types.js';
import {
  type CodeGraphEdge,
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphReference,
  type CodeGraphSymbol,
} from './types.js';

export interface CodeGraphTemporaryPublicationCounts {
  readonly edges: number;
  readonly files: number;
  readonly lookupKeys: number;
  readonly reexports: number;
  readonly symbols: number;
  readonly terms: number;
  readonly workspaceRows: number;
}

export function temporaryActivationInventoryCapacity(
  files: readonly CodeGraphInventoryFile[],
): CodeGraphDirectPersistentCapacityBoundary {
  return temporaryBoundary('stage temporary code graph inventory', files.length, encodedBytes(files));
}

export function temporaryActivationWorkspaceCapacity(
  workspace: CodeGraphWorkspace,
): CodeGraphDirectPersistentCapacityBoundary {
  const dependencyRows = workspace.projects.reduce(
    (total, project) =>
      saturatingCapacityAdd(
        total,
        project.dependencyDetails.length,
        project.externalDependencies?.length ?? 0,
        project.monikers?.length ?? 0,
      ),
    0,
  );
  return temporaryBoundary(
    'stage temporary code graph workspace',
    saturatingCapacityAdd(workspace.workspaces.length, workspace.projects.length, dependencyRows),
    encodedBytes(workspace),
  );
}

export function temporaryActivationFactsCapacity(
  symbols: readonly CodeGraphSymbol[],
  edges: readonly CodeGraphEdge[],
  references: readonly CodeGraphReference[],
  monikers: readonly CodeGraphMonikerV1[] = [],
): CodeGraphDirectPersistentCapacityBoundary {
  const boundedReferences = references.filter(isCodeGraphReferenceWithinCandidateBudget);
  const lookupRows = symbols.reduce((total, symbol) => saturatingCapacityAdd(total, symbol.lookupKeys?.length ?? 0), 0);
  const termRows = symbols.reduce((total, symbol) => saturatingCapacityAdd(total, symbolTerms(symbol).length), 0);
  const candidateRows = boundedReferences.reduce(
    (total, reference) =>
      saturatingCapacityAdd(
        total,
        reference.lookupTiers.reduce((tierTotal, tier) => saturatingCapacityAdd(tierTotal, tier.length), 0),
      ),
    0,
  );
  const rowCount = saturatingCapacityAdd(
    symbols.length,
    lookupRows,
    termRows,
    edges.length,
    boundedReferences.length,
    candidateRows,
    monikers.length,
    // Every reference can contribute at most one bounded provenance row per
    // candidate. This intentionally over-reserves malformed duplicate input.
    candidateRows,
  );
  return temporaryBoundary(
    'stage temporary code graph facts',
    rowCount,
    encodedBytes([symbols, edges, boundedReferences, monikers]),
  );
}

export function temporaryIncrementalActivationCapacity(
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
  deletedPaths: readonly string[] = [],
): CodeGraphDirectPersistentCapacityBoundary {
  const factsCapacity = temporaryActivationFactsCapacity(
    facts.flatMap(fact => fact.symbols),
    facts.flatMap(fact => fact.edges),
    facts.flatMap(fact => fact.references ?? []),
    facts.flatMap(fact => fact.monikers ?? []),
  );
  return temporaryBoundary(
    'prepare temporary incremental code graph activation',
    saturatingCapacityAdd(
      files.length,
      deletedPaths.length,
      factsCapacity.rowCount,
      // Replacement deletes and reinserts each staged row; reserve a second
      // copy so the preflight cannot rely on SQLite freeing pages immediately.
      factsCapacity.rowCount,
    ),
    saturatingCapacityAdd(encodedBytes([files, deletedPaths]), factsCapacity.finalFactBytes),
  );
}

export function temporaryActivationPublicationCapacity(
  counts: CodeGraphTemporaryPublicationCounts,
): CodeGraphDirectPersistentCapacityBoundary {
  const values = Object.values(counts);
  const valid = values.every(value => Number.isSafeInteger(value) && value >= 0);
  const sourceRows = valid ? values.reduce((total, value) => saturatingCapacityAdd(total, value), 0) : Number.NaN;
  return {
    finalFactBytes: 0,
    operation: 'publish temporary code graph snapshot',
    // Copy rows plus compact lexical dictionaries, receipts, state, leases,
    // deletion markers, and analysis aggregates. The 2x source-row envelope
    // is conservative while row calibration supplies the byte floor.
    rowCount: valid ? saturatingCapacityAdd(saturatingCapacityMultiply(sourceRows, 2), 32) : Number.NaN,
    transientFilesystem: 'durable',
  };
}

function temporaryBoundary(
  operation: Extract<
    CodeGraphDirectPersistentCapacityBoundary['operation'],
    | 'prepare temporary incremental code graph activation'
    | 'stage temporary code graph facts'
    | 'stage temporary code graph inventory'
    | 'stage temporary code graph workspace'
  >,
  rowCount: number,
  finalFactBytes: number,
): CodeGraphDirectPersistentCapacityBoundary {
  return {
    finalFactBytes,
    mainFilesystem: 'temporary',
    operation,
    rowCount,
    transientFilesystem: 'temporary',
  };
}

function encodedBytes(value: unknown): number {
  try {
    return codeGraphUtf8ByteLength(JSON.stringify(value));
  } catch {
    return Number.NaN;
  }
}
