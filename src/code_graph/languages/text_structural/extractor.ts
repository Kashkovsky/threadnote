import {Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import type {CodeGraphExtractionContext} from '../types.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../../types.js';

interface MutableTextFacts {
  readonly diagnostics: string[];
  readonly domain: string;
  readonly edges: CodeGraphEdge[];
  readonly file: CodeGraphInventoryFile;
  readonly module: CodeGraphSymbol;
  readonly packageName: string | undefined;
  readonly references: CodeGraphReference[];
  readonly symbols: CodeGraphSymbol[];
}

const MAX_TEXT_STRUCTURAL_SYMBOLS = 4_000;
const MAX_TEXT_STRUCTURAL_EDGES = 8_000;

export function extractTextStructuralFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
  domain: string,
): CodeGraphFileFacts {
  if (file.content === undefined)
    throw new Error(`Repository content for ${file.path} was not loaded before extraction.`);
  const facts = createFacts(file, context, domain);
  if (file.language === 'fortran') extractFortran(facts);
  else if (file.language === 'apex' || file.language === 'apex-trigger') extractApex(facts);
  else if (file.language === 'razor') extractRazor(facts);
  return {
    diagnostics: facts.diagnostics,
    edges: facts.edges,
    path: file.path,
    references: facts.references,
    symbols: facts.symbols,
  };
}

function extractFortran(facts: MutableTextFacts): void {
  const content = facts.file.content!;
  const scopes: CodeGraphSymbol[] = [facts.module];
  if (/^\s*#/m.test(content)) {
    facts.diagnostics.push(`${facts.file.path}: preprocessor directives were indexed without macro expansion`);
  }
  for (const line of linesWithOffsets(content)) {
    if (/^[cC*!]/.test(line.text)) continue;
    const source = stripLineComment(line.text, '!').trim();
    if (!source || /^#/.test(source)) continue;
    if (
      /^end\s*$/i.test(source) ||
      /^end\s+(?:program|module|submodule|subroutine|function|type|interface)\b/i.test(source)
    ) {
      if (scopes.length > 1) scopes.pop();
      continue;
    }
    const parent = scopes.at(-1)!;
    const declaration = fortranDeclaration(source);
    if (declaration) {
      const symbol = addDeclaration(
        facts,
        parent,
        declaration.kind,
        declaration.name.toLowerCase(),
        line.start,
        line.end,
        !/^\s*private\b/i.test(source),
      );
      if (declaration.scoped) scopes.push(symbol);
    }
    const owner = scopes.at(-1)!;
    const used = /^use(?:\s*,[^:]*)?\s*(?:::\s*)?([A-Za-z_]\w*)/i.exec(source);
    if (used) addReference(facts, owner, used[1]!.toLowerCase(), 'imports', 'declared', line.start, line.end);
    const included = /^include\s*["']([^"']+)["']/i.exec(source);
    if (included) addReference(facts, owner, included[1]!, 'imports', 'declared', line.start, line.end);
    for (const call of source.matchAll(/\bcall\s+([A-Za-z_]\w*)/gi)) {
      addReference(facts, owner, call[1]!.toLowerCase(), 'calls', 'syntactic', line.start, line.end);
    }
  }
  addBoundDiagnostic(facts);
}

function fortranDeclaration(
  source: string,
): {readonly kind: string; readonly name: string; readonly scoped: boolean} | undefined {
  const program = /^program\s+([A-Za-z_]\w*)/i.exec(source);
  if (program) return {kind: 'program', name: program[1]!, scoped: true};
  const submodule = /^submodule\s*\([^)]*\)\s*([A-Za-z_]\w*)/i.exec(source);
  if (submodule) return {kind: 'submodule', name: submodule[1]!, scoped: true};
  const module = /^module\s+(?!procedure\b)([A-Za-z_]\w*)/i.exec(source);
  if (module) return {kind: 'module', name: module[1]!, scoped: true};
  const subroutine = /^(?:(?:pure|elemental|recursive|impure|module)\s+)*subroutine\s+([A-Za-z_]\w*)/i.exec(source);
  if (subroutine) return {kind: 'subroutine', name: subroutine[1]!, scoped: true};
  const fn =
    /^(?:(?:pure|elemental|recursive|impure|module)\s+)*(?:(?:integer|real|logical|character|complex|double\s+precision|type\s*\([^)]*\)|class\s*\([^)]*\))(?:\s*\([^)]*\)|\s*,[^:]*)?\s+)?function\s+([A-Za-z_]\w*)/i.exec(
      source,
    );
  if (fn) return {kind: 'function', name: fn[1]!, scoped: true};
  const type = /^type\s*(?:,[^:]*)?::\s*([A-Za-z_]\w*)/i.exec(source);
  if (type) return {kind: 'type', name: type[1]!, scoped: true};
  const namedInterface = /^interface\s+([A-Za-z_]\w*)/i.exec(source);
  if (namedInterface) return {kind: 'interface', name: namedInterface[1]!, scoped: true};
  return undefined;
}

