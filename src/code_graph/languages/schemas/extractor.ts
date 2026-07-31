import * as yaml from 'js-yaml';
import {Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import type {CodeGraphExtractionContext} from '../types.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphRelation,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../../types.js';

interface MutableStructuredFacts {
  readonly diagnostics: string[];
  readonly edges: CodeGraphEdge[];
  readonly file: CodeGraphInventoryFile;
  readonly identityOccurrences: Map<string, number>;
  readonly module: CodeGraphSymbol;
  readonly packageName: string | undefined;
  readonly symbols: CodeGraphSymbol[];
}

const MAX_STRUCTURED_SYMBOLS = 4_000;
const MAX_STRUCTURED_DEPTH = 32;

export function extractStructuredSchemaFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
): CodeGraphFileFacts {
  if (file.content === undefined)
    throw new Error(`Repository content for ${file.path} was not loaded before extraction.`);
  const facts = createFacts(file, context);
  try {
    switch (file.language) {
      case 'sql':
        extractSql(facts);
        break;
      case 'json':
      case 'jsonc':
      case 'yaml':
        extractObjectConfig(facts);
        break;
      case 'toml':
        extractToml(facts);
        break;
      case 'ini':
      case 'properties':
        extractKeyValueConfig(facts);
        break;
      case 'graphql':
        extractGraphql(facts);
        break;
      case 'protobuf':
        extractProtobuf(facts);
        break;
      case 'msbuild':
      case 'xaml':
        extractXml(facts);
        break;
      case 'solution':
        extractSolution(facts);
        break;
      case 'dockerfile':
        extractDockerfile(facts);
        break;
    }
  } catch (cause) {
    facts.diagnostics.push(`${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {diagnostics: facts.diagnostics, edges: facts.edges, path: file.path, symbols: facts.symbols};
}

function createFacts(file: CodeGraphInventoryFile, context: CodeGraphExtractionContext): MutableStructuredFacts {
  const packageName = Option.getOrUndefined(context.packageName);
  const identityOccurrences = new Map<string, number>();
  const module = structuredSymbol(
    file,
    packageName,
    'module',
    file.path,
    file.path,
    0,
    Math.min(file.content!.length, 1),
    file.path,
    identityOccurrences,
  );
  return {diagnostics: [], edges: [], file, identityOccurrences, module, packageName, symbols: [module]};
}

function extractObjectConfig(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  let documents: readonly unknown[];
  if (facts.file.language === 'yaml') {
    documents = [];
    yaml.loadAll(
      content,
      value => {
        documents = [...documents, value];
      },
      {json: true, schema: yaml.FAILSAFE_SCHEMA},
    );
  } else {
    const source = facts.file.language === 'jsonc' ? normalizeJsonc(content) : content;
    documents = [JSON.parse(source) as unknown];
  }
  const seen = new WeakSet<object>();
  let searchFrom = 0;
  const visit = (value: unknown, parent: CodeGraphSymbol, path: readonly string[], depth: number): void => {
    if (depth > MAX_STRUCTURED_DEPTH || facts.symbols.length >= MAX_STRUCTURED_SYMBOLS) return;
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    const entries = Array.isArray(value)
      ? value.flatMap((entry, index) =>
          typeof entry === 'object' && entry !== null ? [[String(index), entry] as const] : [],
        )
      : Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      if (facts.symbols.length >= MAX_STRUCTURED_SYMBOLS) break;
      const qualifiedPath = [...path, key];
      const offset = findConfigKey(content, key, searchFrom);
      searchFrom = Math.max(searchFrom, offset + key.length);
      const symbol = addDeclaration(
        facts,
        parent,
        Array.isArray(value) ? 'item' : 'property',
        key,
        structuredPath(facts.file.path, qualifiedPath),
        offset,
        offset + Math.max(1, key.length),
        `${facts.file.path}#${qualifiedPath.join('.')}`,
      );
      visit(child, symbol, qualifiedPath, depth + 1);
    }
  };
  documents.forEach((document, index) =>
    visit(document, facts.module, documents.length > 1 ? [`document-${index + 1}`] : [], 0),
  );
  if (facts.symbols.length >= MAX_STRUCTURED_SYMBOLS) {
    facts.diagnostics.push(`${facts.file.path}: structured declarations were bounded at ${MAX_STRUCTURED_SYMBOLS}`);
  }
}

