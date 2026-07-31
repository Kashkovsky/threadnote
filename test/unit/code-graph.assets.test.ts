import {describe, expect, it} from 'vitest';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';

interface GrammarManifestEntry {
  readonly abi: number;
  readonly license: string;
  readonly licensePackagePath?: string;
  readonly packagePath?: string;
  readonly path: string;
  readonly sha256: string;
  readonly source: string;
  readonly version: string;
}

describe('code graph grammar assets', () => {
  it('maps every runtime language asset to checksum-pinned release metadata', async () => {
    const manifest = (await Bun.file('assets/code-graph/manifest.json').json()) as {
      readonly grammars: Readonly<Record<string, GrammarManifestEntry>>;
    };
    const assets = BUILTIN_LANGUAGE_PACK_REGISTRY.packs.flatMap(pack => pack.assets);
    const manifestByPath = new Map(Object.values(manifest.grammars).map(entry => [entry.path, entry]));

    expect(new Set(assets.map(asset => asset.relativePath)).size).toBe(assets.length);
    expect(new Set(Object.values(manifest.grammars).map(entry => entry.path)).size).toBe(
      Object.keys(manifest.grammars).length,
    );
    expect([...manifestByPath.keys()].sort()).toEqual(assets.map(asset => asset.relativePath).sort());

    for (const asset of assets) {
      const metadata = manifestByPath.get(asset.relativePath);
      expect(metadata, asset.relativePath).toMatchObject({
        abi: asset.abi,
        path: asset.relativePath,
        sha256: asset.sha256,
        version: asset.version,
      });
      expect(metadata?.source, asset.relativePath).toMatch(/^https:\/\/github\.com\//);
      const source = await existingFile(
        `assets/code-graph/${asset.relativePath}`,
        asset.developmentRelativePath,
        metadata?.packagePath,
      );
      expect(source, asset.relativePath).toBeDefined();
      const bytes = await source!.arrayBuffer();
      const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      expect(checksum, asset.relativePath).toBe(asset.sha256);

      const license = await existingFile(`assets/code-graph/${metadata!.license}`, metadata?.licensePackagePath);
      expect(license, `${asset.relativePath} license`).toBeDefined();
      expect(license!.size, `${asset.relativePath} license`).toBeGreaterThan(0);
    }
  });
});

async function existingFile(...paths: Array<string | undefined>): Promise<ReturnType<typeof Bun.file> | undefined> {
  for (const path of paths) {
    if (!path) continue;
    const file = Bun.file(path);
    if (await file.exists()) return file;
  }
  return undefined;
}
