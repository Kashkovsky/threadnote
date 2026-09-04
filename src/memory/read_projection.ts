import {Schema} from 'effect';

export const MEMORY_READ_MAXIMUM_CONTENT_BYTES = 65_536;
const MEMORY_READ_WARNING_MAXIMUM_BYTES = 160;
const UTF8 = new TextEncoder();

export type MemoryReadMode = 'content' | 'outline';

export interface MemoryReadResource {
  readonly canonicalUri?: string;
  readonly requestedUri?: string;
  readonly text: string;
  readonly uri: string;
}

export interface MemoryReadStructuredContent {
  readonly canonicalUri?: string;
  readonly complete: true;
  readonly content: string;
  readonly contentBytes: number;
  readonly mode: MemoryReadMode;
  readonly requestedUri?: string;
  readonly resourceCount: number;
  readonly section?: string;
  readonly type: 'threadnote-read';
  readonly version: 1;
  readonly warnings?: readonly string[];
}

export interface MemoryRead {
  readonly content: string;
  readonly receipt?: string;
  readonly structuredContent: MemoryReadStructuredContent;
  readonly uri: string;
}

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
    readonly section?: string;
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

  const projected = resources.map(resource => ({
    ...resource,
    text:
      mode === 'outline' ? memoryMarkdownOutline(resource.text) : selectMemoryMarkdownSection(resource.text, section),
  }));
  const content = projected.length === 1 ? projected[0].text : projected.map(resource => resource.text).join('\n\n');
  const contentBytes = utf8Bytes(content);
  if (contentBytes > MEMORY_READ_MAXIMUM_CONTENT_BYTES) {
    const oversizedIndex = projected.findIndex(
      resource => utf8Bytes(resource.text) > MEMORY_READ_MAXIMUM_CONTENT_BYTES,
    );
    const focusIndex = oversizedIndex >= 0 ? oversizedIndex : 0;
    const focus = projected[focusIndex];
    const source = resources[focusIndex] ?? resources[0];
    const outlineForError = memoryMarkdownOutline(source.text);
    throw MemoryReadTooLargeError.make({
      contentBytes,
      maximumContentBytes: MEMORY_READ_MAXIMUM_CONTENT_BYTES,
      message: memoryReadTooLargeMessage({
        contentBytes,
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
    ...(receipt === undefined ? {} : {receipt}),
    structuredContent: {
      complete: true,
      content,
      contentBytes,
      mode,
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
    'Use mode=outline or section="<heading>" to read a part.',
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
