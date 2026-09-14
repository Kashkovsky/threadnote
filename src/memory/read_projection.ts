import {Schema} from 'effect';
import {sha256HexSync} from '../crypto/sha256.js';

export const MEMORY_READ_MAXIMUM_CONTENT_BYTES = 65_536;
export const MEMORY_READ_PAGE_BYTES = 16_384;
const MEMORY_READ_WARNING_MAXIMUM_BYTES = 160;
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export type MemoryReadMode = 'content' | 'outline';

export interface MemoryReadResource {
  readonly canonicalUri?: string;
  readonly requestedUri?: string;
  readonly text: string;
  readonly uri: string;
}

export interface MemoryReadStructuredContent {
  readonly canonicalUri?: string;
  readonly complete: boolean;
  readonly content: string;
  readonly contentBytes: number;
  readonly mode: MemoryReadMode;
  readonly nextOffsetBytes?: number;
  readonly offsetBytes?: number;
  readonly requestedUri?: string;
  readonly resourceCount: number;
  readonly section?: string;
  readonly sourceHash?: string;
  readonly totalBytes?: number;
  readonly type: 'threadnote-read';
  readonly version: 1;
  readonly warnings?: readonly string[];
}

export interface MemoryRead {
  readonly content: string;
  readonly continuation?: string;
  readonly receipt?: string;
  readonly structuredContent: MemoryReadStructuredContent;
  readonly uri: string;
}

export type MemoryReadMcpResponseFormat = 'dual' | 'text';

export type MemoryReadMcpStructuredContent =
  | MemoryReadStructuredContent
  | (Omit<MemoryReadStructuredContent, 'content' | 'version'> & {
      readonly contentChannel: 'text';
      readonly uri: string;
      readonly version: 2;
    });

export class MemoryReadProjectionError extends Schema.TaggedError<MemoryReadProjectionError>()(
  'MemoryReadProjectionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export class MemoryReadTooLargeError extends Schema.TaggedError<MemoryReadTooLargeError>()('MemoryReadTooLargeError', {
  contentBytes: Schema.Finite,
  maximumContentBytes: Schema.Finite,
  message: Schema.String,
  outline: Schema.String,
  uri: Schema.String,
}) {}

export function projectMemoryRead(
  resources: readonly MemoryReadResource[],
  options: {
    readonly mode?: MemoryReadMode;
    readonly offsetBytes?: number;
    readonly section?: string;
    readonly sourceHash?: string;
    readonly toolName?: string;
    readonly warnings?: readonly string[];
  } = {},
): MemoryRead {
  if (resources.length === 0)
    throw MemoryReadProjectionError.make({message: 'Memory read requires at least one resource.'});
  const mode = options.mode ?? 'content';
  const section = normalizedSection(options.section);
  if (mode === 'outline' && section !== undefined) {
    throw MemoryReadProjectionError.make({message: 'Memory read section cannot be combined with mode=outline.'});
  }
  if (section !== undefined && resources.length !== 1) {
    throw MemoryReadProjectionError.make({message: 'Memory read section requires exactly one uri.'});
  }
  if (options.offsetBytes !== undefined && (mode !== 'content' || resources.length !== 1)) {
    throw MemoryReadProjectionError.make({message: 'Memory read offsetBytes requires one uri in content mode.'});
  }
  if (options.sourceHash !== undefined && options.offsetBytes === undefined) {
    throw MemoryReadProjectionError.make({message: 'Memory read sourceHash requires offsetBytes.'});
  }

  const projected = resources.map(resource => ({
    ...resource,
    text:
      mode === 'outline' ? memoryMarkdownOutline(resource.text) : selectMemoryMarkdownSection(resource.text, section),
  }));
  const fullContent =
    projected.length === 1 ? projected[0].text : projected.map(resource => resource.text).join('\n\n');
  const fullContentBytes = utf8Bytes(fullContent);
  const page =
    options.offsetBytes === undefined
      ? undefined
      : memoryReadPage(fullContent, options.offsetBytes, options.sourceHash);
  const content = page?.content ?? fullContent;
  const contentBytes = utf8Bytes(content);
  if (page === undefined && contentBytes > MEMORY_READ_MAXIMUM_CONTENT_BYTES) {
    const oversizedIndex = projected.findIndex(
      resource => utf8Bytes(resource.text) > MEMORY_READ_MAXIMUM_CONTENT_BYTES,
    );
    const focusIndex = oversizedIndex >= 0 ? oversizedIndex : 0;
    const focus = projected[focusIndex];
    const source = resources[focusIndex] ?? resources[0];
    const outlineForError = memoryMarkdownOutline(source.text);
    throw MemoryReadTooLargeError.make({
      contentBytes: fullContentBytes,
      maximumContentBytes: MEMORY_READ_MAXIMUM_CONTENT_BYTES,
      message: memoryReadTooLargeMessage({
        contentBytes: fullContentBytes,
        outline: outlineForError,
        resourceCount: resources.length,
        toolName: options.toolName ?? 'read_context',
        uri: focus.uri,
      }),
      outline: outlineForError,
      uri: focus.uri,
    });
  }

  const resource = projected[0];
  const warnings = memoryReadBoundedWarnings(options.warnings);
  const receipt =
    resource.requestedUri && resource.canonicalUri
      ? `Relocated memory: requested ${resource.requestedUri}; canonical ${resource.canonicalUri}.`
      : undefined;
  return {
    content,
    ...(page?.nextOffsetBytes === undefined
      ? {}
      : {
          continuation: `Incomplete memory page. Continue this URI with offsetBytes=${page.nextOffsetBytes} and sourceHash=${page.sourceHash}; read until complete=true.`,
        }),
    ...(receipt === undefined ? {} : {receipt}),
    structuredContent: {
      complete: page?.complete ?? true,
      content,
      contentBytes,
      mode,
      ...(page === undefined
        ? {}
        : {
            offsetBytes: page.offsetBytes,
            sourceHash: page.sourceHash,
            totalBytes: fullContentBytes,
            ...(page.nextOffsetBytes === undefined ? {} : {nextOffsetBytes: page.nextOffsetBytes}),
          }),
      resourceCount: resources.length,
      type: 'threadnote-read',
      version: 1,
      ...(resource.canonicalUri === undefined ? {} : {canonicalUri: resource.canonicalUri}),
      ...(resource.requestedUri === undefined ? {} : {requestedUri: resource.requestedUri}),
      ...(section === undefined ? {} : {section}),
      ...(warnings === undefined ? {} : {warnings}),
    },
    uri: resource.uri,
  };
}

