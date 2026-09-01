import {Database} from 'bun:sqlite';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runArchive} from '../../src/memory/index.js';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, parseMemoryDocument} from '../../src/memory/document.js';
import {loadRecallIndexData, recallIndexDatabaseFilename} from '../../src/recall/index.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('memory archive code citations', () => {
  it.effect('retains valid schema-v4 citations as machine-readable archive metadata', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, location, store} = yield* archiveFixture();
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/archive-citation.md';
        const citation = archiveCitation();
        const original = formatMemoryDocument(
          'MEMORY',
          {
            authority: 'user_approved',
            codeCitations: [citation],
            createdAt: '2026-08-25T20:00:00.000Z',
            evidence: ['threadnote://memory/tn_archive_evidence'],
            kind: 'durable',
            memoryId: 'tn_archive_source',
            project: 'threadnote',
            references: ['threadnote://memory/tn_archive_reference'],
            relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_archive_target'}],
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            sourceCommit: citation.sourceCommit,
            sourceObservedAt: '2026-08-26T20:00:00.000Z',
            status: 'active',
            supersedes: 'threadnote://memory/tn_archive_history',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: 'archive-citation',
            trust: 'approved',
            validFrom: '2026-08-25T20:00:00.000Z',
            workspaceScope: 'packages/core',
          },
          'The archived decision remains supported by precise code evidence.',
        );
        yield* store.write(location, sourceUri, original, {mode: 'create'});

        yield* runArchive(config, sourceUri, {
          expectedContent: original,
          kind: 'durable',
          project: 'threadnote',
          topic: 'archive-citation',
        });

        expect(Option.isNone(yield* Effect.option(store.stat(location, sourceUri)))).toBe(true);
        const entries = yield* store.list(location, 'threadnote://user/tester/memories/durable/archived/threadnote', {
          recursive: true,
        });
        expect(entries).toHaveLength(1);
        const archivedContent = yield* store.read(location, entries[0]!.uri);
        const archived = parseMemoryDocument(entries[0]!.uri, archivedContent);
        expect(archived?.metadata).toMatchObject({
          archivedFrom: sourceUri,
          authority: 'user_approved',
          codeCitations: [citation],
          createdAt: '2026-08-25T20:00:00.000Z',
          evidence: ['threadnote://memory/tn_archive_evidence'],
          memoryId: 'tn_archive_source',
          references: ['threadnote://memory/tn_archive_reference'],
          relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_archive_target'}],
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceCommit: citation.sourceCommit,
          sourceObservedAt: '2026-08-26T20:00:00.000Z',
          status: 'archived',
          supersedes: 'threadnote://memory/tn_archive_history',
          trust: 'approved',
          validFrom: '2026-08-25T20:00:00.000Z',
          visibility: 'personal',
          workspaceScope: 'packages/core',
        });
        expect(archived?.metadata.citationErrors).toBeUndefined();
        expect(archived?.body).toBe(
          [
            'Archived original Threadnote memory.',
            '',
            'The archived decision remains supported by precise code evidence.',
          ].join('\n'),
        );
        expect(archived?.body).not.toContain(citation.id);
        expect(archived?.body).not.toContain(citation.fileContentHash.value);

        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
        expect(readArchivedMemoryLinks(config.agentContextHome, false)).toEqual([]);
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: true});
        expect(readArchivedMemoryLinks(config.agentContextHome, true)).toEqual([
          {relation_origin: 'evidence', relation_type: 'evidence_for', target_memory_id: 'tn_archive_evidence'},
          {relation_origin: 'references', relation_type: 'references', target_memory_id: 'tn_archive_reference'},
          {relation_origin: 'relation', relation_type: 'depends_on', target_memory_id: 'tn_archive_target'},
          {relation_origin: 'supersedes', relation_type: 'supersedes', target_memory_id: 'tn_archive_history'},
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('keeps the source intact when citation metadata is malformed', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {config, location, store} = yield* archiveFixture();
        const sourceUri = 'threadnote://user/tester/memories/durable/projects/threadnote/archive-malformed-citation.md';
        const original = [
          'MEMORY',
          'kind: durable',
          'status: active',
          'project: threadnote',
          'topic: archive-malformed-citation',
          `schema_version: ${MEMORY_SCHEMA_VERSION}`,
          'code_citation: {not-json}',
          '',
          'Malformed citation metadata must not be demoted to prose.',
        ].join('\n');
        yield* store.write(location, sourceUri, original, {mode: 'create'});

        const failure = yield* Effect.flip(
          runArchive(config, sourceUri, {
            expectedContent: original,
            kind: 'durable',
            project: 'threadnote',
            topic: 'archive-malformed-citation',
          }),
        );

        expect(String(failure)).toContain('malformed code citation metadata (invalid-json)');
        expect(yield* store.read(location, sourceUri)).toBe(original);
        const archived = yield* store
          .list(location, 'threadnote://user/tester/memories/durable/archived/threadnote', {recursive: true})
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.succeed([])));
        expect(archived).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const archiveFixture = Effect.fn('test.archiveFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-archive-citations-'});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  const store = yield* ResourceStore;
  return {config, location: {account: config.account, home, user: config.user}, store};
});

function archiveCitation() {
  return createMemoryCodeCitation({
    extractorSet: 'native-code-graph-13',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/memory/index.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
}

function readArchivedMemoryLinks(home: string, includeInactive: boolean) {
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(includeInactive)}`, {
    readonly: true,
  });
  try {
    return database
      .query<{readonly relation_origin: string; readonly relation_type: string; readonly target_memory_id: string}, []>(
        `SELECT relation_origin, relation_type, target_memory_id
         FROM memory_links
         WHERE source_memory_id = 'tn_archive_source'
         ORDER BY relation_origin, relation_type, target_memory_id`,
      )
      .all();
  } finally {
    database.close();
  }
}
