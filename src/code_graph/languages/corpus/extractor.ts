import {unzipSync, type UnzipFileInfo} from 'fflate';
import {getDocumentProxy, getResolvedPDFJS} from 'unpdf';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {compareNaturalCodeUnits} from '../../ordering.js';
import type {CodeGraphEdge, CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '../../types.js';
import {
  CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT,
  CORPUS_ARCHIVE_EXPANDED_BYTES_LIMIT,
  CORPUS_ARCHIVE_INSPECTED_ENTRY_LIMIT,
  CORPUS_ARCHIVE_SELECTED_ENTRY_LIMIT,
  CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT,
  CORPUS_PDF_EXTRACTED_TEXT_CHARACTER_LIMIT,
  CORPUS_PDF_EXTRACTION_MILLISECONDS_LIMIT,
} from './policy.js';

const TEXT_CHUNK_TARGET = 1_800;

const OFFICE_EXTENSIONS = new Set(['.docx', '.epub', '.odp', '.ods', '.odt', '.pptx', '.xlsx']);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
]);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm']);

interface ExtractedSection {
  readonly name: string;
  readonly text: string;
}

interface ExtractedCorpus {
  readonly diagnostics: readonly string[];
  readonly kind: 'asset' | 'document';
  readonly metadata: readonly string[];
  readonly sections: readonly ExtractedSection[];
  readonly urls: readonly string[];
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfAnnotations = Awaited<ReturnType<PdfPage['getAnnotations']>>;
type PdfTextContent = Awaited<ReturnType<PdfPage['getTextContent']>>;

export interface CorpusExtractionOptions {
  /** Test and internal callers may lower, but never raise, the production safety budgets. */
  readonly archiveInspectedEntryLimit?: number;
  readonly archiveSelectedEntryLimit?: number;
  readonly maximumElapsedMilliseconds?: number;
  readonly maximumExtractedTextCharacters?: number;
  readonly monotonicNow?: () => number;
  readonly signal?: AbortSignal;
}

export async function extractCorpusFile(
  file: CodeGraphInventoryFile,
  options: CorpusExtractionOptions = {},
): Promise<CodeGraphFileFacts> {
  const extension = extensionOf(file.path);
  if (file.contentOmittedReason === 'size-budget' || file.size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT) {
    return buildFacts(file, {
      diagnostics: [
        `${file.path}: content exceeds the 64 MiB per-artifact extraction safety budget; indexed as asset metadata.`,
      ],
      kind: 'asset',
      metadata: [`format ${extension.slice(1) || 'unknown'}`, `${file.size} bytes`],
      sections: [],
      urls: [],
    });
  }
  try {
    const extracted =
      extension === '.pdf'
        ? await extractPdf(file, options)
        : OFFICE_EXTENSIONS.has(extension)
          ? extractArchiveDocument(file, extension, options)
          : IMAGE_EXTENSIONS.has(extension)
            ? extractImage(file, extension)
            : AUDIO_EXTENSIONS.has(extension)
              ? extractMediaAsset(file, extension, 'audio')
              : VIDEO_EXTENSIONS.has(extension)
                ? extractMediaAsset(file, extension, 'video')
                : extractTextDocument(file, extension);
    return buildFacts(file, extracted);
  } catch (cause) {
    if (options.signal?.aborted) throw options.signal.reason ?? cause;
    return buildFacts(file, {
      diagnostics: [`${file.path}: corpus extraction failed (${messageOf(cause)})`],
      kind: 'asset',
      metadata: [`format ${extension.slice(1) || 'unknown'}`, `${file.size} bytes`],
      sections: [],
      urls: [],
    });
  }
}

function extractTextDocument(file: CodeGraphInventoryFile, extension: string): ExtractedCorpus {
  const source = requireText(file);
  const text = normalizeTextDocument(source, extension);
  return {
    diagnostics: [],
    kind: 'document',
    metadata: [`format ${extension.slice(1) || 'text'}`, `${file.size} bytes`],
    sections: sectionize(text, basename(file.path)),
    urls: extractUrls(text),
  };
}

async function extractPdf(file: CodeGraphInventoryFile, options: CorpusExtractionOptions): Promise<ExtractedCorpus> {
  const bytes = sourceBytes(file);
  const budget = pdfExtractionBudget(options);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, {once: true});
  const timeout = setTimeout(
    () => controller.abort(new Error('PDF extraction exceeded the per-artifact elapsed-time safety budget')),
    budget.maximumElapsedMilliseconds,
  );
  let destroy: (() => Promise<void>) | undefined;
  try {
    budget.check();
    const pdfjs = await abortable(getResolvedPDFJS(), controller.signal);
    budget.check();
    let standardFontDataUrl: string | undefined;
    try {
      standardFontDataUrl = new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')).href;
    } catch {
      // The bundled serverless PDF.js build can still extract embedded-font text without this optional path.
    }
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      disableFontFace: true,
      isEvalSupported: false,
      ...(standardFontDataUrl ? {standardFontDataUrl} : {}),
      useSystemFonts: true,
    });
    destroy = async () => {
      await loadingTask.destroy();
    };
    const abortLoading = () => void destroy?.().catch(() => undefined);
    controller.signal.addEventListener('abort', abortLoading, {once: true});
    const pdf = await abortable<PdfDocument>(loadingTask.promise, controller.signal);
    destroy = async () => {
      await pdf.destroy();
    };
    const text: string[] = [];
    const links: string[] = [];
    let extractedCharacters = 0;
    // Deliberately sequential: memory stays bounded by one decoded page plus the cumulative text budget.
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      budget.check();
      const page = await abortable<PdfPage>(pdf.getPage(pageNumber), controller.signal);
      try {
        const content = await abortable<PdfTextContent>(page.getTextContent(), controller.signal);
        budget.check();
        const pageText = content.items
          .filter(
            (item: unknown): item is {readonly hasEOL?: boolean; readonly str: string} =>
              isRecord(item) && typeof item.str === 'string',
          )
          .map((item: {readonly hasEOL?: boolean; readonly str: string}) => `${item.str}${item.hasEOL ? '\n' : ''}`)
          .join('');
        extractedCharacters += pageText.length;
        if (extractedCharacters > budget.maximumExtractedTextCharacters) {
          throw new Error('PDF extracted text exceeds the per-artifact character safety budget');
        }
        text.push(pageText);
        const annotations = await abortable<PdfAnnotations>(page.getAnnotations(), controller.signal);
        for (const annotation of annotations) {
          if (isRecord(annotation) && annotation.subtype === 'Link' && typeof annotation.url === 'string') {
            links.push(annotation.url);
          }
        }
      } finally {
        page.cleanup();
      }
    }
    budget.check();
    return {
      diagnostics: text.every(page => page.trim().length === 0)
        ? [`${file.path}: PDF has no extractable text; indexed as an asset.`]
        : [],
      kind: 'document',
      metadata: ['format pdf', `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`, `${file.size} bytes`],
      sections: text.flatMap((page, index) =>
        sectionize(page, `Page ${index + 1}`).map((section, sectionIndex) => ({
          ...section,
          name:
            section.name === `Page ${index + 1}`
              ? section.name
              : `Page ${index + 1} · ${sectionIndex + 1}: ${section.name}`,
        })),
      ),
      urls: uniqueStrings([...links, ...text.flatMap(extractUrls)]),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
    await destroy?.().catch(() => undefined);
  }
}

