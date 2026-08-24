import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS,
  codeGraphMaterializationApplyPages,
  codeGraphMaterializationSpoolPath,
  commitCodeGraphMaterializationSpoolBatch,
  configureCodeGraphMaterializationSpoolDatabase,
  initializeCodeGraphMaterializationSpoolDatabase,
  readCodeGraphMaterializationSpoolState,
  sealCodeGraphMaterializationSpool,
} from '../../src/code_graph/materialization_spool.js';
import type {CodeGraphLayout} from '../../src/code_graph/layout.js';

describe('code graph materialization spool', () => {
  it.prop(
    'covers every ordered row once with monotonic bounded cursors',
    {
      pageRows: FC.integer({max: CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS, min: 1}),
      rowCount: FC.integer({max: 100_000, min: 0}),
    },
    ({pageRows, rowCount}) => {
      const pages = codeGraphMaterializationApplyPages(rowCount, pageRows);
      expect(pages.reduce((total, page) => total + page.rowCount, 0)).toBe(rowCount);
      expect(pages.every(page => page.rowCount > 0 && page.rowCount <= pageRows)).toBe(true);
      expect(pages.map(page => page.afterRowid)).toEqual(
        Array.from({length: pages.length}, (_, index) => index * pageRows),
      );
      expect(pages.at(-1)?.afterRowid ?? 0).toBeLessThanOrEqual(rowCount);
    },
    {fastCheck: {numRuns: 100}},
  );

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
});
