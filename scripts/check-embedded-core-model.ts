import {
  BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH,
  BUNDLED_CORE_EMBEDDING_MANIFEST,
} from '../src/models/core-embedding-asset.js';

const BUNDLED_MODEL_LICENSE_SHA256 = '587a673933425dbc36ec61268d3b954051b2d3ef3c9b322ede357976055ffdd5';
const source = Bun.file(new URL(`../${BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH}`, import.meta.url));
const license = Bun.file(new URL('../assets/models/licenses/bge-small-en-v1.5.LICENSE', import.meta.url));
if (!(await source.exists())) {
  throw new Error(`Bundled core embedding model is missing: ${BUNDLED_CORE_EMBEDDING_ASSET_RELATIVE_PATH}`);
}
if (source.size !== BUNDLED_CORE_EMBEDDING_MANIFEST.size) {
  throw new Error(
    `Bundled core embedding model has ${source.size} bytes; expected ${BUNDLED_CORE_EMBEDDING_MANIFEST.size}.`,
  );
}
const hash = new Bun.CryptoHasher('sha256');
for await (const chunk of source.stream()) hash.update(chunk);
const sha256 = hash.digest('hex');
if (sha256 !== BUNDLED_CORE_EMBEDDING_MANIFEST.sha256) {
  throw new Error('Bundled core embedding model checksum does not match its manifest.');
}
if (!(await license.exists())) {
  throw new Error('Bundled core embedding model license notice is missing.');
}
if (new Bun.CryptoHasher('sha256').update(await license.arrayBuffer()).digest('hex') !== BUNDLED_MODEL_LICENSE_SHA256) {
  throw new Error('Bundled core embedding model license notice does not match the pinned upstream notice.');
}

await Bun.write(Bun.stdout, 'Embedded core model source checks passed.\n');
