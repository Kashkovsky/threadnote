import {Option} from 'effect';
import type {Node} from 'web-tree-sitter';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {extractTreeSitterFacts, type TreeSitterLanguageDefinition} from '../../tree_sitter/extractor.js';
import {jvmReferenceLookupTiers, jvmSymbolLookupKeys, parseJvmImport, parseJvmNamespace} from '../jvm/lookup.js';
import {KOTLIN_GRAMMAR} from '../tree_sitter_assets.js';
import type {CodeGraphLanguagePack} from '../types.js';

const DECLARATIONS = `
(class_declaration (type_identifier) @name) @definition.class
(object_declaration (type_identifier) @name) @definition.object
(companion_object "companion" @name) @definition.object
(function_declaration (simple_identifier) @name) @definition.function
(property_declaration (variable_declaration (simple_identifier) @name)) @definition.property
(type_alias (type_identifier) @name) @definition.type
(class_declaration (type_identifier) @name (primary_constructor) @definition.constructor)
(secondary_constructor "constructor" @name) @definition.constructor
`;

const METADATA = `
(package_header) @metadata.namespace
(import_header) @metadata.import
`;

const REFERENCES = `
(import_header) @reference.import
(call_expression) @reference.call
(delegation_specifier (constructor_invocation (user_type (type_identifier) @reference.extend)))
(delegation_specifier (user_type (type_identifier) @reference.implement))
(annotation (user_type (type_identifier) @reference.annotation))
(function_declaration
  (modifiers (member_modifier) @_override)
  (simple_identifier) @reference.override
  (#eq? @_override "override"))
`;

const definition: TreeSitterLanguageDefinition = {
  asset: KOTLIN_GRAMMAR,
  declarationKind: (capture, node) => {
    if (capture !== 'definition.class') return capture.replace(/^definition\./, '');
    const declaration = header(node);
    if (/\bannotation\s+class\b/.test(declaration)) return 'annotation';
    if (/\benum\s+class\b/.test(declaration)) return 'enum';
    if (/\binterface\b/.test(declaration)) return 'interface';
    return 'class';
  },
  declarationName: (capture, declaration, name) => {
    if (capture === 'definition.object' && declaration.type === 'companion_object') {
      return declaration.namedChildren.find(child => child.type === 'type_identifier')?.text ?? 'Companion';
    }
    if (capture === 'definition.constructor') {
      for (let current = declaration.parent; current; current = current.parent) {
        if (current.type !== 'class_declaration') continue;
        return current.namedChildren.find(child => child.type === 'type_identifier')?.text ?? name.text;
      }
    }
    return name.text;
  },
  declarationQuery: DECLARATIONS,
  exported: node => !/\bprivate\b/.test(header(node)),
  id: 'kotlin',
  importFromNode: node => parseJvmImport(node.text),
  lookupKeysForSymbol: jvmSymbolLookupKeys,
  lookupTiersForReference: jvmReferenceLookupTiers,
  metadataQuery: METADATA,
  namespaceFromNode: node => parseJvmNamespace(node.text),
  referenceQuery: REFERENCES,
  referenceRelation: (capture, node) => {
    if (capture === 'reference.call') {
      const target = callTarget(node);
      return /^[A-Z]/.test(target.split('.').at(-1) ?? '') ? 'constructs' : 'calls';
    }
    if (capture === 'reference.import') return 'imports';
    if (capture === 'reference.extend') return 'extends';
    if (capture === 'reference.implement') return 'implements';
    if (capture === 'reference.override') return 'overrides';
    return 'references';
  },
  referenceTarget: (capture, node) => {
    if (capture === 'reference.import') {
      return node.text
        .replace(/^\s*import\s+/, '')
        .replace(/\s+as\s+[A-Za-z_$][\w$]*\s*$/, '')
        .trim();
    }
    return capture === 'reference.call' ? callTarget(node) : node.text;
  },
  resolutionDomain: 'jvm',
};

const extractorVersion = sha256HexSync(
  `tree-sitter-kotlin-v1\n${KOTLIN_GRAMMAR.sha256}\n${DECLARATIONS}\n${METADATA}\n${REFERENCES}`,
);

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [KOTLIN_GRAMMAR],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: (file, context) => extractTreeSitterFacts(definition, file, context),
    version: extractorVersion,
  },
  files: [
    {kind: 'extension', language: 'kotlin', role: 'source', value: '.kt'},
    {kind: 'extension', language: 'kotlin', role: 'source', value: '.kts'},
  ],
  id: 'kotlin',
  resolutionStrategy: {domain: 'jvm', version: 'jvm-static-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};

function callTarget(node: Node): string {
  const target = node.namedChildren.find(child => child.type !== 'call_suffix');
  return target?.text.trim() ?? node.text.split('(', 1)[0]!.trim();
}

function header(node: Node): string {
  return node.text.split(/[={\n]/, 1)[0] ?? '';
}