function extractArchiveDocument(
  file: CodeGraphInventoryFile,
  extension: string,
  options: CorpusExtractionOptions,
): ExtractedCorpus {
  options.signal?.throwIfAborted();
  const inspectedEntryLimit = loweredSafetyLimit(
    options.archiveInspectedEntryLimit,
    CORPUS_ARCHIVE_INSPECTED_ENTRY_LIMIT,
  );
  const selectedEntryLimit = loweredSafetyLimit(options.archiveSelectedEntryLimit, CORPUS_ARCHIVE_SELECTED_ENTRY_LIMIT);
  let inspectedEntries = 0;
  let selectedBytes = 0;
  const selectedEntries: {readonly name: string; readonly normalized: string}[] = [];
  const selectedKeys = new Set<string>();
  const files = unzipSync(sourceBytes(file), {
    filter: (entry: UnzipFileInfo) => {
      inspectedEntries += 1;
      if (inspectedEntries > inspectedEntryLimit) {
        throw new Error('archive exceeds the per-document inspected entry-count safety budget');
      }
      const normalized = normalizeArchiveEntryName(entry.name);
      if (!normalized || !archiveEntryAccepted(extension, normalized)) return false;
      const key = normalized.toLowerCase();
      if (selectedKeys.has(key)) return false;
      if (selectedEntries.length >= selectedEntryLimit) {
        throw new Error('archive exceeds the per-document selected entry-count safety budget');
      }
      if (entry.originalSize > CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT) {
        throw new Error(`archive entry ${entry.name} expands beyond the per-entry safety budget`);
      }
      selectedBytes += entry.originalSize;
      if (selectedBytes > CORPUS_ARCHIVE_EXPANDED_BYTES_LIMIT) {
        throw new Error('selected archive text expands beyond the per-document safety budget');
      }
      selectedKeys.add(key);
      selectedEntries.push({name: entry.name, normalized});
      return true;
    },
  });
  options.signal?.throwIfAborted();
  const sections = selectedEntries
    .sort((left, right) => compareNaturalCodeUnits(left.normalized, right.normalized))
    .flatMap((entry, index) => {
      const bytes = files[entry.name];
      if (!bytes) return [];
      const decoded = decodeUtf8(bytes);
      if (decoded === undefined) return [];
      const text = xmlToText(decoded);
      if (!text) return [];
      const entryName = archiveEntryLabel(extension, entry.normalized, index);
      return sectionize(text, entryName).map((section, sectionIndex) => ({
        ...section,
        name: section.name === entryName ? entryName : `${entryName} · ${sectionIndex + 1}: ${section.name}`,
      }));
    });
  return {
    diagnostics:
      sections.length === 0 ? [`${file.path}: document archive has no extractable text; indexed as an asset.`] : [],
    kind: 'document',
    metadata: [`format ${extension.slice(1)}`, `${sections.length} text section${sections.length === 1 ? '' : 's'}`],
    sections,
    urls: uniqueStrings(sections.flatMap(section => extractUrls(section.text))),
  };
}

