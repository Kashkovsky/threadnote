import {Effect, Option} from 'effect';
import {Query, type Node, type QueryMatch} from 'web-tree-sitter';
import {sha256HexSync} from '../../crypto/sha256.js';
import type {
  CodeGraphEdge,
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphProvenance,
  CodeGraphReference,
  CodeGraphRelation,
  CodeGraphSpan,
  CodeGraphSymbol,
} from '../types.js';
import {CodeGraphLanguagePackError} from '../languages/types.js';
import type {CodeGraphExtractionContext, VerifiedLanguageAsset} from '../languages/types.js';
import {TreeSitterRuntime} from './runtime.js';

export interface TreeSitterImport {
  readonly alias: Option.Option<string>;
  readonly importedName: Option.Option<string>;
  readonly module: string;
  readonly wildcard: boolean;
}

export interface TreeSitterMetadata {
  readonly imports: readonly TreeSitterImport[];
  readonly namespace: Option.Option<string>;
  readonly projectName: Option.Option<string>;
}

export interface TreeSitterSymbolInput {
  readonly arity: Option.Option<number>;
  readonly kind: string;
  readonly metadata: TreeSitterMetadata;
  readonly name: string;
  readonly qualifiedName: string;
}

export interface TreeSitterReferenceInput {
  readonly arity: Option.Option<number>;
  readonly metadata: TreeSitterMetadata;
  readonly owner: CodeGraphSymbol;
  readonly relation: CodeGraphRelation;
  readonly targetName: string;
}

export interface TreeSitterLanguageDefinition {
  readonly asset: VerifiedLanguageAsset;
  readonly declarationQuery: string;
  readonly declarationKind?: (capture: string, declaration: Node) => string;
  readonly declarationName?: (capture: string, declaration: Node, name: Node) => string;
  readonly exported: (node: Node) => boolean;
  readonly id: string;
  readonly ignoreReference?: (input: TreeSitterReferenceInput) => boolean;
  readonly importFromNode: (node: Node) => Option.Option<TreeSitterImport>;
  readonly lookupTiersForReference: (input: TreeSitterReferenceInput) => readonly (readonly string[])[];
  readonly lookupKeysForSymbol: (input: TreeSitterSymbolInput) => readonly string[];
  readonly metadataQuery: string;
  readonly namespaceFromNode: (node: Node) => Option.Option<string>;
  readonly referenceQuery: string;
  readonly referenceRelation?: (capture: string, node: Node) => CodeGraphRelation;
  readonly referenceTarget?: (capture: string, node: Node) => string;
  readonly resolutionDomain: string;
}

interface Declaration {
  readonly kind: string;
  readonly name: string;
  readonly node: Node;
}

interface MaterializedDeclaration extends Declaration {
  readonly symbol: CodeGraphSymbol;
}

