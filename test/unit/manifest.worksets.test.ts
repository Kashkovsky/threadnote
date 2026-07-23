import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  inferWorksetFromQuery as inferWorksetFromQueryEffect,
  readSeedManifest as readSeedManifestEffect,
  resolveWorkset as resolveWorksetEffect,
} from '../../src/manifest.js';
import {runEffect} from '../helpers/effect-runtime.js';

const inferWorksetFromQuery = (...args: Parameters<typeof inferWorksetFromQueryEffect>) =>
  runEffect(inferWorksetFromQueryEffect(...args));
const readSeedManifest = (...args: Parameters<typeof readSeedManifestEffect>) =>
  runEffect(readSeedManifestEffect(...args));
const resolveWorkset = (...args: Parameters<typeof resolveWorksetEffect>) => runEffect(resolveWorksetEffect(...args));

const MANIFEST = `
version: 1
projects:
  - name: web-app
    path: ~/src/web-app
    uri: viking://resources/repos/web-app
    seed: [README.md]
  - name: design-system
    path: ~/src/design-system
    uri: viking://resources/repos/design-system
    seed: [README.md]
worksets:
  - name: storefront
    description: web app plus its design system
    projects: [web-app, design-system, missing-repo]
`;

describe('seed manifest worksets', () => {
  let dir: string;
  let manifestPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tn-workset-'));
    manifestPath = join(dir, 'seed-manifest.yaml');
    await writeFile(manifestPath, MANIFEST, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('parses worksets from the manifest', async () => {
    const manifest = await readSeedManifest(manifestPath);
    expect(manifest.worksets).toEqual([
      {
        description: 'web app plus its design system',
        name: 'storefront',
        projects: ['web-app', 'design-system', 'missing-repo'],
      },
    ]);
  });

  it('resolves member names to project manifests and drops unknown names', async () => {
    const resolved = await resolveWorkset(manifestPath, 'storefront');
    expect(resolved?.name).toBe('storefront');
    expect(resolved?.projects.map(project => project.name)).toEqual(['web-app', 'design-system']);
  });

  it('matches worksets case-insensitively and returns undefined for unknown names', async () => {
    expect((await resolveWorkset(manifestPath, 'STOREFRONT'))?.name).toBe('storefront');
    expect(await resolveWorkset(manifestPath, 'nope')).toBeUndefined();
  });

  it('infers a workset when its name appears as a query token', async () => {
    const resolved = await inferWorksetFromQuery(manifestPath, 'continue the storefront rollout');
    expect(resolved?.name).toBe('storefront');
    expect(await inferWorksetFromQuery(manifestPath, 'an unrelated query')).toBeUndefined();
  });

  it('does not infer a workset from a substring inside another token', async () => {
    const apiManifest = `
version: 1
projects:
  - name: web-app
    path: ~/src/web-app
    uri: viking://resources/repos/web-app
    seed: [README.md]
worksets:
  - name: api
    projects: [web-app]
`;
    const apiManifestPath = join(dir, 'api.yaml');
    await writeFile(apiManifestPath, apiManifest, 'utf8');

    expect(await inferWorksetFromQuery(apiManifestPath, 'recap the current mapping')).toBeUndefined();
    expect((await inferWorksetFromQuery(apiManifestPath, 'review the api changes'))?.name).toBe('api');
  });

  it('throws on a malformed worksets block', async () => {
    const badPath = join(dir, 'bad.yaml');
    await writeFile(badPath, 'version: 1\nprojects: []\nworksets: [{description: no name}]\n', 'utf8');
    await expect(readSeedManifest(badPath)).rejects.toThrow();
  });
});
