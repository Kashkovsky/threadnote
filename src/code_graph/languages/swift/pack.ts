import {Option} from 'effect';
import type {Node} from 'web-tree-sitter';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {
  extractTreeSitterFacts,
  TREE_SITTER_EXTRACTOR_POLICY_VERSION,
  type TreeSitterLanguageDefinition,
} from '../../tree_sitter/extractor.js';
import {SWIFT_GRAMMAR} from '../tree_sitter_assets.js';
import type {CodeGraphLanguagePack} from '../types.js';

const DECLARATIONS = `
(class_declaration declaration_kind: "class" name: (_) @name) @definition.class
(class_declaration declaration_kind: "struct" name: (_) @name) @definition.struct
(class_declaration declaration_kind: "enum" name: (_) @name) @definition.enum
(class_declaration declaration_kind: "actor" name: (_) @name) @definition.actor
(class_declaration declaration_kind: "extension" name: (_) @name) @definition.extension
(protocol_declaration name: (type_identifier) @name) @definition.protocol
(function_declaration name: (simple_identifier) @name) @definition.function
(protocol_function_declaration name: (simple_identifier) @name) @definition.method
(property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @definition.property
(protocol_property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @definition.property
(init_declaration "init" @name) @definition.initializer
(subscript_declaration "subscript" @name) @definition.subscript
(typealias_declaration name: (_) @name) @definition.type
`;

const METADATA = `
(import_declaration) @metadata.import
`;

const REFERENCES = `
(import_declaration) @reference.import
(call_expression) @reference.call
(inheritance_specifier inherits_from: (user_type (type_identifier) @reference.extend))
(attribute (user_type (type_identifier) @reference.annotation))
(function_declaration
  (modifiers (member_modifier) @_override)
  name: (simple_identifier) @reference.override
  (#eq? @_override "override"))
`;

const definition: TreeSitterLanguageDefinition = {
  asset: SWIFT_GRAMMAR,
  declarationQuery: DECLARATIONS,
  declarationKind: (capture, node) => {
    if (capture !== 'definition.function') return capture.replace(/^definition\./, '');
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'class_body' || current.type === 'protocol_body') return 'method';
      if (current.type === 'source_file') break;
    }
    return 'function';
  },
  exported: node =>
    /\b(?:open|package|public)\b/.test(header(node)) || !/\bprivate\b|\bfileprivate\b/.test(header(node)),
  id: 'swift',
  importFromNode: node => parseSwiftImport(node.text),
  lookupKeysForSymbol: input => swiftKeys(input.qualifiedName, input.metadata, input.arity),
  lookupTiersForReference: input => {
    if (input.relation === 'imports' || /^(?:self|super)(?:\.|$)/.test(input.targetName)) return [];
    const owner = input.owner.qualifiedName.split('.').slice(0, -1).join('.');
    const candidates = [
      ...(owner ? swiftKeys(`${owner}.${input.targetName}`, input.metadata, input.arity) : []),
      ...swiftKeys(input.targetName, input.metadata, input.arity),
    ];
    return candidates.map(key => [key]);
  },
  metadataQuery: METADATA,
  namespaceFromNode: () => Option.none(),
  referenceQuery: REFERENCES,
  referenceRelation: (capture, node) => {
    if (capture === 'reference.call') {
      const target = callTarget(node);
      return /^[A-Z]/.test(target.split('.').at(-1) ?? '') ? 'constructs' : 'calls';
    }
    if (capture === 'reference.import') return 'imports';
    if (capture === 'reference.extend') return 'extends';
    if (capture === 'reference.override') return 'overrides';
    return 'references';
  },
  referenceTarget: (capture, node) => {
    if (capture === 'reference.import') return node.text.replace(/^\s*import\s+/, '').trim();
    return capture === 'reference.call' ? callTarget(node) : node.text;
  },
  resolutionDomain: 'swift',
};

const extractorVersion = sha256HexSync(
  `tree-sitter-swift-v1\n${TREE_SITTER_EXTRACTOR_POLICY_VERSION}\n${SWIFT_GRAMMAR.sha256}\n${DECLARATIONS}\n${METADATA}\n${REFERENCES}`,
);

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [SWIFT_GRAMMAR],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: (file, context) => extractTreeSitterFacts(definition, file, context),
    version: extractorVersion,
  },
  files: [{kind: 'extension', language: 'swift', role: 'source', value: '.swift'}],
  id: 'swift',
  resolutionStrategy: {domain: 'swift', version: 'swift-static-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};

function swiftKeys(
  qualifiedName: string,
  _metadata: {readonly projectName: Option.Option<string>},
  arity: Option.Option<number>,
): readonly string[] {
  const base = `swift:q:${qualifiedName}`;
  return Option.isSome(arity) ? [`${base}#${arity.value}`, base] : [base];
}

function parseSwiftImport(value: string) {
  const module = value
    .replace(/^\s*import\s+/, '')
    .replace(/^(?:class|enum|func|let|protocol|struct|typealias|var)\s+/, '')
    .trim();
  return module
    ? Option.some({
        alias: Option.none<string>(),
        importedName: Option.some(module.split('.').at(-1)!),
        module,
        wildcard: false,
      })
    : Option.none();
}

function callTarget(node: Node): string {
  const target = node.namedChildren.find(child => child.type !== 'call_suffix');
  return target?.text.trim() ?? node.text.split('(', 1)[0]!.trim();
}

function header(node: Node): string {
  return node.text.split(/[{\n]/, 1)[0] ?? '';
}
