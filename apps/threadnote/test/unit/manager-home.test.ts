import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {handleManagerHomeRequest, managerRecentOutcomeCount} from '@threadnote/threadnote/manager/home';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-manager-home-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-manager-home-test/seed-manifest.yaml',
  user: 'tester',
};

describe('Manager home API', () => {
  effectIt.effect('counts edited approvals once in recent outcomes', () =>
    Effect.sync(() => {
      expect(
        managerRecentOutcomeCount({
          feedback: {applied: 2, useful: 3},
          knowledgeDelta: {approved: 4},
        }),
      ).toBe(9);
    }),
  );

  effectIt.effect('rejects an invalid project before reading local state', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerHomeRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/home?project=../outside'),
      });
      expect(response).toEqual({
        body: {
          code: 'invalid-project',
          error: 'Select a project with letters, numbers, dots, underscores, or hyphens.',
        },
        status: 400,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
