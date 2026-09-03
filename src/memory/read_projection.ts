import {sha256HexSync} from '../crypto/sha256.js';

export const MEMORY_READ_DEFAULT_BUDGET_TOKENS = 1_500;
export const MEMORY_READ_MAXIMUM_BUDGET_TOKENS = 1_500;
export const MEMORY_READ_MINIMUM_BUDGET_TOKENS = 128;
export const MEMORY_READ_CURSOR_TTL_MILLISECONDS = 10 * 60 * 1_000;

const MEMORY_READ_ESTIMATED_BYTES_PER_TOKEN = 3;
const MEMORY_READ_CURSOR_PREFIX = 'tnrc_';
const MEMORY_READ_WARNING_MAXIMUM_BYTES = 160;
const UTF8 = new TextEncoder();

export type MemoryReadMode = 'content' | 'outline';

export interface MemoryReadResource {
  readonly canonicalUri?: string;
  readonly requestedUri?: string;
  readonly text: string;
  readonly uri: string;
}

export interface MemoryReadPosition {
  readonly characterOffset: number;
  readonly resourceIndex: number;
}

export interface MemoryReadCursorState {
  readonly mode: MemoryReadMode;
  readonly position: MemoryReadPosition;
  readonly section?: string;
  readonly sourceHashes: readonly string[];
  readonly uris: readonly string[];
}

export interface MemoryReadPageStructuredContent {
  readonly budgetTokens: number;
  readonly complete: boolean;
  readonly canonicalUri?: string;
  /** Mirrors the text content block for MCP clients that surface only structured results. */
  readonly content: string;
  readonly contentBytes: number;
  readonly cursor?: string;
  readonly estimatedTokens: number;
  readonly mode: MemoryReadMode;
  readonly resource: number;
  readonly resourceCount: number;
  readonly requestedUri?: string;
  readonly section?: string;
  readonly type: 'threadnote-read-page';
  readonly version: 1;
  readonly warnings?: readonly string[];
}

export interface MemoryReadPage {
  readonly complete: boolean;
  readonly content: string;
  readonly nextPosition?: MemoryReadPosition;
  readonly receipt?: string;
  readonly structuredContent: MemoryReadPageStructuredContent;
  readonly uri: string;
}

export class MemoryReadProjectionError extends Error {
  override readonly name = 'MemoryReadProjectionError';
}

export function memoryReadCursorToken(entropy: string): string {
  return `${MEMORY_READ_CURSOR_PREFIX}${sha256HexSync(entropy).slice(0, 32)}`;
}

export function memoryReadSourceHashes(resources: readonly MemoryReadResource[]): string[] {
  return resources.map(resource => sha256HexSync(resource.text));
}

export function memoryReadSourcesMatch(
  resources: readonly MemoryReadResource[],
  expectedHashes: readonly string[],
): boolean {
  if (resources.length !== expectedHashes.length) return false;
  return resources.every((resource, index) => sha256HexSync(resource.text) === expectedHashes[index]);
}

export function memoryReadWouldPage(
  resources: readonly MemoryReadResource[],
  options: {
    readonly budgetTokens?: number;
    readonly mode?: MemoryReadMode;
    readonly section?: string;
  } = {},
): boolean {
  return !projectMemoryReadPage(resources, {
    budgetTokens: options.budgetTokens,
    continuationCursor: 'tnrc_image_projection_probe',
    includeReceipt: false,
    mode: options.mode,
    section: options.section,
  }).complete;
}

