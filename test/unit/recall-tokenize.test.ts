import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {identifiers, indexTerms} from '../../src/recall/index_lexical.js';

describe('recall tokenization', () => {
  it('keeps Ukrainian words and splits apostrophe and hyphen compounds', () => {
    expect(indexTerms('Пам’ять про Київ-2026')).toEqual(["пам'ять", 'пам', 'ять', 'про', 'київ-2026', 'київ', '2026']);
  });

  it.prop(
    'is invariant under canonical Unicode composition',
    {
      parts: FC.array(FC.constantFrom('Київ', 'пам’ять', 'надійний', 'європейський-2026'), {
        maxLength: 16,
      }),
    },
    ({parts}) => {
      const value = parts.join(' ');
      expect(indexTerms(value.normalize('NFD'))).toEqual(indexTerms(value.normalize('NFC')));
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps Unicode identifier values bounded', () => {
    const values = Array.from({length: 100}, (_, index) => `Київ-${index}`).join(' ');
    const indexed = identifiers(values);
    expect(indexed).toHaveLength(64);
    expect(indexed[0]).toBe('київ-0');
    expect(indexed.every(identifier => /[\p{N}_.-]/u.test(identifier))).toBe(true);
  });
});