export function memoryReadMcpStructuredContent(
  read: MemoryRead,
  responseFormat: MemoryReadMcpResponseFormat = 'dual',
): MemoryReadMcpStructuredContent {
  if (responseFormat === 'dual') return read.structuredContent;
  const {content: _content, version: _version, ...metadata} = read.structuredContent;
  return {...metadata, contentChannel: 'text', uri: read.uri, version: 2};
}

export function memoryMarkdownOutline(content: string): string {
  const headings = markdownHeadings(content);
  if (headings.length === 0) return `- (document without Markdown headings; ${utf8Bytes(content)} bytes)\n`;
  return `${headings
    .map((heading, index) => {
      const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
      const bytes = utf8Bytes(content.slice(heading.start, next?.start ?? content.length));
      return `- ${'#'.repeat(heading.level)} ${heading.title} (${bytes} bytes)`;
    })
    .join('\n')}\n`;
}

export function selectMemoryMarkdownSection(content: string, section: string | undefined): string {
  if (section === undefined) return content;
  const selector = markdownSectionSelector(section);
  const headings = markdownHeadings(content);
  const index = headings.findIndex(
    heading => heading.title === selector.title && (selector.level === undefined || heading.level === selector.level),
  );
  if (index < 0) throw MemoryReadProjectionError.make({message: `Memory section "${section}" was not found.`});
  const heading = headings[index];
  const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
  return content.slice(heading.start, next?.start ?? content.length);
}

export function memoryReadBoundedWarnings(warnings: readonly string[] | undefined): string[] | undefined {
  if (!warnings || warnings.length === 0) return undefined;
  const combined = warnings
    .map(warning => warning.trim())
    .filter(Boolean)
    .join('; ');
  if (!combined) return undefined;
  return [utf8Prefix(combined, 0, MEMORY_READ_WARNING_MAXIMUM_BYTES).text];
}

export function memoryReadContentBytes(value: string): number {
  return utf8Bytes(value);
}

