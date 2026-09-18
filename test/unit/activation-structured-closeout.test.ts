import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import {findOrCreateActivationDecisionReviewV1} from '../../src/activation/production_evidence.js';
import {parseActivationProductionRequestV1} from '../../src/activation/production_contract.js';
import {observeActivationProductionV1} from '../../src/activation/production_observe.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {projectKnowledgeDeltaV1} from '../../src/memory/knowledge_delta.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('activation structured closeout', () => {
  it('keeps the documented request fixture strict and copyable', async () => {
    const fixture = (await Bun.file(
      new URL('../../docs/examples/threadnote-activation-request.json', import.meta.url),
    ).json()) as unknown;
    expect(parseActivationProductionRequestV1(fixture)).toMatchObject({
      primarySurfaceId: 'codex-cli',
      secondarySurfaceId: 'claude-code',
      type: 'threadnote-activation-request',
      version: 1,
    });
  });

  effectIt.effect('preserves every closeout field through the durable review and Knowledge Delta', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const command = yield* CommandExecutor;
        const repository = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-closeout-repo-'});
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-activation-closeout-home-'});
        yield* command.execute('git', ['init', '--quiet'], {
          cwd: repository,
          maxOutputBytes: 4_096,
          timeoutMs: 5_000,
        });
        const request = parseActivationProductionRequestV1({
          adrPaths: [],
          decision: {
            constraints: ['Stay offline.'],
            decision: 'Use the reviewed activation path.',
            invalidated: ['The unreviewed path.'],
            rationale: 'It preserves reviewable evidence.',
            unresolvedRisks: ['A host restart may still be required.'],
            verification: ['Focused activation tests passed.'],
          },
          primarySurfaceId: 'codex-cli',
          project: 'threadnote',
          publicationMode: 'direct',
          repositoryRoot: repository,
          secondarySurfaceId: 'claude-code',
          task: 'Review activation closeout fields.',
          team: {name: 'default', push: false, remotePath: repository, setDefault: true},
          topic: 'activation-closeout',
          type: 'threadnote-activation-request',
          version: 1,
        });
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'test-user',
        };
        const observation = yield* observeActivationProductionV1(config, request);
        const review = yield* findOrCreateActivationDecisionReviewV1(config, observation);
        const expected = {
          constraints: request.decision.constraints,
          knowledgeInvalidated: request.decision.invalidated,
          rationale: request.decision.rationale,
          type: 'structured-closeout',
          unresolvedRisks: request.decision.unresolvedRisks,
          verificationPerformed: request.decision.verification,
          version: 1,
        } as const;
        expect(review.structuredCloseout).toEqual(expected);
        expect(projectKnowledgeDeltaV1(review).structuredCloseout).toEqual(expected);
        expect(review.candidates[0]?.proposedText).toContain('# Decision\nUse the reviewed activation path.');
        expect(review.candidates[0]?.proposedText).toContain('## Knowledge invalidated\n- The unreviewed path.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
