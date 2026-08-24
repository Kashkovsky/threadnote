import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS,
  beginCodeGraphMaterializationSpoolSort,
  codeGraphMaterializationApplyPages,
  codeGraphMaterializationSpoolPath,
  commitCodeGraphMaterializationSpoolBatch,
  commitCodeGraphMaterializationSpoolSortedSurface,
  configureCodeGraphMaterializationSpoolDatabase,
  finishCodeGraphMaterializationSpoolSort,
  initializeCodeGraphMaterializationSpoolDatabase,
  readCodeGraphMaterializationSpoolState,
  sealCodeGraphMaterializationSpool,
  sortCodeGraphMaterializationSpoolSurfaces,
} from '../../src/code_graph/materialization_spool.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from '../../src/code_graph/materialization_spool_surfaces.js';
import type {CodeGraphLayout} from '../../src/code_graph/layout.js';

describe('code graph materialization spool', () => {
  it.prop(
    'covers every ordered row once with median-block bounded cursors',
    {
      pageRows: FC.integer({max: CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS, min: 1}),
      rowCount: FC.integer({max: 100_000, min: 0}),
    },
    ({pageRows, rowCount}) => {
      const pages = codeGraphMaterializationApplyPages(rowCount, pageRows);
      expect(pages.reduce((total, page) => total + page.rowCount, 0)).toBe(rowCount);
      expect(pages.every(page => page.rowCount > 0 && page.rowCount <= pageRows)).toBe(true);
      expect(pages.map(page => page.afterRowid).sort((left, right) => left - right)).toEqual(
        Array.from({length: pages.length}, (_, index) => index * pageRows),
      );
      expect(new Set(pages.map(page => page.afterRowid)).size).toBe(pages.length);
      if (pages.length > 0) {
        expect(pages[0]!.afterRowid).toBe(Math.floor(pages.length / 2) * pageRows);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it('uses the breadth-first median schedule retained by the storage screen', () => {
    expect(codeGraphMaterializationApplyPages(50, 10).map(page => page.afterRowid)).toEqual([20, 10, 40, 0, 30]);
  });

  it('uses a closed snapshot grammar for a repository-contained sibling path', () => {
    const layout = {repositoryRoot: '/threadnote/code-graph/repository'} as CodeGraphLayout;
    const path = {join: (...parts: readonly string[]) => parts.join('/')} as unknown as Parameters<
      typeof codeGraphMaterializationSpoolPath
    >[0];
    expect(codeGraphMaterializationSpoolPath(path, layout, `cgsn_${'a'.repeat(40)}-direct`)).toBe(
      `/threadnote/code-graph/repository/materialization-spool-v1-cgsn_${'a'.repeat(40)}-direct.sqlite`,
    );
    for (const invalid of ['', '../escape', `cgsn_${'a'.repeat(39)}`, `cgsn_${'a'.repeat(40)}-full-xyz`]) {
      expect(() => codeGraphMaterializationSpoolPath(path, layout, invalid)).toThrow(
        'Code graph materialization spool snapshot identity is invalid.',
      );
    }
  });

  it('fails closed for malformed row and page bounds', () => {
    for (const rowCount of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => codeGraphMaterializationApplyPages(rowCount)).toThrow(
        'Code graph materialization spool row count is invalid.',
      );
    }
    for (const pageRows of [-1, 0, 0.5, CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS + 1]) {
      expect(() => codeGraphMaterializationApplyPages(1, pageRows)).toThrow(
        'Code graph materialization spool page bound is invalid.',
      );
    }
  });

  it('resumes only the exact immutable sidecar identity', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: 'a'.repeat(64),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${'b'.repeat(40)}`,
      repositoryId: 'c'.repeat(64),
      snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('created');
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('resumed');
      for (const [field, replacement] of [
        ['checkoutId', 'e'.repeat(64)],
        ['extractorSet', 'extractor-v2'],
        ['graphContentId', `cgc_${'e'.repeat(40)}`],
        ['repositoryId', 'e'.repeat(64)],
        ['snapshotId', `cgsn_${'e'.repeat(40)}-direct`],
      ] as const) {
        expect(() =>
          initializeCodeGraphMaterializationSpoolDatabase(database, {...header, [field]: replacement}),
        ).toThrow('Code graph materialization spool identity does not match the persistent build.');
      }
      database.exec('DROP TABLE materialization_raw_edges');
      expect(() => initializeCodeGraphMaterializationSpoolDatabase(database, header)).toThrow(
        'Code graph materialization spool fact surfaces are missing or corrupt.',
      );
    } finally {
      database.close();
    }
  });

  it('atomically sorts every raw fact surface and resumes the ready state', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: 'a'.repeat(64),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${'b'.repeat(40)}`,
      repositoryId: 'c'.repeat(64),
      snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, header);
      database.exec(`
        INSERT INTO materialization_raw_lookup (
          lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
        ) VALUES
          ('zeta', 'symbol-2', 'generic', 0, 'symbol', NULL, 'src/zeta.ts'),
          ('alpha', 'symbol-3', 'generic', 1, 'symbol', NULL, 'src/alpha.ts'),
          ('alpha', 'symbol-1', 'generic', 1, 'symbol', NULL, 'src/alpha.ts')
      `);
      sealCodeGraphMaterializationSpool(database, 0);
      sortCodeGraphMaterializationSpoolSurfaces(database);
      expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
        appendedBatchCount: 0,
        expectedBatchCount: 0,
        expectedSurfaceCount: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
        sortedSurfaceCount: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
        stage: 'ready',
      });
      expect(
        database.prepare('SELECT lookup_key, symbol_id FROM materialization_ordered_lookup ORDER BY rowid').all(),
      ).toEqual([
        {lookup_key: 'alpha', symbol_id: 'symbol-1'},
        {lookup_key: 'alpha', symbol_id: 'symbol-3'},
        {lookup_key: 'zeta', symbol_id: 'symbol-2'},
      ]);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_raw_%'",
          )
          .get(),
      ).toEqual({count: 0});
      expect(() => sortCodeGraphMaterializationSpoolSurfaces(database)).not.toThrow();
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('resumed');
    } finally {
      database.close();
    }
  });

  it('rejects malformed sidecar headers before creating schema', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      expect(() =>
        initializeCodeGraphMaterializationSpoolDatabase(database, {
          checkoutId: '../escape',
          extractorSet: 'extractor-v1',
          graphContentId: `cgc_${'b'.repeat(40)}`,
          repositoryId: 'c'.repeat(64),
          snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
        }),
      ).toThrow('Code graph materialization spool header is invalid.');
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as {
          readonly count: number;
        },
      ).toEqual({count: 0});
    } finally {
      database.close();
    }
  });

  it.prop(
    'records a contiguous exact append prefix and seals it once',
    {batchIds: FC.uniqueArray(FC.stringMatching(/^[0-9a-f]{64}$/u), {maxLength: 24})},
    ({batchIds}) => {
      const database = new Database(':memory:', {strict: true});
      try {
        configureCodeGraphMaterializationSpoolDatabase(database);
        initializeCodeGraphMaterializationSpoolDatabase(database, {
          checkoutId: 'a'.repeat(64),
          extractorSet: 'extractor-v1',
          graphContentId: `cgc_${'b'.repeat(40)}`,
          repositoryId: 'c'.repeat(64),
          snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
        });
        for (const [batchIndex, batchId] of batchIds.entries()) {
          const receipt = {batchId, batchIndex, factBytes: batchIndex * 3, rowCount: batchIndex * 5, sourceBytes: 7};
          expect(commitCodeGraphMaterializationSpoolBatch(database, receipt, () => undefined)).toBe('appended');
          expect(commitCodeGraphMaterializationSpoolBatch(database, receipt, () => undefined)).toBe('resumed');
        }
        expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
          appendedBatchCount: batchIds.length,
          stage: 'appending',
        });
        expect(sealCodeGraphMaterializationSpool(database, batchIds.length)).toBe('sealed');
        expect(sealCodeGraphMaterializationSpool(database, batchIds.length)).toBe('resumed');
        expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
          appendedBatchCount: batchIds.length,
          expectedBatchCount: batchIds.length,
          stage: 'sealed',
        });
      } finally {
        database.close();
      }
    },
    {fastCheck: {numRuns: 50}},
  );

  it('fails closed for gaps, receipt changes, premature seals, and appends after sealing', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, {
        checkoutId: 'a'.repeat(64),
        extractorSet: 'extractor-v1',
        graphContentId: `cgc_${'b'.repeat(40)}`,
        repositoryId: 'c'.repeat(64),
        snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
      });
      const receipt = {batchId: 'e'.repeat(64), batchIndex: 0, factBytes: 3, rowCount: 5, sourceBytes: 7};
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(database, {...receipt, batchIndex: 1}, () => undefined),
      ).toThrow('Code graph materialization spool batch sequence is not contiguous.');
      expect(() => sealCodeGraphMaterializationSpool(database, 1)).toThrow(
        'Code graph materialization spool cannot seal before every expected batch is committed.',
      );
      expect(commitCodeGraphMaterializationSpoolBatch(database, receipt, () => undefined)).toBe('appended');
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(database, {...receipt, rowCount: 6}, () => undefined),
      ).toThrow('Code graph materialization spool batch identity does not match the committed receipt.');
      expect(sealCodeGraphMaterializationSpool(database, 1)).toBe('sealed');
      expect(() => sealCodeGraphMaterializationSpool(database, 2)).toThrow(
        'Code graph materialization spool sealed batch count does not match.',
      );
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(
          database,
          {
            batchId: 'f'.repeat(64),
            batchIndex: 1,
            factBytes: 0,
            rowCount: 0,
            sourceBytes: 0,
          },
          () => undefined,
        ),
      ).toThrow('Code graph materialization spool is already sealed.');
    } finally {
      database.close();
    }
  });

  it('rejects a corrupt durable receipt ledger during exact-identity resume', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: 'a'.repeat(64),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${'b'.repeat(40)}`,
      repositoryId: 'c'.repeat(64),
      snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, header);
      commitCodeGraphMaterializationSpoolBatch(
        database,
        {
          batchId: 'e'.repeat(64),
          batchIndex: 0,
          factBytes: 3,
          rowCount: 5,
          sourceBytes: 7,
        },
        () => undefined,
      );
      database
        .prepare('UPDATE materialization_spool_batches SET batch_id = ? WHERE batch_index = 0')
        .run('z'.repeat(64));
      expect(() => initializeCodeGraphMaterializationSpoolDatabase(database, header)).toThrow(
        'Code graph materialization spool batch ledger is corrupt.',
      );
    } finally {
      database.close();
    }
  });

  it('commits raw rows and their receipt atomically and skips an exact replay writer', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, {
        checkoutId: 'a'.repeat(64),
        extractorSet: 'extractor-v1',
        graphContentId: `cgc_${'b'.repeat(40)}`,
        repositoryId: 'c'.repeat(64),
        snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
      });
      database.exec('CREATE TABLE raw_test (value TEXT NOT NULL)');
      const receipt = {batchId: 'e'.repeat(64), batchIndex: 0, factBytes: 3, rowCount: 1, sourceBytes: 7};
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(database, receipt, () => {
          database.prepare('INSERT INTO raw_test (value) VALUES (?)').run('rolled-back');
          throw new Error('injected append failure');
        }),
      ).toThrow('injected append failure');
      expect(database.prepare('SELECT value FROM raw_test').all()).toEqual([]);
      expect(readCodeGraphMaterializationSpoolState(database)).toEqual({appendedBatchCount: 0, stage: 'appending'});

      expect(
        commitCodeGraphMaterializationSpoolBatch(database, receipt, () => {
          database.prepare('INSERT INTO raw_test (value) VALUES (?)').run('committed');
        }),
      ).toBe('appended');
      expect(
        commitCodeGraphMaterializationSpoolBatch(database, receipt, () => {
          throw new Error('exact replay writer must not run');
        }),
      ).toBe('resumed');
      expect(database.prepare('SELECT value FROM raw_test').all()).toEqual([{value: 'committed'}]);
    } finally {
      database.close();
    }
  });

  it.prop(
    'sorts a registered surface plan in a contiguous atomic prefix',
    {surfaceCount: FC.integer({max: 16, min: 1})},
    ({surfaceCount}) => {
      const database = new Database(':memory:', {strict: true});
      try {
        configureCodeGraphMaterializationSpoolDatabase(database);
        initializeCodeGraphMaterializationSpoolDatabase(database, {
          checkoutId: 'a'.repeat(64),
          extractorSet: 'extractor-v1',
          graphContentId: `cgc_${'b'.repeat(40)}`,
          repositoryId: 'c'.repeat(64),
          snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
        });
        sealCodeGraphMaterializationSpool(database, 0);
        expect(beginCodeGraphMaterializationSpoolSort(database, surfaceCount)).toBe('sorting');
        for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex += 1) {
          expect(commitCodeGraphMaterializationSpoolSortedSurface(database, surfaceIndex, () => undefined)).toBe(
            'sorted',
          );
          expect(commitCodeGraphMaterializationSpoolSortedSurface(database, surfaceIndex, () => undefined)).toBe(
            'resumed',
          );
        }
        expect(finishCodeGraphMaterializationSpoolSort(database)).toBe('ready');
        expect(finishCodeGraphMaterializationSpoolSort(database)).toBe('resumed');
        expect(sealCodeGraphMaterializationSpool(database, 0)).toBe('resumed');
        expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
          appendedBatchCount: 0,
          expectedBatchCount: 0,
          expectedSurfaceCount: surfaceCount,
          sortedSurfaceCount: surfaceCount,
          stage: 'ready',
        });
      } finally {
        database.close();
      }
    },
    {fastCheck: {numRuns: 50}},
  );

  it('rolls a failed surface back without advancing and rejects gaps or early readiness', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, {
        checkoutId: 'a'.repeat(64),
        extractorSet: 'extractor-v1',
        graphContentId: `cgc_${'b'.repeat(40)}`,
        repositoryId: 'c'.repeat(64),
        snapshotId: `cgsn_${'d'.repeat(40)}-direct`,
      });
      sealCodeGraphMaterializationSpool(database, 0);
      beginCodeGraphMaterializationSpoolSort(database, 2);
      database.exec('CREATE TABLE sorted_test (value TEXT NOT NULL)');
      expect(() =>
        commitCodeGraphMaterializationSpoolSortedSurface(database, 0, () => {
          database.prepare('INSERT INTO sorted_test (value) VALUES (?)').run('rolled-back');
          throw new Error('injected sort failure');
        }),
      ).toThrow('injected sort failure');
      expect(database.prepare('SELECT value FROM sorted_test').all()).toEqual([]);
      expect(() => commitCodeGraphMaterializationSpoolSortedSurface(database, 1, () => undefined)).toThrow(
        'Code graph materialization spool sorted surface sequence is not contiguous.',
      );
      expect(() => finishCodeGraphMaterializationSpoolSort(database)).toThrow(
        'Code graph materialization spool cannot become ready before every surface is sorted.',
      );
    } finally {
      database.close();
    }
  });
});