function extractApex(facts: MutableTextFacts): void {
  const content = stripCStyleComments(facts.file.content!);
  const scopes: Array<{readonly bodyDepth: number; readonly symbol: CodeGraphSymbol}> = [];
  let braceDepth = 0;
  for (const line of linesWithOffsets(content)) {
    while (scopes.length > 0 && braceDepth < scopes.at(-1)!.bodyDepth) scopes.pop();
    const source = line.text.trim();
    const parent = scopes.at(-1)?.symbol ?? facts.module;
    let declaredScope: CodeGraphSymbol | undefined;
    const trigger = /^trigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_]\w*)\s*\(/i.exec(source);
    const type =
      /^(?:(?:@[A-Za-z_]\w*(?:\([^)]*\))?\s*)*)(?:(?:public|private|protected|global|abstract|virtual|static|final|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+)*(class|interface|enum)\s+([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_]\w*))?(?:\s+implements\s+([A-Za-z_][\w\s,]*))?/i.exec(
        source,
      );
    if (trigger) {
      declaredScope = addDeclaration(facts, parent, 'trigger', trigger[1]!, line.start, line.end, true);
      addReference(facts, declaredScope, trigger[2]!, 'references', 'syntactic', line.start, line.end);
    } else if (type) {
      declaredScope = addDeclaration(
        facts,
        parent,
        type[1]!.toLowerCase(),
        type[2]!,
        line.start,
        line.end,
        !/\bprivate\b/i.test(source),
      );
      if (type[3]) addReference(facts, declaredScope, type[3]!, 'extends', 'syntactic', line.start, line.end);
      for (const implemented of (type[4] ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)) {
        addReference(facts, declaredScope, implemented, 'implements', 'syntactic', line.start, line.end);
      }
    } else if (scopes.length > 0) {
      const method =
        /^(?:(?:@[A-Za-z_]\w*(?:\([^)]*\))?\s*)*)(?:(?:public|private|protected|global|webservice|static|abstract|virtual|override|final|testmethod)\s+)+[A-Za-z_][\w<>[\],.]*\s+([A-Za-z_]\w*)\s*\([^)]*\)/i.exec(
          source,
        );
      if (method && !APEX_CONTROL_WORDS.has(method[1]!.toLowerCase())) {
        addDeclaration(facts, parent, 'method', method[1]!, line.start, line.end, !/\bprivate\b/i.test(source));
      }
    }
    const owner = declaredScope ?? parent;
    for (const query of source.matchAll(/\[\s*select\b[^\]]*?\bfrom\s+([A-Za-z_]\w*)/gi)) {
      addReference(facts, owner, query[1]!, 'references', 'syntactic', line.start, line.end);
    }
    const opens = countCharacterOutsideStrings(source, '{');
    const closes = countCharacterOutsideStrings(source, '}');
    if (declaredScope && opens > 0) scopes.push({bodyDepth: braceDepth + opens, symbol: declaredScope});
    braceDepth = Math.max(0, braceDepth + opens - closes);
  }
  addBoundDiagnostic(facts);
}

const APEX_CONTROL_WORDS = new Set(['catch', 'for', 'if', 'switch', 'while']);