function memoryReadPage(content: string, offsetBytes: number, expectedHash: string | undefined) {
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
    throw MemoryReadProjectionError.make({message: 'Memory read offsetBytes must be a non-negative safe integer.'});
  }
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/u.test(expectedHash)) {
    throw MemoryReadProjectionError.make({message: 'Memory read sourceHash must be a lowercase SHA-256 hex digest.'});
  }
  if (offsetBytes > 0 && expectedHash === undefined) {
    throw MemoryReadProjectionError.make({
      message: 'Memory read continuation requires sourceHash from the first page.',
    });
  }
  const encoded = UTF8.encode(content);
  const sourceHash = sha256HexSync(encoded);
  if (expectedHash !== undefined && expectedHash !== sourceHash) {
    throw MemoryReadProjectionError.make({message: 'Memory changed between pages; restart with offsetBytes=0.'});
  }
  const totalBytes = encoded.byteLength;
  if (offsetBytes > totalBytes || (offsetBytes < totalBytes && isUtf8ContinuationByte(encoded[offsetBytes]))) {
    throw MemoryReadProjectionError.make({
      message: 'Memory read offsetBytes must be on a UTF-8 character boundary within the memory.',
    });
  }
  let nextOffsetBytes = Math.min(offsetBytes + MEMORY_READ_PAGE_BYTES, totalBytes);
  while (nextOffsetBytes < totalBytes && isUtf8ContinuationByte(encoded[nextOffsetBytes])) {
    nextOffsetBytes -= 1;
  }
  const start = UTF8_DECODER.decode(encoded.subarray(0, offsetBytes)).length;
  const end = start + UTF8_DECODER.decode(encoded.subarray(offsetBytes, nextOffsetBytes)).length;
  return {
    complete: nextOffsetBytes === totalBytes,
    content: content.slice(start, end),
    nextOffsetBytes: nextOffsetBytes < totalBytes ? nextOffsetBytes : undefined,
    offsetBytes,
    sourceHash,
  };
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function memoryReadTooLargeMessage(input: {
  readonly contentBytes: number;
  readonly outline: string;
  readonly resourceCount: number;
  readonly toolName: string;
  readonly uri: string;
}): string {
  const scope =
    input.resourceCount > 1
      ? `Combined read is ${input.contentBytes} bytes across ${input.resourceCount} URIs`
      : `Memory ${input.uri} is ${input.contentBytes} bytes`;
  return [
    `${scope}; ${input.toolName} returns at most ${MEMORY_READ_MAXIMUM_CONTENT_BYTES} bytes.`,
    'Use mode=outline, section="<heading>", or pass one URI with offsetBytes=0 to start an explicit bounded read. Continue with nextOffsetBytes and sourceHash.',
    '',
    'Outline:',
    input.outline.trimEnd(),
  ].join('\n');
}

interface MarkdownHeading {
  readonly level: number;
  readonly start: number;
  readonly title: string;
}

function markdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: {readonly character: '`' | '~'; readonly length: number} | undefined;
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    const line = content.slice(start, end).replace(/\r$/u, '');
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[\t ]*$/u.exec(line)?.[1];
      if (closing?.[0] === fence.character && closing.length >= fence.length) fence = undefined;
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      const sequence = opening?.[1];
      const suffix = opening?.[2] ?? '';
      const character = sequence?.[0];
      if (sequence && (character === '~' || (character === '`' && !suffix.includes('`')))) {
        fence = {character, length: sequence.length};
      } else {
        const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(line);
        const hashes = heading?.[1];
        const rawTitle = heading?.[2];
        if (hashes && rawTitle) headings.push({level: hashes.length, start, title: rawTitle.trim()});
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return headings;
}

function markdownSectionSelector(section: string): {readonly level?: number; readonly title: string} {
  const match = /^(#{1,6})[\t ]+(.+)$/u.exec(section);
  return match?.[1] && match[2]
    ? {level: match[1].length, title: match[2].trim().replace(/[\t ]+#+[\t ]*$/u, '')}
    : {title: section};
}

function normalizedSection(section: string | undefined): string | undefined {
  if (section === undefined) return undefined;
  const normalized = section.trim();
  if (normalized.length === 0 || utf8Bytes(normalized) > 256) {
    throw MemoryReadProjectionError.make({message: 'Memory read section must be 1 through 256 UTF-8 bytes.'});
  }
  return normalized;
}

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function utf8Prefix(value: string, start: number, maximumBytes: number): {readonly end: number; readonly text: string} {
  let bytes = 0;
  let end = start;
  while (end < value.length) {
    const codePoint = value.codePointAt(end);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    const characterBytes = utf8Bytes(value.slice(end, end + width));
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    end += width;
  }
  return {end, text: value.slice(start, end)};
}