function extractToml(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  let table = facts.module;
  let tableIdentityQualifiedName = facts.file.path;
  for (const line of linesWithOffsets(content)) {
    const tableMatch = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line.text);
    if (tableMatch) {
      const name = tableMatch[1]!.trim();
      table = addDeclaration(
        facts,
        facts.module,
        'table',
        name,
        structuredPath(facts.file.path, [name]),
        line.start,
        line.end,
        `${facts.file.path}#${name}`,
      );
      tableIdentityQualifiedName = `${facts.file.path}#${name}`;
      continue;
    }
    const keyMatch = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line.text);
    if (!keyMatch) continue;
    const name = keyMatch[1]!;
    addDeclaration(
      facts,
      table,
      'property',
      name,
      structuredChild(table.qualifiedName, name),
      line.start,
      line.end,
      `${tableIdentityQualifiedName}.${name}`,
    );
  }
}

function extractKeyValueConfig(facts: MutableStructuredFacts): void {
  let section = facts.module;
  let sectionIdentityQualifiedName = facts.file.path;
  for (const line of linesWithOffsets(facts.file.content!)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line.text);
    if (sectionMatch) {
      const name = sectionMatch[1]!.trim();
      section = addDeclaration(
        facts,
        facts.module,
        'section',
        name,
        structuredPath(facts.file.path, [name]),
        line.start,
        line.end,
        `${facts.file.path}#${name}`,
      );
      sectionIdentityQualifiedName = `${facts.file.path}#${name}`;
      continue;
    }
    const keyMatch = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?:=|:)/.exec(line.text);
    if (!keyMatch) continue;
    const name = keyMatch[1]!;
    addDeclaration(
      facts,
      section,
      'property',
      name,
      structuredChild(section.qualifiedName, name),
      line.start,
      line.end,
      `${sectionIdentityQualifiedName}.${name}`,
    );
  }
}

function extractSql(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const declarations: Array<{readonly offset: number; readonly symbol: CodeGraphSymbol}> = [];
  const declaration =
    /(?:^|[;\r\n])\s*create\s+(?:or\s+replace\s+)?(?:global\s+|local\s+)?(?:temporary\s+|temp\s+)?(materialized\s+view|table|view|index|function|procedure|trigger|type|schema|sequence)\s+(?:if\s+not\s+exists\s+)?([`"[]?[A-Za-z_][\w$.-]*(?:\s*\.\s*[`"[]?[A-Za-z_][\w$-]*[`"\]]?)*[`"\]]?)/gi;
  for (const match of content.matchAll(declaration)) {
    const kind = match[1]!.toLowerCase().replace(/\s+/g, '_');
    const name = normalizeSqlIdentifier(match[2]!);
    const offset = match.index ?? 0;
    const symbol = addDeclaration(facts, facts.module, kind, name, name, offset, offset + match[0].length);
    declarations.push({offset, symbol});
  }
  const references =
    /\b(?:references|from|join|update|into)\s+([`"[]?[A-Za-z_][\w$.-]*(?:\s*\.\s*[`"[]?[A-Za-z_][\w$-]*[`"\]]?)*[`"\]]?)/gi;
  for (const match of content.matchAll(references)) {
    const target = normalizeSqlIdentifier(match[1]!);
    if (!target) continue;
    const offset = match.index ?? 0;
    let owner = facts.module;
    for (const candidate of declarations) {
      if (candidate.offset > offset) break;
      owner = candidate.symbol;
    }
    addUnresolvedEdge(facts, owner, target, 'references', 'syntactic', offset, offset + match[0].length);
  }
}

function extractGraphql(facts: MutableStructuredFacts): void {
  const expression =
    /^\s*(extend\s+)?(schema|type|interface|input|enum|scalar|union|directive)\s+@?([_A-Za-z][_0-9A-Za-z]*)/gim;
  for (const match of facts.file.content!.matchAll(expression)) {
    const kind = `${match[1] ? 'extended_' : ''}${match[2]!.toLowerCase()}`;
    const name = match[3]!;
    const offset = match.index ?? 0;
    addDeclaration(facts, facts.module, kind, name, name, offset, offset + match[0].length);
  }
}

function extractProtobuf(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const declarationsSource = maskCStyleNonCode(content, true);
  const commentsMaskedSource = maskCStyleNonCode(content, false);
  const namespace = /^\s*package\s+([\w.]+)\s*;/m.exec(declarationsSource)?.[1];
  const token = /\b(message|enum|service|rpc|oneof)\s+([A-Za-z_]\w*)|[{}]/gi;
  const scopes: Array<CodeGraphSymbol | undefined> = [];
  let pendingScope: CodeGraphSymbol | undefined;
  for (const match of declarationsSource.matchAll(token)) {
    const text = match[0];
    if (text === '{') {
      scopes.push(pendingScope);
      pendingScope = undefined;
      continue;
    }
    if (text === '}') {
      scopes.pop();
      pendingScope = undefined;
      continue;
    }
    const name = match[2]!;
    const kind = match[1]!.toLowerCase();
    const offset = match.index ?? 0;
    const parent = [...scopes].reverse().find((scope): scope is CodeGraphSymbol => scope !== undefined) ?? facts.module;
    const parentQualifiedName = parent === facts.module ? namespace : parent.qualifiedName;
    pendingScope = addDeclaration(
      facts,
      parent,
      kind,
      name,
      parentQualifiedName ? `${parentQualifiedName}.${name}` : name,
      offset,
      offset + text.length,
    );
  }
  for (const match of commentsMaskedSource.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gim)) {
    addUnresolvedEdge(
      facts,
      facts.module,
      match[1]!,
      'imports',
      'declared',
      match.index ?? 0,
      (match.index ?? 0) + match[0].length,
    );
  }
}

