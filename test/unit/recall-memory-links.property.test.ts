import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {formatMemoryDocument, MEMORY_RELATION_TYPES, type MemoryMetadata} from '../../src/memory/document.js';
import {memoryIdentityAlias} from '../../src/memory/identity_alias.js';
import {memoryLinkLocatorDigest} from '../../src/recall/memory_links.js';
import {clearRecallIndexMemoryCache, loadRecallIndexData, recallIndexDatabaseFilename} from '../../src/recall/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

type Operation =
  | {readonly id: number; readonly kind: 'put-target'}
  | {readonly kind: 'remove-source' | 'remove-target'}
  | {
      readonly kind: 'put-source';
      readonly relationType: (typeof MEMORY_RELATION_TYPES)[number];
      readonly selector: 'alias' | 'legacy';
      readonly targetId: number;
    };

interface Model {
  source?: Extract<Operation, {readonly kind: 'put-source'}>;
  targetId?: number;
}

const operation = FC.oneof(
  FC.record({id: FC.integer({max: 3, min: 0}), kind: FC.constant('put-target' as const)}),
  FC.constant({kind: 'remove-target' as const}),
  FC.record({
    kind: FC.constant('put-source' as const),
    relationType: FC.constantFrom(...MEMORY_RELATION_TYPES),
    selector: FC.constantFrom('alias' as const, 'legacy' as const),
    targetId: FC.integer({max: 3, min: 0}),
  }),
  FC.constant({kind: 'remove-source' as const}),
);

describe('recall memory link properties', () => {
  effectIt.effect.prop(
    'matches an independent model across incremental source and target operations and a clean rebuild',
    {operations: FC.array(operation, {maxLength: 8, minLength: 1})},
    ({operations}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-links-property-'});
        const user = 'memory-links-property-user';
        const model: Model = {};
        const runtime = {account: 'local', agentContextHome: home, user};

        for (const next of operations) {
          yield* applyOperation(fs, path, home, user, model, next);
          yield* loadRecallIndexData(runtime, {forceRefresh: true, includeInactive: false});
          expect(readProjection(home)).toEqual(expectedProjection(user, model));
        }

        const incremental = readProjection(home);
        yield* fs.remove(path.join(home, 'indexes', 'lexical'), {force: true, recursive: true});
        yield* clearRecallIndexMemoryCache();
        yield* loadRecallIndexData(runtime, {forceRefresh: true, includeInactive: false});
        expect(readProjection(home)).toEqual(incremental);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 16}, timeout: 30_000},
  );
});

const applyOperation = Effect.fn('test.applyMemoryLinkOperation')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  user: string,
  model: Model,
  operation: Operation,
) {
  const sourcePath = memoryPath(path, home, user, 'source');
  const targetPath = memoryPath(path, home, user, 'target');
  switch (operation.kind) {
    case 'put-target':
      model.targetId = operation.id;
      yield* writeMemory(fs, path, targetPath, 'target', targetMemoryId(operation.id));
      return;
    case 'remove-target':
      delete model.targetId;
      yield* fs.remove(targetPath, {force: true});
      return;
    case 'put-source': {
      model.source = operation;
      const uri =
        operation.selector === 'alias'
          ? memoryIdentityAlias(targetMemoryId(operation.targetId))
          : memoryUri(user, 'target');
      yield* writeMemory(fs, path, sourcePath, 'source', 'tn_property_source', {
        relations: [{type: operation.relationType, uri}],
      });
      return;
    }
    case 'remove-source':
      delete model.source;
      yield* fs.remove(sourcePath, {force: true});
  }
});

function expectedProjection(user: string, model: Model): readonly Record<string, unknown>[] {
  if (!model.source) return [];
  const legacy = model.source.selector === 'legacy';
  return [
    {
      relation_ordinal: 0,
      relation_origin: 'relation',
      relation_type: model.source.relationType,
      source_memory_id: 'tn_property_source',
      source_uri: memoryUri(user, 'source'),
      target_locator_digest: legacy ? memoryLinkLocatorDigest(memoryUri(user, 'target')) : '',
      target_memory_id: legacy
        ? model.targetId === undefined
          ? ''
          : targetMemoryId(model.targetId)
        : targetMemoryId(model.source.targetId),
    },
  ];
}

function targetMemoryId(id: number): string {
  return `tn_property_target_${id}`;
}

function memoryUri(user: string, topic: string): string {
  return `threadnote://user/${user}/memories/durable/projects/threadnote/${topic}.md`;
}

function memoryPath(path: Path.Path, home: string, user: string, topic: string): string {
  return path.join(home, 'data', 'local', 'user', user, 'memories', 'durable', 'projects', 'threadnote', `${topic}.md`);
}

const writeMemory = Effect.fn('test.writePropertyMemory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  topic: string,
  memoryId: string,
  extra: Partial<MemoryMetadata> = {},
) {
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId,
    project: 'threadnote',
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-08-31T00:00:00.000Z',
    topic,
    ...extra,
  };
  yield* fs.writeFileString(target, formatMemoryDocument('MEMORY', metadata, `${topic} property body`));
});

function readProjection(home: string): readonly Record<string, unknown>[] {
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true});
  try {
    return database
      .query<Record<string, unknown>, []>(
        `SELECT
          source.uri AS source_uri,
          link.source_memory_id,
          link.target_memory_id,
          link.target_locator_digest,
          link.relation_type,
          link.relation_origin,
          link.relation_ordinal
        FROM memory_links AS link
        INNER JOIN documents AS source ON source.id = link.source_document_id
        ORDER BY source.uri, link.relation_origin, link.relation_ordinal, link.relation_type`,
      )
      .all();
  } finally {
    database.close();
  }
}