function extractRazor(facts: MutableTextFacts): void {
  const content = facts.file.content!;
  for (const line of linesWithOffsets(content)) {
    const directive = /^\s*@(using|inject|inherits|model)\s+([\w.<>,[\]]+)/.exec(line.text);
    if (directive) {
      const relation: CodeGraphRelation =
        directive[1] === 'inherits' ? 'extends' : directive[1] === 'model' ? 'references' : 'imports';
      addReference(facts, facts.module, directive[2]!, relation, 'declared', line.start, line.end);
    }
    const page = /^\s*@page\s+["']([^"']+)["']/.exec(line.text);
    if (page) addDeclaration(facts, facts.module, 'route', page[1]!, line.start, line.end, true);
  }
  const component = /<([A-Z][A-Za-z0-9_.]*)(?=[\s/>])/g;
  for (const match of content.matchAll(component)) {
    if (RAZOR_HTML_TAGS.has(match[1]!)) continue;
    const start = match.index ?? 0;
    addReference(facts, facts.module, match[1]!, 'constructs', 'syntactic', start, start + match[0].length);
  }
  for (const block of razorCodeBlocks(content)) {
    const method =
      /\b(?:(?:public|private|protected|internal|static|async|override|virtual|abstract|sealed|partial)\s+)+[A-Za-z_][\w<>[\],.?\s]*?\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:=>|\{)/g;
    for (const match of block.content.matchAll(method)) {
      const start = block.start + (match.index ?? 0);
      addDeclaration(
        facts,
        facts.module,
        'method',
        match[1]!,
        start,
        start + match[0].length,
        !/\bprivate\b/.test(match[0]),
      );
    }
  }
  addBoundDiagnostic(facts);
}

const RAZOR_HTML_TAGS = new Set([
  'Body',
  'Button',
  'Div',
  'DOCTYPE',
  'Form',
  'Head',
  'Html',
  'Input',
  'Label',
  'Link',
  'Main',
  'Meta',
  'Option',
  'Script',
  'Section',
  'Select',
  'Span',
  'Style',
  'Table',
  'Textarea',
  'Title',
]);

