import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import {describe, expect} from 'vitest';
import {handleManagerAttentionRequest, managerAttentionProjectRoot} from '@threadnote/threadnote/manager/attention';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Manager attention API', () => {
  effectIt.effect('returns a project-scoped empty review inbox from local state', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-attention-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/seed-manifest.yaml`,
        user: 'tester',
      };
      const response = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=threadnote'),
      });
      expect(response).toEqual({
        body: {items: [], pendingCount: 0, project: 'threadnote', version: 1},
        status: 200,
      });
    }).pipe(Effect.scoped, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects traversal-like project names before reading local state', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerAttentionRequest({
        config: {
          account: 'local',
          agentContextHome: '/unread',
          agentId: 'threadnote',
          manifestPath: '/unread/seed-manifest.yaml',
          user: 'tester',
        },
        method: 'GET',
        url: new URL('http://manager.test/api/context-health?project=../outside'),
      });
      expect(response).toEqual({
        body: {code: 'invalid-project', error: 'Select a valid project to inspect its attention queue.'},
        status: 400,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('marks repository evidence unavailable for memory-only and unresolved projects', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-attention-root-'});
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: `${home}/seed-manifest.yaml`,
        user: 'tester',
      };
      yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      const memoryOnly = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/context-health?project=threadnote'),
      });
      expect(memoryOnly?.status).toBe(200);
      expect(memoryOnly?.body).toMatchObject({
        project: 'threadnote',
        repositoryEvidence: {reason: 'project-not-configured', state: 'unavailable'},
        semanticCompleteness: {eligibleRecords: 0, state: 'complete', unknownRecords: 0},
        status: 'unknown',
      });

      yield* fs.writeFileString(
        config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(`${home}/missing`)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      expect(yield* managerAttentionProjectRoot(config, 'threadnote')).toEqual({
        reason: 'repository-unavailable',
        state: 'unavailable',
      });

      yield* fs.writeFileString(config.manifestPath, 'projects: [unterminated\n');
      expect(yield* managerAttentionProjectRoot(config, 'threadnote')).toEqual({
        reason: 'manifest-unavailable',
        state: 'unavailable',
      });
    }).pipe(Effect.scoped, provideTestLayer(ApplicationLayer)),
  );
});
