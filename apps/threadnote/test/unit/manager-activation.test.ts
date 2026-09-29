import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {handleManagerActivationRequest} from '@threadnote/threadnote/manager/activation';
import {createActivationPlanV1} from '@threadnote/threadnote/activation/index';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/tmp/threadnote-manager-activation-test',
  agentId: 'threadnote',
  manifestPath: '/tmp/threadnote-manager-activation-test/seed-manifest.yaml',
  user: 'tester',
};

const request = {
  adrPaths: [],
  decision: {
    constraints: [],
    decision: 'Use a reviewed proposal.',
    invalidated: [],
    rationale: 'Keep the change reviewable.',
    unresolvedRisks: [],
    verification: ['Run focused checks.'],
  },
  primarySurfaceId: 'codex',
  project: 'threadnote',
  publicationMode: 'proposal' as const,
  repositoryRoot: '/private/threadnote',
  secondarySurfaceId: 'cursor',
  task: 'Prepare two managed surfaces.',
  team: {name: 'local-team', push: false, remotePath: '/private/team.git', setDefault: false},
  topic: 'manager-home',
  type: 'threadnote-activation-request' as const,
  version: 1 as const,
};

const plan = createActivationPlanV1({
  catalogSnapshotHash: 'a'.repeat(64),
  primarySurfaceId: 'codex',
  publicationMode: 'proposal',
  repositoryIdentityHash: 'b'.repeat(64),
  secondarySurfaceId: 'cursor',
  selectedSourceSetHash: 'c'.repeat(64),
  taskHash: 'd'.repeat(64),
  teamId: 'local-team',
  teamShareStateHash: 'e'.repeat(64),
  threadnoteVersion: 'test',
});

describe('Manager activation bridge', () => {
  effectIt.effect('validates a browser draft without creating activation state', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerActivationRequest({
        body: Effect.succeed({request}),
        config,
        method: 'POST',
        observe: () => Effect.succeed({plan}),
        url: new URL('http://manager.test/api/activation/preview'),
      });
      expect(response).toMatchObject({
        body: {
          steps: expect.arrayContaining(['Create a reviewed local proposal and stop before any push.']),
          writer: expect.stringContaining('does not create project setup state'),
        },
        status: 200,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects malformed browser drafts before they reach activation services', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerActivationRequest({
        body: Effect.succeed({request: {...request, secondarySurfaceId: 'codex'}}),
        config,
        method: 'POST',
        url: new URL('http://manager.test/api/activation/preview'),
      });
      expect(response).toEqual({
        body: {code: 'invalid-request', error: 'The activation request is invalid or unsupported.'},
        status: 400,
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
