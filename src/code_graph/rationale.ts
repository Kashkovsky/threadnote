import {sha256HexSync} from '../crypto/sha256.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphRationaleInput,
  CodeGraphSymbol,
} from './types.js';

export const CODE_GRAPH_RATIONALE_INPUT_VERSION = 'rationale-input-v1' as const;
export const CODE_GRAPH_RATIONALE_EXTRACTOR_VERSION = 'rationale-v1' as const;

const RATIONALE_MARKER =
  /(?:^|\s)(?:\/\/|\/\*+|\*|#|--|<!--)\s*(NOTE|WHY|HACK|RATIONALE|DECISION|SAFETY|INVARIANT)\s*[:-]\s*(.+?)(?:\*\/|-->)?\s*$/i;
const DESIGN_REFERENCE = /\b(?:ADR|RFC)[- #:]?\d{2,6}\b/gi;
const RATIONALE_PREFILTER = /\b(?:NOTE|WHY|HACK|RATIONALE|DECISION|SAFETY|INVARIANT|ADR|RFC)\b/i;

export function captureRationaleInputs(file: CodeGraphInventoryFile, facts: CodeGraphFileFacts): CodeGraphFileFacts {
  if (file.content === undefined) return facts;
  const rationale = rationaleCandidates(file.content);
  if (rationale.length === 0) return facts;
  return {
    ...facts,
    derivationInputs: {...facts.derivationInputs, rationale},
  };
}

export function augmentRationaleFacts(file: CodeGraphInventoryFile, facts: CodeGraphFileFacts): CodeGraphFileFacts {
  const candidates =
    facts.derivationInputs?.rationale ?? (file.content === undefined ? [] : rationaleCandidates(file.content));
  if (candidates.length === 0) return facts;
  const symbols = [...facts.symbols];
  const edges = [...facts.edges];
  for (const [index, candidate] of candidates.entries()) {
    const rationale = rationaleSymbol(file, candidate, index);
    symbols.push(rationale);
    const owners = rationaleOwners(facts.symbols, candidate);
    for (const owner of owners) edges.push(rationaleEdge(file, rationale, owner, candidate.line));
  }
  return {...facts, edges, symbols};
}

function rationaleCandidates(content: string): readonly CodeGraphRationaleInput[] {
  // Most source and almost all large data files have no rationale marker. Avoid
  // allocating an array containing every line merely to prove that fact.
  if (!RATIONALE_PREFILTER.test(content)) return [];
  const output: CodeGraphRationaleInput[] = [];
  const seen = new Set<string>();
  let lineNumber = 1;
  let offset = 0;
  while (offset <= content.length) {
    const newline = content.indexOf('\n', offset);
    const end = newline < 0 ? content.length : newline;
    const line = content.slice(offset, end);
    const marker = RATIONALE_MARKER.exec(line);
    if (marker) {
      const name = marker[1].toUpperCase();
      const documentation = marker[2].trim();
      const key = `${lineNumber}\0${name}\0${documentation}`;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({documentation, line: lineNumber, marker: name, name: `${name}: ${shortName(documentation)}`});
      }
    }
    for (const reference of line.matchAll(DESIGN_REFERENCE)) {
      const name = reference[0].replace(/[ #:-]+/, '-').toUpperCase();
      const key = `${lineNumber}\0REFERENCE\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        documentation: line.trim(),
        line: lineNumber,
        marker: 'REFERENCE',
        name,
      });
    }
    if (newline < 0) break;
    offset = newline + 1;
    lineNumber += 1;
  }
  return output;
}

function rationaleSymbol(
  file: CodeGraphInventoryFile,
  candidate: CodeGraphRationaleInput,
  index: number,
): CodeGraphSymbol {
  const qualifiedName = `${file.path}#rationale-${candidate.line}-${index + 1}`;
  return {
    contentHash: file.contentHash,
    documentation: candidate.documentation,
    exported: false,
    id: `cgs_${sha256HexSync(`${qualifiedName}\0${candidate.marker}\0${candidate.documentation}`).slice(0, 40)}`,
    kind: 'rationale',
    language: file.language,
    lookupKeys: [candidate.name, candidate.marker, qualifiedName],
    name: candidate.name,
    path: file.path,
    qualifiedName,
    resolutionDomain: 'documentation',
    signature: candidate.marker,
    span: {column: 1, endColumn: 1, endLine: candidate.line, line: candidate.line},
  };
}

function rationaleOwners(
  symbols: readonly CodeGraphSymbol[],
  candidate: CodeGraphRationaleInput,
): readonly CodeGraphSymbol[] {
  const enclosing = symbols
    .filter(
      symbol =>
        symbol.kind !== 'rationale' && symbol.span.line <= candidate.line && symbol.span.endLine >= candidate.line,
    )
    .sort((left, right) => spanSize(left) - spanSize(right));
  if (enclosing[0]) return [enclosing[0]];
  const preceding = symbols
    .filter(symbol => symbol.kind !== 'rationale' && symbol.span.line <= candidate.line)
    .sort((left, right) => right.span.line - left.span.line);
  if (preceding[0]) return [preceding[0]];
  return symbols.length > 0 ? [symbols[0]] : [];
}

function rationaleEdge(
  file: CodeGraphInventoryFile,
  rationale: CodeGraphSymbol,
  owner: CodeGraphSymbol,
  line: number,
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: file.path,
    evidenceSpan: {column: 1, endColumn: 1, endLine: line, line},
    id: `cge_${sha256HexSync(`${rationale.id}\0documents\0${owner.id}`).slice(0, 40)}`,
    provenance: 'declared',
    relation: 'documents',
    sourceId: rationale.id,
    sourceName: rationale.name,
    targetId: owner.id,
    targetName: owner.name,
  };
}

function spanSize(symbol: CodeGraphSymbol): number {
  return Math.max(0, symbol.span.endLine - symbol.span.line);
}

function shortName(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}…`;
}
