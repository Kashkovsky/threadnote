import {Effect} from 'effect';
import {renderTextToImages} from 'pxpipe-proxy/transform';
import {fromPromise} from '../effect/errors.js';

export interface RenderedMemoryImagePage {
  readonly height: number;
  readonly png: Uint8Array;
  readonly width: number;
}

export interface RenderedMemoryImages {
  readonly droppedChars: number;
  readonly pages: readonly RenderedMemoryImagePage[];
}

export type MemoryImageRenderer = (text: string) => Effect.Effect<RenderedMemoryImages, unknown>;

export const renderMemoryTextToImages: MemoryImageRenderer = Effect.fn('imageProjection.render')(function* (
  text: string,
) {
  const result = yield* fromPromise('render memory text to images', () => renderTextToImages(text, {reflow: true}));
  return {
    droppedChars: result.droppedChars,
    pages: result.pages.map(page => ({height: page.height, png: page.png, width: page.width})),
  };
});
