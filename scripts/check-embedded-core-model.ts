import {
  BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH,
  BUNDLED_CORE_EMBEDDING_MANIFEST,
} from '../src/models/core-embedding-asset.js';

const source = Bun.file(new URL(`../${BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH}`, import.meta.url));
if (!(await source.exists())) {
  throw new Error(`Bundled core embedding model is missing: ${BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH}`);
}
if (source.size !== BUNDLED_CORE_EMBEDDING_MANIFEST.size) {
  throw new Error(
    `Bundled core embedding model has ${source.size} bytes; expected ${BUNDLED_CORE_EMBEDDING_MANIFEST.size}.`,
  );
}
const sha256 = new Bun.CryptoHasher('sha256').update(await source.arrayBuffer()).digest('hex');
if (sha256 !== BUNDLED_CORE_EMBEDDING_MANIFEST.sha256) {
  throw new Error('Bundled core embedding model checksum does not match its manifest.');
}

await Bun.write(Bun.stdout, 'Embedded core model source checks passed.\n');
