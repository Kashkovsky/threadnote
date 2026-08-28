import {parseCodeGraphMonikerV1} from './cross_repository/monikers.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSpan,
  CodeGraphSymbol,
} from './types.js';

const ARRAY_ENTRIES_MAXIMUM = 1_000_000;
const PATH_LENGTH_MAXIMUM = 4_096;
const SHORT_TEXT_LENGTH_MAXIMUM = 16_384;
const TEXT_LENGTH_MAXIMUM = 8 * 1_048_576;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROVENANCE = new Set<CodeGraphProvenance>(['declared', 'heuristic', 'model', 'resolved', 'syntactic']);
const RELATIONS = new Set<CodeGraphRelation>([
  'calls',
  'configures',
  'constructs',
  'contains',
  'declares',
  'depends_on',
  'documents',
  'exports',
  'extends',
  'implements',
  'imports',
  'overrides',
  'reads_or_writes',
  'references',
  'reexports',
  'semantic_association',
  'tests',
]);

export class CodeGraphFactValidationError extends Error {
  override readonly name = 'CodeGraphFactValidationError';
}

/** Exact recursive validator for parser facts crossing a durable or portable boundary. */
export function parseCodeGraphFileFacts(value: unknown): CodeGraphFileFacts {
  const input = object(value, 'Code graph file facts');
  exactKeys(input, ['diagnostics', 'edges', 'path', 'symbols'], ['derivationInputs', 'monikers', 'references']);
  repositoryPath(input.path, 'File-fact path');
  stringArray(input.diagnostics, 'File-fact diagnostics', TEXT_LENGTH_MAXIMUM);
  array(input.symbols, 'File-fact symbols').forEach((symbol, index) => parseSymbol(symbol, index));
  array(input.edges, 'File-fact edges').forEach((edge, index) => parseEdge(edge, index));
  if (input.references !== undefined) {
    array(input.references, 'File-fact references').forEach((reference, index) => parseReference(reference, index));
  }
  if (input.monikers !== undefined) {
    array(input.monikers, 'File-fact monikers').forEach((moniker, index) => {
      try {
        parseCodeGraphMonikerV1(moniker);
      } catch (cause) {
        throw new CodeGraphFactValidationError(`File-fact moniker ${index} is invalid.`, {cause});
      }
    });
  }
  if (input.derivationInputs !== undefined) parseDerivationInputs(input.derivationInputs);
  return input as unknown as CodeGraphFileFacts;
}

function parseSymbol(value: unknown, index: number): CodeGraphSymbol {
  const input = object(value, `File-fact symbol ${index}`);
  exactKeys(
    input,
    ['contentHash', 'exported', 'id', 'kind', 'language', 'name', 'path', 'qualifiedName', 'span'],
    ['arity', 'documentation', 'lookupKeys', 'packageName', 'resolutionDomain', 'resolutionScopeId', 'signature'],
  );
  optionalNonNegativeInteger(input.arity, 'Symbol arity');
  digest(input.contentHash, 'Symbol content hash');
  optionalText(input.documentation, 'Symbol documentation');
  bool(input.exported, 'Symbol exported');
  shortText(input.id, 'Symbol ID');
  shortText(input.kind, 'Symbol kind');
  shortText(input.language, 'Symbol language');
  if (input.lookupKeys !== undefined) nonEmptyStringArray(input.lookupKeys, 'Symbol lookup keys', false);
  boundedNonEmptyText(input.name, 'Symbol name');
  optionalBoundedNonEmptyText(input.packageName, 'Symbol package name');
  repositoryPath(input.path, 'Symbol path');
  boundedNonEmptyText(input.qualifiedName, 'Symbol qualified name');
  optionalShortText(input.resolutionDomain, 'Symbol resolution domain');
  optionalShortText(input.resolutionScopeId, 'Symbol resolution scope');
  optionalText(input.signature, 'Symbol signature');
  parseSpan(input.span, 'Symbol span');
  return input as unknown as CodeGraphSymbol;
}

function parseEdge(value: unknown, index: number): CodeGraphEdge {
  const input = object(value, `File-fact edge ${index}`);
  exactKeys(
    input,
    ['confidence', 'evidencePath', 'evidenceSpan', 'id', 'provenance', 'relation', 'sourceName', 'targetName'],
    ['sourceId', 'targetId'],
  );
  finiteRange(input.confidence, 'Edge confidence', 0, 1);
  repositoryPath(input.evidencePath, 'Edge evidence path');
  parseSpan(input.evidenceSpan, 'Edge evidence span');
  shortText(input.id, 'Edge ID');
  provenance(input.provenance, 'Edge provenance');
  relation(input.relation, 'Edge relation');
  optionalShortText(input.sourceId, 'Edge source ID');
  boundedNonEmptyText(input.sourceName, 'Edge source name');
  optionalShortText(input.targetId, 'Edge target ID');
  boundedNonEmptyText(input.targetName, 'Edge target name');
  return input as unknown as CodeGraphEdge;
}

