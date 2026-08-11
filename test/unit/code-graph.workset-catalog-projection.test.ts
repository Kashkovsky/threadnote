import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {Effect} from 'effect';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {buildCodeGraphWorksetRoutingProjection} from '../../src/code_graph/workset_catalog/projection_builder.js';
import {CodeGraphWorksetCatalogError} from '../../src/code_graph/workset_catalog/types.js';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('code graph ready-snapshot workset routing projections', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('projects compact lexical and lookup surfaces without selecting source bodies', async () => {
    const home = await temporaryHome(homes);
    const identity = repositoryIdentity('compact');
    const snapshotId = snapshotIdentity('compact');
    const symbols = [
      symbol('gamma', {
        aliases: Array.from({length: 70}, (_, index) => `alias.gamma.${index.toString().padStart(2, '0')}`),
        documentation: `SOURCE_BODY_MUST_NOT_ESCAPE_${'private '.repeat(4_000)}`,
        lookupKeys: ['gamma', 'service.gamma'],
        terms: Array.from({length: 70}, (_, index) => ({
          term: `term-${index.toString().padStart(2, '0')}`,
          weight: index < 4 ? 5 : 1,
        })),
      }),
      symbol('alpha', {lookupKeys: ['alpha'], terms: [{term: 'alpha', weight: 5}]}),
      symbol('beta', {lookupKeys: ['beta'], terms: [{term: 'beta', weight: 5}]}),
    ];
    await initializeGraph(home, identity.checkoutId);
    seedGraph(
      home,
      identity,
      [
        {
          compact: true,
          effectiveSymbolCount: symbols.length,
          id: snapshotId,
          symbols: [...symbols].reverse(),
          worktreeId: identity.worktreeId,
        },
      ],
      [{snapshotId, worktreeId: identity.worktreeId}],
    );

    const result = await runEffect(
      buildCodeGraphWorksetRoutingProjection({
        identity,
        pageSize: 1,
        snapshotId,
        threadnoteHome: home,
      }),
    );

    expect(result.projection).toMatchObject({
      checkoutId: identity.checkoutId,
      componentCount: 2,
      repositoryId: identity.repositoryId,
      snapshotId,
      worktreeId: identity.worktreeId,
    });
    expect(result.projection.symbols.map(entry => entry.name).sort(compareText)).toEqual(['alpha', 'beta', 'gamma']);
    const gamma = result.projection.symbols.find(entry => entry.name === 'gamma');
    expect(gamma?.lookupKeys).toHaveLength(64);
    expect(gamma?.lookupKeys).toContain('gamma');
    expect(gamma?.lookupKeys).toContain('service.gamma');
    expect(gamma?.terms).toHaveLength(64);
    expect(gamma?.terms).toEqual(expect.arrayContaining([{term: 'term-00', weight: 5}]));
    expect(gamma?.terms.some(term => term.term === 'ignored-legacy')).toBe(false);
    expect(result.stats).toMatchObject({
      componentCount: 2,
      dependencyCount: 1,
      lookupKeysOmitted: 8,
      pagesRead: 3,
      symbolsRead: 3,
      termsOmitted: 6,
    });
    expect(JSON.stringify(result.projection)).not.toContain('SOURCE_BODY_MUST_NOT_ESCAPE');

    seedLateAnalysisReceipts(home, identity.checkoutId, snapshotId, symbols.length);
    const afterLateReceipts = await runEffect(
      buildCodeGraphWorksetRoutingProjection({identity, pageSize: 2, snapshotId, threadnoteHome: home}),
    );
    expect(afterLateReceipts.projection).toEqual(result.projection);

    await expect(
      runEffect(
        buildCodeGraphWorksetRoutingProjection({
          identity,
          snapshotId: snapshotIdentity('not-active'),
          threadnoteHome: home,
        }),
      ),
    ).rejects.toMatchObject({reason: 'missing'} satisfies Partial<CodeGraphWorksetCatalogError>);
  });

  it('makes a persisted incremental snapshot converge to the clean routing surface', async () => {
    const home = await temporaryHome(homes);
    const identity = repositoryIdentity('incremental');
    const incrementalWorktree = identity.worktreeId;
    const cleanWorktree = hash('clean-worktree');
    const baseId = snapshotIdentity('incremental-base');
    const overlayId = snapshotIdentity('incremental-overlay');
    const cleanId = snapshotIdentity('incremental-clean');
    const baseAlpha = symbol('alpha', {aliases: ['old.alpha'], terms: [{term: 'alpha', weight: 5}]});
    const baseBeta = symbol('beta', {aliases: ['old.beta'], terms: [{term: 'beta', weight: 5}]});
    const baseGamma = symbol('gamma', {aliases: ['gamma.alias'], terms: [{term: 'gamma', weight: 5}]});
    const changedBeta = symbol('beta', {
      aliases: ['new.beta'],
      name: 'betaUpdated',
      path: 'src/updated-beta.ts',
      terms: [{term: 'beta-updated', weight: 5}],
    });
    const delta = symbol('delta', {aliases: ['delta.alias'], terms: [{term: 'delta', weight: 5}]});
    const cleanSymbols = [changedBeta, baseGamma, delta];
    await initializeGraph(home, identity.checkoutId);
    seedGraph(
      home,
      identity,
      [
        {
          effectiveSymbolCount: 3,
          id: baseId,
          symbols: [baseGamma, baseAlpha, baseBeta],
          worktreeId: incrementalWorktree,
        },
        {
          baseSnapshotId: baseId,
          deletedSymbolIds: [baseAlpha.id],
          dirty: true,
          effectiveSymbolCount: 3,
          id: overlayId,
          symbols: [delta, changedBeta],
          worktreeId: incrementalWorktree,
        },
        {
          effectiveSymbolCount: 3,
          id: cleanId,
          symbols: [...cleanSymbols].reverse(),
          worktreeId: cleanWorktree,
        },
      ],
      [
        {snapshotId: overlayId, worktreeId: incrementalWorktree},
        {snapshotId: cleanId, worktreeId: cleanWorktree},
      ],
    );

    const incremental = await runEffect(
      buildCodeGraphWorksetRoutingProjection({
        identity: {...identity, worktreeId: incrementalWorktree},
        pageSize: 1,
        snapshotId: overlayId,
        threadnoteHome: home,
      }),
    );
    const clean = await runEffect(
      buildCodeGraphWorksetRoutingProjection({
        identity: {...identity, worktreeId: cleanWorktree},
        pageSize: 2,
        snapshotId: cleanId,
        threadnoteHome: home,
      }),
    );

    expect(incremental.projection.symbols).toEqual(clean.projection.symbols);
    expect(incremental.projection.symbols.map(entry => entry.name).sort(compareText)).toEqual([
      'betaUpdated',
      'delta',
      'gamma',
    ]);
    const beta = incremental.projection.symbols.find(entry => entry.name === 'betaUpdated');
    expect(beta?.lookupKeys).toContain('new.beta');
    expect(beta?.lookupKeys).not.toContain('old.beta');
    expect(beta?.terms).toEqual([{term: 'beta-updated', weight: 5}]);
    expect(incremental.stats).toMatchObject({
      componentCount: clean.stats.componentCount,
      dependencyCount: clean.stats.dependencyCount,
      lookupKeysObserved: clean.stats.lookupKeysObserved,
      symbolsRead: clean.stats.symbolsRead,
      termsObserved: clean.stats.termsObserved,
    });
  });

  it('keeps projection identity invariant across bounded keyset page sizes', async () => {
    const home = await temporaryHome(homes);
    const identity = repositoryIdentity('page-property');
    const snapshotId = snapshotIdentity('page-property');
    const symbols = Array.from({length: 19}, (_, index) =>
      symbol(`node${index.toString().padStart(2, '0')}`, {
        aliases: [`alias.${index}`],
        terms: [
          {term: `node-${index}`, weight: 5},
          {term: `group-${index % 4}`, weight: 2},
        ],
      }),
    );
    await initializeGraph(home, identity.checkoutId);
    seedGraph(
      home,
      identity,
      [
        {
          effectiveSymbolCount: symbols.length,
          id: snapshotId,
          symbols: [...symbols].reverse(),
          worktreeId: identity.worktreeId,
        },
      ],
      [{snapshotId, worktreeId: identity.worktreeId}],
    );
    const reference = await runEffect(
      buildCodeGraphWorksetRoutingProjection({identity, pageSize: 7, snapshotId, threadnoteHome: home}),
    );

    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1, max: 16}), async pageSize => {
        const candidate = await runEffect(
          buildCodeGraphWorksetRoutingProjection({identity, pageSize, snapshotId, threadnoteHome: home}),
        );
        expect(candidate.projection).toEqual(reference.projection);
        expect({...candidate.stats, pagesRead: 0}).toEqual({...reference.stats, pagesRead: 0});
      }),
      {numRuns: 40},
    );
  });
});

