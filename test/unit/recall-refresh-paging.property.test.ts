import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {SystemInfo} from '../../src/effect/system.js';
import {expireRecallIndexValidation, loadRecallIndexData, recallIndexDatabaseFilename} from '../../src/recall/index.js';
import {canonicalResourceUri} from '../../src/storage/resource-id.js';

const RecallIndexTestLayer = Layer.merge(BunServices.layer, SystemInfo.layer);
const UNICODE_NAMES = ['alpha', 'omega', 'ßeta', 'λambda', '中間', '\uE000-private', '😀-face', '𐀀-linear-b'] as const;

interface CorpusEntry {
  readonly name: string;
  readonly variant: number;
}

const corpusArbitrary = FC.uniqueArray(
  FC.record({
    name: FC.constantFrom(...UNICODE_NAMES),
    variant: FC.integer({max: 9, min: 0}),
  }),
  {maxLength: UNICODE_NAMES.length, selector: entry => entry.name},
);

describe('recall refresh source paging', () => {
  effectIt.layer(RecallIndexTestLayer)(layerIt => {
    layerIt.effect(
      'crosses source and deletion page boundaries without losing Unicode or legacy-v1 memories',
      () =>
        withRecallHome((home, fs, path) =>
          Effect.gen(function* () {
            const config = recallConfig(home);
            const resourceRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'paging');
            const memoryRoot = path.join(
              home,
              'data',
              'local',
              'user',
              'paging-user',
              'memories',
              'durable',
              'projects',
              'threadnote',
            );
            yield* fs.makeDirectory(resourceRoot, {recursive: true});
            yield* fs.makeDirectory(memoryRoot, {recursive: true});
            const asciiNames = Array.from(
              {length: 264},
              (_unused, index) => `document-${String(index).padStart(3, '0')}.md`,
            );
            const unicodeNames = [
              'ßeta.md',
              'λambda.md',
              '中間.md',
              '\uE000-private.md',
              '😀-face.md',
              '𐀀-linear-b.md',
            ];
            const names = [...asciiNames, ...unicodeNames];
            yield* Effect.forEach(
              names,
              (name, index) => fs.writeFileString(path.join(resourceRoot, name), resourceDocument(name, index)),
              {concurrency: 32, discard: true},
            );
            yield* fs.writeFileString(path.join(memoryRoot, 'legacy-v1.md'), legacyV1Memory());

            yield* loadRecallIndexData(config, {includeInactive: false, query: 'page-boundary-anchor'});
            expect(readDocumentCount(home)).toBe(271);

            const retainedNames = new Set([
              'document-000.md',
              'document-128.md',
              'ßeta.md',
              '中間.md',
              '😀-face.md',
              '𐀀-linear-b.md',
            ]);
            yield* Effect.forEach(
              names.filter(name => !retainedNames.has(name)),
              name => fs.remove(path.join(resourceRoot, name), {force: true}),
              {concurrency: 32, discard: true},
            );
            const changedName = '😀-face.md';
            yield* fs.writeFileString(
              path.join(resourceRoot, changedName),
              '# Changed\n\nunicode-refresh-anchor page-boundary-anchor\n',
            );
            const addedName = 'Ω-added.md';
            yield* fs.writeFileString(
              path.join(resourceRoot, addedName),
              '# Added\n\nadded-refresh-anchor page-boundary-anchor\n',
            );
            yield* expireRecallIndexValidation(home, false, [resourceUri(changedName)]);

            const refreshed = yield* loadRecallIndexData(config, {
              includeInactive: false,
              query: 'unicode-refresh-anchor added-refresh-anchor',
            });
            expect(refreshed.candidates.map(candidate => candidate.uri)).toEqual(
              expect.arrayContaining([resourceUri(changedName), resourceUri(addedName)]),
            );
            expect(readDocumentCount(home)).toBe(retainedNames.size + 2);
            expect(readResourceNames(home)).toEqual([...retainedNames, addedName].sort());

            const legacy = yield* loadRecallIndexData(config, {
              includeInactive: false,
              query: 'legacy-page-continuity-anchor',
            });
            expect(
              legacy.candidates.find(candidate => candidate.fields?.topic === 'recall-refresh-legacy-v1'),
            ).toMatchObject({
              text: expect.stringContaining('legacy-page-continuity-anchor'),
              uri: 'threadnote://user/paging-user/memories/durable/projects/threadnote/legacy-v1.md',
            });
          }),
        ),
      30_000,
    );

    layerIt.effect.prop(
      'matches an independent Unicode corpus model across paged additions, replacements, and deletions',
      {
        initial: corpusArbitrary,
        next: corpusArbitrary,
      },
      ({initial, next}) =>
        withRecallHome((home, fs, path) =>
          Effect.gen(function* () {
            const config = recallConfig(home);
            const resourceRoot = path.join(home, 'data', 'local', 'resources', 'repos', 'paging');
            yield* fs.makeDirectory(resourceRoot, {recursive: true});
            yield* writeCorpus(fs, path, resourceRoot, initial);
            yield* loadRecallIndexData(config, {includeInactive: false, query: 'property-refresh-anchor'});

            const nextByName = new Map(next.map(entry => [entry.name, entry]));
            yield* Effect.forEach(
              initial.filter(entry => !nextByName.has(entry.name)),
              entry => fs.remove(path.join(resourceRoot, `${entry.name}.md`), {force: true}),
              {discard: true},
            );
            yield* writeCorpus(fs, path, resourceRoot, next);
            yield* expireRecallIndexValidation(
              home,
              false,
              next.map(entry => resourceUri(`${entry.name}.md`)),
            );
            yield* loadRecallIndexData(config, {includeInactive: false, query: 'property-refresh-anchor'});

            expect(readResourceModel(home)).toEqual(
              [...next]
                .sort((left, right) => left.name.localeCompare(right.name))
                .map(entry => ({name: `${entry.name}.md`, variant: entry.variant})),
            );
          }),
        ),
      {fastCheck: {numRuns: 12}, timeout: 30_000},
    );
  });
});

