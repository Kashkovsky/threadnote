import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  IMAGE_PROJECTION_EXACT_TOKEN_LIMIT,
  extractExactMemoryTokens,
  renderExactTokenAppendix,
} from '../../src/image_projection/exact_tokens.js';

describe('image projection exact tokens', () => {
  it('extracts Threadnote identifiers and strips trailing URI punctuation', () => {
    const source = [
      'See threadnote://user/me/memories/durable/projects/threadnote/plan.md.',
      'memory_id: tn_abc123',
      'Continue with read_context cursor tnrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.',
      'node cgs_0123456789abcdef0123456789abcdef and handle cgr_repo_node',
      'duplicate tn_abc123',
    ].join('\n');
    expect(extractExactMemoryTokens(source)).toEqual([
      'threadnote://user/me/memories/durable/projects/threadnote/plan.md',
      'tn_abc123',
      'tnrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'cgs_0123456789abcdef0123456789abcdef',
      'cgr_repo_node',
    ]);
  });

  it('omits an appendix when no exact tokens are present', () => {
    expect(renderExactTokenAppendix([])).toBeUndefined();
    expect(extractExactMemoryTokens('plain prose without identifiers')).toEqual([]);
  });

  it('keeps extracted tokens as source substrings and caps uniqueness', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('tn_deadbeef', 'tnrc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cgr_node'), {
          maxLength: 12,
          minLength: 1,
        }),
        fc.string({maxLength: 40}),
        (ids, filler) => {
          const source = `${filler}\n${ids.join(' and ')}\n${filler}`;
          const extracted = extractExactMemoryTokens(source);
          expect(extracted.length).toBeLessThanOrEqual(IMAGE_PROJECTION_EXACT_TOKEN_LIMIT);
          expect(new Set(extracted).size).toBe(extracted.length);
          for (const token of extracted) {
            expect(source.includes(token)).toBe(true);
          }
          for (const id of ids) {
            expect(extracted).toContain(id);
          }
        },
      ),
    );
  });
});
