import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {readMemoryRecordsByUri} from '../../src/memory/commands.js';
import {MEMORY_SCHEMA_VERSION} from '../../src/memory/code_citation.js';
import {formatMemoryDocument, type MemoryMetadata, type MemoryRelation} from '../../src/memory/document.js';
import {
  classifyRecallMemoryPremiseState,
  parseRecallMemoryConnectionInput,
  retrieveRecallMemoryConnections,
} from '../../src/recall/memory_connections.js';
import {loadRecallMemoryLinks} from '../../src/recall/index.js';
import {rankRecallCandidates, type RecallCandidate} from '../../src/recall/rank.js';
import {prepareRecallSections} from '../../src/recall/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const CURRENT = new Date('2026-08-31T12:00:00.000Z');

describe('recall memory connections', () => {
  it('normalizes bounded memory references and the closed relation vocabulary', () => {
    expect(
      parseRecallMemoryConnectionInput({
        memoryRefs: [
          'threadnote://memory/tn_target',
          'threadnote://user/test/memories/durable/projects/threadnote/source.md',
          'threadnote://memory/tn_target',
        ],
        relationTypes: ['supersedes', 'depends_on', 'supersedes'],
      }),
    ).toEqual({
      memoryRefs: [
        'threadnote://memory/tn_target',
        'threadnote://user/test/memories/durable/projects/threadnote/source.md',
      ],
      relationTypes: ['depends_on', 'supersedes'],
    });

    expect(() =>
      parseRecallMemoryConnectionInput({
        memoryRefs: Array.from({length: 9}, (_, index) => `threadnote://memory/tn_${index}`),
      }),
    ).toThrow('at most 8');
    expect(() =>
      parseRecallMemoryConnectionInput({memoryRefs: ['threadnote://resources/repos/threadnote/README.md']}),
    ).toThrow('managed memory');
    expect(() =>
      parseRecallMemoryConnectionInput({
        memoryRefs: ['threadnote://memory/tn_target'],
        relationTypes: ['causes'],
      }),
    ).toThrow('Unknown memory relation type');
  });

  it('derives currentness before recency and abstains on unresolved or conflicting evidence', () => {
    expect(classifyRecallMemoryPremiseState({resolved: false}, CURRENT)).toBe('unresolved');
    expect(classifyRecallMemoryPremiseState({identityConflict: true, resolved: true}, CURRENT)).toBe('conflicted');
    expect(classifyRecallMemoryPremiseState({resolved: true, status: 'archived'}, CURRENT)).toBe('historical');
    expect(
      classifyRecallMemoryPremiseState(
        {resolved: true, status: 'active', validTo: '2026-08-30T00:00:00.000Z'},
        CURRENT,
      ),
    ).toBe('historical');
    expect(
      classifyRecallMemoryPremiseState({activeSupersederCount: 1, resolved: true, status: 'active'}, CURRENT),
    ).toBe('historical');
    expect(
      classifyRecallMemoryPremiseState({activeSupersederCount: 2, resolved: true, status: 'active'}, CURRENT),
    ).toBe('conflicted');
    expect(classifyRecallMemoryPremiseState({resolved: true, status: 'active'}, CURRENT)).toBe('current');
  });

  it('keeps direct one-hop candidates ahead of topical backfill without making the relation an entailment', () => {
    const direct = candidate('threadnote://memory/tn_direct', 'unrelated dependency body');
    const topical = candidate('threadnote://memory/tn_topical', 'allocator regression recovery procedure', {
      semantic: 1,
    });
    const ranked = rankRecallCandidates('allocator regression recovery', [topical, direct], {
      minimumScore: 0.3,
      now: CURRENT,
      protectedUris: [direct.uri],
      seedUris: ['threadnote://memory/tn_seed'],
    });

    expect(ranked.results.map(result => result.candidate.uri)).toEqual([direct.uri, topical.uri]);
    expect(ranked.results[0]?.passedRelevanceGate).toBe(false);
  });

  effectIt.effect('selects verified incoming and outgoing edges and stops after one hop', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connections-'});
      const config = runtimeConfig(home, 'connection-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_seed', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_target'},
      ]);
      yield* writeMemory(fs, path, config, 'target', 'tn_target', [
        {type: 'related_to', uri: 'threadnote://memory/tn_second_hop'},
      ]);
      yield* writeMemory(fs, path, config, 'second-hop', 'tn_second_hop');
      yield* writeMemory(fs, path, config, 'incoming', 'tn_incoming', [
        {type: 'evidence_for', uri: 'threadnote://memory/tn_seed'},
      ]);

      const selected = yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        forceRefresh: true,
        includeInactive: true,
        memorySeeds: [{memoryId: 'tn_seed', requestedOrdinal: 0}],
      });
      expect(
        selected.map(link => [link.direction, link.relationType, link.sourceMemoryId, link.targetMemoryId]),
      ).toEqual([
        ['incoming', 'evidence_for', 'tn_incoming', 'tn_seed'],
        ['outgoing', 'depends_on', 'tn_seed', 'tn_target'],
      ]);

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });
      expect(result.premises).toEqual([
        expect.objectContaining({memoryId: 'tn_seed', requestedOrdinal: 0, state: 'current'}),
      ]);
      expect(result.candidates.map(candidate => candidate.memoryId)).toEqual(['tn_incoming', 'tn_target']);
      expect(result.connections.map(connection => [connection.direction, connection.relationType])).toEqual([
        ['incoming', 'evidence_for'],
        ['outgoing', 'depends_on'],
      ]);
      expect(result.diagnostics).toMatchObject({canonicalRereads: 7, rawLinkRows: 2});
      expect(result.candidates.map(candidate => candidate.memoryId)).not.toContain('tn_second_hop');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('counts every bounded selector reread across the repair pass', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-connection-diagnostics-'});
      const config = runtimeConfig(home, 'diagnostic-user');
      yield* writeMemory(fs, path, config, 'target-a', 'tn_diagnostic_target_a');
      yield* writeMemory(fs, path, config, 'target-b', 'tn_diagnostic_target_b');
      yield* writeMemory(fs, path, config, 'seed', 'tn_diagnostic_seed', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_a'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_b'},
      ]);
      yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        forceRefresh: true,
        includeInactive: true,
        memorySeeds: [{memoryId: 'tn_diagnostic_seed', requestedOrdinal: 0}],
      });
      yield* writeMemory(fs, path, config, 'seed', 'tn_diagnostic_seed', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_b'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_diagnostic_target_a'},
      ]);

      let canonicalMismatches = 0;
      let canonicalRereads = 0;
      let rawLinkRows = 0;
      let refreshRepairs = 0;
      const selected = yield* loadRecallMemoryLinks(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        includeInactive: true,
        limit: 1,
        memorySeeds: [{memoryId: 'tn_diagnostic_seed', requestedOrdinal: 0}],
        onCanonicalMismatch: count => {
          canonicalMismatches += count;
        },
        onCanonicalReread: count => {
          canonicalRereads += count;
        },
        onRawRows: count => {
          rawLinkRows += count;
        },
        onRefreshRepair: () => {
          refreshRepairs += 1;
        },
      });

      expect(selected).toHaveLength(1);
      expect(canonicalMismatches).toBe(2);
      expect(canonicalRereads).toBe(4);
      expect(rawLinkRows).toBe(4);
      expect(refreshRepairs).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('labels explicit supersession before freshness and hides unauthorized targets', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-currentness-'});
      const config = runtimeConfig(home, 'scope-user');
      const seed = yield* writeMemory(fs, path, config, 'seed', 'tn_old', [
        {type: 'references', uri: 'threadnote://memory/tn_foreign'},
      ]);
      yield* writeMemory(fs, path, config, 'new', 'tn_new', [], {supersedes: 'threadnote://memory/tn_old'});
      yield* writeMemory(fs, path, runtimeConfig(home, 'foreign-user'), 'foreign', 'tn_foreign');

      const result = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
      });
      expect(result.premises[0]?.state).toBe('historical');
      expect(result.candidates.map(candidate => candidate.memoryId)).toEqual(['tn_new']);
      expect(JSON.stringify(result)).not.toContain('tn_foreign');
      expect(result.connections).toEqual([
        expect.objectContaining({
          currentness: 'current',
          direction: 'incoming',
          relationType: 'supersedes',
          resolution: 'resolved',
        }),
      ]);
      const filtered = yield* retrieveRecallMemoryConnections(config, {
        allowedUriScopes: [memoryRoot(config.user)],
        memoryRefs: [seed],
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        relationTypes: ['references'],
      });
      expect(filtered.premises[0]?.state).toBe('historical');
      expect(filtered.candidates).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not traverse random or out-of-scope identity aliases', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-unresolved-premise-'});
      const config = runtimeConfig(home, 'premise-user');
      yield* writeMemory(fs, path, config, 'random-incoming', 'tn_random_incoming', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing_premise'},
      ]);
      yield* writeMemory(fs, path, config, 'foreign-incoming', 'tn_foreign_incoming', [
        {type: 'depends_on', uri: 'threadnote://memory/tn_foreign_premise'},
      ]);
      yield* writeMemory(fs, path, runtimeConfig(home, 'foreign-user'), 'foreign-premise', 'tn_foreign_premise');

      for (const memoryRef of ['threadnote://memory/tn_missing_premise', 'threadnote://memory/tn_foreign_premise']) {
        const result = yield* retrieveRecallMemoryConnections(config, {
          allowedUriScopes: [memoryRoot(config.user)],
          memoryRefs: [memoryRef],
          readRecords: uris => readMemoryRecordsByUri(config, uris),
        });
        expect(result.premises).toEqual([expect.objectContaining({requestedRef: memoryRef, state: 'unresolved'})]);
        expect(result.connections).toEqual([]);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics.rawLinkRows).toBe(0);
        expect(result.diagnostics.canonicalRereads).toBe(0);
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps preferred scopes soft for explicit cross-project premises', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-preferred-scope-'});
      const config = runtimeConfig(home, 'preferred-scope-user');
      const target = yield* writeMemory(fs, path, config, 'target', 'tn_cross_project_target', [], {
        project: 'project-b',
      });
      const seed = yield* writeMemory(
        fs,
        path,
        config,
        'seed',
        'tn_cross_project_seed',
        [{type: 'depends_on', uri: 'threadnote://memory/tn_cross_project_target'}],
        {project: 'project-b'},
      );

      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: false,
        exactMatches: [],
        feedbackQuery: 'explicit cross project premise',
        includeInactive: false,
        limit: 5,
        memoryRefs: [seed],
        passes: [],
        preferredUriScopes: [`${memoryRoot(config.user)}/durable/projects/project-a`],
        query: 'explicit cross project premise',
        readRecords: uris => readMemoryRecordsByUri(config, uris),
        semanticResult: Option.none(),
      });

      expect(prepared.memoryConnections?.premises).toEqual([
        expect.objectContaining({memoryId: 'tn_cross_project_seed', state: 'current'}),
      ]);
      expect(prepared.memoryConnections?.candidates.map(candidate => candidate.uri)).toEqual([target]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function candidate(uri: string, text: string, overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    fields: {project: 'threadnote', topic: uri.split('/').at(-1)},
    kind: 'durable',
    status: 'active',
    text,
    timestamp: '2026-08-31T00:00:00.000Z',
    trust: 'approved',
    uri,
    ...overrides,
  };
}

function runtimeConfig(home: string, user: string) {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'codex',
    manifestPath: `${home}/manifest.json`,
    user,
  } as const;
}

function memoryRoot(user: string): string {
  return `threadnote://user/${user}/memories`;
}

function writeMemory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: ReturnType<typeof runtimeConfig>,
  topic: string,
  memoryId: string,
  relations: readonly MemoryRelation[] = [],
  overrides: Partial<MemoryMetadata> = {},
) {
  return Effect.gen(function* () {
    const project = overrides.project ?? 'threadnote';
    const filePath = path.join(
      config.agentContextHome,
      'data',
      config.account,
      'user',
      config.user,
      'memories',
      'durable',
      'projects',
      project,
      `${topic}.md`,
    );
    const uri = `${memoryRoot(config.user)}/durable/projects/${project}/${topic}.md`;
    yield* fs.makeDirectory(path.dirname(filePath), {recursive: true});
    yield* fs.writeFileString(
      filePath,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId,
          project,
          relations,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic,
          ...overrides,
        },
        `Body for ${topic}.`,
      ),
    );
    return uri;
  });
}
