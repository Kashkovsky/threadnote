import type {CodeGraphQueryResult} from '../code_graph/types.js';
import {UNAVAILABLE_IMPACT_BASE_WARNING} from '../code_graph/query_impact_base.js';
import {sha256HexSync} from '../crypto/sha256.js';
import type {MemoryRecord} from '../memory/document.js';

export const MAXIMUM_CONTEXT_CHECK_CAPTURE_ADVISORIES = 8 as const;

export type ContextCheckGraphImpactEvidenceV1 =
  | {
      readonly reason: 'graph-impact-evidence-incomplete' | 'graph-impact-evidence-unavailable';
      readonly status: 'unknown';
    }
  | {
      readonly captureAdvisoryIds: readonly string[];
      readonly impactedMemoryUris: readonly string[];
      readonly status: 'complete';
    };

export function selectContextCheckGraphImpact(
  result: CodeGraphQueryResult | undefined,
  records: readonly MemoryRecord[],
  repositoryId: string,
  changedPaths: readonly string[],
  directlyAffectedMemoryUris: readonly string[],
): ContextCheckGraphImpactEvidenceV1 {
  if (result === undefined || result.operation !== 'impact' || result.repository.repositoryId !== repositoryId) {
    return {reason: 'graph-impact-evidence-unavailable', status: 'unknown'};
  }
  if (!completeImpactResult(result, changedPaths)) {
    return {reason: 'graph-impact-evidence-incomplete', status: 'unknown'};
  }

  const changed = new Set(changedPaths);
  const indirectlyImpactedNodes = result.nodes.filter(node => !changed.has(node.path));
  const impactedNodeIds = new Set(indirectlyImpactedNodes.map(node => node.id));
  const impactedPaths = new Set(indirectlyImpactedNodes.map(node => node.path));
  const directUris = new Set(directlyAffectedMemoryUris);
  const impactedRecords = records.filter(
    record =>
      !directUris.has(record.uri) &&
      record.metadata.codeCitations?.some(
        citation =>
          citation.repositoryId === repositoryId &&
          (impactedPaths.has(citation.path) ||
            (citation.target.kind === 'symbol' && impactedNodeIds.has(citation.target.nodeId))),
      ) === true,
  );
  const citedNodeIds = new Set<string>();
  const citedPaths = new Set<string>();
  const coveredRecords = records.filter(record => directUris.has(record.uri) || impactedRecords.includes(record));
  for (const record of coveredRecords) {
    for (const citation of record.metadata.codeCitations ?? []) {
      if (citation.repositoryId !== repositoryId) continue;
      citedPaths.add(citation.path);
      if (citation.target.kind === 'symbol') citedNodeIds.add(citation.target.nodeId);
    }
  }
  const uncitedImpactKeys = [
    ...new Set(
      result.nodes.flatMap(node =>
        citedPaths.has(node.path) || citedNodeIds.has(node.id) ? [] : [`${node.path}\u0000${node.id}`],
      ),
    ),
  ].sort(compareText);

  return {
    captureAdvisoryIds: uncitedImpactKeys
      .slice(0, MAXIMUM_CONTEXT_CHECK_CAPTURE_ADVISORIES)
      .map(value => sha256HexSync(`threadnote-context-check-capture-v1\u0000${value}`)),
    impactedMemoryUris: [...new Set(impactedRecords.map(record => record.uri))].sort(compareText),
    status: 'complete',
  };
}

export function citedDocumentCitationUris(
  records: readonly MemoryRecord[],
  repositoryId: string,
  affectedMemoryUris: readonly string[],
): readonly string[] {
  const affected = new Set(affectedMemoryUris);
  return records
    .filter(record => affected.has(record.uri))
    .flatMap(record =>
      (record.metadata.codeCitations ?? []).flatMap(citation =>
        citation.repositoryId === repositoryId && documentationPath(citation.path)
          ? [`${record.uri}#${citation.id}`]
          : [],
      ),
    )
    .sort(compareText);
}

function completeImpactResult(result: CodeGraphQueryResult, changedPaths: readonly string[]): boolean {
  if (result.freshness !== 'current') return false;
  const warnings = result.warnings.filter(warning => warning !== UNAVAILABLE_IMPACT_BASE_WARNING);
  if (warnings.length > 0) return false;
  if (
    result.warnings.includes(UNAVAILABLE_IMPACT_BASE_WARNING) &&
    !changedPaths.every(path => result.nodes.some(node => node.path === path))
  ) {
    return false;
  }
  const coverage = result.searchCoverage;
  return (
    coverage === undefined ||
    ((coverage.status === 'found' || coverage.status === 'exhaustive') && coverage.limitsReached.length === 0)
  );
}

function documentationPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    normalized.startsWith('docs/') ||
    /(?:^|\/)(?:agents|claude|readme)\.md$/u.test(normalized) ||
    /\.(?:adoc|md|mdx|rst|txt)$/u.test(normalized)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