function extractImage(file: CodeGraphInventoryFile, extension: string): ExtractedCorpus {
  const dimensions = imageDimensions(sourceBytes(file), extension);
  return {
    diagnostics: [
      `${file.path}: image pixels were not interpreted; filename and deterministic metadata remain searchable.`,
    ],
    kind: 'asset',
    metadata: [
      `format ${extension.slice(1)}`,
      ...(dimensions ? [`${dimensions.width}×${dimensions.height} pixels`] : []),
      `${file.size} bytes`,
    ],
    sections: [],
    urls: [],
  };
}

function extractMediaAsset(file: CodeGraphInventoryFile, extension: string, media: 'audio' | 'video'): ExtractedCorpus {
  return {
    diagnostics: [`${file.path}: ${media} was not transcribed; filename and deterministic metadata remain searchable.`],
    kind: 'asset',
    metadata: [`${media} format ${extension.slice(1)}`, `${file.size} bytes`],
    sections: [],
    urls: [],
  };
}

function buildFacts(file: CodeGraphInventoryFile, extracted: ExtractedCorpus): CodeGraphFileFacts {
  const rootName = titleFromPath(file.path);
  const root = symbol(file, extracted.kind, rootName, file.path, 1, 1, {
    documentation: [rootName, ...extracted.metadata].join('\n'),
    signature: extracted.metadata.join(' · '),
  });
  const symbols: CodeGraphSymbol[] = [root];
  const edges: CodeGraphEdge[] = [];
  let logicalLine = 2;
  extracted.sections.forEach((section, index) => {
    const lineCount = Math.max(1, section.text.split('\n').length);
    const child = symbol(
      file,
      'section',
      section.name,
      `${file.path}#section-${index + 1}-${slug(section.name)}`,
      logicalLine,
      logicalLine + lineCount - 1,
      {documentation: section.text},
    );
    symbols.push(child);
    edges.push(edge(file, root, child, 'contains', logicalLine));
    logicalLine += lineCount;
  });
  extracted.urls.forEach((url, index) => {
    const child = symbol(
      file,
      'external-resource',
      url,
      `${file.path}#url-${sha256HexSync(url).slice(0, 16)}`,
      logicalLine,
      logicalLine,
      {
        documentation: url,
        language: 'url',
      },
    );
    symbols.push(child);
    edges.push(edge(file, root, child, 'references', logicalLine + index));
  });
  return {diagnostics: extracted.diagnostics, edges, path: file.path, symbols};
}

