import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {compareCodeUnits, compareNaturalCodeUnits} from '../../src/code_graph/ordering.js';

const unicodeEdgeCases = ['Z', 'é', '\u0000', '\ud800', '\udfff', '\ud800A', 'A\udfff', '😀', '\uffff'] as const;

const arbitraryCodeUnitString = FC.oneof(
  FC.constantFrom(...unicodeEdgeCases),
  FC.array(FC.integer({max: 0xffff, min: 0}), {maxLength: 32}).map(codeUnits => String.fromCharCode(...codeUnits)),
);

const arbitraryNaturalString = FC.tuple(
  arbitraryCodeUnitString,
  FC.integer({max: 1_000_000, min: 0}),
  arbitraryCodeUnitString,
).map(([prefix, number, suffix]) => `${prefix}${number}${suffix}`);

describe('code graph deterministic ordering properties', () => {
  it.prop(
    'matches ECMAScript relational order for Unicode and surrogate strings',
    {left: arbitraryCodeUnitString, right: arbitraryCodeUnitString},
    ({left, right}) => {
      const expected = referenceCodeUnitCompare(left, right);
      expect(compareCodeUnits(left, right)).toBe(expected);
      expect(compareCodeUnits(right, left)).toBe(inverseSign(expected));
      expect(compareCodeUnits(left, right) === 0).toBe(left === right);
    },
    {fastCheck: {numRuns: 500}},
  );

  it.prop(
    'produces the same total sort as the UTF-16 reference regardless of input order',
    {values: FC.array(arbitraryCodeUnitString, {maxLength: 48})},
    ({values}) => {
      const expected = [...values].sort(referenceCodeUnitCompare);
      expect([...values].sort(compareCodeUnits)).toEqual(expected);
      expect([...values].reverse().sort(compareCodeUnits)).toEqual(expected);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('covers known ordering boundaries explicitly', () => {
    const values = [...unicodeEdgeCases];
    expect(values.sort(compareCodeUnits)).toEqual([...unicodeEdgeCases].sort(referenceCodeUnitCompare));
    expect(compareCodeUnits('Z', 'é')).toBeLessThan(0);
    expect(compareCodeUnits('\ud800', '\udfff')).toBeLessThan(0);
  });

  it.prop(
    'keeps natural ordering total and antisymmetric for Unicode strings with numeric runs',
    {left: arbitraryNaturalString, right: arbitraryNaturalString},
    ({left, right}) => {
      const comparison = compareNaturalCodeUnits(left, right);
      expect(Math.sign(compareNaturalCodeUnits(right, left))).toBe(inverseSign(Math.sign(comparison)));
      expect(comparison === 0).toBe(left === right);
    },
    {fastCheck: {numRuns: 300}},
  );

  it.prop(
    'keeps natural ordering transitive across Unicode strings and numeric runs',
    {first: arbitraryNaturalString, second: arbitraryNaturalString, third: arbitraryNaturalString},
    ({first, second, third}) => {
      const firstToSecond = compareNaturalCodeUnits(first, second);
      const secondToThird = compareNaturalCodeUnits(second, third);
      if (firstToSecond <= 0 && secondToThird <= 0) {
        expect(compareNaturalCodeUnits(first, third)).toBeLessThanOrEqual(0);
      }
      if (firstToSecond >= 0 && secondToThird >= 0) {
        expect(compareNaturalCodeUnits(first, third)).toBeGreaterThanOrEqual(0);
      }
    },
    {fastCheck: {numRuns: 500}},
  );

  it.prop(
    'orders archive-style ASCII digit runs by numeric magnitude',
    {
      left: FC.integer({max: 1_000_000, min: 0}),
      right: FC.integer({max: 1_000_000, min: 0}),
    },
    ({left, right}) => {
      expect(Math.sign(compareNaturalCodeUnits(`chapter${left}.xml`, `chapter${right}.xml`))).toBe(
        Math.sign(left - right),
      );
    },
    {fastCheck: {numRuns: 300}},
  );

  it('compares numeric runs without Number precision limits', () => {
    expect(compareNaturalCodeUnits('chapter2.xml', 'chapter10.xml')).toBeLessThan(0);
    expect(
      compareNaturalCodeUnits('chapter999999999999999999999.xml', 'chapter1000000000000000000000.xml'),
    ).toBeLessThan(0);
  });
});

function referenceCodeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inverseSign(value: number): number {
  return value === 0 ? 0 : -value;
}
