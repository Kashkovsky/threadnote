import {Effect, Option} from 'effect';
import ts from 'typescript-compiler';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {extractFileFacts} from '../../extractor.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../types.js';

const EXTRACTOR_POLICY_VERSION = 'typescript-compiler-v1';

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: file =>
      Effect.try({
        try: () => extractFileFacts(file),
        catch: cause =>
          new CodeGraphLanguagePackError(`Could not extract TypeScript facts from ${file.path}.`, {cause}),
      }),
    version: sha256HexSync(`${EXTRACTOR_POLICY_VERSION}\ntypescript:${ts.version}`),
  },
  files: [
    {kind: 'extension', language: 'typescript', role: 'source', value: '.ts'},
    {kind: 'extension', language: 'typescript', role: 'source', value: '.tsx'},
    {kind: 'extension', language: 'typescript', role: 'source', value: '.mts'},
    {kind: 'extension', language: 'typescript', role: 'source', value: '.cts'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.js'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.jsx'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.mjs'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.cjs'},
  ],
  id: 'typescript',
  resolutionStrategy: {domain: 'typescript', version: 'typescript-modules-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};
