import {describe, expect, it} from 'vitest';
import {javascriptStringLiteral} from '../../scripts/effect/javascript.js';

describe('build-time JavaScript string serialization', () => {
  it('preserves the value without emitting script-breaking characters', () => {
    const value = '</script> "quoted" \\\nline\u2028separator\u2029paragraph';
    const literal = javascriptStringLiteral(value);

    expect(literal).not.toMatch(/[<>\u2028\u2029]/);
    expect(JSON.parse(literal)).toBe(value);
  });
});
