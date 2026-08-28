import {describe, expect, it} from 'vitest';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../../src/code_graph/languages/registry.js';
import {TREE_SITTER_RUNTIME_CACHE_IDENTITY} from '../../src/code_graph/tree_sitter/runtime.js';

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

interface RuntimeManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly source: string;
  readonly version: string;
}

describe('code graph grammar assets', () => {
  it('keeps the parser package, lockfile, vendored runtime, and cache identity on one exact release', async () => {
    const [assetManifest, lockfile, packageManifest, installedManifest, thirdPartyNotices] = await Promise.all([
      Bun.file('assets/code-graph/manifest.json').json() as Promise<{readonly runtime: RuntimeManifestEntry}>,
      Bun.file('bun.lock').text(),
      Bun.file('package.json').json() as Promise<{
        readonly dependencies?: Readonly<Record<string, string>>;
      }>,
      Bun.file('node_modules/web-tree-sitter/package.json').json() as Promise<{readonly version?: string}>,
      Bun.file('THIRD_PARTY.md').text(),
    ]);
    const expectedVersion = packageManifest.dependencies?.['web-tree-sitter'];
    const runtime = assetManifest.runtime;
    const [packagedRuntime, vendoredRuntime] = await Promise.all([
      Bun.file('node_modules/web-tree-sitter/web-tree-sitter.wasm').arrayBuffer(),
      Bun.file(`assets/code-graph/${runtime.path}`).arrayBuffer(),
    ]);
    const packagedSha256 = new Bun.CryptoHasher('sha256').update(packagedRuntime).digest('hex');
    const vendoredSha256 = new Bun.CryptoHasher('sha256').update(vendoredRuntime).digest('hex');

    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(installedManifest.version).toBe(expectedVersion);
    expect(lockfile).toContain(`"web-tree-sitter": ["web-tree-sitter@${expectedVersion}"`);
    expect(thirdPartyNotices).toContain(`\`web-tree-sitter\` ${expectedVersion} (MIT)`);
    expect(runtime).toMatchObject({
      id: 'web-tree-sitter',
      sha256: vendoredSha256,
      source: `https://github.com/tree-sitter/tree-sitter/tree/v${expectedVersion}/lib/binding_web`,
      version: expectedVersion,
    });
    expect(packagedSha256).toBe(vendoredSha256);
    expect(TREE_SITTER_RUNTIME_CACHE_IDENTITY).toBe(`web-tree-sitter:${expectedVersion}:${vendoredSha256}`);
  });

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