export function extractTreeSitterFacts(
  definition: TreeSitterLanguageDefinition,
  file: CodeGraphInventoryFile,
  context: CodeGraphExtractionContext,
): Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime> {
  if (file.content === undefined) {
    return Effect.fail(languageError(`Repository content for ${file.path} was not loaded before extraction.`));
  }
  return Effect.gen(function* () {
    const runtime = yield* TreeSitterRuntime;
    return yield* runtime
      .withParsedSource(definition.asset, file.content!, parsed => {
        const queries = [
          new Query(parsed.language, definition.metadataQuery),
          new Query(parsed.language, definition.declarationQuery),
          new Query(parsed.language, definition.referenceQuery),
        ] as const;
        try {
          const metadata = extractMetadata(definition, queries[0].matches(parsed.root), context);
          const moduleSymbol = makeModuleSymbol(file, definition, metadata);
          const declarations = materializeDeclarations(
            definition,
            file,
            metadata,
            declarationMatches(definition, queries[1].matches(parsed.root)),
          );
          const symbols = [moduleSymbol, ...declarations.map(declaration => declaration.symbol)];
          const edges: CodeGraphEdge[] = [];
          const references: CodeGraphReference[] = [];
          for (const declaration of declarations) {
            const parent = nearestOwner(declarations, declaration.node, declaration.symbol.id, moduleSymbol);
            edges.push(resolvedEdge(parent, declaration.symbol, 'contains', declaration.node, file.path));
          }
          for (const match of queries[2].matches(parsed.root)) {
            const capture = match.captures.find(candidate => candidate.name.startsWith('reference.'));
            if (!capture) continue;
            const targetName = (definition.referenceTarget?.(capture.name, capture.node) ?? capture.node.text).trim();
            if (!targetName) continue;
            const relation =
              definition.referenceRelation?.(capture.name, capture.node) ??
              relationForCapture(capture.name.replace(/^reference\./, ''));
            const owner = nearestOwner(declarations, capture.node, undefined, moduleSymbol);
            const arity = referenceArity(capture.node);
            const input: TreeSitterReferenceInput = {
              arity,
              metadata,
              owner,
              relation,
              targetName,
            };
            if (definition.ignoreReference?.(input) === true) continue;
            const edge = unresolvedEdge(owner, targetName, relation, capture.node, file.path);
            edges.push(edge);
            references.push({
              arity: Option.getOrUndefined(arity),
              edgeId: edge.id,
              evidencePath: edge.evidencePath,
              evidenceSpan: edge.evidenceSpan,
              lookupTiers: definition.lookupTiersForReference(input),
              provenance: edge.provenance,
              relation,
              resolutionDomain: definition.resolutionDomain,
              sourceId: edge.sourceId,
              sourceName: edge.sourceName,
              targetName,
            });
          }
          const diagnostics = parsed.root.hasError
            ? [`${file.path}: ${definition.id} parser recovered from one or more syntax errors`]
            : [];
          return {diagnostics, edges, path: file.path, references, symbols} satisfies CodeGraphFileFacts;
        } finally {
          for (const query of queries) query.delete();
        }
      })
      .pipe(Effect.mapError(cause => languageError(`${file.path}: ${cause.message}`, cause)));
  });
}

function extractMetadata(
  definition: TreeSitterLanguageDefinition,
  matches: readonly QueryMatch[],
  context: CodeGraphExtractionContext,
): TreeSitterMetadata {
  let namespace = Option.none<string>();
  const imports: TreeSitterImport[] = [];
  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === 'metadata.namespace' && Option.isNone(namespace)) {
        namespace = definition.namespaceFromNode(capture.node);
      } else if (capture.name === 'metadata.import') {
        const parsed = definition.importFromNode(capture.node);
        if (Option.isSome(parsed)) imports.push(parsed.value);
      }
    }
  }
  return {
    imports,
    namespace,
    projectName: Option.map(context.project, project => project.name),
  };
}

function declarationMatches(
  language: TreeSitterLanguageDefinition,
  matches: readonly QueryMatch[],
): readonly Declaration[] {
  const declarations: Declaration[] = [];
  for (const match of matches) {
    const definition = match.captures.find(capture => capture.name.startsWith('definition.'));
    const name = match.captures.find(capture => capture.name === 'name');
    if (!definition || !name) continue;
    const value = (language.declarationName?.(definition.name, definition.node, name.node) ?? name.node.text).trim();
    if (!value) continue;
    declarations.push({
      kind:
        language.declarationKind?.(definition.name, definition.node) ?? definition.name.replace(/^definition\./, ''),
      name: value,
      node: definition.node,
    });
  }
  return [...deduplicateDeclarations(declarations)].sort(
    (left, right) => left.node.startIndex - right.node.startIndex || right.node.endIndex - left.node.endIndex,
  );
}

