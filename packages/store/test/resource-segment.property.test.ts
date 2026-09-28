import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {uriSegment} from '@threadnote/store/resource-segment';

const mixedInputArbitrary = FC.array(
  FC.oneof(FC.string({maxLength: 8}), FC.constantFrom('-', '_', '.', ' ', '/', '+', 'é', '中', 'क', '😀', 'İ')),
  {maxLength: 32},
).map(parts => parts.join(''));

describe('uriSegment', () => {
  it('handles a long boundary run without a polynomial regular expression', () => {
    expect(uriSegment('-'.repeat(100_000))).toBe('unknown');
  });

  it('preserves the established normalization behavior', () => {
    expect(uriSegment('  Project / Notes  ')).toBe('project-notes');
    expect(uriSegment('___Already.Safe___')).toBe('___already.safe___');
    expect(uriSegment('é中😀')).toBe('unknown');
  });

  fcProp(
    it,
    'matches the character-by-character model and is idempotent',
    {value: mixedInputArbitrary},
    ({value}) => {
      const normalized = uriSegment(value);

      expect(normalized).toBe(referenceUriSegment(value));
      expect(uriSegment(normalized)).toBe(normalized);
      expect(normalized).toMatch(/^[a-z0-9._-]+$/);
      expect(normalized.startsWith('-')).toBe(false);
      expect(normalized.endsWith('-')).toBe(false);
    },
    {fastCheck: {numRuns: 250}},
  );
});

function referenceUriSegment(value: string): string {
  let normalized = '';
  let replacingUnsafeRun = false;

  for (const character of value.toLowerCase()) {
    if (isAllowed(character)) {
      normalized += character;
      replacingUnsafeRun = false;
    } else if (!replacingUnsafeRun) {
      normalized += '-';
      replacingUnsafeRun = true;
    }
  }

  const characters = [...normalized];
  while (characters[0] === '-') characters.shift();
  while (characters.at(-1) === '-') characters.pop();
  return characters.length > 0 ? characters.join('') : 'unknown';
}

function isAllowed(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') ||
    character === '.' ||
    character === '_' ||
    character === '-'
  );
}
