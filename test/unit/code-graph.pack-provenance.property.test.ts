import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {extractorSetIdentityFromPackProvenance} from '../../src/code_graph/indexer.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  codeGraphLanguagePackProvenance,
  createCodeGraphLanguagePackRegistry,
} from '../../src/code_graph/languages/registry.js';
import {assessCodeGraphLanguagePackDelta} from '../../src/code_graph/languages/provenance.js';
import {codeGraphSnapshotMatchesCurrentLanguagePacks} from '../../src/code_graph/query.js';
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

  it.effect.prop(
    'recognizes current snapshot contracts independent of active-pack ordering and rejects provenance drift',
    {
      activeIds: FC.uniqueArray(FC.constantFrom(...packIds), {minLength: 1}),
      reverseCatalog: FC.boolean(),
      reverseReceipt: FC.boolean(),
    },
    ({activeIds, reverseCatalog, reverseReceipt}) =>
      Effect.sync(() => {
        const activeIdSet = new Set<string>(activeIds);
        const selected = BUILTIN_LANGUAGE_PACK_REGISTRY.packs.filter(value => activeIdSet.has(value.id));
        const registry = createCodeGraphLanguagePackRegistry(reverseCatalog ? [...selected].reverse() : selected);
        const provenance = selected.map(codeGraphLanguagePackProvenance);
        const extractorSet = extractorSetIdentityFromPackProvenance(provenance);
        const snapshot = {extractorSet};
        const storedProvenance = reverseReceipt ? [...provenance].reverse() : provenance;

        expect(codeGraphSnapshotMatchesCurrentLanguagePacks(snapshot, storedProvenance, registry)).toBe(true);
        expect(
          codeGraphSnapshotMatchesCurrentLanguagePacks(
            snapshot,
            storedProvenance.map((value, index) =>
              index === 0 ? {...value, cacheIdentity: `${value.cacheIdentity}-stale`} : value,
            ),
            registry,
          ),
        ).toBe(false);
      }),
    {fastCheck: {numRuns: 100}},
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
