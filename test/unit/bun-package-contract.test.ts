import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

describe('Bun distribution contract', () => {
  it('uses Bun as the only application runtime and build toolchain', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest;
    const allDependencies = {...manifest.dependencies, ...manifest.devDependencies};
    const effectVersion = '4.0.0-rc.112';

    expect(manifest.packageManager).toMatch(/^bun@/);
    for (const packageName of [
      '@effect/ai-openai-compat',
      '@effect/platform-bun',
      '@effect/sql-sqlite-bun',
      '@effect/vitest',
      'effect',
    ]) {
      expect(allDependencies[packageName]).toBe(effectVersion);
    }
    expect(manifest.overrides?.['@effect/platform-node-shared']).toBe(effectVersion);
    expect(manifest.devDependencies?.['@effect/tsgo']).toBe('0.37.0');
    expect(allDependencies['@effect/platform-node']).toBeUndefined();
    expect(allDependencies['@effect/sql-sqlite-node']).toBeUndefined();
    expect(manifest.engines?.node).toBeUndefined();
    expect(manifest.scripts?.build).toMatch(/^bun /);
    expect(manifest.scripts?.test).toMatch(/^bun /);
    expect(Object.values(manifest.scripts ?? {}).join('\n')).not.toMatch(/\b(?:node|npm|npx)\b/);
  });

  it('patches only the vulnerable PostCSS Nano ID edge', async () => {
    const [manifestText, lockfile] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'bun.lock'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as PackageManifest;

    expect(manifest.dependencies?.nanoid).toBeUndefined();
    expect(manifest.devDependencies?.nanoid).toBeUndefined();
    expect(manifest.overrides?.nanoid).toBeUndefined();
    expect(lockfile).toContain('"nanoid": ["nanoid@5.1.16"');
    expect(lockfile).toContain('"postcss/nanoid": ["nanoid@3.3.18"');
    expect(lockfile).not.toContain('"postcss/nanoid": ["nanoid@3.3.16"');
  });
});
