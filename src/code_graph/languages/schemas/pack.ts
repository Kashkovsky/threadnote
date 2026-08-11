import {Effect, Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {extractStructuredSchemaFacts} from './extractor.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../types.js';

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['declarations', 'dependencies', 'imports']),
  extractor: {
    extract: (file, context) =>
      Effect.try({
        try: () => extractStructuredSchemaFacts(file, context),
        catch: cause =>
          new CodeGraphLanguagePackError(`Could not extract structured facts from ${file.path}.`, {cause}),
      }),
    version: sha256HexSync('threadnote-structured-schema-extractors-v8-bounded-generic-objects-protobuf-monikers'),
  },
  files: [
    {kind: 'extension', language: 'sql', role: 'source', value: '.sql'},
    {kind: 'extension', language: 'json', role: 'source', value: '.json'},
    {kind: 'extension', language: 'jsonc', role: 'source', value: '.jsonc'},
    {kind: 'extension', language: 'yaml', role: 'source', value: '.yaml'},
    {kind: 'extension', language: 'yaml', role: 'source', value: '.yml'},
    {kind: 'extension', language: 'toml', role: 'source', value: '.toml'},
    {kind: 'extension', language: 'ini', role: 'source', value: '.ini'},
    {kind: 'extension', language: 'properties', role: 'source', value: '.properties'},
    {kind: 'extension', language: 'graphql', role: 'source', value: '.graphql'},
    {kind: 'extension', language: 'graphql', role: 'source', value: '.graphqls'},
    {kind: 'extension', language: 'graphql', role: 'source', value: '.gql'},
    {kind: 'extension', language: 'protobuf', role: 'source', value: '.proto'},
    {kind: 'extension', language: 'msbuild', role: 'manifest', value: '.csproj'},
    {kind: 'extension', language: 'msbuild', role: 'manifest', value: '.fsproj'},
    {kind: 'extension', language: 'msbuild', role: 'manifest', value: '.vbproj'},
    {kind: 'extension', language: 'msbuild', role: 'manifest', value: '.props'},
    {kind: 'extension', language: 'msbuild', role: 'manifest', value: '.targets'},
    {kind: 'extension', language: 'xaml', role: 'source', value: '.xaml'},
    {kind: 'extension', language: 'solution', role: 'workspace', value: '.sln'},
    {kind: 'basename', language: 'dockerfile', role: 'manifest', value: 'Dockerfile'},
    {kind: 'basename', language: 'dockerfile', role: 'manifest', value: 'Containerfile'},
  ],
  id: 'schemas',
  resolutionStrategy: {domain: 'structured-schema', version: 'structured-schema-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};
