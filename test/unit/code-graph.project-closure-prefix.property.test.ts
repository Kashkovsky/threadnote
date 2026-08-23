import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  boundedSnapshotProjectPrefixes,
  codeGraphSnapshotProjectClosureStatement,
} from '../../src/code_graph/store_project_closure.js';

describe('bounded snapshot project prefixes', () => {
  it.prop(
    'is permutation-invariant and preserves exactly the same descendant coverage',
    {
      reverse: FC.boolean(),
      roots: FC.uniqueArray(
        FC.tuple(FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/), FC.stringMatching(/^[a-z][a-z0-9]{0,8}$/)).map(
          ([parent, child]) => `packages/${parent}/${child}`,
        ),
        {maxLength: 40, minLength: 1},
      ),
    },
    ({reverse, roots}) => {
      const withAncestors = roots.flatMap((root, index) =>
        index % 3 === 0 ? [root, root.slice(0, root.lastIndexOf('/'))] : [root],
      );
      const input = reverse ? [...withAncestors].reverse() : withAncestors;
      const canonical = boundedSnapshotProjectPrefixes(input);
      const repeated = boundedSnapshotProjectPrefixes([...(canonical ?? [])].reverse());

      expect(canonical).toBeDefined();
      expect(repeated).toEqual(canonical);
      for (const root of roots) {
        expect(canonical!.some(prefix => root === prefix || root.startsWith(`${prefix}/`))).toBe(true);
      }
      expect(
        canonical!.some((prefix, index) =>
          canonical!.some((other, otherIndex) => otherIndex !== index && prefix.startsWith(`${other}/`)),
        ),
      ).toBe(false);
    },
    {fastCheck: {numRuns: 250}},
  );

  it('rejects roots that could select the repository or escape canonical path bounds', () => {
    expect(boundedSnapshotProjectPrefixes([''])).toBeUndefined();
    expect(boundedSnapshotProjectPrefixes(['/absolute'])).toBeUndefined();
    expect(boundedSnapshotProjectPrefixes(['packages/../outside'])).toBeUndefined();
    expect(boundedSnapshotProjectPrefixes(['packages\\outside'])).toBeUndefined();
  });

  it('probes every project prefix through the snapshot primary key without a TEMP sort', () => {
    const database = new Database(':memory:');
    try {
      database.run(`CREATE TABLE snapshot_files (
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        mode TEXT NOT NULL,
        size INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      ) WITHOUT ROWID`);
      const statement = codeGraphSnapshotProjectClosureStatement('snapshot', ['packages/app', 'packages/core']);
      const plan = database
        .query(`EXPLAIN QUERY PLAN ${statement.text}`)
        .all(...statement.parameters)
        .map(row => (row as {readonly detail: string}).detail);

      expect(plan).toContain('SEARCH file USING PRIMARY KEY (snapshot_id=? AND path>? AND path<?)');
      expect(plan.some(detail => detail.includes('USE TEMP B-TREE'))).toBe(false);
    } finally {
      database.close(false);
    }
  });
});
