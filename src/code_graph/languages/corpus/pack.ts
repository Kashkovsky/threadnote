import {Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {fromPromiseInterruptible} from '../../../effect/errors.js';
import {CodeGraphLanguagePackError, type CodeGraphFileMatcher, type CodeGraphLanguagePack} from '../types.js';
import {extractCorpusFile} from './extractor.js';
import {OPAQUE_CORPUS_MEDIA_EXTENSIONS} from './policy.js';

const extensions = (values: readonly string[], language: string): readonly CodeGraphFileMatcher[] =>
  values.map(value => ({kind: 'extension', language, role: 'corpus', value}));

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['assets', 'corpus', 'declarations', 'documentation']),
  extractor: {
    extract: (file, context) =>
      fromPromiseInterruptible(
        signal => extractCorpusFile(file, {signal}, context),
        cause => new CodeGraphLanguagePackError(`Could not extract corpus facts from ${file.path}.`, {cause}),
      ),
    version: sha256HexSync('threadnote-corpus-extractor-v4-mobile-resource-wiring'),
  },
  files: [
    ...extensions(
      [
        '.adoc',
        '.asciidoc',
        '.csv',
        '.dot',
        '.drawio',
        '.graphml',
        '.htm',
        '.html',
        '.ipynb',
        '.mermaid',
        '.mmd',
        '.org',
        '.plantuml',
        '.plist',
        '.puml',
        '.rst',
        '.rtf',
        '.storyboard',
        '.svg',
        '.tex',
        '.tsv',
        '.txt',
        '.url',
        '.webloc',
        '.xib',
        '.xml',
      ],
      'document',
    ),
    ...extensions(['.docx', '.epub', '.odp', '.ods', '.odt', '.pdf', '.pptx', '.xlsx'], 'office-document'),
    ...extensions(
      OPAQUE_CORPUS_MEDIA_EXTENSIONS.filter(extension =>
        ['.avif', '.bmp', '.gif', '.heic', '.ico', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'].includes(
          extension,
        ),
      ),
      'image',
    ),
    ...extensions(
      OPAQUE_CORPUS_MEDIA_EXTENSIONS.filter(extension =>
        ['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav'].includes(extension),
      ),
      'audio',
    ),
    ...extensions(
      OPAQUE_CORPUS_MEDIA_EXTENSIONS.filter(extension =>
        ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm'].includes(extension),
      ),
      'video',
    ),
  ],
  id: 'corpus',
  resolutionStrategy: {domain: 'corpus', version: 'corpus-links-v1'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};