interface FixtureIdentity {
  readonly checkoutId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
}

interface FixtureTerm {
  readonly term: string;
  readonly weight: number;
}

interface FixtureSymbol {
  readonly aliases: readonly string[];
  readonly documentation: string;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly lookupKeys: readonly string[];
  readonly name: string;
  readonly packageName: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly terms: readonly FixtureTerm[];
}

interface FixtureSnapshot {
  readonly baseSnapshotId?: string;
  readonly compact?: boolean;
  readonly deletedSymbolIds?: readonly string[];
  readonly dirty?: boolean;
  readonly effectiveSymbolCount: number;
  readonly id: string;
  readonly symbols: readonly FixtureSymbol[];
  readonly worktreeId: string;
}

async function temporaryHome(homes: string[]): Promise<string> {
  const home = await mkdtemp('threadnote-workset-projection-');
  homes.push(home);
  return home;
}

async function initializeGraph(home: string, checkoutId: string): Promise<void> {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      yield* store.initialize(databasePath(home, checkoutId));
    }),
  );
}

function seedGraph(
  home: string,
  identity: FixtureIdentity,
  snapshots: readonly FixtureSnapshot[],
  active: readonly {readonly snapshotId: string; readonly worktreeId: string}[],
): void {
  const database = new Database(databasePath(home, identity.checkoutId), {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, ?, 'sha1', ?, ?)`,
      )
      .run(identity.repositoryId, 'projection-fixture', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
    for (const snapshot of snapshots) seedSnapshot(database, identity.repositoryId, snapshot);
    for (const entry of active) {
      database
        .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
        .run(entry.worktreeId, entry.snapshotId, '2026-08-11T00:00:00.000Z');
    }
  } finally {
    database.close(false);
  }
}

function seedSnapshot(database: Database, repositoryId: string, snapshot: FixtureSnapshot): void {
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
         extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
         edge_count, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 1, ?, 0, ?, ?)`,
    )
    .run(
      snapshot.id,
      repositoryId,
      snapshot.worktreeId,
      commitIdentity(snapshot.id),
      `cgc_${hash(`content:${snapshot.id}`).slice(0, 40)}`,
      snapshot.baseSnapshotId ?? null,
      'native-code-graph-12',
      snapshot.dirty === true ? 1 : 0,
      snapshot.dirty === true ? hash(`overlay:${snapshot.id}`) : null,
      snapshot.effectiveSymbolCount,
      '2026-08-11T00:00:00.000Z',
      '2026-08-11T00:00:01.000Z',
    );
  database
    .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, 12)')
    .run(snapshot.id);
  seedWorkspace(database, snapshot.id);

  for (const entry of snapshot.symbols) {
    database
      .query(
        `INSERT INTO symbols (
           snapshot_id, id, content_hash, kind, name, qualified_name, path, language,
           arity, lookup_keys_json, resolution_domain, resolution_scope_id, package_name,
           exported, signature, documentation, span_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'typescript', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        entry.id,
        hash(`content:${snapshot.id}:${entry.id}`),
        entry.kind,
        entry.name,
        entry.qualifiedName,
        entry.path,
        entry.language,
        JSON.stringify(entry.lookupKeys),
        entry.packageName,
        entry.exported ? 1 : 0,
        `export function ${entry.name}(): void`,
        entry.documentation,
        JSON.stringify({column: 1, endColumn: 8, endLine: 1, line: 1}),
      );
    const lookupKeys = [...new Set([...entry.lookupKeys, ...entry.aliases])];
    for (const lookupKey of lookupKeys) {
      database
        .query(
          `INSERT INTO snapshot_symbol_lookup (
             snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
             provenance, evidence_edge_id, evidence_path
           ) VALUES (?, ?, ?, 'typescript', ?, ?, NULL, ?)`,
        )
        .run(
          snapshot.id,
          lookupKey,
          entry.id,
          entry.exported ? 1 : 0,
          entry.lookupKeys.includes(lookupKey) ? 'symbol' : 'alias',
          entry.path,
        );
    }
  }
  for (const symbolId of snapshot.deletedSymbolIds ?? []) {
    database
      .query('INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)')
      .run(snapshot.id, symbolId);
  }
  if (snapshot.compact === true) seedCompactTerms(database, snapshot);
  else seedLegacyTerms(database, snapshot);
}

function seedLegacyTerms(database: Database, snapshot: FixtureSnapshot): void {
  const insert = database.query('INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight) VALUES (?, ?, ?, ?)');
  for (const entry of snapshot.symbols) {
    for (const term of entry.terms) insert.run(snapshot.id, term.term, entry.id, term.weight);
  }
}

function seedCompactTerms(database: Database, snapshot: FixtureSnapshot): void {
  database.query('INSERT INTO lexical_compact_snapshots (snapshot_id) VALUES (?)').run(snapshot.id);
  const snapshotKey = database
    .query<{readonly snapshot_key: number}, [string]>(
      'SELECT snapshot_key FROM lexical_compact_snapshots WHERE snapshot_id = ?',
    )
    .get(snapshot.id)!.snapshot_key;
  const termKeys = new Map<string, number>();
  const insertTerm = database.query('INSERT INTO lexical_compact_terms (snapshot_key, term) VALUES (?, ?)');
  const selectTerm = database.query<{readonly term_key: number}, [number, string]>(
    'SELECT term_key FROM lexical_compact_terms WHERE snapshot_key = ? AND term = ?',
  );
  for (const term of [...new Set(snapshot.symbols.flatMap(entry => entry.terms.map(value => value.term)))].sort(
    compareText,
  )) {
    insertTerm.run(snapshotKey, term);
    termKeys.set(term, selectTerm.get(snapshotKey, term)!.term_key);
  }
  const insertSymbol = database.query('INSERT INTO lexical_compact_symbols (snapshot_key, symbol_id) VALUES (?, ?)');
  const selectSymbol = database.query<{readonly symbol_key: number}, [number, string]>(
    'SELECT symbol_key FROM lexical_compact_symbols WHERE snapshot_key = ? AND symbol_id = ?',
  );
  const insertPosting = database.query(
    `INSERT INTO lexical_compact_postings (snapshot_key, term_key, symbol_key, weight)
     VALUES (?, ?, ?, ?)`,
  );
  let postingCount = 0;
  for (const entry of snapshot.symbols) {
    insertSymbol.run(snapshotKey, entry.id);
    const symbolKey = selectSymbol.get(snapshotKey, entry.id)!.symbol_key;
    for (const term of entry.terms) {
      insertPosting.run(snapshotKey, termKeys.get(term.term)!, symbolKey, term.weight);
      postingCount += 1;
    }
    database
      .query('INSERT INTO symbol_terms (snapshot_id, term, symbol_id, weight) VALUES (?, ?, ?, 5)')
      .run(snapshot.id, 'ignored-legacy', entry.id);
  }
  database
    .query(
      `INSERT INTO lexical_storage_formats (
         snapshot_id, format_version, posting_count, symbol_count, term_count, created_at
       ) VALUES (?, 1, ?, ?, ?, ?)`,
    )
    .run(snapshot.id, postingCount, snapshot.symbols.length, termKeys.size, '2026-08-11T00:00:01.000Z');
}

function seedWorkspace(database: Database, snapshotId: string): void {
  const insert = database.query(
    `INSERT INTO workspace_components (
       snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
       languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
     ) VALUES (?, ?, 'workspace', 'npm', 'package', ?, ?, 'typescript', '["typescript"]', ?, ?, 'manifest', '[]')`,
  );
  insert.run(snapshotId, 'component-api', 'api', 'packages/api', '["packages/api/src"]', '["."]');
  insert.run(snapshotId, 'component-app', 'app', 'packages/app', '["packages/app/src"]', '["."]');
  database
    .query(
      `INSERT INTO workspace_component_dependencies (
         snapshot_id, source_component_id, target_component_id, provenance, evidence
       ) VALUES (?, 'component-app', 'component-api', 'manifest', 'package.json')`,
    )
    .run(snapshotId);
}

function seedLateAnalysisReceipts(home: string, checkoutId: string, snapshotId: string, symbolCount: number): void {
  const database = new Database(databasePath(home, checkoutId), {strict: true});
  try {
    database
      .query(
        `INSERT INTO snapshot_analysis_summary_receipts (
           snapshot_id, version, symbol_count, edge_count, digest, created_at
         ) VALUES (?, 1, ?, 0, ?, ?)`,
      )
      .run(snapshotId, symbolCount, hash(`analysis:${snapshotId}`), '2026-08-11T00:00:02.000Z');
    database
      .query(
        `INSERT INTO snapshot_component_edge_aggregate_receipts (
           snapshot_id, version, row_count, edge_count, digest, created_at
         ) VALUES (?, 1, 0, 0, ?, ?)`,
      )
      .run(snapshotId, hash(`components:${snapshotId}`), '2026-08-11T00:00:02.000Z');
  } finally {
    database.close(false);
  }
}

function symbol(
  key: string,
  options: {
    readonly aliases?: readonly string[];
    readonly documentation?: string;
    readonly lookupKeys?: readonly string[];
    readonly name?: string;
    readonly path?: string;
    readonly terms?: readonly FixtureTerm[];
  } = {},
): FixtureSymbol {
  const name = options.name ?? key;
  return {
    aliases: options.aliases ?? [],
    documentation: options.documentation ?? `Documentation for ${name}`,
    exported: true,
    id: nodeIdentity(key),
    kind: 'function',
    language: 'typescript',
    lookupKeys: options.lookupKeys ?? [name],
    name,
    packageName: '@fixture/api',
    path: options.path ?? `src/${key}.ts`,
    qualifiedName: `fixture.${name}`,
    terms: options.terms ?? [{term: name.toLowerCase(), weight: 5}],
  };
}

function repositoryIdentity(key: string): FixtureIdentity {
  return {
    checkoutId: hash(`checkout:${key}`),
    repositoryId: hash(`repository:${key}`),
    worktreeId: hash(`worktree:${key}`),
  };
}

function databasePath(home: string, checkoutId: string): string {
  return join(home, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
}

function snapshotIdentity(value: string): string {
  return `cgsn_${hash(`snapshot:${value}`).slice(0, 40)}`;
}

function nodeIdentity(value: string): string {
  return `cgs_${hash(`node:${value}`).slice(0, 40)}`;
}

function commitIdentity(value: string): string {
  return hash(`commit:${value}`).slice(0, 40);
}

function hash(value: string): string {
  return sha256HexSync(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
