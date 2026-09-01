import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {readMemoryRecordsByUri} from '../../src/memory/commands.js';
import {formatMemoryDocument, type MemoryMetadata, type MemoryRelation} from '../../src/memory/document.js';
import {clearRecallIndexMemoryCache, loadRecallIndexData} from '../../src/recall/index.js';
import {
  classifyRecallMemoryPremiseState,
  parseRecallMemoryConnectionInput,
  retrieveRecallMemoryConnections,
} from '../../src/recall/memory_connections.js';
import {rankRecallCandidates, type RecallCandidate} from '../../src/recall/rank.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');

describe('recall memory connection properties', () => {
  effectIt.effect.prop(
    'normalizes raw and URI-form stable identities to one deterministic premise',
    {
      suffix: FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'), {
        maxLength: 64,
        minLength: 1,
      }).map(characters => characters.join('')),
    },
    ({suffix}) =>
      Effect.sync(() => {
        const memoryId = `tn_${suffix}`;
        const alias = `threadnote://memory/${memoryId}`;
        expect(parseRecallMemoryConnectionInput({memoryRefs: [memoryId, alias, memoryId]})).toEqual({
          memoryRefs: [alias],
        });
      }),
    {fastCheck: {numRuns: 64}},
  );

  effectIt.effect.prop(
    'never lets timestamps make inactive, unresolved, conflicted, or superseded evidence current',
    {
      activeSupersederCount: FC.integer({max: 3, min: 0}),
      offsetDays: FC.integer({max: 10_000, min: -10_000}),
      state: FC.constantFrom('archived' as const, 'expired' as const, 'superseded' as const),
    },
    ({activeSupersederCount, offsetDays, state}) =>
      Effect.sync(() => {
        const timestamp = new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString();
        expect(classifyRecallMemoryPremiseState({resolved: false, validFrom: timestamp}, NOW)).toBe('unresolved');
        expect(
          classifyRecallMemoryPremiseState({identityConflict: true, resolved: true, validFrom: timestamp}, NOW),
        ).toBe('conflicted');
        expect(classifyRecallMemoryPremiseState({resolved: true, status: state, validFrom: timestamp}, NOW)).toBe(
          'historical',
        );
        expect(classifyRecallMemoryPremiseState({activeSupersederCount, resolved: true, status: 'active'}, NOW)).toBe(
          activeSupersederCount > 1 ? 'conflicted' : activeSupersederCount === 1 ? 'historical' : 'current',
        );
      }),
    {fastCheck: {numRuns: 64}},
  );

  effectIt.effect.prop(
    'keeps direct candidates deterministic and protected from unrelated topical additions',
    {
      directOrdinal: FC.integer({max: 99, min: 0}),
      noiseCount: FC.integer({max: 20, min: 0}),
    },
    ({directOrdinal, noiseCount}) =>
      Effect.sync(() => {
        const direct = candidate(`threadnote://memory/tn_direct_${directOrdinal}`, 'lexically unrelated direct body');
        const noise = Array.from({length: noiseCount}, (_, index) =>
          candidate(`threadnote://memory/tn_noise_${index}`, 'allocator recovery regression procedure', {semantic: 1}),
        );
        const context = {minimumScore: 0.3, now: NOW, protectedUris: [direct.uri]} as const;
        const forward = rankRecallCandidates('allocator recovery regression', [direct, ...noise], context);
        const reverse = rankRecallCandidates(
          'allocator recovery regression',
          [...noise].reverse().concat(direct),
          context,
        );
        expect(forward.results[0]?.candidate.uri).toBe(direct.uri);
        expect(reverse.results.map(result => result.candidate.uri)).toEqual(
          forward.results.map(result => result.candidate.uri),
        );
      }),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect.prop(
    'returns the same bounded direct neighborhood after incremental and clean indexing',
    {
      neighborIds: FC.uniqueArray(FC.integer({max: 20, min: 0}), {maxLength: 12, minLength: 1}),
      reverseWrites: FC.boolean(),
    },
    ({neighborIds, reverseWrites}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-property-'});
        const config = runtimeConfig(home);
        const orderedIds = reverseWrites ? [...neighborIds].reverse() : neighborIds;
        yield* Effect.forEach(orderedIds, id => writeMemory(fs, path, home, `neighbor-${id}`, `tn_neighbor_${id}`), {
          concurrency: 1,
        });
        yield* writeMemory(
          fs,
          path,
          home,
          'seed',
          'tn_property_seed',
          neighborIds.map(id => ({type: 'related_to', uri: `threadnote://memory/tn_neighbor_${id}`})),
        );
        yield* writeMemory(fs, path, home, 'topical-noise', 'tn_topical_noise');
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: true});
        const incremental = yield* retrieve(config);
        yield* fs.remove(path.join(home, 'indexes', 'lexical'), {force: true, recursive: true});
        yield* clearRecallIndexMemoryCache();
        yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: true});
        const rebuilt = yield* retrieve(config);
        const normalize = (result: typeof incremental) => ({
          connections: result.connections.map(connection => ({
            direction: connection.direction,
            memoryId: connection.neighborMemoryId,
            relationType: connection.relationType,
            resolution: connection.resolution,
          })),
          memoryIds: result.candidates.map(value => value.memoryId),
          premises: result.premises.map(value => value.state),
        });
        expect(normalize(rebuilt)).toEqual(normalize(incremental));
        expect(incremental.candidates).toHaveLength(Math.min(8, neighborIds.length));
        expect(new Set(incremental.candidates.map(value => value.memoryId)).size).toBe(incremental.candidates.length);
        expect(incremental.candidates.map(value => value.memoryId)).not.toContain('tn_topical_noise');
        expect(incremental.diagnostics.canonicalRereads).toBe(neighborIds.length + 2);
        expect(incremental.diagnostics.rawLinkRows).toBe(neighborIds.length);
        expect(incremental.coverage.truncated).toBe(neighborIds.length > 8);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 8}, timeout: 30_000},
  );
});

function retrieve(config: ReturnType<typeof runtimeConfig>) {
  return retrieveRecallMemoryConnections(config, {
    allowedUriScopes: [`threadnote://user/${config.user}/memories`],
    memoryRefs: ['threadnote://memory/tn_property_seed'],
    now: NOW,
    readRecords: uris => readMemoryRecordsByUri(config, uris),
  });
}

function runtimeConfig(home: string) {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'property',
    manifestPath: `${home}/manifest.yaml`,
    user: 'property-user',
  } as const;
}

const writeMemory = Effect.fn('test.writeMemoryConnectionPropertyDocument')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  topic: string,
  memoryId: string,
  relations: readonly MemoryRelation[] = [],
) {
  const target = path.join(
    home,
    'data',
    'local',
    'user',
    'property-user',
    'memories',
    'durable',
    'projects',
    'threadnote',
    `${topic}.md`,
  );
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId,
    project: 'threadnote',
    relations,
    sourceAgentClient: 'property',
    status: 'active',
    timestamp: '2026-08-31T00:00:00.000Z',
    topic,
  };
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  yield* fs.writeFileString(target, formatMemoryDocument('MEMORY', metadata, `${topic} property body.`));
});

function candidate(uri: string, text: string, overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    fields: {project: 'threadnote'},
    kind: 'durable',
    status: 'active',
    text,
    timestamp: '2026-08-31T00:00:00.000Z',
    trust: 'approved',
    uri,
    ...overrides,
  };
}