export function projectMemoryReadPage(
  resources: readonly MemoryReadResource[],
  options: {
    readonly budgetTokens?: number;
    readonly continuationCursor: string;
    readonly includeReceipt?: boolean;
    readonly mode?: MemoryReadMode;
    readonly position?: MemoryReadPosition;
    readonly reservedResponseBytes?: number;
    readonly section?: string;
    readonly toolName?: string;
    readonly warnings?: readonly string[];
  },
): MemoryReadPage {
  if (resources.length === 0) throw new MemoryReadProjectionError('Memory read requires at least one resource.');
  const budgetTokens = options.budgetTokens ?? MEMORY_READ_DEFAULT_BUDGET_TOKENS;
  if (
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < MEMORY_READ_MINIMUM_BUDGET_TOKENS ||
    budgetTokens > MEMORY_READ_MAXIMUM_BUDGET_TOKENS
  ) {
    throw new MemoryReadProjectionError(
      `Memory read budgetTokens must be an integer from ${MEMORY_READ_MINIMUM_BUDGET_TOKENS} through ${MEMORY_READ_MAXIMUM_BUDGET_TOKENS}.`,
    );
  }
  if (
    options.continuationCursor.length < 1 ||
    options.continuationCursor.length > 8_192 ||
    !/^[A-Za-z0-9._:-]+$/u.test(options.continuationCursor)
  ) {
    throw new MemoryReadProjectionError('Memory read continuation cursor is invalid.');
  }
  const mode = options.mode ?? 'content';
  const section = normalizedSection(options.section);
  if (mode === 'outline' && section !== undefined) {
    throw new MemoryReadProjectionError('Memory read section cannot be combined with mode=outline.');
  }
  const position = options.position ?? {characterOffset: 0, resourceIndex: 0};
  if (
    !Number.isSafeInteger(position.resourceIndex) ||
    position.resourceIndex < 0 ||
    position.resourceIndex >= resources.length ||
    !Number.isSafeInteger(position.characterOffset) ||
    position.characterOffset < 0
  ) {
    throw new MemoryReadProjectionError('Memory read continuation position is invalid.');
  }

  const projectedResources = resources.map(resource => ({
    ...resource,
    text:
      mode === 'outline' ? memoryMarkdownOutline(resource.text) : selectMemoryMarkdownSection(resource.text, section),
  }));
  const resource = projectedResources[position.resourceIndex];
  if (position.characterOffset > resource.text.length) {
    throw new MemoryReadProjectionError('Memory read continuation position is stale.');
  }
  const warnings = boundedWarnings(options.warnings);
  const reservedResponseBytes = options.reservedResponseBytes ?? 0;
  if (!Number.isSafeInteger(reservedResponseBytes) || reservedResponseBytes < 0) {
    throw new MemoryReadProjectionError('Memory read reserved response bytes must be a non-negative integer.');
  }
  const maximumBytes = budgetTokens * MEMORY_READ_ESTIMATED_BYTES_PER_TOKEN - reservedResponseBytes;
  if (maximumBytes < 1) {
    throw new MemoryReadProjectionError(`Memory read budgetTokens=${budgetTokens} cannot fit required metadata.`);
  }
  const receipt =
    options.includeReceipt === false
      ? undefined
      : [
          resource.requestedUri && resource.canonicalUri
            ? `Relocated memory: requested ${resource.requestedUri}; canonical ${resource.canonicalUri}.`
            : undefined,
          `Continue with ${options.toolName ?? 'read_context'} cursor ${options.continuationCursor}.`,
        ]
          .filter((part): part is string => part !== undefined)
          .join('\n');
  const completionReceipt =
    resource.requestedUri && resource.canonicalUri
      ? `Relocated memory: requested ${resource.requestedUri}; canonical ${resource.canonicalUri}.`
      : undefined;
  const responseOptionCandidates = [
    {section, warnings},
    {section, warnings: undefined},
    {section: undefined, warnings: undefined},
  ] as const;
  const firstBoundary = unicodeBoundariesWithin(resource.text, position.characterOffset, 4)[1];
  const minimumContent =
    firstBoundary === undefined ? '' : resource.text.slice(position.characterOffset, firstBoundary);
  const responseOptions = responseOptionCandidates.find(candidate => {
    const envelope = finalizedStructuredContent(
      baseStructuredContent({
        budgetTokens,
        canonicalUri: resource.canonicalUri,
        complete: false,
        content: minimumContent,
        contentBytes: utf8Bytes(minimumContent),
        cursor: options.continuationCursor,
        mode,
        resourceCount: resources.length,
        resourceIndex: position.resourceIndex,
        requestedUri: resource.requestedUri,
        section: candidate.section,
        warnings: candidate.warnings,
      }),
      receipt,
    );
    return responseBytes(minimumContent, receipt, envelope) <= maximumBytes;
  }) ?? {section: undefined, warnings: undefined};

  const structuredContentFor = (
    content: string,
    complete: boolean,
    cursor: string | undefined,
    responseReceipt: string | undefined,
  ): MemoryReadPageStructuredContent =>
    finalizedStructuredContent(
      baseStructuredContent({
        budgetTokens,
        canonicalUri: resource.canonicalUri,
        complete,
        content,
        contentBytes: utf8Bytes(content),
        ...(cursor === undefined ? {} : {cursor}),
        mode,
        resourceCount: resources.length,
        resourceIndex: position.resourceIndex,
        requestedUri: resource.requestedUri,
        section: responseOptions.section,
        warnings: responseOptions.warnings,
      }),
      responseReceipt,
    );

  const completeCandidate = resource.text.slice(position.characterOffset);
  const isLastResource = position.resourceIndex === resources.length - 1;
  if (isLastResource) {
    const completed = structuredContentFor(completeCandidate, true, undefined, completionReceipt);
    if (responseBytes(completeCandidate, completionReceipt, completed) <= maximumBytes) {
      return {
        complete: true,
        content: completeCandidate,
        ...(completionReceipt === undefined ? {} : {receipt: completionReceipt}),
        structuredContent: completed,
        uri: resource.uri,
      };
    }
  }

  const slice = largestFittingMemoryReadPrefix(
    resource.text,
    position.characterOffset,
    maximumBytes,
    receipt,
    content => structuredContentFor(content, false, options.continuationCursor, receipt),
  );
  if (slice.end === position.characterOffset && position.characterOffset < resource.text.length) {
    throw new MemoryReadProjectionError(`Memory read budgetTokens=${budgetTokens} cannot fit one Unicode character.`);
  }
  const nextPosition =
    slice.end < resource.text.length
      ? {characterOffset: slice.end, resourceIndex: position.resourceIndex}
      : {characterOffset: 0, resourceIndex: position.resourceIndex + 1};
  if (nextPosition.resourceIndex >= resources.length) {
    throw new MemoryReadProjectionError('Memory read projection produced an invalid terminal continuation.');
  }
  const structuredContent = structuredContentFor(slice.text, false, options.continuationCursor, receipt);
  if (responseBytes(slice.text, receipt, structuredContent) > maximumBytes) {
    throw new MemoryReadProjectionError('Memory read projection exceeded its response budget.');
  }
  return {
    complete: false,
    content: slice.text,
    nextPosition,
    receipt,
    structuredContent,
    uri: resource.uri,
  };
}

