import {Effect, Encoding, Result} from 'effect';
import type {RuntimeConfig} from '../types.js';
import {
  MEMORY_READ_DEFAULT_BUDGET_TOKENS,
  memoryReadWouldPage,
  type MemoryReadMode,
  type MemoryReadResource,
} from '../memory/read_projection.js';
import {extractExactMemoryTokens, renderExactTokenAppendix} from './exact_tokens.js';
import {isImageProjectionEnabled} from './config.js';
import {renderMemoryTextToImages, type MemoryImageRenderer, type RenderedMemoryImages} from './render.js';

export const IMAGE_PROJECTION_MAX_PAGES = 8 as const;
export const IMAGE_PROJECTION_MAX_DROPPED_CHARS = 16 as const;

export interface ImageProjectedReadResult {
  readonly _meta: {
    readonly 'threadnote.io/memory-scope'?: unknown;
    readonly 'threadnote.io/read-page': ImageProjectedReadPageMeta;
  };
  readonly content: readonly ImageProjectedContentBlock[];
  readonly structuredContent: ImageProjectedStructuredContent;
}

export interface ImageProjectedReadPageMeta {
  readonly canonicalUri?: string;
  readonly contentIndex: 0;
  readonly pageCount: number;
  readonly projection: 'image';
  readonly requestedUri?: string;
  readonly resource: number;
  readonly resourceCount: number;
  readonly type: 'threadnote-read-page';
  readonly uri: string;
  readonly version: 1;
}

export interface ImageProjectedStructuredContent {
  readonly budgetTokens: number;
  readonly canonicalUri?: string;
  readonly complete: true;
  readonly content: '';
  readonly contentBytes: 0;
  readonly estimatedTokens: 0;
  readonly mode: 'content';
  readonly pageCount: number;
  readonly projection: 'image';
  readonly requestedUri?: string;
  readonly resource: number;
  readonly resourceCount: number;
  readonly type: 'threadnote-read-page';
  readonly version: 1;
}

export type ImageProjectedContentBlock =
  | {readonly text: string; readonly type: 'text'}
  | {readonly data: string; readonly mimeType: 'image/png'; readonly type: 'image'};

export interface TryProjectMemoryReadAsImagesInput {
  readonly budgetTokens?: number;
  readonly config: Pick<RuntimeConfig, 'agentContextHome'>;
  readonly memoryScopeReceipt?: unknown;
  readonly mode?: MemoryReadMode;
  readonly render?: MemoryImageRenderer;
  readonly requestedCursor?: string;
  readonly resources: readonly MemoryReadResource[];
  readonly section?: string;
  readonly warnings?: readonly string[];
}

export function imageProjectionAttemptEligible(options: {
  readonly mode?: MemoryReadMode;
  readonly requestedCursor?: string;
  readonly section?: string;
}): boolean {
  if ((options.requestedCursor ?? '').trim().length > 0) return false;
  if ((options.mode ?? 'content') !== 'content') return false;
  return (options.section ?? '').trim().length === 0;
}

export function imageProjectionSourceText(resources: readonly MemoryReadResource[]): string {
  if (resources.length === 1) return resources[0]?.text ?? '';
  return resources.map(resource => `## ${resource.uri}\n\n${resource.text}`).join('\n\n');
}

export function buildImageProjectedReadResult(options: {
  readonly budgetTokens: number;
  readonly memoryScopeReceipt?: unknown;
  readonly pages: RenderedMemoryImages['pages'];
  readonly resources: readonly MemoryReadResource[];
  readonly source: string;
  readonly warnings?: readonly string[];
}): ImageProjectedReadResult | undefined {
  if (options.pages.length === 0 || options.pages.length > IMAGE_PROJECTION_MAX_PAGES) return undefined;
  const resource = options.resources[0];
  if (resource === undefined) return undefined;
  const appendix = renderExactTokenAppendix(extractExactMemoryTokens(options.source));
  const caption = [
    `Full memory as ${options.pages.length} PNG page${options.pages.length === 1 ? '' : 's'}. Image projection is lossy for hex and identifiers.`,
    ...(options.warnings ?? []),
  ].join('\n');
  const structuredContent: ImageProjectedStructuredContent = {
    budgetTokens: options.budgetTokens,
    complete: true,
    content: '',
    contentBytes: 0,
    estimatedTokens: 0,
    mode: 'content',
    pageCount: options.pages.length,
    projection: 'image',
    resource: 0,
    resourceCount: options.resources.length,
    type: 'threadnote-read-page',
    version: 1,
    ...(resource.canonicalUri === undefined ? {} : {canonicalUri: resource.canonicalUri}),
    ...(resource.requestedUri === undefined ? {} : {requestedUri: resource.requestedUri}),
  };
  return {
    _meta: {
      ...(options.memoryScopeReceipt === undefined ? {} : {'threadnote.io/memory-scope': options.memoryScopeReceipt}),
      'threadnote.io/read-page': {
        contentIndex: 0,
        pageCount: options.pages.length,
        projection: 'image',
        resource: 0,
        resourceCount: options.resources.length,
        type: 'threadnote-read-page',
        uri: resource.uri,
        version: 1,
        ...(resource.canonicalUri === undefined ? {} : {canonicalUri: resource.canonicalUri}),
        ...(resource.requestedUri === undefined ? {} : {requestedUri: resource.requestedUri}),
      },
    },
    content: [
      {text: caption, type: 'text'},
      ...options.pages.map(page => ({
        data: Encoding.encodeBase64(page.png),
        mimeType: 'image/png' as const,
        type: 'image' as const,
      })),
      ...(appendix === undefined ? [] : [{text: appendix, type: 'text' as const}]),
    ],
    structuredContent,
  };
}

export const tryProjectMemoryReadAsImages = Effect.fn('imageProjection.tryProjectRead')(function* (
  input: TryProjectMemoryReadAsImagesInput,
) {
  if (!imageProjectionAttemptEligible(input)) return undefined;
  const budgetTokens = input.budgetTokens ?? MEMORY_READ_DEFAULT_BUDGET_TOKENS;
  const wouldPage = Result.try(() =>
    memoryReadWouldPage(input.resources, {
      budgetTokens,
      mode: input.mode,
      section: input.section,
    }),
  );
  if (Result.isFailure(wouldPage) || !wouldPage.success) return undefined;
  if (!(yield* isImageProjectionEnabled(input.config))) return undefined;
  const source = imageProjectionSourceText(input.resources).trim();
  if (source.length === 0) return undefined;
  const rendered = yield* (input.render ?? renderMemoryTextToImages)(source).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (rendered === undefined || rendered.droppedChars > IMAGE_PROJECTION_MAX_DROPPED_CHARS) return undefined;
  return buildImageProjectedReadResult({
    budgetTokens,
    memoryScopeReceipt: input.memoryScopeReceipt,
    pages: rendered.pages,
    resources: input.resources,
    source,
    warnings: input.warnings,
  });
});
