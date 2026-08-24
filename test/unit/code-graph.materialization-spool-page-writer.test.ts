import {BunFileSystem, BunPath} from '@effect/platform-bun';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Database} from 'bun:sqlite';
import {expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES} from '../../src/code_graph/materialization_spool_apply_surfaces.js';
import {writeCodeGraphMaterializationSpoolSurfacePage} from '../../src/code_graph/store_materialization_spool_apply.js';

const layer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  SqliteClient.layer({disableWAL: true, filename: ':memory:'}),
);

effectIt.effect('applies compact lexical dictionaries before exact joined postings', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-materialization-spool-page-'});
    const sidecarPath = path.join(root, 'spool.sqlite');
    yield* Effect.sync(() => {
      const sidecar = new Database(sidecarPath, {create: true, strict: true});
      try {
        sidecar.exec(`
          CREATE TABLE materialization_ordered_symbols (id TEXT NOT NULL);
          CREATE TABLE materialization_ordered_terms (term TEXT NOT NULL);
          CREATE TABLE materialization_ordered_symbol_terms (term TEXT NOT NULL, symbol_id TEXT NOT NULL, weight INTEGER NOT NULL);
          INSERT INTO materialization_ordered_symbols (id) VALUES ('symbol-a'), ('symbol-b');
          INSERT INTO materialization_ordered_terms (term) VALUES ('alpha'), ('beta');
          INSERT INTO materialization_ordered_symbol_terms (term, symbol_id, weight) VALUES
            ('alpha', 'symbol-a', 5), ('alpha', 'symbol-b', 3), ('beta', 'symbol-b', 4);
        `);
      } finally {
        sidecar.close();
      }
    });

    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TABLE lexical_compact_snapshots (
      snapshot_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_id TEXT UNIQUE NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE lexical_compact_symbols (
      symbol_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL,
      symbol_id TEXT NOT NULL,
      UNIQUE (snapshot_key, symbol_id)
    )`);
    yield* sql.unsafe(`CREATE TABLE lexical_compact_terms (
      term_key INTEGER PRIMARY KEY NOT NULL,
      snapshot_key INTEGER NOT NULL,
      term TEXT NOT NULL,
      UNIQUE (snapshot_key, term)
    )`);
    yield* sql.unsafe(`CREATE TABLE lexical_compact_postings (
      snapshot_key INTEGER NOT NULL,
      term_key INTEGER NOT NULL,
      symbol_key INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY (snapshot_key, term_key, symbol_key)
    ) WITHOUT ROWID`);
    yield* sql.unsafe('ATTACH DATABASE ? AS materialization_spool', [sidecarPath]);
    const surfaceIndex = (name: string) =>
      CODE_GRAPH_MATERIALIZATION_SPOOL_APPLY_SURFACES.findIndex(surface => surface.name === name);
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('lexical_snapshot'), {
      afterRowid: 0,
      rowCount: 1,
    });
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('lexical_symbols'), {
      afterRowid: 0,
      rowCount: 2,
    });
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('lexical_terms'), {
      afterRowid: 0,
      rowCount: 2,
    });
    yield* writeCodeGraphMaterializationSpoolSurfacePage(sql, 'snapshot', surfaceIndex('symbol_terms'), {
      afterRowid: 0,
      rowCount: 3,
    });
    expect(yield* sql.unsafe('SELECT symbol_key, symbol_id FROM lexical_compact_symbols ORDER BY symbol_key')).toEqual([
      {symbol_id: 'symbol-a', symbol_key: 1},
      {symbol_id: 'symbol-b', symbol_key: 2},
    ]);
    expect(yield* sql.unsafe('SELECT term_key, term FROM lexical_compact_terms ORDER BY term_key')).toEqual([
      {term: 'alpha', term_key: 1},
      {term: 'beta', term_key: 2},
    ]);
    expect(
      yield* sql.unsafe(
        `SELECT term.term, symbol.symbol_id, posting.weight
         FROM lexical_compact_postings AS posting
         JOIN lexical_compact_terms AS term ON term.term_key = posting.term_key
         JOIN lexical_compact_symbols AS symbol ON symbol.symbol_key = posting.symbol_key
         ORDER BY posting.term_key, posting.symbol_key`,
      ),
    ).toEqual([
      {symbol_id: 'symbol-a', term: 'alpha', weight: 5},
      {symbol_id: 'symbol-b', term: 'alpha', weight: 3},
      {symbol_id: 'symbol-b', term: 'beta', weight: 4},
    ]);
    yield* sql.unsafe('DETACH DATABASE materialization_spool');
  }).pipe(provideTestLayer(layer)),
);