function largestFittingMemoryReadPrefix(
  value: string,
  start: number,
  maximumBytes: number,
  receipt: string | undefined,
  structuredContentFor: (content: string) => MemoryReadPageStructuredContent,
): {readonly end: number; readonly text: string} {
  const boundaries = unicodeBoundariesWithin(value, start, maximumBytes);
  let lower = 0;
  let upper = boundaries.length - 1;
  let selected = 0;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const end = boundaries[middle];
    const content = value.slice(start, end);
    const structuredContent = structuredContentFor(content);
    if (responseBytes(content, receipt, structuredContent) <= maximumBytes) {
      selected = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  const end = boundaries[selected];
  return {end, text: value.slice(start, end)};
}

function unicodeBoundariesWithin(value: string, start: number, maximumBytes: number): number[] {
  const boundaries = [start];
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
    boundaries.push(end);
  }
  return boundaries;
}

export function memoryReadPageEstimatedTokens(page: MemoryReadPage): number {
  return estimatedTokens(responseBytes(page.content, page.receipt, page.structuredContent));
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
  if (index < 0) throw new MemoryReadProjectionError(`Memory section "${section}" was not found.`);
  const heading = headings[index];
  const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level);
  return content.slice(heading.start, next?.start ?? content.length);
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
    throw new MemoryReadProjectionError('Memory read section must be 1 through 256 UTF-8 bytes.');
  }
  return normalized;
}

function boundedWarnings(warnings: readonly string[] | undefined): string[] | undefined {
  if (!warnings || warnings.length === 0) return undefined;
  const combined = warnings
    .map(warning => warning.trim())
    .filter(Boolean)
    .join('; ');
  if (!combined) return undefined;
  return [utf8Prefix(combined, 0, MEMORY_READ_WARNING_MAXIMUM_BYTES).text];
}

function baseStructuredContent(input: {
  readonly budgetTokens: number;
  readonly canonicalUri?: string;
  readonly complete: boolean;
  readonly content: string;
  readonly contentBytes: number;
  readonly cursor?: string;
  readonly estimatedTokens?: number;
  readonly mode: MemoryReadMode;
  readonly resourceCount: number;
  readonly resourceIndex: number;
  readonly requestedUri?: string;
  readonly section?: string;
  readonly warnings?: readonly string[];
}): MemoryReadPageStructuredContent {
  return {
    budgetTokens: input.budgetTokens,
    ...(input.canonicalUri === undefined ? {} : {canonicalUri: input.canonicalUri}),
    complete: input.complete,
    content: input.content,
    contentBytes: input.contentBytes,
    ...(input.cursor === undefined ? {} : {cursor: input.cursor}),
    estimatedTokens: input.estimatedTokens ?? 0,
    mode: input.mode,
    resource: input.resourceIndex + 1,
    resourceCount: input.resourceCount,
    ...(input.requestedUri === undefined ? {} : {requestedUri: input.requestedUri}),
    ...(input.section === undefined ? {} : {section: input.section}),
    type: 'threadnote-read-page',
    version: 1,
    ...(input.warnings === undefined ? {} : {warnings: input.warnings}),
  };
}

function finalizedStructuredContent(
  input: MemoryReadPageStructuredContent,
  receipt?: string,
): MemoryReadPageStructuredContent {
  let value = input;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const next = {...value, estimatedTokens: estimatedTokens(responseBytes(value.content, receipt, value))};
    if (next.estimatedTokens === value.estimatedTokens) return next;
    value = next;
  }
  return value;
}

function responseBytes(
  content: string,
  receipt: string | undefined,
  structuredContent: MemoryReadPageStructuredContent,
): number {
  return utf8Bytes(content) + utf8Bytes(receipt ?? '') + utf8Bytes(JSON.stringify(structuredContent));
}

function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / MEMORY_READ_ESTIMATED_BYTES_PER_TOKEN);
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