function symbol(
  file: CodeGraphInventoryFile,
  kind: string,
  name: string,
  qualifiedName: string,
  line: number,
  endLine: number,
  options: {readonly documentation?: string; readonly language?: string; readonly signature?: string} = {},
): CodeGraphSymbol {
  const language = options.language ?? file.language;
  return {
    contentHash: file.contentHash,
    documentation: options.documentation,
    exported: true,
    id: `cgs_${sha256HexSync(`${file.path}\0${qualifiedName}\0${kind}`).slice(0, 40)}`,
    kind,
    language,
    lookupKeys: uniqueStrings([name, qualifiedName, file.path, ...tokens(name), ...tokens(file.path)]),
    name,
    path: file.path,
    qualifiedName,
    resolutionDomain: 'corpus',
    signature: options.signature,
    span: {column: 1, endColumn: 1, endLine, line},
  };
}

function edge(
  file: CodeGraphInventoryFile,
  source: CodeGraphSymbol,
  target: CodeGraphSymbol,
  relation: 'contains' | 'references',
  line: number,
): CodeGraphEdge {
  return {
    confidence: 1,
    evidencePath: file.path,
    evidenceSpan: {column: 1, endColumn: 1, endLine: line, line},
    id: `cge_${sha256HexSync(`${source.id}\0${relation}\0${target.id}`).slice(0, 40)}`,
    provenance: 'declared',
    relation,
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
  };
}

function sectionize(raw: string, fallbackName: string): readonly ExtractedSection[] {
  const text = normalizeWhitespace(raw);
  if (!text) return [];
  const headings = [...text.matchAll(/^(#{1,6}|={1,6}|\*{1,6})\s+(.+)$/gm)];
  if (headings.length === 0) return chunkSection(fallbackName, text);
  const sections: ExtractedSection[] = [];
  const preamble = text.slice(0, headings[0]!.index).trim();
  if (preamble) sections.push(...chunkSection(fallbackName, preamble));
  headings.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const name = match[2]!.trim().replace(/\s+#+$/, '') || `${fallbackName} · ${index + 1}`;
    const body = text.slice(start, end).trim();
    sections.push(...chunkSection(name, body || name));
  });
  return sections;
}

function chunkSection(name: string, text: string): readonly ExtractedSection[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(value => value.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];
  const output: ExtractedSection[] = [];
  let current = '';
  const flush = () => {
    if (!current) return;
    output.push({name: output.length === 0 ? name : `${name} · part ${output.length + 1}`, text: current});
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > TEXT_CHUNK_TARGET) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += TEXT_CHUNK_TARGET) {
        const part = paragraph.slice(offset, offset + TEXT_CHUNK_TARGET).trim();
        if (part) output.push({name: output.length === 0 ? name : `${name} · part ${output.length + 1}`, text: part});
      }
      continue;
    }
    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && combined.length > TEXT_CHUNK_TARGET) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  flush();
  return output;
}

