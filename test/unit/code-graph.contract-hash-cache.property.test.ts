import {createHash} from 'node:crypto';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {createCachedCodeGraphContractHash} from '../../src/code_graph/cached_contract_hash.js';
import {codeGraphInventoryReuseContract} from '../../src/code_graph/inventory_reuse.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  packCacheIdentity,
  packDerivationIdentity,
} from '../../src/code_graph/languages/registry.js';
import type {CodeGraphLanguagePack} from '../../src/code_graph/languages/types.js';

const nativeHash = (input: string) => createHash('sha256').update(input).digest('hex');
const fixturePack = BUILTIN_LANGUAGE_PACK_REGISTRY.packs[0];
const mutableFixturePack = BUILTIN_LANGUAGE_PACK_REGISTRY.packs.find(pack => pack.assets.length > 0)!;

function clonePack(pack: CodeGraphLanguagePack) {
  return {
    ...pack,
    assets: pack.assets.map(asset => ({...asset})),
    capabilities: new Set(pack.capabilities),
    extractor: {...pack.extractor},
    files: pack.files.map(file => ({...file})),
    resolutionStrategy: {...pack.resolutionStrategy},
  };
}

function packState(pack: CodeGraphLanguagePack): string {
  return JSON.stringify({...pack, capabilities: [...pack.capabilities]});
}

describe('code graph pure contract digest caches', () => {
  it('preserves retained catalog contract and language-pack digests', () => {
    expect(fixturePack.id).toBe('apex');
    expect(packCacheIdentity(fixturePack)).toBe('fbf422bfd91437e705e1eb2ee583487b40b27719a6be49f8e014fb44d4faecd3');
    expect(packDerivationIdentity(fixturePack)).toBe(
      'caacde722edfe4f0f411f12dfc71b5a592c2c6a4e9218cc0415301af80c17a22',
    );
    expect(codeGraphInventoryReuseContract(BUILTIN_LANGUAGE_PACK_REGISTRY, false)).toBe(
      '0dfda8c81dfdb76e49efe5ba28377987206430886a1ccb8252b3516c2b7b4919',
    );
    expect(codeGraphInventoryReuseContract(BUILTIN_LANGUAGE_PACK_REGISTRY, true)).toBe(
      'f09ceb40f50c5e59db7ca46679b4e7b2b141be2d3959aac67427294108cc076e',
    );
  });

  it('matches native SHA-256 across owner reuse, changed inputs, and restored inputs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({owner: fc.integer({min: 0, max: 3}), input: fc.string({maxLength: 250})}), {
          minLength: 1,
          maxLength: 20,
        }),
        operations => {
          const hash = createCachedCodeGraphContractHash();
          const owners = Array.from({length: 4}, (_, id) => Object.freeze({id}));
          for (const {owner, input} of [...operations, ...[...operations].reverse()]) {
            expect(hash(owners[owner], input)).toBe(nativeHash(input));
            expect(hash(owners[owner], input)).toBe(nativeHash(input));
          }
        },
      ),
      {numRuns: 50},
    );
  });

  it('preserves exact UTF-8 hashing across the cache limit and oversized fallback', () => {
    const hash = createCachedCodeGraphContractHash();
    const owner = Object.freeze({});
    for (const input of [
      'before',
      '\u0000\ud800\udfff\ud83d\ude80',
      'x'.repeat(65_536),
      'y'.repeat(65_537),
      'before',
    ]) {
      expect(hash(owner, input)).toBe(nativeHash(input));
      expect(hash(owner, input)).toBe(nativeHash(input));
    }
  });

  it('detects in-place policy and pack mutations without changing the input objects', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            field: fc.constantFrom('matcher', 'role', 'asset', 'extractor', 'version', 'resolver', 'capability', 'id'),
            suffix: fc.integer({min: 0, max: 100_000}),
            opaque: fc.boolean(),
          }),
          {minLength: 1, maxLength: 15},
        ),
        mutations => {
          const pack = clonePack(mutableFixturePack);
          const registry = {...BUILTIN_LANGUAGE_PACK_REGISTRY, packs: [pack]};
          const original = packState(pack);
          const originalHashes = [packCacheIdentity(pack), packDerivationIdentity(pack)];
          const originalContracts = [false, true].map(opaque => codeGraphInventoryReuseContract(registry, opaque));
          for (const {field, suffix, opaque} of mutations) {
            if (field === 'matcher') pack.files[0].value = `.changed-${suffix}`;
            else if (field === 'role') pack.files[0].role = suffix % 2 === 0 ? 'manifest' : 'source';
            else if (field === 'asset') pack.assets[0].version = `asset-${suffix}`;
            else if (field === 'extractor') pack.extractor.version = `extractor-${suffix}`;
            else if (field === 'version') pack.version = `version-${suffix}`;
            else if (field === 'resolver') pack.resolutionStrategy.version = `resolver-${suffix}`;
            else if (field === 'capability') {
              if (suffix % 2 === 0) pack.capabilities.add('declarations');
              else pack.capabilities.delete('declarations');
            } else pack.id = `identity-${suffix}`;
            const before = packState(pack);
            const fresh = clonePack(pack);
            expect(packCacheIdentity(pack)).toBe(packCacheIdentity(fresh));
            expect(packDerivationIdentity(pack)).toBe(packDerivationIdentity(fresh));
            expect(codeGraphInventoryReuseContract(registry, opaque)).toBe(
              codeGraphInventoryReuseContract({...registry, packs: [fresh]}, opaque),
            );
            expect(packState(pack)).toBe(before);
          }
          Object.assign(pack, clonePack(mutableFixturePack));
          expect(packState(pack)).toBe(original);
          expect([packCacheIdentity(pack), packDerivationIdentity(pack)]).toEqual(originalHashes);
          expect([false, true].map(opaque => codeGraphInventoryReuseContract(registry, opaque))).toEqual(
            originalContracts,
          );
        },
      ),
      {numRuns: 50},
    );
  });
});