function parseReference(value: unknown, index: number): CodeGraphReference {
  const input = object(value, `File-fact reference ${index}`);
  exactKeys(
    input,
    [
      'edgeId',
      'evidencePath',
      'evidenceSpan',
      'lookupTiers',
      'provenance',
      'relation',
      'resolutionDomain',
      'sourceName',
      'targetName',
    ],
    ['aliasLookupKeys', 'arity', 'exportedOnly', 'sourceId'],
  );
  if (input.aliasLookupKeys !== undefined) {
    nonEmptyStringArray(input.aliasLookupKeys, 'Reference alias lookup keys', false);
  }
  optionalNonNegativeInteger(input.arity, 'Reference arity');
  shortText(input.edgeId, 'Reference edge ID');
  repositoryPath(input.evidencePath, 'Reference evidence path');
  parseSpan(input.evidenceSpan, 'Reference evidence span');
  if (input.exportedOnly !== undefined) bool(input.exportedOnly, 'Reference exported-only state');
  array(input.lookupTiers, 'Reference lookup tiers').forEach((tier, tierIndex) =>
    nonEmptyStringArray(tier, `Reference lookup tier ${tierIndex}`, false),
  );
  provenance(input.provenance, 'Reference provenance');
  relation(input.relation, 'Reference relation');
  shortText(input.resolutionDomain, 'Reference resolution domain');
  optionalShortText(input.sourceId, 'Reference source ID');
  boundedNonEmptyText(input.sourceName, 'Reference source name');
  boundedNonEmptyText(input.targetName, 'Reference target name');
  return input as unknown as CodeGraphReference;
}

function parseDerivationInputs(value: unknown): void {
  const input = object(value, 'File-fact derivation inputs');
  exactKeys(input, [], ['rationale']);
  if (input.rationale === undefined) return;
  array(input.rationale, 'File-fact rationale inputs').forEach((value, index) => {
    const rationale = object(value, `File-fact rationale ${index}`);
    exactKeys(rationale, ['documentation', 'line', 'marker', 'name'], []);
    text(rationale.documentation, 'Rationale documentation');
    positiveInteger(rationale.line, 'Rationale line');
    shortText(rationale.marker, 'Rationale marker');
    boundedNonEmptyText(rationale.name, 'Rationale name');
  });
}

function parseSpan(value: unknown, label: string): CodeGraphSpan {
  const input = object(value, label);
  exactKeys(input, ['column', 'endColumn', 'endLine', 'line'], []);
  positiveInteger(input.column, `${label} column`);
  positiveInteger(input.endColumn, `${label} end column`);
  positiveInteger(input.endLine, `${label} end line`);
  positiveInteger(input.line, `${label} line`);
  if (
    (input.endLine as number) < (input.line as number) ||
    (input.endLine === input.line && (input.endColumn as number) < (input.column as number))
  ) {
    throw new CodeGraphFactValidationError(`${label} ends before it starts.`);
  }
  return input as unknown as CodeGraphSpan;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodeGraphFactValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > ARRAY_ENTRIES_MAXIMUM) {
    throw new CodeGraphFactValidationError(`${label} must be a bounded array.`);
  }
  return value;
}

function exactKeys(input: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(input, key)) throw new CodeGraphFactValidationError(`Code graph facts are missing ${key}.`);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new CodeGraphFactValidationError(`Code graph facts contain unknown field ${key}.`);
  }
}

function text(value: unknown, label: string, maximum = TEXT_LENGTH_MAXIMUM): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new CodeGraphFactValidationError(`${label} must be a bounded string.`);
  }
}

function shortText(value: unknown, label: string): asserts value is string {
  boundedNonEmptyText(value, label);
  if (containsControlCharacter(value)) {
    throw new CodeGraphFactValidationError(`${label} must be non-empty and control-free.`);
  }
}

/**
 * Repository-controlled semantic text may contain terminal controls. It is
 * persisted verbatim for graph fidelity and sanitized only at presentation
 * boundaries; structural IDs and paths remain control-free.
 */
function boundedNonEmptyText(value: unknown, label: string): asserts value is string {
  text(value, label, SHORT_TEXT_LENGTH_MAXIMUM);
  if (value.length === 0) throw new CodeGraphFactValidationError(`${label} must be non-empty.`);
}

function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label);
}

function optionalShortText(value: unknown, label: string): void {
  if (value !== undefined) shortText(value, label);
}

function optionalBoundedNonEmptyText(value: unknown, label: string): void {
  if (value !== undefined) boundedNonEmptyText(value, label);
}

function stringArray(value: unknown, label: string, maximum = SHORT_TEXT_LENGTH_MAXIMUM): void {
  for (const entry of array(value, label)) {
    text(entry, `${label} entry`, maximum);
  }
}

function nonEmptyStringArray(value: unknown, label: string, controlFree: boolean): void {
  for (const entry of array(value, label)) {
    if (controlFree) shortText(entry, `${label} entry`);
    else boundedNonEmptyText(entry, `${label} entry`);
  }
}

function repositoryPath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PATH_LENGTH_MAXIMUM ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    containsControlCharacter(value) ||
    value.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new CodeGraphFactValidationError(`${label} must be a safe repository-relative POSIX path.`);
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new CodeGraphFactValidationError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function bool(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new CodeGraphFactValidationError(`${label} must be boolean.`);
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CodeGraphFactValidationError(`${label} must be a positive safe integer.`);
  }
}

function optionalNonNegativeInteger(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new CodeGraphFactValidationError(`${label} must be a non-negative safe integer.`);
  }
}

function finiteRange(value: unknown, label: string, minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CodeGraphFactValidationError(`${label} must be a finite number between ${minimum} and ${maximum}.`);
  }
}

function provenance(value: unknown, label: string): asserts value is CodeGraphProvenance {
  if (typeof value !== 'string' || !PROVENANCE.has(value as CodeGraphProvenance)) {
    throw new CodeGraphFactValidationError(`${label} is invalid.`);
  }
}

function relation(value: unknown, label: string): asserts value is CodeGraphRelation {
  if (typeof value !== 'string' || !RELATIONS.has(value as CodeGraphRelation)) {
    throw new CodeGraphFactValidationError(`${label} is invalid.`);
  }
}
