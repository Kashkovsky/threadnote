import {Effect} from 'effect';
import {extractorSetIdentityFromPackProvenance} from './indexer.js';
import {codeGraphLanguagePackProvenance, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphLanguagePackProvenance, CodeGraphStoreShape} from './store.js';
import type {CodeGraphSnapshot} from './types.js';

/** Prove that a snapshot's recorded extractor contract still matches the current language-pack catalog. */
export function codeGraphSnapshotMatchesCurrentLanguagePacks(
  snapshot: Pick<CodeGraphSnapshot, 'extractorSet'>,
  provenance: readonly CodeGraphLanguagePackProvenance[] | undefined,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): boolean {
  if (provenance === undefined) return false;
  const previousIds = new Set(provenance.map(pack => pack.id));
  if (previousIds.size !== provenance.length) return false;
  const currentProvenance = languagePacks.packs
    .filter(pack => previousIds.has(pack.id))
    .map(codeGraphLanguagePackProvenance);
  if (currentProvenance.length !== previousIds.size) return false;
  return (
    extractorSetIdentityFromPackProvenance(provenance) === snapshot.extractorSet &&
    extractorSetIdentityFromPackProvenance(currentProvenance) === snapshot.extractorSet
  );
}

export function codeGraphSnapshotRuntimeCurrent(
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshot: CodeGraphSnapshot,
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  return store.snapshotPackProvenance(databasePath, snapshot.id).pipe(
    Effect.map(provenance => codeGraphSnapshotMatchesCurrentLanguagePacks(snapshot, provenance, languagePacks)),
    Effect.orElseSucceed(() => false),
  );
}
