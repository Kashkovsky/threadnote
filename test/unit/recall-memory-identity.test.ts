import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {memoryIdentityAlias} from '../../src/memory/identity_alias.js';
import {loadRecallIndex, recallIndexDatabaseFilename} from '../../src/recall/index.js';
import {resolveMemoryIdentityAliases} from '../../src/recall/memory_identity.js';
import type {RuntimeConfig} from '../../src/types.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('stable memory identity resolution', () => {
  effectIt.effect('resolves only one active identity inside an explicit authorized scope', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-identity-'});
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'me',
      };
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const root = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'threadnote');
      yield* fs.makeDirectory(root, {recursive: true});
      yield* fs.writeFileString(
        path.join(root, 'active.md'),
        memory('tn_active_identity', 'active', 'Active evidence.'),
      );
      yield* fs.writeFileString(
        path.join(root, 'inactive.md'),
        memory('tn_inactive_identity', 'archived', 'Inactive evidence.'),
      );
      yield* fs.writeFileString(
        path.join(root, 'conflict-a.md'),
        memory('tn_conflicted_identity', 'active', 'First evidence.'),
      );
      yield* fs.writeFileString(
        path.join(root, 'conflict-b.md'),
        memory('tn_conflicted_identity', 'active', 'Divergent evidence.'),
      );
      yield* loadRecallIndex(config, {forceRefresh: true, includeInactive: false});
      const queryPlan = yield* Effect.sync(() => {
        const database = new Database(path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)));
        try {
          return database
            .query<{readonly detail: string}, []>(
              `
              EXPLAIN QUERY PLAN
              SELECT d.id, d.uri, d.candidate_json
              FROM documents AS d
              WHERE d.uri >= 'threadnote://user/me/memories/'
                AND d.uri < 'threadnote://user/me/memories0'
                AND json_extract(d.candidate_json, '$.memoryId') IN ('tn_active_identity')
              ORDER BY d.uri
            `,
            )
            .all()
            .map(row => row.detail)
            .join('\n');
        } finally {
          database.close();
        }
      });
      expect(queryPlan).toContain('documents_memory_identity');

      const authorizedRoot = 'threadnote://user/me/memories';
      const [resolved] = yield* resolveMemoryIdentityAliases(
        config,
        [memoryIdentityAlias('tn_active_identity')],
        [authorizedRoot],
      );
      expect(resolved).toMatchObject({
        canonicalUri: 'threadnote://user/me/memories/durable/projects/threadnote/active.md',
        expectedMemoryId: 'tn_active_identity',
        requestedUri: memoryIdentityAlias('tn_active_identity'),
      });

      const inactive = yield* Effect.flip(
        resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_inactive_identity')], [authorizedRoot]),
      );
      expect(inactive).toMatchObject({reason: 'not-found'});

      const outsideScope = yield* Effect.flip(
        resolveMemoryIdentityAliases(
          config,
          [memoryIdentityAlias('tn_active_identity')],
          ['threadnote://user/me/memories/shared/other-team'],
        ),
      );
      expect(outsideScope).toMatchObject({reason: 'not-found'});

      const conflicted = yield* Effect.flip(
        resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_conflicted_identity')], [authorizedRoot]),
      );
      expect(conflicted).toMatchObject({reason: 'ambiguous'});

      const unscoped = yield* Effect.flip(
        resolveMemoryIdentityAliases(config, [memoryIdentityAlias('tn_active_identity')], []),
      );
      expect(unscoped).toMatchObject({reason: 'scope-required'});
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function memory(memoryId: string, status: 'active' | 'archived', body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    `status: ${status}`,
    'project: threadnote',
    `topic: ${memoryId}`,
    `memory_id: ${memoryId}`,
    'source_agent_client: test',
    'timestamp: 2026-08-31T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}
