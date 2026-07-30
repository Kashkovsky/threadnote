import {Effect, Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {extractFileFacts} from '../../extractor.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../types.js';

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['declarations', 'documentation']),
  extractor: {
    extract: file =>
      Effect.try({
        try: () => extractFileFacts(file),
        catch: cause =>
          new CodeGraphLanguagePackError(`Could not extract documentation facts from ${file.path}.`, {cause}),
      }),
    version: sha256HexSync('threadnote-markdown-extractor-v1'),
  },
  files: [
    {kind: 'extension', language: 'markdown', role: 'documentation', value: '.md'},
    {kind: 'extension', language: 'markdown', role: 'documentation', value: '.mdx'},
  ],
  id: 'documentation',
  resolutionStrategy: {domain: 'documentation', version: 'documentation-links-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};