function normalizeTextDocument(content: string, extension: string): string {
  if (extension === '.ipynb') return notebookToText(content);
  if (['.html', '.htm', '.svg', '.xml', '.drawio', '.graphml', '.webloc'].includes(extension)) {
    return xmlToText(content);
  }
  if (extension === '.rtf') return rtfToText(content);
  if (extension === '.url') {
    return content.replace(/^URL=/m, 'URL: ');
  }
  if (extension === '.rst') {
    return content.replace(/^(.+)\n([=\-~^"`:+*#])\2{2,}\s*$/gm, '# $1');
  }
  if (['.adoc', '.asciidoc'].includes(extension)) return content.replace(/^(={1,6})\s+/gm, '#'.repeat(1) + ' ');
  if (extension === '.org')
    return content.replace(/^(\*{1,6})\s+/gm, (_match, marks: string) => `${'#'.repeat(marks.length)} `);
  if (extension === '.tex') {
    return content.replace(/\\(?:part|chapter|section|subsection|subsubsection)\*?\{([^}]+)\}/g, '# $1');
  }
  return content;
}

function notebookToText(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value) || !Array.isArray(value.cells)) return content;
    return value.cells
      .flatMap((cell, index) => {
        if (!isRecord(cell) || !Array.isArray(cell.source)) return [];
        const source = cell.source.filter((line): line is string => typeof line === 'string').join('');
        if (!source.trim()) return [];
        const label = cell.cell_type === 'markdown' ? 'Markdown' : cell.cell_type === 'code' ? 'Code' : 'Cell';
        return [`# ${label} cell ${index + 1}\n${source}`];
      })
      .join('\n\n');
  } catch {
    return content;
  }
}

