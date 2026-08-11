import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {extractorSetIdentityFromPackProvenance} from '../../src/code_graph/indexer.js';
import {assessCodeGraphLanguagePackDelta} from '../../src/code_graph/languages/provenance.js';
import type {CodeGraphLanguagePackProvenance} from '../../src/code_graph/store.js';

const packIds = ['typescript', 'bazel', 'python', 'java'] as const;

describe('code graph language-pack provenance', () => {
  it.effect.prop(
    'selects exactly cache-identity changes independent of receipt ordering',
    {
      changed: FC.uniqueArray(FC.constantFrom(...packIds), {maxLength: packIds.length}),
      reversePrevious: FC.constantFrom(false, true),
      reverseCurrent: FC.constantFrom(false, true),
    },
    ({changed, reverseCurrent, reversePrevious}) =>
      Effect.sync(() => {
        const previous = packIds.map(pack);
        const changedIds = new Set<string>(changed);
        const current = previous.map(value =>
          changedIds.has(value.id) ? {...value, cacheIdentity: `${value.cacheIdentity}-next`} : value,
        );
        const result = assessCodeGraphLanguagePackDelta(
          reversePrevious ? [...previous].reverse() : previous,
          reverseCurrent ? [...current].reverse() : current,
        );
        expect(result).toEqual({changedPackIds: [...changed].sort(), mode: 'compatible'});
        expect(extractorSetIdentityFromPackProvenance(previous)).toBe(
          extractorSetIdentityFromPackProvenance([...previous].reverse()),
        );
      }),
    {fastCheck: {numRuns: 100}},
  );

  it.effect('fails closed when resolution derivation or active pack membership changes', () =>
    Effect.sync(() => {
      const previous = [pack('typescript'), pack('bazel')];
      expect(
        assessCodeGraphLanguagePackDelta(previous, [
          {...pack('typescript'), resolutionVersion: 'resolver-v2'},
          pack('bazel'),
        ]),
      ).toEqual({mode: 'fallback', reason: 'pack-surface-changed'});
      expect(assessCodeGraphLanguagePackDelta(previous, [pack('typescript')])).toEqual({
        mode: 'fallback',
        reason: 'pack-surface-changed',
      });
      expect(assessCodeGraphLanguagePackDelta([], previous)).toEqual({
        mode: 'fallback',
        reason: 'missing-provenance',
      });
    }),
  );
});

function pack(id: string): CodeGraphLanguagePackProvenance {
  return {
    cacheIdentity: `${id}-extractor-v1`,
    derivationIdentity: `${id}-derivation-v1`,
    id,
    resolutionDomain: id,
    resolutionVersion: 'resolver-v1',
  };
}