function withRecallHome<A, E, R>(
  use: (home: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectory({prefix: 'threadnote-recall-refresh-paging-'});
    return yield* use(home, fs, path).pipe(
      Effect.ensuring(fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore)),
    );
  });
}

function recallConfig(home: string) {
  return {account: 'local', agentContextHome: home, user: 'paging-user'};
}

function resourceUri(name: string): string {
  return canonicalResourceUri('resources', ['repos', 'paging', name]);
}

function resourceDocument(name: string, variant: number): string {
  return `# ${name}\n\npage-boundary-anchor property-refresh-anchor variant-${variant}\n`;
}

function legacyV1Memory(): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    'topic: recall-refresh-legacy-v1',
    'source_agent_client: codex',
    'timestamp: 2025-01-01T00:00:00.000Z',
    'schema_version: 1',
    '',
    'legacy-page-continuity-anchor remains recallable after a paged refresh.',
  ].join('\n');
}

function writeCorpus(fs: FileSystem.FileSystem, path: Path.Path, root: string, entries: readonly CorpusEntry[]) {
  return Effect.forEach(
    entries,
    entry => fs.writeFileString(path.join(root, `${entry.name}.md`), resourceDocument(entry.name, entry.variant)),
    {concurrency: 8, discard: true},
  );
}

function readDocumentCount(home: string): number {
  const database = openRecallDatabase(home);
  try {
    return (database.query('SELECT COUNT(*) AS count FROM documents').get() as {readonly count: number}).count;
  } finally {
    database.close(false);
  }
}

function readResourceNames(home: string): readonly string[] {
  const database = openRecallDatabase(home);
  try {
    return (
      database
        .query("SELECT source_path FROM documents WHERE uri LIKE 'threadnote://resources/%' ORDER BY uri")
        .all() as readonly {readonly source_path: string}[]
    )
      .map(row => row.source_path.split(/[\\/]/u).at(-1)!)
      .sort();
  } finally {
    database.close(false);
  }
}

function readResourceModel(home: string): readonly {readonly name: string; readonly variant: number}[] {
  const database = openRecallDatabase(home);
  try {
    return (
      database
        .query(
          "SELECT source_path, candidate_json FROM documents WHERE uri LIKE 'threadnote://resources/%' ORDER BY uri",
        )
        .all() as readonly {readonly candidate_json: string; readonly source_path: string}[]
    )
      .map(row => ({
        name: row.source_path.split(/[\\/]/u).at(-1)!,
        variant: Number(/variant-(\d+)/u.exec((JSON.parse(row.candidate_json) as {readonly text: string}).text)?.[1]),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    database.close(false);
  }
}

function openRecallDatabase(home: string): Database {
  return new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true});
}