function extractXml(facts: MutableStructuredFacts): void {
  const content = facts.file.content!;
  const elements = /<([A-Za-z_][\w:.-]*)([^<>]*?)\/?\s*>/g;
  for (const match of content.matchAll(elements)) {
    if (facts.symbols.length >= MAX_STRUCTURED_SYMBOLS) break;
    const tag = match[1]!;
    const attributes = match[2] ?? '';
    const identity = /\b(?:x:Class|x:Name|Name|Include|Update|Remove|Id)\s*=\s*["']([^"']+)["']/.exec(attributes)?.[1];
    if (!identity && !/^(?:Project|PackageReference|ProjectReference|Target|PropertyGroup|ItemGroup)$/i.test(tag))
      continue;
    const name = identity ?? tag;
    const offset = match.index ?? 0;
    const symbol = addDeclaration(
      facts,
      facts.module,
      tag.toLowerCase(),
      name,
      `${tag}:${name}`,
      offset,
      offset + match[0].length,
    );
    if (/^(?:PackageReference|ProjectReference)$/i.test(tag) && identity) {
      addUnresolvedEdge(facts, symbol, identity, 'depends_on', 'declared', offset, offset + match[0].length);
    }
  }
}

function extractSolution(facts: MutableStructuredFacts): void {
  const expression = /^Project\("[^"\r\n]+"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gim;
  for (const match of facts.file.content!.matchAll(expression)) {
    const offset = match.index ?? 0;
    const symbol = addDeclaration(
      facts,
      facts.module,
      'project',
      match[1]!,
      match[1]!,
      offset,
      offset + match[0].length,
    );
    addUnresolvedEdge(facts, symbol, match[2]!, 'depends_on', 'declared', offset, offset + match[0].length);
  }
}

function extractDockerfile(facts: MutableStructuredFacts): void {
  let stage = facts.module;
  for (const line of linesWithOffsets(facts.file.content!)) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.text);
    if (from) {
      const name = from[2] ?? from[1]!;
      stage = addDeclaration(facts, facts.module, 'stage', name, name, line.start, line.end);
      addUnresolvedEdge(facts, stage, from[1]!, 'depends_on', 'declared', line.start, line.end);
      continue;
    }
    const copy = /^\s*COPY\s+--from=(\S+)/i.exec(line.text);
    if (copy) addUnresolvedEdge(facts, stage, copy[1]!, 'depends_on', 'declared', line.start, line.end);
  }
}

function addDeclaration(
  facts: MutableStructuredFacts,
  parent: CodeGraphSymbol,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  identityQualifiedName: string = qualifiedName,
): CodeGraphSymbol {
  const symbol = structuredSymbol(
    facts.file,
    facts.packageName,
    kind,
    name,
    qualifiedName,
    start,
    end,
    identityQualifiedName,
    facts.identityOccurrences,
  );
  facts.symbols.push(symbol);
  facts.edges.push(resolvedEdge(facts.file, parent, symbol, 'contains', 'syntactic', start, end));
  return symbol;
}

function structuredSymbol(
  file: CodeGraphInventoryFile,
  packageName: string | undefined,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  identityQualifiedName: string,
  identityOccurrences: Map<string, number>,
): CodeGraphSymbol {
  const identityKey = `${kind}\n${identityQualifiedName}`;
  const occurrence = identityOccurrences.get(identityKey) ?? 0;
  identityOccurrences.set(identityKey, occurrence + 1);
  return {
    contentHash: file.contentHash,
    exported: true,
    id:
      occurrence === 0
        ? `cgs_${sha256HexSync(
            `structured-symbol-v1\n${file.path}\n${file.language}\n${kind}\n${identityQualifiedName}`,
          ).slice(0, 32)}`
        : `cgs_${sha256HexSync(
            `structured-symbol-v2\n${file.path}\n${file.language}\n${kind}\n${qualifiedName}\n${occurrence}`,
          ).slice(0, 32)}`,
    kind,
    language: file.language,
    name,
    packageName,
    path: file.path,
    qualifiedName,
    resolutionDomain: 'structured-schema',
    span: textSpan(file.content!, start, end),
  };
}