function materializeDeclarations(
  definition: TreeSitterLanguageDefinition,
  file: CodeGraphInventoryFile,
  metadata: TreeSitterMetadata,
  declarations: readonly Declaration[],
): readonly MaterializedDeclaration[] {
  const output: MaterializedDeclaration[] = [];
  for (const declaration of declarations) {
    const parent = nearestDeclaration(output, declaration.node);
    const namespace = Option.getOrUndefined(metadata.namespace);
    const qualifiedName = [namespace, parent?.symbol.qualifiedName.replace(`${namespace}.`, ''), declaration.name]
      .filter(Boolean)
      .join('.');
    const arity = declarationArity(declaration.node, declaration.kind);
    const signature = boundedSignature(declaration.node.text);
    const lookupKeys = definition.lookupKeysForSymbol({
      arity,
      kind: declaration.kind,
      metadata,
      name: declaration.name,
      qualifiedName,
    });
    const discriminator =
      declaration.kind === 'method' ||
      declaration.kind === 'function' ||
      declaration.kind === 'constructor' ||
      declaration.kind === 'initializer' ||
      declaration.kind === 'subscript'
        ? `${Option.getOrElse(arity, () => -1)}:${sha256HexSync(signature).slice(0, 12)}`
        : '';
    const symbol: CodeGraphSymbol = {
      arity: Option.getOrUndefined(arity),
      contentHash: file.contentHash,
      documentation: leadingDocumentation(declaration.node),
      exported: definition.exported(declaration.node),
      id: treeSitterSymbolId(file.path, file.language, declaration.kind, qualifiedName, discriminator),
      kind: declaration.kind,
      language: file.language,
      lookupKeys,
      name: declaration.name,
      packageName: Option.getOrUndefined(metadata.projectName),
      path: file.path,
      qualifiedName,
      resolutionDomain: definition.resolutionDomain,
      signature: signature || undefined,
      span: nodeSpan(declaration.node),
    };
    output.push({...declaration, symbol});
  }
  return output;
}

function makeModuleSymbol(
  file: CodeGraphInventoryFile,
  definition: TreeSitterLanguageDefinition,
  metadata: TreeSitterMetadata,
): CodeGraphSymbol {
  return {
    contentHash: file.contentHash,
    exported: true,
    id: treeSitterSymbolId(file.path, file.language, 'module', file.path, ''),
    kind: 'module',
    language: file.language,
    lookupKeys: [],
    name: file.path,
    packageName: Option.getOrUndefined(metadata.projectName),
    path: file.path,
    qualifiedName: file.path,
    resolutionDomain: definition.resolutionDomain,
    span: {column: 1, endColumn: 1, endLine: 1, line: 1},
  };
}

function nearestDeclaration(
  declarations: readonly MaterializedDeclaration[],
  node: Node,
): MaterializedDeclaration | undefined {
  let best: MaterializedDeclaration | undefined;
  for (const declaration of declarations) {
    if (
      declaration.node.startIndex <= node.startIndex &&
      declaration.node.endIndex >= node.endIndex &&
      (!best || declaration.node.startIndex > best.node.startIndex || declaration.node.endIndex < best.node.endIndex)
    ) {
      best = declaration;
    }
  }
  return best;
}

function nearestOwner(
  declarations: readonly MaterializedDeclaration[],
  node: Node,
  excludedSymbolId: string | undefined,
  fallback: CodeGraphSymbol,
): CodeGraphSymbol {
  let best: MaterializedDeclaration | undefined;
  for (const declaration of declarations) {
    if (
      declaration.symbol.id !== excludedSymbolId &&
      declaration.node.startIndex <= node.startIndex &&
      declaration.node.endIndex >= node.endIndex &&
      (!best || declaration.node.startIndex > best.node.startIndex || declaration.node.endIndex < best.node.endIndex)
    ) {
      best = declaration;
    }
  }
  return best?.symbol ?? fallback;
}

function deduplicateDeclarations(declarations: readonly Declaration[]): readonly Declaration[] {
  const unique = new Map<string, Declaration>();
  for (const declaration of declarations) {
    const key = `${declaration.kind}\0${declaration.name}\0${declaration.node.startIndex}\0${declaration.node.endIndex}`;
    if (!unique.has(key)) unique.set(key, declaration);
  }
  return [...unique.values()];
}

function declarationArity(node: Node, kind: string): Option.Option<number> {
  if (!['constructor', 'function', 'initializer', 'method', 'subscript'].includes(kind)) return Option.none();
  const parameters = findFirstDescendant(node, candidate =>
    /^(?:formal_parameters|function_value_parameters|parameter_clause)$/.test(candidate.type),
  );
  if (!parameters) return Option.some(0);
  return Option.some(
    parameters.namedChildren.filter(child =>
      /^(?:class_parameter|formal_parameter|parameter|receiver_parameter|spread_parameter|variable_arity_parameter)$/.test(
        child.type,
      ),
    ).length,
  );
}

