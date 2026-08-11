export const CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT = 64 * 1_048_576;
export const CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT = 16 * 1_048_576;
export const CORPUS_ARCHIVE_EXPANDED_BYTES_LIMIT = 64 * 1_048_576;
export const CORPUS_ARCHIVE_INSPECTED_ENTRY_LIMIT = 65_536;
export const CORPUS_ARCHIVE_SELECTED_ENTRY_LIMIT = 8_192;
export const CORPUS_PDF_EXTRACTED_TEXT_CHARACTER_LIMIT = 16 * 1_048_576;
export const CORPUS_PDF_EXTRACTION_MILLISECONDS_LIMIT = 30_000;

export const OPAQUE_CORPUS_MEDIA_EXTENSIONS = [
  '.aac',
  '.avi',
  '.avif',
  '.bmp',
  '.flac',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.oga',
  '.ogg',
  '.opus',
  '.png',
  '.tif',
  '.tiff',
  '.wav',
  '.webm',
  '.webp',
] as const;

const OPAQUE_CORPUS_MEDIA_EXTENSION_SET = new Set<string>(OPAQUE_CORPUS_MEDIA_EXTENSIONS);

/** Binary media contributes metadata-only asset nodes and can be deferred by structural-only indexing. */
export function isOpaqueCorpusMediaPath(path: string): boolean {
  const basename = path.split('/').at(-1)?.toLowerCase() ?? '';
  const separator = basename.lastIndexOf('.');
  return separator > 0 && OPAQUE_CORPUS_MEDIA_EXTENSION_SET.has(basename.slice(separator));
}
