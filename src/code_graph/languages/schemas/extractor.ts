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
  const module = structuredSymbol(
    file,
    packageName,
    'module',
    file.path,
    file.path,
    0,
    Math.min(file.content!.length, 1),
  );
  return {diagnostics: [], edges: [], file, module, packageName, symbols: [module]};
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
    const source = facts.file.language === 'jsonc' ? stripJsonComments(content) : content;
    documents = [JSON.parse(source.replace(/,\s*([}\]])/g, '$1')) as unknown];
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
        `${facts.file.path}#${qualifiedPath.join('.')}`,
        offset,
        offset + Math.max(1, key.length),
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
  for (const line of linesWithOffsets(content)) {
    const tableMatch = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line.text);
    if (tableMatch) {
      const name = tableMatch[1]!.trim();
      table = addDeclaration(facts, facts.module, 'table', name, `${facts.file.path}#${name}`, line.start, line.end);
      continue;
    }
    const keyMatch = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line.text);
    if (!keyMatch) continue;
    const name = keyMatch[1]!;
    addDeclaration(facts, table, 'property', name, `${table.qualifiedName}.${name}`, line.start, line.end);
  }
}

function extractKeyValueConfig(facts: MutableStructuredFacts): void {
  let section = facts.module;
  for (const line of linesWithOffsets(facts.file.content!)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line.text);
    if (sectionMatch) {
      const name = sectionMatch[1]!.trim();
      section = addDeclaration(
        facts,
        facts.module,
        'section',
        name,
        `${facts.file.path}#${name}`,
        line.start,
        line.end,
      );
      continue;
    }
    const keyMatch = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*(?:=|:)/.exec(line.text);
    if (!keyMatch) continue;
    const name = keyMatch[1]!;
    addDeclaration(facts, section, 'property', name, `${section.qualifiedName}.${name}`, line.start, line.end);
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
  const namespace = /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1];
  const expression = /(?:^|[;{}\r\n])\s*(message|enum|service|rpc|oneof)\s+([A-Za-z_]\w*)/gi;
  for (const match of content.matchAll(expression)) {
    const name = match[2]!;
    const offset = match.index ?? 0;
    addDeclaration(
      facts,
      facts.module,
      match[1]!.toLowerCase(),
      name,
      namespace ? `${namespace}.${name}` : name,
      offset,
      offset + match[0].length,
    );
  }
  for (const match of content.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gim)) {
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
): CodeGraphSymbol {
  const symbol = structuredSymbol(facts.file, facts.packageName, kind, name, qualifiedName, start, end);
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
): CodeGraphSymbol {
  return {
    contentHash: file.contentHash,
    exported: true,
    id: `cgs_${sha256HexSync(`structured-symbol-v1\n${file.path}\n${file.language}\n${kind}\n${qualifiedName}`).slice(0, 32)}`,
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
  const before = content.slice(0, boundedStart);
  const through = content.slice(0, boundedEnd);
  const line = before.split('\n').length;
  const endLine = through.split('\n').length;
  return {
    column: boundedStart - before.lastIndexOf('\n'),
    endColumn: boundedEnd - through.lastIndexOf('\n'),
    endLine,
    line,
  };
}

function linesWithOffsets(
  content: string,
): readonly {readonly end: number; readonly start: number; readonly text: string}[] {
  const output: Array<{end: number; start: number; text: string}> = [];
  let start = 0;
  for (const text of content.split(/\r?\n/)) {
    output.push({end: start + text.length, start, text});
    start += text.length + 1;
  }
  return output;
}

function findConfigKey(content: string, key: string, from: number): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:["']${escaped}["']|^|[\\s{,])${escaped}(?=\\s*[:=])`, 'm').exec(content.slice(from));
  return match ? from + match.index + Math.max(0, match[0].lastIndexOf(key)) : Math.min(content.length, from);
}

function stripJsonComments(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    const next = value[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < value.length - 1 && !(value[index] === '*' && value[index + 1] === '/')) {
        output += value[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function normalizeSqlIdentifier(value: string): string {
  return value
    .replace(/[\s`"[\]]/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}
