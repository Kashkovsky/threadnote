import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  clearRecallIndexMemoryCache,
  expireRecallIndexValidation,
  loadRecallExactMatches,
  loadRecallIndex,
  loadRecallIndexDataBatch,
  recallIndexDatabaseFilename,
  recallIndexStatus,
  recallUriMatchesScopes,
} from '../../src/recall/index.js';
import {join, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect as run} from '../helpers/effect-runtime.js';

describe('local recall index', () => {
  let directory: string;
  const config = () => ({
    account: 'local',
    agentContextHome: directory,
    user: 'me',
  });
  const databasePath = (includeInactive = false) =>
    join(directory, 'indexes', 'lexical', recallIndexDatabaseFilename(includeInactive));
  const queryDatabase = <Row extends object>(sql: string): readonly Row[] => {
    const database = new Database(databasePath());
    try {
      return database.query(sql).all() as Row[];
    } finally {
      database.close();
    }
  };
  const executeDatabase = (sql: string): void => {
    const database = new Database(databasePath());
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
  };

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
    expect((await stat(databasePath())).mode & 0o777).toBe(0o600);
    expect(queryDatabase<{document_count: number}>('SELECT COUNT(*) AS document_count FROM documents')).toEqual([
      {document_count: 2},
    ]);
    expect(
      queryDatabase<{posting_count: number}>('SELECT COUNT(*) AS posting_count FROM postings')[0]?.posting_count,
    ).toBeGreaterThan(0);
    const candidateJson = queryDatabase<{candidate_json: string}>('SELECT candidate_json FROM documents').map(
      row => row.candidate_json,
    );
    expect(candidateJson.join('\n')).not.toContain('# Alpha-42');
    expect(candidateJson.join('\n')).not.toContain('MEMORY\\nkind: durable');

    const withArchived = await run(loadRecallIndex(config(), {includeInactive: true}));
    expect(withArchived.map(candidate => candidate.uri)).toContain(
      'threadnote://user/me/memories/durable/archived/threadnote/old.md',
    );
    await expect(stat(databasePath(true))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    expect(await run(loadRecallIndex(config(), {includeInactive: false}))).toHaveLength(2);
  });

  it('reports canonical documents omitted by the bounded file-size policy', async () => {
    const root = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(root, {recursive: true});
    await writeFile(join(root, 'small.md'), '# Indexed\n\nSmall canonical document.', 'utf8');
    await writeFile(join(root, 'oversized.md'), `# Oversized\n\n${'x'.repeat(512 * 1024)}`, 'utf8');

    await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}));
    const status = await run(recallIndexStatus(config()));

    expect(status).toMatchObject({
      documentCount: 1,
      ready: true,
      skippedOversizedDocumentCount: 1,
    });
  });

  it('serves bounded exact substring matches from SQLite without scanning canonical files', async () => {
    const memoryRoot = join(directory, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'threadnote');
    const outsideRoot = join(directory, 'data', 'local', 'resources', 'repos', 'outside');
    await mkdir(memoryRoot, {recursive: true});
    await mkdir(outsideRoot, {recursive: true});
    await writeFile(join(memoryRoot, 'target.md'), '# Target\n\nReSharding keeps ALPHA-42 available.', 'utf8');
    await writeFile(join(memoryRoot, 'other.md'), '# Other\n\nNo distinctive exact anchor.', 'utf8');
    await writeFile(join(outsideRoot, 'outside.md'), '# Outside\n\nresharding alpha-42', 'utf8');

    const scope = 'threadnote://user/me/memories/durable/projects/threadnote';
    const matches = await run(
      loadRecallExactMatches(config(), {
        includeInactive: false,
        limitPerTerm: 25,
        terms: ['sharding', 'alpha-42'],
        uriScopes: [scope],
      }),
    );

    expect(matches).toEqual([
      {
        terms: ['sharding', 'alpha-42'],
        uri: `${scope}/target.md`,
      },
    ]);
    await expect(
      run(
        loadRecallExactMatches(config(), {
          includeInactive: false,
          terms: ['not-present-908'],
          uriScopes: [scope],
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('reports determinate lexical indexing and posting progress', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(join(resourceRoot, 'alpha.md'), '# Alpha\n\nprogress-alpha', 'utf8');
    await writeFile(join(resourceRoot, 'beta.md'), '# Beta\n\nprogress-beta', 'utf8');
    const progress: unknown[] = [];

    await run(
      loadRecallIndex(config(), {
        forceRefresh: true,
        includeInactive: false,
        onProgress: event =>
          Effect.sync(() => {
            progress.push(event);
          }),
      }),
    );

    expect(progress).toEqual([
      {completed: 0, phase: 'indexing', scanned: 2, total: 2},
      {completed: 2, phase: 'indexing', scanned: 2, total: 2},
      {completed: 0, phase: 'writing', removed: 0, total: 2},
      {completed: 2, phase: 'writing', removed: 0, total: 2},
      {documentCount: 2, phase: 'activating'},
    ]);
  });

  it('uses persisted indexes for bounded recency and project samples', async () => {
    const resourcesRoot = join(directory, 'data', 'local', 'resources', 'repos');
    await mkdir(join(resourcesRoot, 'threadnote'), {recursive: true});
    await mkdir(join(resourcesRoot, 'outside'), {recursive: true});
    await writeFile(join(resourcesRoot, 'threadnote', 'inside.md'), '# Inside\n\nsample', 'utf8');
    await writeFile(join(resourcesRoot, 'outside', 'outside.md'), '# Outside\n\nsample', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));

    const recentPlan = queryDatabase<{detail: string}>(
      `EXPLAIN QUERY PLAN
       SELECT d.id, d.uri, d.candidate_json
       FROM documents AS d
       ORDER BY d.source_modified_at DESC, d.uri
       LIMIT 200`,
    )
      .map(row => row.detail)
      .join('\n');
    const projectPlan = queryDatabase<{detail: string}>(
      `EXPLAIN QUERY PLAN
       SELECT d.id, d.uri, d.candidate_json
       FROM documents AS d
       WHERE d.project = 'threadnote'
       ORDER BY d.source_modified_at DESC, d.uri
       LIMIT 200`,
    )
      .map(row => row.detail)
      .join('\n');

    expect(recentPlan).toContain('documents_modified_uri');
    expect(recentPlan).not.toContain('USE TEMP B-TREE');
    expect(projectPlan).toContain('documents_project_modified_uri');
    expect(projectPlan).not.toContain('USE TEMP B-TREE');
    expect(queryDatabase<{project: string}>('SELECT project FROM documents ORDER BY project')).toEqual([
      {project: 'outside'},
      {project: 'threadnote'},
    ]);
  });

  it('reconstructs canonical encoded URIs for external resource paths', async () => {
    const resourcePath = join(
      directory,
      'data',
      'local',
      'resources',
      'external',
      'obsidian',
      'engineering',
      'Release bridge.md',
    );
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Release bridge\n\nZOBSIDIAN-74291 bounded external recall anchor.', 'utf8');

    const candidates = await run(
      loadRecallIndex(config(), {
        includeInactive: false,
        query: 'ZOBSIDIAN-74291',
      }),
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        authority: 'external',
        trust: 'untrusted',
        uri: 'threadnote://resources/external/obsidian/engineering/Release%20bridge.md',
      }),
    ]);
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

    await writeFile(databasePath(), '{invalid', 'utf8');
    await expect(run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}))).resolves.toHaveLength(1);
    await run(clearRecallIndexMemoryCache());
    await expect(run(loadRecallIndex(config(), {includeInactive: false}))).resolves.toEqual([
      expect.objectContaining({text: expect.stringContaining('beta-9000')}),
    ]);
  });

  it('rebuilds an earlier beta lexical schema from canonical documents', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'schema.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Schema recovery\n\nearlier-beta-lexical-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));

    executeDatabase("UPDATE metadata SET value = '2' WHERE key = 'schema_version'");
    await run(clearRecallIndexMemoryCache());

    const recovered = await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}));
    const status = await run(recallIndexStatus(config()));

    expect(recovered).toEqual([
      expect.objectContaining({text: expect.stringContaining('earlier-beta-lexical-anchor')}),
    ]);
    expect(status).toMatchObject({documentCount: 1, ready: true});
    expect(status.databasePath).toContain('/generations/');
  });

  it('supports concurrent first opens without racing schema initialization', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Concurrent\n\nfirst-open-anchor', 'utf8');

    const results = await Promise.all(
      Array.from({length: 4}, () =>
        run(loadRecallIndex(config(), {includeInactive: false, query: 'first-open-anchor'})),
      ),
    );

    expect(results.every(candidates => candidates[0]?.uri.endsWith('/doc.md'))).toBe(true);
  });

  it('force-refreshes a same-size source even when its modification time is preserved', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const original = await stat(resourcePath);

    await writeFile(resourcePath, '# Other\n\nomega-99', 'utf8');
    await utimes(resourcePath, new Date(original.mtimeMs), new Date(original.mtimeMs));
    const refreshed = await run(loadRecallIndex(config(), {forceRefresh: true, includeInactive: false}));

    expect(refreshed[0]?.text).toContain('omega-99');
    expect(refreshed[0]?.text).not.toContain('alpha-42');
  });

  it('fully refreshes an explicitly stale generation when size and modification time are preserved', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const original = await stat(resourcePath);

    await writeFile(resourcePath, '# Other\n\nomega-99', 'utf8');
    await utimes(resourcePath, new Date(original.mtimeMs), new Date(original.mtimeMs));
    await run(expireRecallIndexValidation(directory, false));
    const refreshed = await run(loadRecallIndex(config(), {includeInactive: false, query: 'omega-99'}));

    expect(refreshed[0]?.text).toContain('omega-99');
    expect(refreshed[0]?.text).not.toContain('alpha-42');
  });

  it('bounds URI-aware invalidation growth and falls back to a conservative refresh', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const original = await stat(resourcePath);

    await writeFile(resourcePath, '# Other\n\nomega-99', 'utf8');
    await utimes(resourcePath, new Date(original.mtimeMs), new Date(original.mtimeMs));
    await run(
      expireRecallIndexValidation(
        directory,
        false,
        Array.from({length: 1_025}, (_unused, index) => `threadnote://resources/repos/unrelated/doc-${index}.md`),
      ),
    );
    const refreshed = await run(loadRecallIndex(config(), {includeInactive: false, query: 'omega-99'}));

    expect(refreshed[0]?.text).toContain('omega-99');
    expect(refreshed[0]?.text).not.toContain('alpha-42');
  });

  it('rejects structurally invalid candidate rows and rebuilds them from canonical sources', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Valid\n\ncache-shape-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    executeDatabase(`UPDATE documents SET candidate_json = '{"text":42,"uri":"invalid"}'`);
    await run(clearRecallIndexMemoryCache());

    const rebuilt = await run(loadRecallIndex(config(), {includeInactive: false}));

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.text).toContain('cache-shape-anchor');
  });

  it('repairs incomplete posting relationships from canonical sources', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# Valid\n\nreferential-cache-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    executeDatabase('DELETE FROM postings');

    const rebuilt = await run(
      loadRecallIndex(config(), {
        includeInactive: false,
        query: 'referential-cache-anchor',
      }),
    );
    expect(rebuilt.map(candidate => candidate.uri)).toContain('threadnote://resources/repos/threadnote/doc.md');
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

  it('removes legacy JSON caches only after activating the SQLite index', async () => {
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
    await expect(stat(databasePath())).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    await expect(stat(join(cacheDirectory, 'recall-index-v1.json'))).rejects.toBeDefined();
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
    expect(
      queryDatabase<{posting_count: number}>('SELECT COUNT(*) AS posting_count FROM postings')[0]?.posting_count,
    ).toBeGreaterThan(0);
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

    const diagnostics: Array<{postingRows: number; postingStatements: number; queryTerms: number}> = [];
    const selected = await run(
      loadRecallIndex(config(), {
        includeInactive: false,
        limit: 5,
        onQueryDiagnostics: event =>
          Effect.sync(() => {
            diagnostics.push(event);
          }),
        query: 'common rare-anchor-699',
      }),
    );

    expect(selected[0]?.uri).toBe('threadnote://resources/repos/threadnote/699.md');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.postingStatements).toBe(1);
    expect(diagnostics[0]?.queryTerms).toBeGreaterThan(1);
    expect(diagnostics[0]?.postingRows).toBeLessThanOrEqual((diagnostics[0]?.queryTerms ?? 0) * 500);
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

  it('normalizes URI scope anchors and trailing slashes and fails closed for invalid restrictions', async () => {
    const resourcesRoot = join(directory, 'data', 'local', 'resources', 'repos');
    await mkdir(join(resourcesRoot, 'threadnote'), {recursive: true});
    await mkdir(join(resourcesRoot, 'outside'), {recursive: true});
    await writeFile(join(resourcesRoot, 'threadnote', 'target.md'), '# Target\n\nnormalized-scope-anchor', 'utf8');
    await writeFile(join(resourcesRoot, 'outside', 'other.md'), '# Other\n\nnormalized-scope-anchor', 'utf8');
    const scope = 'threadnote://resources/repos/threadnote';

    const selected = await run(
      loadRecallIndex(config(), {
        allowedUriScopes: [`${scope}///#ignored`],
        includeInactive: false,
        query: 'normalized-scope-anchor',
      }),
    );
    const rejected = await run(
      loadRecallIndex(config(), {
        allowedUriScopes: ['///#invalid'],
        includeInactive: false,
        query: 'normalized-scope-anchor',
      }),
    );

    expect(selected.map(candidate => candidate.uri)).toEqual([`${scope}/target.md`]);
    expect(rejected).toEqual([]);
    expect(recallUriMatchesScopes(`${scope}/target.md#heading`, [`${scope}/#ignored`])).toBe(true);
    expect(recallUriMatchesScopes(`${scope}/target.md#heading`, [`${scope}/target.md/#ignored`])).toBe(true);
    expect(recallUriMatchesScopes(`${scope}/other.md`, [`${scope}/target.md/#ignored`])).toBe(false);
    expect(recallUriMatchesScopes(`${scope}/target.md`, ['#invalid'])).toBe(false);
  });

  it('uses the URI index for exact-or-prefix scope ranges', async () => {
    const resource = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'target.md');
    await mkdir(join(resource, '..'), {recursive: true});
    await writeFile(resource, '# Target\n\nscope-plan-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));

    const plan = queryDatabase<{detail: string}>(
      `EXPLAIN QUERY PLAN
       SELECT d.id
       FROM documents AS d INDEXED BY documents_uri
       WHERE d.uri = 'threadnote://resources/repos/threadnote'
          OR (
            d.uri >= 'threadnote://resources/repos/threadnote/'
            AND d.uri < 'threadnote://resources/repos/threadnote0'
          )`,
    )
      .map(row => row.detail)
      .join('\n');

    expect(plan).toContain('documents_uri');
    expect(plan).not.toContain('SCAN d');
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

  it('keeps prototype-collision terms safe across an incremental cache refresh', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    const resourcePath = join(resourceRoot, 'target.md');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(resourcePath, '# Target\n\ninitial-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false, query: 'initial-anchor'}));

    await writeFile(resourcePath, '# Target\n\nconstructor prototype-collision-anchor', 'utf8');
    await run(expireRecallIndexValidation(directory, false, ['threadnote://resources/repos/threadnote/target.md']));
    const refreshed = await run(loadRecallIndex(config(), {includeInactive: false, query: 'constructor'}));

    expect(refreshed[0]?.uri).toBe('threadnote://resources/repos/threadnote/target.md');
    expect(
      queryDatabase<{document_frequency: number}>(
        `SELECT document_frequency FROM term_statistics WHERE term = 'constructor'`,
      ),
    ).toEqual([{document_frequency: 1}]);
    expect(
      queryDatabase<{uri: string}>(
        `SELECT d.uri FROM postings p JOIN documents d ON d.id = p.document_id WHERE p.term = 'constructor'`,
      ),
    ).toEqual([{uri: 'threadnote://resources/repos/threadnote/target.md'}]);
  });

  it('updates term statistics only for documents changed by an incremental refresh', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(join(resourceRoot, 'changed.md'), '# Changed\n\nchanged-term-001', 'utf8');
    await writeFile(join(resourceRoot, 'untouched.md'), '# Untouched\n\nuntouched-unique-777', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false, query: 'changed-term-001'}));
    const originalIds = queryDatabase<{id: number; uri: string}>('SELECT id, uri FROM documents ORDER BY uri');

    await writeFile(join(resourceRoot, 'changed.md'), '# Changed\n\nchanged-term-002', 'utf8');
    await run(expireRecallIndexValidation(directory, false, ['threadnote://resources/repos/threadnote/changed.md']));
    await run(loadRecallIndex(config(), {includeInactive: false, query: 'changed-term-002'}));

    const refreshedIds = queryDatabase<{id: number; uri: string}>('SELECT id, uri FROM documents ORDER BY uri');
    const originalUntouchedId = originalIds.find(row => row.uri.endsWith('/untouched.md'))?.id;
    const refreshedUntouchedId = refreshedIds.find(row => row.uri.endsWith('/untouched.md'))?.id;
    expect(refreshedUntouchedId).toBe(originalUntouchedId);
    expect(refreshedIds.find(row => row.uri.endsWith('/changed.md'))?.id).not.toBe(
      originalIds.find(row => row.uri.endsWith('/changed.md'))?.id,
    );
    expect(
      queryDatabase<{term: string}>(
        `SELECT term FROM term_statistics WHERE term IN ('changed-term-001', 'changed-term-002') ORDER BY term`,
      ),
    ).toEqual([{term: 'changed-term-002'}]);
  });

  it('observes another process invalidating an already-warmed cache', async () => {
    const resourceRoot = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote');
    await mkdir(resourceRoot, {recursive: true});
    await writeFile(join(resourceRoot, 'first.md'), '# First\n\nfirst-anchor', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false, query: 'first-anchor'}));

    await writeFile(join(resourceRoot, 'second.md'), '# Second\n\nsecond-anchor', 'utf8');
    await writeFile(`${databasePath()}.stale`, 'external-generation\n', 'utf8');

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
    await run(expireRecallIndexValidation(directory, false, [targetUri]));
    const updated = await run(loadRecallIndex(recallConfig, {includeInactive: false}));

    expect(updated.find(candidate => candidate.uri === stableUri)).toStrictEqual(initialStable);
    expect(updated.find(candidate => candidate.uri === targetUri)).not.toStrictEqual(initialTarget);
    expect(updated.find(candidate => candidate.uri === targetUri)?.text).toContain('seed-target-v2');
  });

  it('persists a fresh corpus generation after explicit invalidation', async () => {
    const resourcePath = join(directory, 'data', 'local', 'resources', 'repos', 'threadnote', 'doc.md');
    await mkdir(join(resourcePath, '..'), {recursive: true});
    await writeFile(resourcePath, '# First\n\nalpha-42', 'utf8');
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const persisted = queryDatabase<{value: string}>(`SELECT value FROM metadata WHERE key = 'validated_at'`)[0]?.value;

    await run(expireRecallIndexValidation(directory, false));
    await run(loadRecallIndex(config(), {includeInactive: false}));
    const revalidated = queryDatabase<{value: string}>(`SELECT value FROM metadata WHERE key = 'validated_at'`)[0]
      ?.value;
    expect(revalidated).not.toBe(persisted);

    await writeFile(resourcePath, '# Second\n\nbeta-9000', 'utf8');
    await run(expireRecallIndexValidation(directory, false));
    const updated = await run(loadRecallIndex(config(), {includeInactive: false}));
    expect(updated[0]?.text).toContain('beta-9000');
    expect(queryDatabase<{value: string}>(`SELECT value FROM metadata WHERE key = 'validated_at'`)[0]?.value).not.toBe(
      revalidated,
    );
  });
});
