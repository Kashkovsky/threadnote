import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {describe} from 'vitest';
import {ResourceStore} from '../../src/effect/resource-store.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {runArchive} from '../../src/memory.js';
import {createMemoryCodeCitation, MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, parseMemoryDocument} from '../../src/memory/document.js';
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
            codeCitations: [citation],
            kind: 'durable',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'codex',
            sourceCommit: citation.sourceCommit,
            sourceObservedAt: '2026-08-26T20:00:00.000Z',
            status: 'active',
            timestamp: '2026-08-26T20:00:00.000Z',
            topic: 'archive-citation',
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
          codeCitations: [citation],
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceCommit: citation.sourceCommit,
          sourceObservedAt: '2026-08-26T20:00:00.000Z',
          status: 'archived',
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
    path: 'src/memory.ts',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {kind: 'file'},
    version: 1,
  });
}
