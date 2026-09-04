import {describe, expect, it} from 'vitest';
import {mcpCallToolResultWithTelemetryMetadata} from '../../src/effect/ai/mcp.js';
import {
  buildImageProjectedReadResult,
  imageProjectionAttemptEligible,
  imageProjectionSourceText,
} from '../../src/image_projection/mcp_result.js';

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
      resource: 1,
      resourceCount: 2,
    });
    expect(result?._meta['threadnote.io/read-page'].resource).toBe(1);
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

  it('bounds appended warnings', () => {
    const result = buildImageProjectedReadResult({
      budgetTokens: 1_500,
      pages: [{height: 8, png: PNG, width: 8}],
      resources: [{text: 'body', uri: 'threadnote://test/a.md'}],
      source: 'body',
      warnings: [`sync failed: ${'x'.repeat(400)}`],
    });
    const caption = result?.content.find(block => block.type === 'text')?.text ?? '';
    const warningLine = caption.split('\n')[1] ?? '';
    expect(warningLine.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(warningLine, 'utf8')).toBeLessThanOrEqual(160);
    expect(warningLine.startsWith('sync failed:')).toBe(true);
  });
});
