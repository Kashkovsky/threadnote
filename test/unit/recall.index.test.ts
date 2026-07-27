import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  clearRecallIndexMemoryCache,
  expireRecallIndexValidation,
  loadRecallIndex,
  loadRecallIndexDataBatch,
} from '../../src/recall/index.js';
import {join, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

describe('local recall index', () => {
  let directory: string;
  const config = () => ({
    account: 'local',
    agentContextHome: directory,
    user: 'me',
  });

  beforeEach(async () => {
    directory = await mkdtemp('threadnote-recall-index-');
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  it('indexes the full eligible local corpus and atomically caches tokens and metadata', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'alpha.md');
    const activePath = join(
      directory,
      'data',
      'local',
      'user',
      'me',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'recall.md',
    );
    const archivedPath = join(
      directory,
      'data',
      'local',
      'user',
      'me',
      'memories',
      'durable',
      'archived',
      'threadnote',
      'old.md',
    );
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await mkdir(join(activePath, '..'), {recursive: true});
    await mkdir(join(archivedPath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Alpha-42\n\nUse bounded retryPolicy.', 'utf8');
    await writeFile(
      activePath,
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: recall',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T00:00:00.000Z',
        '',
        'Recall uses hybrid ranking.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      archivedPath,
      [
        'MEMORY',
        'kind: durable',
        'status: archived',
        'project: threadnote',
        'source_agent_client: codex',
        'timestamp: 2025-01-01T00:00:00.000Z',
        '',
        'Obsolete memory.',
      ].join('\n'),
      'utf8',
    );

    const candidates = await run(loadRecallIndex(config(), {includeInactive: false}));

    expect(candidates.map(candidate => candidate.uri).sort()).toEqual([
      'threadnote://resources/repos/threadnote/alpha.md',
      'threadnote://user/me/memories/durable/projects/threadnote/recall.md',
    ]);
    expect(candidates[0]?.text).toMatch(/alpha-42|recall/);
    const cachePath = join(directory, 'cache', 'recall-index-v6.json');
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    const cache = await readFile(cachePath, 'utf8');
    expect(cache).not.toContain('# Alpha-42');
    expect(cache).not.toContain('MEMORY\\nkind: durable');
    expect(JSON.parse(cache)).toMatchObject({
      corpusStatistics: {
        documentCount: 2,
        documentFrequency: expect.any(Object),
      },
    });

    const withArchived = await run(loadRecallIndex(config(), {includeInactive: true}));
    expect(withArchived.map(candidate => candidate.uri)).toContain(
      'threadnote://user/me/memories/durable/archived/threadnote/old.md',
    );
    await expect(stat(join(directory, 'cache', 'recall-index-v6-with-inactive.json'))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    expect(await run(loadRecallIndex(config(), {includeInactive: false}))).toHaveLength(2);
  });

  it('rebuilds after source changes and degrades safely from a corrupt cache', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    expect((await run(loadRecallIndex(config(), {includeInactive: false})))[0]?.text).toContain('alpha-42');

    await writeFile(resourcePath, '# Second\n\nbeta-9000 with a longer body', 'utf8');
    expect((await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false})))[0]?.text).toContain(
      'beta-9000',
    );

    await writeFile(join(directory, 'cache', 'recall-index-v6.json'), '{invalid', 'utf8');
    await expect(run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}))).resolves.toHaveLength(1);
  });

  it('force-refreshes a same-size source even when its modification time is preserved', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const original = await stat(resourcePath);

    await writeFile(resourcePath, '# Other\n\nomega-99', 'utf8');
    await utimes(resourcePath, original.mtimeMs, original.mtimeMs);
    const refreshed = await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}));

    expect(refreshed[0]?.text).toContain('omega-99');
    expect(refreshed[0]?.text).not.toContain('alpha-42');
  });

  it('rejects structurally invalid JSON caches and rebuilds them from canonical sources', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    const cachePath = join(directory, 'cache', 'recall-index-v6.json');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Valid\n\ncache-shape-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
      candidates: Array<{text: unknown}>;
      postings: Record<string, unknown>;
    };
    cache.candidates[0]!.text = 42;
    cache.postings.invalid = [{documentLength: 'many', fieldWeight: 1, termFrequency: 1, uri: 'bad'}];
    await writeFile(cachePath, JSON.stringify(cache), 'utf8');
    await rm(`${cachePath}.stale`, {force: true});
    await run(clearRecallIndexMemoryCache());

    const rebuilt = await run(loadRecallIndex(config(), {includeInactive: false}));

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.text).toContain('cache-shape-anchor');
  });

  it('rejects incomplete lookup and posting relationships in otherwise well-typed caches', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    const cachePath = join(directory, 'cache', 'recall-index-v6.json');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Valid\n\nreferential-cache-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));

    for (const corrupt of [
      (cache: Record<string, unknown>) => {
        cache.uriLookup = {};
      },
      (cache: Record<string, unknown>) => {
        cache.postings = {};
      },
    ]) {
      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
      corrupt(cache);
      await writeFile(cachePath, JSON.stringify(cache), 'utf8');
      await rm(`${cachePath}.stale`, {force: true});
      await run(clearRecallIndexMemoryCache());

      const rebuilt = await run(loadRecallIndex(config(), {includeInactive: false, query: 'referential-cache-anchor'}));
      expect(rebuilt.map(candidate => candidate.uri)).toContain('threadnote://resources/repos/threadnote/doc.md');
    }
  });

  it('loads one corpus snapshot for multiple query and scope selections', async () => {
    const alpha = join(directory, 'data', 'local', 'resources', 'repos', 'alpha', 'doc.md');
    const beta = join(directory, 'data', 'local', 'resources', 'repos', 'beta', 'doc.md');
    await mkdir(join(alpha, '..'), {recursive: true});
    await mkdir(join(beta, '..'), {recursive: true});
    await writeFile(alpha, '# Alpha\n\nshared batch anchor', 'utf8');
    await writeFile(beta, '# Beta\n\nshared batch anchor', 'utf8');

    const results = await run(
      loadRecallIndexDataBatch(config(), {
        includeInactive: false,
        selections: [
          {allowedUriScopes: ['threadnote://resources/repos/alpha'], query: 'shared batch anchor'},
          {allowedUriScopes: ['threadnote://resources/repos/beta'], query: 'shared batch anchor'},
        ],
      }),
    );

    expect(results[0]?.candidates.map(candidate => candidate.uri)).toEqual([
      'threadnote://resources/repos/alpha/doc.md',
    ]);
    expect(results[1]?.candidates.map(candidate => candidate.uri)).toEqual([
      'threadnote://resources/repos/beta/doc.md',
    ]);
  });

  it('rejects file escapes and directory cycles introduced through symlinks', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    const outsidePath = join(directory, 'outside.md');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(join(resourceRoot, 'safe.md'), '# Safe\n\nsafe-scan-anchor', 'utf8');
    await writeFile(outsidePath, '# Outside\n\nescaped-scan-anchor', 'utf8');
    await symlink(outsidePath, join(resourceRoot, 'escaped.md'));
    await symlink(resourceRoot, join(resourceRoot, 'cycle'), 'dir');

    const candidates = await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}));

    expect(candidates.map(candidate => candidate.uri)).toEqual(['threadnote://resources/repos/threadnote/safe.md']);
    expect(candidates[0]?.text).not.toContain('escaped-scan-anchor');
  });

  it('leaves an older derived cache untouched and rebuilds the current version lazily', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    const cacheDirectory = join(directory, 'cache');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await mkdir(cacheDirectory, {recursive: true});
    await writeFile(resourcePath, '# Current\n\nmanaged-field-safe', 'utf8');
    await writeFile(
      join(cacheDirectory, 'recall-index-v1.json'),
      JSON.stringify({candidates: [], sources: [], version: 1}),
      'utf8',
    );

    const candidates = await run(loadRecallIndex(config(), {includeInactive: false}));

    expect(candidates[0]?.text).toContain('managed-field-safe');
    await expect(stat(join(cacheDirectory, 'recall-index-v6.json'))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    await expect(stat(join(cacheDirectory, 'recall-index-v1.json'))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it('uses a recently validated cache without walking the source tree again', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Cached\n\nbounded-validation', 'utf8');
    expect(await run(loadRecallIndex(config(), {includeInactive: false}))).toHaveLength(1);

    await rm(resourcePath);

    expect(await run(loadRecallIndex(config(), {includeInactive: false}))).toHaveLength(1);
    expect(await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}))).toHaveLength(0);
  });

  it('uses persisted postings to return a bounded query pool plus required semantic hits', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(resourceRoot, {recursive: true});
    await Promise.all(
      Array.from({length: 140}, (_unused, index) =>
        writeFile(
          join(resourceRoot, `${String(index).padStart(3, '0')}.md`),
          index === 139 ? '# Exact target\n\nalpha-42 rare anchor' : `# Common ${index}\n\ncommon retrieval term`,
          'utf8',
        ),
      ),
    );

    const selected = await run(
      loadRecallIndex(config(), {
        includeInactive: false,
        limit: 5,
        query: 'alpha-42',
        requiredUris: ['threadnote://resources/repos/threadnote/000.md'],
      }),
    );

    expect(selected.map(candidate => candidate.uri)).toEqual([
      'threadnote://resources/repos/threadnote/000.md',
      'threadnote://resources/repos/threadnote/139.md',
    ]);
    const cache = JSON.parse(await readFile(join(directory, 'cache', 'recall-index-v6.json'), 'utf8')) as {
      readonly postings?: unknown;
    };
    expect(cache.postings).toBeDefined();
  });

  it('uses enriched keywords to retrieve paraphrases absent from the memory body', async () => {
    const memoryPath = join(
      directory,
      'data',
      'local',
      'user',
      'me',
      'memories',
      'durable',
      'projects',
      'orion-worker',
      'lease-renewal.md',
    );
    await mkdir(join(memoryPath, '..'), {recursive: true});
    await writeFile(
      memoryPath,
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: orion-worker',
        'topic: lease-renewal',
        'source_agent_client: codex',
        'timestamp: 2026-07-23T00:00:00.000Z',
        'keywords: resume jobs after stalled heartbeat',
        'keywords: worker lease renewal',
        '',
        'The coordinator reschedules work after a stalled heartbeat.',
      ].join('\n'),
      'utf8',
    );

    const candidates = await run(
      loadRecallIndex(config(), {
        includeInactive: false,
        query: 'resume jobs after a stalled heartbeat',
      }),
    );

    expect(candidates.map(candidate => candidate.uri)).toContain(
      'threadnote://user/me/memories/durable/projects/orion-worker/lease-renewal.md',
    );
    expect(candidates[0]?.fields?.keywords).toEqual(['resume jobs after stalled heartbeat', 'worker lease renewal']);
  });

  it('unions per-term lexical pools so a late rare identifier survives an early common term', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(resourceRoot, {recursive: true});
    await Promise.all(
      Array.from({length: 700}, (_unused, index) =>
        writeFile(
          join(resourceRoot, `${String(index).padStart(3, '0')}.md`),
          index === 699 ? '# Rare target\n\ncommon rare-anchor-699' : `# Common ${index}\n\ncommon retrieval document`,
          'utf8',
        ),
      ),
    );

    const selected = await run(
      loadRecallIndex(config(), {
        includeInactive: false,
        limit: 5,
        query: 'common rare-anchor-699',
      }),
    );

    expect(selected[0]?.uri).toBe('threadnote://resources/repos/threadnote/699.md');
  });

  it('applies URI scope before truncating each lexical posting pool', async () => {
    const resourcesRoot = join(directory, 'data', 'local', 'resources', 'repos');
    const outsideRoot = join(resourcesRoot, 'outside');
    const insideRoot = join(resourcesRoot, 'threadnote');
    await mkdir(outsideRoot, {recursive: true});
    await mkdir(insideRoot, {recursive: true});
    await Promise.all(
      Array.from({length: 550}, (_unused, index) =>
        writeFile(join(outsideRoot, `${String(index).padStart(3, '0')}.md`), '# scoped-anchor\n\noutside', 'utf8'),
      ),
    );
    await writeFile(join(insideRoot, 'target.md'), '# In-scope target\n\nscoped-anchor', 'utf8');

    const selected = await run(
      loadRecallIndex(config(), {
        allowedUriScopes: ['threadnote://resources/repos/threadnote'],
        includeInactive: false,
        limit: 1,
        query: 'scoped-anchor',
      }),
    );

    expect(selected.map(candidate => candidate.uri)).toEqual(['threadnote://resources/repos/threadnote/target.md']);
  });

  it('selects capped query terms by corpus IDF independently of query order', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    const commonTerms = Array.from({length: 40}, (_unused, index) => `commonterm${String(index).padStart(2, '0')}`);
    const rareTerm = 'rare-cap-9999';
    await mkdir(resourceRoot, {recursive: true});
    await Promise.all(
      Array.from({length: 40}, (_unused, index) =>
        writeFile(join(resourceRoot, `common-${index}.md`), `# Common\n\n${commonTerms.join(' ')}`, 'utf8'),
      ),
    );
    await writeFile(join(resourceRoot, 'rare.md'), `# Rare\n\n${rareTerm}`, 'utf8');

    const recall = (query: string) => run(loadRecallIndex(config(), {includeInactive: false, limit: 50, query}));
    const rareFirst = await recall([rareTerm, ...commonTerms].join(' '));
    const rareLast = await recall([...commonTerms, rareTerm].join(' '));

    expect(rareFirst.map(candidate => candidate.uri)).toContain('threadnote://resources/repos/threadnote/rare.md');
    expect(rareLast.map(candidate => candidate.uri)).toEqual(rareFirst.map(candidate => candidate.uri));
  });

  it('does not let globally rare out-of-scope terms consume a scoped query cap', async () => {
    const resourcesRoot = join(directory, 'data', 'local', 'resources', 'repos');
    const insideRoot = join(resourcesRoot, 'threadnote');
    const outsideRoot = join(resourcesRoot, 'outside');
    const outsideTerms = Array.from({length: 40}, (_unused, index) => `outside-term-${String(index).padStart(2, '0')}`);
    await mkdir(insideRoot, {recursive: true});
    await mkdir(outsideRoot, {recursive: true});
    await Promise.all([
      ...Array.from({length: 40}, (_unused, index) =>
        writeFile(join(insideRoot, `common-${index}.md`), '# Common\n\ninside-anchor', 'utf8'),
      ),
      ...outsideTerms.map((term, index) => writeFile(join(outsideRoot, `${index}.md`), `# Outside\n\n${term}`, 'utf8')),
    ]);
    await writeFile(join(insideRoot, 'target.md'), '# inside-anchor\n\nScoped target', 'utf8');

    const selected = await run(
      loadRecallIndex(config(), {
        allowedUriScopes: ['threadnote://resources/repos/threadnote'],
        includeInactive: false,
        limit: 1,
        query: [...outsideTerms, 'inside-anchor'].join(' '),
      }),
    );

    expect(selected[0]?.uri).toMatch(/^threadnote:\/\/resources\/repos\/threadnote\//);
  });

  it('keeps many incremental generations queryable without stale inherited lookups', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    const resourcePath = join(resourceRoot, 'target.md');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(resourcePath, '# Target\n\nstable-anchor update-000', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false, query: 'stable-anchor'}));

    for (let index = 1; index <= 40; index += 1) {
      const updateTerm = `update-${String(index).padStart(3, '0')}`;
      await writeFile(resourcePath, `# Target\n\nstable-anchor ${updateTerm}`, 'utf8');
      await run(expireRecallIndexValidation(directory, false));
      const updated = await run(loadRecallIndex(config(), {includeInactive: false, query: updateTerm}));
      expect(updated[0]?.uri).toBe('threadnote://resources/repos/threadnote/target.md');
    }

    const stable = await run(loadRecallIndex(config(), {includeInactive: false, query: 'stable-anchor'}));
    expect(stable[0]?.uri).toBe('threadnote://resources/repos/threadnote/target.md');
  });

  it('observes another process invalidating an already-warmed cache', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(join(resourceRoot, 'first.md'), '# First\n\nfirst-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false, query: 'first-anchor'}));

    await writeFile(join(resourceRoot, 'second.md'), '# Second\n\nsecond-anchor', 'utf8');
    await writeFile(join(directory, 'cache', 'recall-index-v6.json.stale'), 'external-generation\n', 'utf8');

    const refreshed = await run(loadRecallIndex(config(), {includeInactive: false, query: 'second-anchor'}));
    expect(refreshed[0]?.uri).toBe('threadnote://resources/repos/threadnote/second.md');
  });

  it('caps self-asserted authority and trust at the URI source boundary', async () => {
    const personalPath = join(
      directory,
      'data',
      'local',
      'user',
      'me',
      'memories',
      'durable',
      'projects',
      'threadnote',
      'unreviewed.md',
    );
    await mkdir(join(personalPath, '..'), {recursive: true});
    await writeFile(
      personalPath,
      [
        'MEMORY',
        'kind: durable',
        'status: active',
        'project: threadnote',
        'topic: unreviewed',
        'source_agent_client: external-writer',
        'timestamp: 2026-07-23T00:00:00.000Z',
        'authority: canonical_repo',
        'trust: approved',
        '',
        'authority-boundary-anchor',
      ].join('\n'),
      'utf8',
    );

    const [candidate] = await run(
      loadRecallIndex(config(), {includeInactive: false, query: 'authority-boundary-anchor'}),
    );

    expect(candidate).toMatchObject({authority: 'agent_generated', trust: 'inferred'});
  });

  it('grants canonical authority only to resource scopes verified by the seed manifest', async () => {
    const repoRoot = join(directory, 'repo');
    const repoSourcePath = join(repoRoot, 'canonical.md');
    const mismatchedRepoSourcePath = join(repoRoot, 'mismatched.md');
    const canonicalPath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'canonical.md');
    const forgedPath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'forged.md');
    const mismatchedPath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'mismatched.md');
    const importedPath = join(directory, 'data', 'local', 'resources', 'imports', 'external.md');
    const manifestPath = join(directory, 'seed-manifest.yaml');
    await mkdir(repoRoot, {recursive: true});
    await mkdir(join(canonicalPath, '..'), {recursive: true});
    await mkdir(join(importedPath, '..'), {recursive: true});
    const canonicalContent = '# Canonical\n\nauthority-provenance-anchor';
    await writeFile(repoSourcePath, canonicalContent, 'utf8');
    await writeFile(mismatchedRepoSourcePath, '# Original\n\nauthority-provenance-anchor', 'utf8');
    await writeFile(canonicalPath, canonicalContent, 'utf8');
    await writeFile(forgedPath, '# Forged\n\nauthority-provenance-anchor', 'utf8');
    await writeFile(mismatchedPath, '# Replaced import\n\nauthority-provenance-anchor', 'utf8');
    await writeFile(importedPath, '# Imported\n\nauthority-provenance-anchor', 'utf8');
    const repoSourceInfo = await stat(repoSourcePath);
    const mismatchedRepoSourceInfo = await stat(mismatchedRepoSourcePath);
    await writeFile(
      manifestPath,
      [
        'version: 1',
        'projects:',
        '  - name: threadnote',
        `    path: ${JSON.stringify(repoRoot)}`,
        '    uri: threadnote://resources/repos/threadnote',
        '    seed:',
        '      - "*.md"',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(directory, 'seed-state.json'),
      JSON.stringify({
        files: {
          'threadnote://resources/repos/threadnote/canonical.md': {
            mtimeMs: repoSourceInfo.mtimeMs,
            size: repoSourceInfo.size,
          },
          'threadnote://resources/repos/threadnote/mismatched.md': {
            mtimeMs: mismatchedRepoSourceInfo.mtimeMs,
            size: mismatchedRepoSourceInfo.size,
          },
        },
        version: 1,
      }),
      'utf8',
    );

    const candidates = await run(
      loadRecallIndex({...config(), manifestPath}, {includeInactive: false, query: 'authority-provenance-anchor'}),
    );
    const byUri = new Map(candidates.map(candidate => [candidate.uri, candidate]));

    expect(byUri.get('threadnote://resources/repos/threadnote/canonical.md')).toMatchObject({
      authority: 'canonical_repo',
      trust: 'approved',
    });
    expect(byUri.get('threadnote://resources/imports/external.md')).toMatchObject({
      authority: 'external',
      trust: 'untrusted',
    });
    expect(byUri.get('threadnote://resources/repos/threadnote/forged.md')).toMatchObject({
      authority: 'external',
      trust: 'untrusted',
    });
    expect(byUri.get('threadnote://resources/repos/threadnote/mismatched.md')).toMatchObject({
      authority: 'external',
      trust: 'untrusted',
    });
  });

  it('reindexes only the URI whose verified seed provenance changed', async () => {
    const repoRoot = join(directory, 'repo');
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    const manifestPath = join(directory, 'seed-manifest.yaml');
    const targetUri = 'threadnote://resources/repos/threadnote/target.md';
    const stableUri = 'threadnote://resources/repos/threadnote/stable.md';
    const targetRepoPath = join(repoRoot, 'target.md');
    const stableRepoPath = join(repoRoot, 'stable.md');
    const targetResourcePath = join(resourceRoot, 'target.md');
    const stableResourcePath = join(resourceRoot, 'stable.md');
    await mkdir(repoRoot, {recursive: true});
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(targetRepoPath, '# Target\n\nseed-target-v1', 'utf8');
    await writeFile(targetResourcePath, '# Target\n\nseed-target-v1', 'utf8');
    await writeFile(stableRepoPath, '# Stable\n\nseed-stable', 'utf8');
    await writeFile(stableResourcePath, '# Stable\n\nseed-stable', 'utf8');
    await writeFile(
      manifestPath,
      JSON.stringify({
        projects: [
          {
            name: 'threadnote',
            path: repoRoot,
            seed: ['*.md'],
            uri: 'threadnote://resources/repos/threadnote',
          },
        ],
        version: 1,
      }),
      'utf8',
    );
    const targetInfo = await stat(targetRepoPath);
    const stableInfo = await stat(stableRepoPath);
    const writeState = async (targetMtimeMs: number, targetSize: number) =>
      writeFile(
        join(directory, 'seed-state.json'),
        JSON.stringify({
          files: {
            [stableUri]: {mtimeMs: stableInfo.mtimeMs, size: stableInfo.size},
            [targetUri]: {mtimeMs: targetMtimeMs, size: targetSize},
          },
          version: 1,
        }),
        'utf8',
      );
    await writeState(targetInfo.mtimeMs, targetInfo.size);
    const recallConfig = {...config(), manifestPath};
    const initial = await run(loadRecallIndex(recallConfig, {includeInactive: false}));
    const initialStable = initial.find(candidate => candidate.uri === stableUri);
    const initialTarget = initial.find(candidate => candidate.uri === targetUri);

    await writeFile(targetRepoPath, '# Target\n\nseed-target-v2', 'utf8');
    await writeFile(targetResourcePath, '# Target\n\nseed-target-v2', 'utf8');
    const updatedAt = new Date('2027-01-01T00:00:00.000Z');
    await utimes(targetRepoPath, updatedAt, updatedAt);
    await utimes(targetResourcePath, updatedAt, updatedAt);
    const updatedTargetInfo = await stat(targetRepoPath);
    await writeState(updatedTargetInfo.mtimeMs, updatedTargetInfo.size);
    await run(expireRecallIndexValidation(directory, false));
    const updated = await run(loadRecallIndex(recallConfig, {includeInactive: false}));

    expect(updated.find(candidate => candidate.uri === stableUri)).toStrictEqual(initialStable);
    expect(updated.find(candidate => candidate.uri === targetUri)).not.toStrictEqual(initialTarget);
    expect(updated.find(candidate => candidate.uri === targetUri)?.text).toContain('seed-target-v2');
  });

  it('persists a fresh corpus generation after explicit invalidation', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    const cachePath = join(directory, 'cache', 'recall-index-v6.json');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const persisted = await readFile(cachePath, 'utf8');

    await run(expireRecallIndexValidation(directory, false));
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const revalidated = await readFile(cachePath, 'utf8');
    expect(revalidated).not.toBe(persisted);

    await writeFile(resourcePath, '# Second\n\nbeta-9000', 'utf8');
    await run(expireRecallIndexValidation(directory, false));
    const updated = await run(loadRecallIndex(config(), {includeInactive: false}));
    expect(updated[0]?.text).toContain('beta-9000');
    expect(await readFile(cachePath, 'utf8')).not.toBe(revalidated);
  });
});
