import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {
  compileContextBriefWith,
  retrieveContextBriefMemoryEvidence,
  type ContextBriefGraphEvidenceV1,
} from '../../src/context_brief/index.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const COMMIT = 'a'.repeat(40);
const REPOSITORY_ID = 'b'.repeat(64);

describe('Context Brief schema-v1 memory compatibility', () => {
  effectIt.effect('keeps LF, CRLF, and CR v1 memory bodies nonempty in the projected brief', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-v1-'});
      const memoryRoot = path.join(
        home,
        'data',
        'local',
        'user',
        'legacy-user',
        'memories',
        'durable',
        'projects',
        'threadnote',
      );
      yield* fs.makeDirectory(memoryRoot, {recursive: true});
      yield* fs.writeFileString(
        path.join(memoryRoot, 'without-commit.md'),
        legacyMemory(
          'without-commit',
          'Legacy compatibility sentinel without commit remains recallable after the schema-v4 upgrade.',
        ),
      );
      yield* fs.writeFileString(
        path.join(memoryRoot, 'matching-commit.md'),
        legacyMemory(
          'matching-commit',
          'Legacy compatibility sentinel with matching commit remains recallable after the schema-v4 upgrade.',
          COMMIT,
        ),
      );
      yield* fs.writeFileString(
        path.join(memoryRoot, 'crlf.md'),
        withLineEnding(
          legacyMemory(
            'crlf',
            'Legacy compatibility sentinel with CRLF remains recallable after the schema-v4 upgrade.',
            COMMIT,
          ),
          '\r\n',
        ),
      );
      yield* fs.writeFileString(
        path.join(memoryRoot, 'cr.md'),
        withLineEnding(
          legacyMemory(
            'cr',
            'Legacy compatibility sentinel with CR remains recallable after the schema-v4 upgrade.',
            COMMIT,
          ),
          '\r',
        ),
      );
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'test-agent',
        manifestPath: path.join(home, 'manifest.yaml'),
        user: 'legacy-user',
      };

      const result = yield* compileContextBriefWith(
        {
          graphEvidence: () => Effect.succeed(graphEvidence()),
          memoryEvidence: plan => retrieveContextBriefMemoryEvidence(config, plan),
        },
        {
          budgetTokens: 1_500,
          mode: 'brief',
          scope: {callerCwd: home, kind: 'repository', project: 'threadnote'},
          task: 'Recall the legacy compatibility sentinel after the schema-v4 upgrade.',
        },
      );

      const byTopic = new Map(result.structuredContent.durableDecisions.map(memory => [memory.topic, memory]));
      expect(byTopic.get('without-commit')).toMatchObject({freshness: 'unknown'});
      expect(byTopic.get('matching-commit')).toMatchObject({freshness: 'fresh'});
      expect(byTopic.get('crlf')).toMatchObject({freshness: 'fresh'});
      expect(byTopic.get('cr')).toMatchObject({freshness: 'fresh'});
      for (const topic of ['without-commit', 'matching-commit', 'crlf', 'cr']) {
        expect(byTopic.get(topic)?.excerpt).toContain('Legacy compatibility sentinel');
      }
      expect([...byTopic.keys()]).toEqual(expect.arrayContaining(['without-commit', 'matching-commit', 'crlf', 'cr']));
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function legacyMemory(topic: string, body: string, sourceCommit?: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    `topic: ${topic}`,
    'source_agent_client: codex',
    'timestamp: 2025-01-01T00:00:00.000Z',
    'schema_version: 1',
    ...(sourceCommit === undefined ? [] : [`source_commit: ${sourceCommit}`]),
    '',
    body,
  ].join('\n');
}

function withLineEnding(content: string, lineEnding: '\r\n' | '\r'): string {
  return content.replaceAll('\n', lineEnding);
}

function graphEvidence(): ContextBriefGraphEvidenceV1 {
  return {
    cards: [],
    contracts: [],
    coverage: {
      complete: true,
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {current: 1},
    },
    gaps: [],
    resolvedSnapshots: [
      {
        commit: COMMIT,
        dirty: false,
        freshness: 'fresh',
        repositoryId: REPOSITORY_ID,
        repositoryKey: 'threadnote',
        snapshotId: `cgsn_${'c'.repeat(40)}`,
      },
    ],
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}