function razorCodeBlocks(content: string): readonly {readonly content: string; readonly start: number}[] {
  const output: Array<{content: string; start: number}> = [];
  for (const match of content.matchAll(/@code\s*\{/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let quote = '';
    let escaped = false;
    let position = start;
    for (; position < content.length && depth > 0; position += 1) {
      const character = content[position]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
    }
    if (depth === 0) output.push({content: content.slice(start, position - 1), start});
  }
  return output;
}

function createFacts(
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
  domain: string,
): MutableTextFacts {
  const packageName = Option.getOrUndefined(context.packageName);
  const module = textSymbol(
    file,
    packageName,
    domain,
    'module',
    file.path,
    file.path,
    0,
    Math.min(1, file.content!.length),
    true,
  );
  return {diagnostics: [], domain, edges: [], file, module, packageName, references: [], symbols: [module]};
}

function addDeclaration(
  facts: MutableTextFacts,
  parent: CodeGraphSymbol,
  kind: string,
  name: string,
  start: number,
  end: number,
  exported: boolean,
): CodeGraphSymbol {
  if (facts.symbols.length >= MAX_TEXT_STRUCTURAL_SYMBOLS) return parent;
  const qualifiedName = parent === facts.module ? name : `${parent.qualifiedName}.${name}`;
  const symbol = textSymbol(
    facts.file,
    facts.packageName,
    facts.domain,
    kind,
    name,
    qualifiedName,
    start,
    end,
    exported,
  );
  facts.symbols.push(symbol);
  facts.edges.push(resolvedEdge(facts, parent, symbol, 'contains', start, end));
  return symbol;
}

function textSymbol(
  file: CodeGraphInventoryFile,
  packageName: string | undefined,
  domain: string,
  kind: string,
  name: string,
  qualifiedName: string,
  start: number,
  end: number,
  exported: boolean,
): CodeGraphSymbol {
  const normalizedQualifiedName = normalizeLookupName(qualifiedName);
  const normalizedName = normalizeLookupName(name).split('.').at(-1) ?? normalizeLookupName(name);
  return {
    contentHash: file.contentHash,
    exported,
    id: `cgs_${sha256HexSync(`text-structural-symbol-v1\n${file.path}\n${file.language}\n${kind}\n${qualifiedName}\n${start}`).slice(0, 32)}`,
    kind,
    language: file.language,
    lookupKeys: [`${domain}:q:${normalizedQualifiedName}`, `${domain}:name:${normalizedName}`],
    name,
    packageName,
    path: file.path,
    qualifiedName,
    resolutionDomain: domain,
    span: textSpan(file.content!, start, end),
  };
}

function resolvedEdge(
  facts: MutableTextFacts,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  start: number,
  end: number,
): CodeGraphEdge {
  const provenance = 'syntactic' as const;
  return {
    confidence: 0.75,
    evidencePath: facts.file.path,
    evidenceSpan: textSpan(facts.file.content!, start, end),
    id: textEdgeId(facts.file.path, source.id, relation, target.id, provenance),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function addReference(
  facts: MutableTextFacts,
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  provenance: CodeGraphProvenance,
  start: number,
  end: number,
): void {
  if (facts.edges.length >= MAX_TEXT_STRUCTURAL_EDGES) return;
  const normalized = normalizeLookupName(targetName);
  if (!normalized) return;
  const edge: CodeGraphEdge = {
    confidence: provenance === 'declared' ? 1 : 0.75,
    evidencePath: facts.file.path,
    evidenceSpan: textSpan(facts.file.content!, start, end),
    id: textEdgeId(facts.file.path, source.id, relation, targetName, provenance),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  };
  if (facts.edges.some(candidate => candidate.id === edge.id)) return;
  facts.edges.push(edge);
  facts.references.push({
    edgeId: edge.id,
    evidencePath: edge.evidencePath,
    evidenceSpan: edge.evidenceSpan,
    lookupTiers: [
      [`${facts.domain}:q:${normalized}`],
      [`${facts.domain}:name:${normalized.split('.').at(-1) ?? normalized}`],
    ],
    provenance,
    relation,
    resolutionDomain: facts.domain,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  });
}

function addBoundDiagnostic(facts: MutableTextFacts): void {
  if (facts.symbols.length >= MAX_TEXT_STRUCTURAL_SYMBOLS || facts.edges.length >= MAX_TEXT_STRUCTURAL_EDGES) {
    facts.diagnostics.push(`${facts.file.path}: text-structural extraction reached its deterministic bound`);
  }
}

function textEdgeId(path: string, source: string, relation: string, target: string, provenance: string): string {
  return `cge_${sha256HexSync(`text-structural-edge-v1\n${path}\n${source}\n${relation}\n${target}\n${provenance}`).slice(0, 32)}`;
}

function textSpan(content: string, start: number, end: number): CodeGraphSpan {
  const boundedStart = Math.max(0, Math.min(content.length, start));
  const boundedEnd = Math.max(boundedStart, Math.min(content.length, end));
  const before = content.slice(0, boundedStart);
  const through = content.slice(0, boundedEnd);
  return {
    column: boundedStart - before.lastIndexOf('\n'),
    endColumn: boundedEnd - through.lastIndexOf('\n'),
    endLine: through.split('\n').length,
    line: before.split('\n').length,
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

function stripLineComment(value: string, marker: string): string {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index + 1] === quote) index += 1;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === marker) return value.slice(0, index);
  }
  return value;
}

function stripCStyleComments(value: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1;
      output += '\n';
    } else if (character === '/' && next === '*') {
      index += 2;
      while (index < value.length - 1 && !(value[index] === '*' && value[index + 1] === '/')) {
        output += value[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
    } else output += character;
  }
  return output;
}

function countCharacterOutsideStrings(value: string, expected: string): number {
  let count = 0;
  let quote = '';
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === expected) count += 1;
  }
  return count;
}

function normalizeLookupName(value: string): string {
  return value
    .trim()
    .replace(/^(?:&|\*|::)+/, '')
    .replace(/(?:->|::|\\|\/)+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.+/g, '.')
    .toLowerCase();
}