function structuredPath(filePath: string, segments: readonly string[]): string {
  return `${filePath}#/${segments.map(escapeStructuredSegment).join('/')}`;
}

function structuredChild(parent: string, name: string): string {
  return `${parent}/${escapeStructuredSegment(name)}`;
}

function escapeStructuredSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function resolvedEdge(
  file: CodeGraphInventoryFile,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  start: number,
  end: number,
): CodeGraphEdge {
  return {
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: file.path,
    evidenceSpan: textSpan(file.content!, start, end),
    id: edgeId(file.path, source.id, relation, target.id, provenance),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function addUnresolvedEdge(
  facts: MutableStructuredFacts,
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  start: number,
  end: number,
): void {
  facts.edges.push({
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: facts.file.path,
    evidenceSpan: textSpan(facts.file.content!, start, end),
    id: edgeId(facts.file.path, source.id, relation, targetName, provenance),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  });
}

function edgeId(path: string, source: string, relation: string, target: string, provenance: string): string {
  return `cge_${sha256HexSync(`structured-edge-v1\n${path}\n${source}\n${relation}\n${target}\n${provenance}`).slice(0, 32)}`;
}

function textSpan(content: string, start: number, end: number): CodeGraphSpan {
  const boundedStart = Math.max(0, Math.min(content.length, start));
  const boundedEnd = Math.max(boundedStart, Math.min(content.length, end));
  const from = sourcePositionAt(content, boundedStart);
  const to = sourcePositionAt(content, boundedEnd);
  return {
    column: from.column,
    endColumn: to.column,
    endLine: to.line,
    line: from.line,
  };
}

function linesWithOffsets(
  content: string,
): readonly {readonly end: number; readonly start: number; readonly text: string}[] {
  const output: Array<{end: number; start: number; text: string}> = [];
  let start = 0;
  let cursor = 0;
  while (cursor < content.length) {
    const width = lineTerminatorWidth(content, cursor);
    if (width === 0) {
      cursor += 1;
      continue;
    }
    output.push({end: cursor, start, text: content.slice(start, cursor)});
    cursor += width;
    start = cursor;
  }
  output.push({end: content.length, start, text: content.slice(start)});
  return output;
}

function sourcePositionAt(content: string, offset: number): {readonly column: number; readonly line: number} {
  let column = 1;
  let cursor = 0;
  let line = 1;
  while (cursor < offset) {
    const width = lineTerminatorWidth(content, cursor);
    if (width > 0) {
      cursor += width;
      column = 1;
      line += 1;
    } else {
      cursor += 1;
      column += 1;
    }
  }
  return {column, line};
}

function lineTerminatorWidth(content: string, offset: number): number {
  const character = content[offset];
  if (character === '\r') return content[offset + 1] === '\n' ? 2 : 1;
  return character === '\n' || character === '\u2028' || character === '\u2029' ? 1 : 0;
}

function findConfigKey(content: string, key: string, from: number): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:["']${escaped}["']|^|[\\s{,])${escaped}(?=\\s*[:=])`, 'm').exec(content.slice(from));
  return match ? from + match.index + Math.max(0, match[0].lastIndexOf(key)) : Math.min(content.length, from);
}

function stripJsonComments(value: string): string {
  return maskCStyleNonCode(value, false);
}

function normalizeJsonc(value: string): string {
  const output = stripJsonComments(value).split('');
  let escaped = false;
  let inString = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current !== ',') continue;
    let lookahead = index + 1;
    while (lookahead < output.length && /\s/u.test(output[lookahead]!)) lookahead += 1;
    if (output[lookahead] === '}' || output[lookahead] === ']') output[index] = ' ';
  }
  if (output[0] === '\uFEFF') output[0] = ' ';
  return output.join('');
}

function maskCStyleNonCode(value: string, maskStrings: boolean): string {
  const output = value.split('');
  let mode: 'block-comment' | 'code' | 'line-comment' | 'string' = 'code';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    const next = value[index + 1];
    if (mode === 'line-comment') {
      if (isLineTerminator(current)) mode = 'code';
      else output[index] = ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (current === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        mode = 'code';
      } else if (!isLineTerminator(current)) output[index] = ' ';
      continue;
    }
    if (mode === 'string') {
      if (maskStrings && !isLineTerminator(current)) output[index] = ' ';
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) mode = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      mode = 'line-comment';
    } else if (current === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      mode = 'block-comment';
    } else if (current === '"' || current === "'") {
      if (maskStrings) output[index] = ' ';
      quote = current;
      escaped = false;
      mode = 'string';
    }
  }
  return output.join('');
}

function isLineTerminator(character: string): boolean {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

function normalizeSqlIdentifier(value: string): string {
  return value
    .replace(/[\s`"[\]]/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}