function referenceArity(node: Node): Option.Option<number> {
  for (let current: Node | null = node; current; current = current.parent) {
    if (/^(?:argument_list|call_suffix|value_arguments)$/.test(current.type)) {
      const argumentsNode =
        current.type === 'call_suffix'
          ? current.namedChildren.find(child => /^(?:argument_list|value_arguments)$/.test(child.type))
          : current;
      return Option.some(argumentsNode?.namedChildren.length ?? 0);
    }
    if (/declaration$/.test(current.type)) break;
  }
  return Option.none();
}

function findFirstDescendant(node: Node, predicate: (candidate: Node) => boolean): Node | undefined {
  const queue = [...node.namedChildren];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (predicate(candidate)) return candidate;
    queue.push(...candidate.namedChildren);
  }
  return undefined;
}

function resolvedEdge(
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: CodeGraphRelation,
  evidence: Node,
  path: string,
): CodeGraphEdge {
  const provenance: CodeGraphProvenance = 'syntactic';
  return {
    confidence: 0.75,
    evidencePath: path,
    evidenceSpan: nodeSpan(evidence),
    id: treeSitterEdgeId(source.id, source.name, relation, target.id, target.name, provenance, path),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function unresolvedEdge(
  source: CodeGraphSymbol,
  targetName: string,
  relation: CodeGraphRelation,
  evidence: Node,
  path: string,
): CodeGraphEdge {
  const provenance: CodeGraphProvenance = 'syntactic';
  return {
    confidence: 0.75,
    evidencePath: path,
    evidenceSpan: nodeSpan(evidence),
    id: treeSitterEdgeId(source.id, source.name, relation, undefined, targetName, provenance, path),
    provenance,
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetName,
  };
}

function relationForCapture(value: string): CodeGraphRelation {
  if (value === 'call') return 'calls';
  if (value === 'construct') return 'constructs';
  if (value === 'extend') return 'extends';
  if (value === 'implement') return 'implements';
  if (value === 'override') return 'overrides';
  if (value === 'import') return 'imports';
  if (value === 'annotation') return 'references';
  return 'references';
}

function boundedSignature(value: string): string {
  return (value.split(/[{\n]/, 1)[0] ?? '').trim().slice(0, 300);
}

function leadingDocumentation(node: Node): string | undefined {
  const comments: string[] = [];
  for (
    let previous = node.previousNamedSibling;
    previous?.type.includes('comment');
    previous = previous.previousNamedSibling
  ) {
    if (node.startPosition.row - previous.endPosition.row > 2) break;
    comments.unshift(previous.text);
  }
  const documentation = comments
    .join('\n')
    .replace(/^\/\*\*?|\*\/$/g, '')
    .replace(/^\s*(?:\/\/\/?|#|\*)\s?/gm, '')
    .trim();
  return documentation ? documentation.slice(0, 1_024) : undefined;
}

function nodeSpan(node: Node): CodeGraphSpan {
  return {
    column: node.startPosition.column + 1,
    endColumn: node.endPosition.column + 1,
    endLine: node.endPosition.row + 1,
    line: node.startPosition.row + 1,
  };
}

function treeSitterSymbolId(
  path: string,
  language: string,
  kind: string,
  qualifiedName: string,
  discriminator: string,
): string {
  return `cgs_${sha256HexSync(`symbol-v2\n${path}\n${language}\n${kind}\n${qualifiedName}\n${discriminator}`).slice(
    0,
    32,
  )}`;
}

function treeSitterEdgeId(
  sourceId: string | undefined,
  sourceName: string,
  relation: string,
  targetId: string | undefined,
  targetName: string,
  provenance: string,
  path: string,
): string {
  return `cge_${sha256HexSync(
    `edge-v1\n${sourceId ?? sourceName}\n${relation}\n${targetId ?? targetName}\n${provenance}\n${path}`,
  ).slice(0, 32)}`;
}

function languageError(message: string, cause?: unknown): CodeGraphLanguagePackError {
  return new CodeGraphLanguagePackError(message, cause === undefined ? undefined : {cause});
}