function xmlToText(content: string): string {
  return decodeXmlEntities(
    content
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_match, level: string, body: string) => `\n${'#'.repeat(Number(level))} ${stripTags(body)}\n`,
      )
      .replace(/<\/(?:p|div|section|article|li|tr|w:p|a:p|text:p|text:h|table:table-row)>/gi, '\n')
      .replace(/<(?:br|w:br|a:br)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

function rtfToText(content: string): string {
  return content
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\'[0-9a-fA-F]{2}/g, match => String.fromCharCode(Number.parseInt(match.slice(2), 16)))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, ' ');
}

function archiveEntryAccepted(extension: string, name: string): boolean {
  const normalized = name.toLowerCase();
  if (extension === '.docx') {
    return /^word\/(?:document|comments|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(normalized);
  }
  if (extension === '.pptx') return /^ppt\/(?:slides\/slide\d+|notesslides\/notesslide\d+)\.xml$/.test(normalized);
  if (extension === '.xlsx')
    return /^(?:xl\/(?:sharedstrings|workbook)|xl\/worksheets\/sheet\d+)\.xml$/.test(normalized);
  if (['.odt', '.odp', '.ods'].includes(extension)) return normalized === 'content.xml' || normalized === 'meta.xml';
  if (extension === '.epub') return /\.(?:xhtml|html|htm|ncx|opf)$/i.test(normalized);
  return false;
}

function normalizeArchiveEntryName(value: string): string | undefined {
  if (value.includes('\0')) return undefined;
  const normalized = value.normalize('NFC').replaceAll('\\', '/');
  if (normalized.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return undefined;
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join('/');
}

function archiveEntryLabel(extension: string, name: string, index: number): string {
  const normalized = name.replaceAll('\\', '/');
  const slide = /slide(\d+)\.xml$/i.exec(normalized)?.[1];
  if (extension === '.pptx' && slide) return `Slide ${slide}`;
  const sheet = /sheet(\d+)\.xml$/i.exec(normalized)?.[1];
  if (extension === '.xlsx' && sheet) return `Sheet ${sheet}`;
  if (extension === '.docx' && /document\.xml$/i.test(normalized)) return 'Document';
  return (
    normalized
      .split('/')
      .at(-1)
      ?.replace(/\.[^.]+$/, '') || `Part ${index + 1}`
  );
}

function imageDimensions(
  bytes: Uint8Array,
  extension: string,
): {readonly height: number; readonly width: number} | undefined {
  if (extension === '.png' && bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG') {
    return {height: uint32(bytes, 20), width: uint32(bytes, 16)};
  }
  if (extension === '.gif' && bytes.length >= 10 && ascii(bytes, 0, 3) === 'GIF') {
    return {height: uint16le(bytes, 8), width: uint16le(bytes, 6)};
  }
  if (['.jpg', '.jpeg'].includes(extension)) return jpegDimensions(bytes);
  if (extension === '.webp' && bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    if (ascii(bytes, 12, 4) === 'VP8X') {
      return {height: uint24le(bytes, 27) + 1, width: uint24le(bytes, 24) + 1};
    }
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): {readonly height: number; readonly width: number} | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function sourceBytes(file: CodeGraphInventoryFile): Uint8Array {
  if (file.bytes) return file.bytes;
  if (file.content !== undefined) return new TextEncoder().encode(file.content);
  throw new Error(`Repository bytes for ${file.path} were not loaded before extraction.`);
}

function requireText(file: CodeGraphInventoryFile): string {
  if (file.content !== undefined) return file.content;
  if (file.bytes) {
    const decoded = decodeUtf8(file.bytes);
    if (decoded !== undefined) return decoded;
  }
  throw new Error(`Repository text for ${file.path} was not loaded before extraction.`);
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function extractUrls(value: string): readonly string[] {
  return uniqueStrings(
    [...value.matchAll(/\bhttps?:\/\/[^\s<>"')\]}]+/gi)].map(match => match[0]!.replace(/[.,;:]$/, '')),
  );
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFromPath(path: string): string {
  return basename(path)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index);
}

function tokens(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(token => token.toLowerCase())
    .filter(token => token.length >= 2);
}

function slug(value: string): string {
  return tokens(value).slice(0, 12).join('-') || 'section';
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

function loweredSafetyLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('corpus extraction safety limits must be positive integers');
  return Math.min(value, maximum);
}

function pdfExtractionBudget(options: CorpusExtractionOptions): {
  readonly check: () => void;
  readonly maximumElapsedMilliseconds: number;
  readonly maximumExtractedTextCharacters: number;
} {
  const maximumElapsedMilliseconds = loweredSafetyLimit(
    options.maximumElapsedMilliseconds,
    CORPUS_PDF_EXTRACTION_MILLISECONDS_LIMIT,
  );
  const maximumExtractedTextCharacters = loweredSafetyLimit(
    options.maximumExtractedTextCharacters,
    CORPUS_PDF_EXTRACTED_TEXT_CHARACTER_LIMIT,
  );
  const now = options.monotonicNow ?? (() => performance.now());
  const startedAt = now();
  return {
    check: () => {
      options.signal?.throwIfAborted();
      if (now() - startedAt > maximumElapsedMilliseconds) {
        throw new Error('PDF extraction exceeded the per-artifact elapsed-time safety budget');
      }
    },
    maximumElapsedMilliseconds,
    maximumExtractedTextCharacters,
  };
}

function abortable<A>(promise: PromiseLike<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<A>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, {once: true});
    void Promise.resolve(promise).then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      cause => {
        signal.removeEventListener('abort', abort);
        reject(cause);
      },
    );
  });
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
