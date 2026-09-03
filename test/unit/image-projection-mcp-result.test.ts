import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe, expect, it} from 'vitest';
import {mcpCallToolResultWithTelemetryMetadata} from '../../src/effect/ai/mcp.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  IMAGE_PROJECTION_MAX_DROPPED_CHARS,
  buildImageProjectedReadResult,
  imageProjectionAttemptEligible,
  imageProjectionSourceText,
  tryProjectMemoryReadAsImages,
} from '../../src/image_projection/mcp_result.js';
import {imageProjectionConfiguration, writeImageProjectionConfiguration} from '../../src/image_projection/config.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('image projection MCP results', () => {
  it('skips imaging when a cursor, outline, or section is present', () => {
    expect(imageProjectionAttemptEligible({})).toBe(true);
    expect(imageProjectionAttemptEligible({requestedCursor: 'tnrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})).toBe(false);
    expect(imageProjectionAttemptEligible({mode: 'outline'})).toBe(false);
    expect(imageProjectionAttemptEligible({section: '## Setup'})).toBe(false);
  });

  it('concatenates multiple URIs with headers and omits the body from structuredContent', () => {
    const resources = [
      {text: 'First body tn_abc123', uri: 'threadnote://user/me/memories/durable/projects/threadnote/a.md'},
      {text: 'Second body', uri: 'threadnote://user/me/memories/durable/projects/threadnote/b.md'},
    ];
    const source = imageProjectionSourceText(resources);
    expect(source).toContain('## threadnote://user/me/memories/durable/projects/threadnote/a.md');
    const result = buildImageProjectedReadResult({
      budgetTokens: 1_500,
      pages: [{height: 8, png: PNG, width: 8}],
      resources,
      source,
    });
    expect(result?.structuredContent).toMatchObject({
      complete: true,
      content: '',
      pageCount: 1,
      projection: 'image',
      resourceCount: 2,
    });
    expect(result?.content.some(block => block.type === 'text' && block.text.includes('tn_abc123'))).toBe(true);
    expect(
      result?.content.some(
        block =>
          block.type === 'image' &&
          block.mimeType === 'image/png' &&
          Buffer.from(block.data, 'base64')
            .subarray(0, 8)
            .equals(Buffer.from(PNG.subarray(0, 8))),
      ),
    ).toBe(true);
    expect(mcpCallToolResultWithTelemetryMetadata(result!)).toMatchObject({
      structuredContent: {projection: 'image', content: ''},
    });
  });

  effectIt.effect('images only when paging would be incomplete, and falls back on dropped glyphs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-image-projection-mcp-'});
        const config = runtimeConfig(home);
        const large = {text: `${'ASCII evidence line\n'.repeat(800)}tn_deadbeef`, uri: 'threadnote://test/large.md'};
        const small = {text: 'fits', uri: 'threadnote://test/small.md'};

        yield* writeImageProjectionConfiguration(config, imageProjectionConfiguration(true));

        const completeText = yield* tryProjectMemoryReadAsImages({
          config,
          render: () => Effect.succeed({droppedChars: 0, pages: [{height: 8, png: PNG, width: 8}]}),
          resources: [small],
        });
        expect(completeText).toBeUndefined();

        const imaged = yield* tryProjectMemoryReadAsImages({
          config,
          render: () => Effect.succeed({droppedChars: 0, pages: [{height: 8, png: PNG, width: 8}]}),
          resources: [large],
        });
        expect(imaged?.structuredContent.projection).toBe('image');
        expect(imaged?.structuredContent.content).toBe('');
        expect(imaged?.content.some(block => block.type === 'image')).toBe(true);

        const dropped = yield* tryProjectMemoryReadAsImages({
          config,
          render: () =>
            Effect.succeed({
              droppedChars: IMAGE_PROJECTION_MAX_DROPPED_CHARS + 1,
              pages: [{height: 8, png: PNG, width: 8}],
            }),
          resources: [large],
        });
        expect(dropped).toBeUndefined();
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function runtimeConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: `${agentContextHome}/manifest.yaml`,
    user: 'tester',
  };
}
