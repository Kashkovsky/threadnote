import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {escapeGraphMarkup, escapeHtmlText, normalizeCodeGraphText} from '../../src/code_graph/export.js';

const sourceTextArbitrary = FC.array(
  FC.constantFrom(
    'a',
    'Z',
    '0',
    ' ',
    '\t',
    '\n',
    '\r',
    '\u0000',
    '\u0001',
    '\u000b',
    '\ud800',
    '\udfff',
    '\ufffe',
    '\uffff',
    '&',
    '<',
    '>',
    '"',
    "'",
    'é',
    '漢',
    '🙂',
  ),
  {maxLength: 160},
).map(characters => characters.join(''));

describe('code graph export markup properties', () => {
  it.prop(
    'normalizes arbitrary repository text to bounded XML 1.0 characters without splitting surrogates',
    {maximum: FC.integer({max: 128, min: 1}), value: sourceTextArbitrary},
    ({maximum, value}) => {
      const normalized = normalizeCodeGraphText(value, maximum);

      expect(normalized.length).toBeLessThanOrEqual(maximum);
      expect([...normalized].every(character => isXmlCharacter(character.codePointAt(0)!))).toBe(true);
      expect(hasUnpairedSurrogate(normalized)).toBe(false);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'escapes XML and HTML metacharacters while preserving normalized text',
    {value: sourceTextArbitrary},
    ({value}) => {
      const normalized = normalizeCodeGraphText(value, Number.MAX_SAFE_INTEGER);
      const xml = escapeGraphMarkup(value);
      const html = escapeHtmlText(value);

      expect(xml).not.toMatch(/[<>"']/);
      expect(html).not.toMatch(/[<>"']/);
      expect(decodeEntities(xml)).toBe(normalized);
      expect(decodeEntities(html)).toBe(normalized);
    },
    {fastCheck: {numRuns: 250}},
  );
});

function isXmlCharacter(point: number): boolean {
  return (
    point === 0x9 ||
    point === 0xa ||
    point === 0xd ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}
