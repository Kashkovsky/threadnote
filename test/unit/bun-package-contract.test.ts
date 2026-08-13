import {readFile} from '../helpers/node-fs-promises.js';
import {join} from '../helpers/node-path.js';
import {describe, expect, it} from 'vitest';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

describe('Bun distribution contract', () => {
  it('uses Bun as the only application runtime and build toolchain', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as PackageManifest;
    const allDependencies = {...manifest.dependencies, ...manifest.devDependencies};

    expect(manifest.packageManager).toMatch(/^bun@/);
    expect(manifest.dependencies?.['@effect/platform-bun']).toBe('4.0.0-beta.102');
    expect(allDependencies['@effect/sql-sqlite-bun']).toBe('4.0.0-beta.102');
    expect(allDependencies['@effect/platform-node']).toBeUndefined();
    expect(allDependencies['@effect/sql-sqlite-node']).toBeUndefined();
    expect(manifest.engines?.node).toBeUndefined();
    expect(manifest.scripts?.build).toMatch(/^bun /);
    expect(manifest.scripts?.test).toMatch(/^bun /);
    expect(Object.values(manifest.scripts ?? {}).join('\n')).not.toMatch(/\b(?:node|npm|npx)\b/);
  });
});
