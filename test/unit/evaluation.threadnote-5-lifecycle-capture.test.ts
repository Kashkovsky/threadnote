import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  ActivationOperationExecutionError,
  bindActivationApprovalV1,
  completeSecondSurfaceProofChallengeV1,
  continueActivationV1,
  createActivationPlanV1,
  createActivationReceiptV1,
  issueSecondSurfaceProofChallengeV1,
  recordActivationOutcomeV1,
} from '../../src/activation/index.js';
import {completeSecondSurfaceProofV1} from '../../src/activation/second_surface.js';
import {
  compileActivationContextBrief,
  compileContextBrief,
  compileContextBriefForValidation,
  compileSetupSourceVerificationBrief,
} from '../../src/context_brief/index.js';
import {SystemInfo} from '../../src/effect/system.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  captureThreadnote5ActivationChallengeV1,
  captureThreadnote5ActivationTransitionV1,
  activationTransitionIdentityV1,
} from '../../src/evaluation/threadnote-5-lifecycle-capture.js';
import {
  createThreadnote5ProductCaptureV1,
  parseThreadnote5ProductCaptureV1,
  productCaptureIdentityDigest,
} from '../../src/evaluation/threadnote-5-product-capture.js';
import {
  captureThreadnote5ProductEventV1,
  captureConfiguredThreadnote5ProductEventV1,
  PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE,
} from '../../src/evaluation/threadnote-5-product-capture-sink.js';
import {recordRecallFeedback} from '../../src/recall/feedback.js';
import type {RuntimeConfig} from '../../src/types.js';
import {buildLocalValueReport} from '../../src/value_report/commands.js';
import {recordActivationValueEvent} from '../../src/value_report/events.js';
import {aggregateValueReportV1} from '../../src/value_report/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {fcEffectProp} from '../helpers/fast-check-property.js';

const digest = (character: string) => character.repeat(64);
const commit = 'a'.repeat(40);
const candidate = {
  commit,
  executableSha256: digest('b'),
  id: 'threadnote-5.0.0',
  version: `5.0.0-local.g${commit}`,
} as const;
const planInput = {
  catalogSnapshotHash: digest('a'),
  primarySurfaceId: 'codex-cli',
  publicationMode: 'proposal' as const,
  repositoryIdentityHash: digest('b'),
  secondarySurfaceId: 'claude-code',
  selectedSourceSetHash: digest('c'),
  taskHash: digest('d'),
  teamId: 'default',
  teamShareStateHash: digest('e'),
  threadnoteVersion: candidate.version,
};

describe('Threadnote 5 lifecycle product capture', () => {
  effectIt.effect('is lazy when disabled or when the configured scenario excludes the source', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-gating-'});
        yield* fs.chmod(root, 0o700);
        const canonicalRoot = yield* fs.realPath(root);
        let evaluated = 0;
        const event = () => {
          evaluated += 1;
          return {
            event: 'plan',
            payload: createActivationPlanV1(planInput),
            sequence: 0,
            source: 'activation',
          } as const;
        };
        const disabledSystem = SystemInfo.of({
          ...system,
          environment: () => {
            const environment = {...system.environment()};
            delete environment[PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE];
            return environment;
          },
        });
        expect(
          yield* captureConfiguredThreadnote5ProductEventV1('activation', event).pipe(
            Effect.provideService(SystemInfo, disabledSystem),
          ),
        ).toBeUndefined();
        const unsupportedIdentity = {
          attempt: 0,
          candidate,
          scenario: 'output-budgets',
          trial: 0,
          version: 1,
        } as const;
        const unsupportedSystem = SystemInfo.of({
          ...system,
          environment: () => ({
            ...system.environment(),
            [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: JSON.stringify({
              ...unsupportedIdentity,
              root: canonicalRoot,
            }),
          }),
        });
        expect(
          yield* captureConfiguredThreadnote5ProductEventV1('activation', event).pipe(
            Effect.provideService(SystemInfo, unsupportedSystem),
          ),
        ).toBeUndefined();
        expect(evaluated).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains the complete activation receipt, approval, publication, and resume history', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-home-'});
        const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-output-'});
        yield* fs.chmod(captureRoot, 0o700);
        const identity = {attempt: 0, candidate, scenario: 'solo', trial: 0, version: 1} as const;
        const configuration = JSON.stringify({...identity, root: yield* fs.realPath(captureRoot)});
        const captureSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: configuration}),
        });
        const plan = createActivationPlanV1(planInput);
        let tick = 0;
        const clock = () => new Date(Date.parse('2026-09-19T08:00:00.000Z') + tick++ * 1_000).toISOString();
        const executor = {
          execute: ({operationId}: {readonly operationId: string}) => {
            const operation = plan.operations.find(candidate => candidate.id === operationId)!;
            const operationIndex = plan.operations.findIndex(candidate => candidate.id === operationId);
            return Effect.succeed({
              ownership: 'preexisting' as const,
              status: operation.expectedOutcome,
              subsystemReceiptHash: digest(String(operationIndex % 10)),
              undoEligible: false,
            });
          },
        };
        const config = {agentContextHome: home};
        const first = yield* continueActivationV1(config, {apply: true, now: clock, plan}, executor).pipe(
          Effect.provideService(SystemInfo, captureSystem),
        );
        expect(first.status).toBe('awaiting-approval');
        const imports = yield* continueActivationV1(
          config,
          {apply: true, approval: {operationId: 'imports-review', reviewRevisionHash: digest('1')}, now: clock, plan},
          executor,
        ).pipe(Effect.provideService(SystemInfo, captureSystem));
        expect(imports.status).toBe('awaiting-approval');
        const decision = yield* continueActivationV1(
          config,
          {apply: true, approval: {operationId: 'decision-apply', reviewRevisionHash: digest('2')}, now: clock, plan},
          executor,
        ).pipe(Effect.provideService(SystemInfo, captureSystem));
        expect(decision.status).toBe('awaiting-approval');
        const completed = yield* continueActivationV1(
          config,
          {
            apply: true,
            approval: {operationId: 'decision-propose', reviewRevisionHash: digest('3')},
            now: clock,
            plan,
          },
          executor,
        ).pipe(Effect.provideService(SystemInfo, captureSystem));
        expect(completed.status).toBe('completed');

        const captures = yield* readCaptures(fs, path, captureRoot, identity);
        const activation = captures.filter(capture => capture.source === 'activation');
        expect(activation.filter(capture => capture.event === 'plan')).toHaveLength(1);
        expect(
          activation
            .filter(capture => capture.event === 'receipt')
            .map(capture => (capture.payload as {readonly generation: number}).generation),
        ).toEqual(Array.from({length: 11}, (_, index) => index));
        expect(activation.filter(capture => capture.event === 'approval')).toHaveLength(3);
        expect(activation.filter(capture => capture.event === 'resume')).toHaveLength(3);
        expect(activation.filter(capture => capture.event === 'publication')).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({mode: 'proposal', operationId: 'decision-propose'}),
          }),
        ]);
        expect(captures.filter(capture => capture.source === 'context-brief' && capture.event === 'event')).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              activationId: plan.activationId,
              activationReceiptRevision: expect.stringMatching(/^[0-9a-f]{64}$/u),
            }),
          }),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('captures failed approval retries as distinct attempted transitions', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-retry-output-'});
        yield* fs.chmod(captureRoot, 0o700);
        const canonicalCaptureRoot = yield* fs.realPath(captureRoot);
        const identity = {attempt: 0, candidate, scenario: 'solo', trial: 1, version: 1} as const;
        const captureSystem = SystemInfo.of({
          ...system,
          environment: () => ({
            ...system.environment(),
            [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: JSON.stringify({...identity, root: canonicalCaptureRoot}),
          }),
        });
        const plan = createActivationPlanV1(planInput);
        let previous = createActivationReceiptV1(plan, '2026-09-19T08:00:00.000Z');
        const approvalOperation = plan.operations.find(operation => operation.approvalKind !== undefined)!;
        for (const operation of plan.operations) {
          if (operation.id === approvalOperation.id) break;
          const transition = recordActivationOutcomeV1({
            now: '2026-09-19T08:00:01.000Z',
            operationId: operation.id,
            outcome: {
              ownership: 'preexisting',
              status: operation.expectedOutcome,
              subsystemReceiptHash: digest(String(previous.generation % 10)),
              undoEligible: false,
            },
            plan,
            receipt: previous,
          });
          if (transition.status !== 'updated') throw new Error('Fixture did not reach approval boundary.');
          previous = transition.receipt;
        }
        const failedApproval = bindActivationApprovalV1(plan, previous, approvalOperation.id, digest('1'));
        const failed = recordActivationOutcomeV1({
          approval: failedApproval,
          now: '2026-09-19T08:00:02.000Z',
          operationId: approvalOperation.id,
          outcome: {failureCode: 'operation-failed', status: 'failed'},
          plan,
          receipt: previous,
        });
        if (failed.status !== 'updated') throw new Error('Fixture did not record the failed approval attempt.');
        const retryApproval = bindActivationApprovalV1(plan, failed.receipt, approvalOperation.id, digest('2'));
        const retried = recordActivationOutcomeV1({
          approval: retryApproval,
          now: '2026-09-19T08:00:03.000Z',
          operationId: approvalOperation.id,
          outcome: {
            ownership: 'preexisting',
            status: approvalOperation.expectedOutcome,
            subsystemReceiptHash: digest('3'),
            undoEligible: false,
          },
          plan,
          receipt: failed.receipt,
        });
        if (retried.status !== 'updated') throw new Error('Fixture did not record the approved retry.');

        yield* captureThreadnote5ActivationTransitionV1({
          approval: failedApproval,
          plan,
          previous,
          receipt: failed.receipt,
          resumed: false,
        }).pipe(Effect.provideService(SystemInfo, captureSystem));
        yield* captureThreadnote5ActivationTransitionV1({
          approval: retryApproval,
          plan,
          previous: failed.receipt,
          receipt: retried.receipt,
          resumed: false,
        }).pipe(Effect.provideService(SystemInfo, captureSystem));

        const captures = yield* readCaptures(fs, path, canonicalCaptureRoot, identity);
        expect(captures.map(capture => [capture.event, capture.sequence])).toEqual([
          ['receipt', 1],
          ['receipt', 1],
          ['approval', 2],
          ['approval', 2],
        ]);
        expect(
          captures
            .filter(capture => capture.event === 'receipt')
            .map(
              capture =>
                (capture.payload as {operations: readonly {attempt: number; id: string}[]}).operations.find(
                  operation => operation.id === approvalOperation.id,
                )?.attempt,
            ),
        ).toEqual([1, 2]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'replays both second-surface challenge states after interruption before activation receipt persistence',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-challenge-home-'});
          const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-challenge-output-'});
          yield* fs.chmod(captureRoot, 0o700);
          const canonicalCaptureRoot = yield* fs.realPath(captureRoot);
          const identity = {attempt: 0, candidate, scenario: 'solo', trial: 2, version: 1} as const;
          const captureSystem = SystemInfo.of({
            ...system,
            environment: () => ({
              ...system.environment(),
              [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: JSON.stringify({...identity, root: canonicalCaptureRoot}),
            }),
          });
          const context = secondSurfaceContext();
          const challenge = yield* issueSecondSurfaceProofChallengeV1({agentContextHome: home}, context);
          yield* captureThreadnote5ActivationChallengeV1(challenge).pipe(
            Effect.provideService(SystemInfo, captureSystem),
          );
          yield* captureThreadnote5ActivationChallengeV1(challenge).pipe(
            Effect.provideService(SystemInfo, captureSystem),
          );
          const proof = completeSecondSurfaceProofV1(
            context,
            secondSurfaceObservations(context).recall,
            secondSurfaceObservations(context).read,
          );
          if (proof.status !== 'verified') throw new Error(`Fixture proof was rejected: ${proof.code}`);
          yield* completeSecondSurfaceProofChallengeV1(
            {agentContextHome: home},
            {
              challengeId: challenge.challengeId,
              proof: proof.receipt,
              runtimeFingerprint: context.secondary.mcpServerFingerprint,
              surfaceId: context.secondary.surfaceId,
            },
          );
          const completed = yield* issueSecondSurfaceProofChallengeV1({agentContextHome: home}, context);
          yield* captureThreadnote5ActivationChallengeV1(completed).pipe(
            Effect.provideService(SystemInfo, captureSystem),
          );
          // The proof challenge is already durable while its successful activation receipt is not yet persisted.
          yield* captureThreadnote5ActivationChallengeV1(completed).pipe(
            Effect.provideService(SystemInfo, captureSystem),
          );

          const captures = yield* readCaptures(fs, path, canonicalCaptureRoot, identity);
          expect(captures.map(capture => [capture.event, capture.sequence])).toEqual([
            ['challenge', 160],
            ['challenge', 161],
          ]);
          const [issued, completedCapture] = captures;
          if (issued === undefined || completedCapture === undefined)
            throw new Error('Challenge capture fixture is incomplete.');
          expect((issued.payload as {receipt?: unknown}).receipt).toBeUndefined();
          expect((completedCapture.payload as {receipt?: unknown}).receipt).toBeDefined();
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects different or malformed occupied second-surface challenge artifacts in both sequences', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-challenge-conflict-home-'});
        const otherHome = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-challenge-other-home-'});
        const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-challenge-conflict-output-'});
        yield* fs.chmod(captureRoot, 0o700);
        const canonicalCaptureRoot = yield* fs.realPath(captureRoot);
        const identity = {attempt: 0, candidate, scenario: 'solo', trial: 3, version: 1} as const;
        const configuration = JSON.stringify({...identity, root: canonicalCaptureRoot});
        const captureSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: configuration}),
        });
        const context = secondSurfaceContext();
        const differentContext = {...context, activationId: digest('f')};
        const challenge = yield* issueSecondSurfaceProofChallengeV1({agentContextHome: home}, context);
        const differentChallenge = yield* issueSecondSurfaceProofChallengeV1(
          {agentContextHome: otherHome},
          differentContext,
        );
        const occupied = yield* captureThreadnote5ProductEventV1(configuration, () => ({
          event: 'challenge',
          payload: differentChallenge,
          sequence: 160,
          source: 'activation',
        }));
        if (occupied === undefined) throw new Error('Fixture did not occupy the challenge artifact.');
        const differentContent = yield* fs.readFileString(occupied);
        expect(
          (yield* captureThreadnote5ActivationChallengeV1(challenge).pipe(
            Effect.provideService(SystemInfo, captureSystem),
            Effect.result,
          ))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(occupied)).toBe(differentContent);
        yield* fs.writeFileString(occupied, 'malformed');
        expect(
          (yield* captureThreadnote5ActivationChallengeV1(challenge).pipe(
            Effect.provideService(SystemInfo, captureSystem),
            Effect.result,
          ))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(occupied)).toBe('malformed');

        const observations = secondSurfaceObservations(context);
        const proof = completeSecondSurfaceProofV1(context, observations.recall, observations.read);
        if (proof.status !== 'verified') throw new Error(`Fixture proof was rejected: ${proof.code}`);
        yield* completeSecondSurfaceProofChallengeV1(
          {agentContextHome: home},
          {
            challengeId: challenge.challengeId,
            proof: proof.receipt,
            runtimeFingerprint: context.secondary.mcpServerFingerprint,
            surfaceId: context.secondary.surfaceId,
          },
        );
        const completed = yield* issueSecondSurfaceProofChallengeV1({agentContextHome: home}, context);
        const otherObservations = secondSurfaceObservations(differentContext);
        const otherProof = completeSecondSurfaceProofV1(
          differentContext,
          otherObservations.recall,
          otherObservations.read,
        );
        if (otherProof.status !== 'verified') throw new Error(`Fixture proof was rejected: ${otherProof.code}`);
        yield* completeSecondSurfaceProofChallengeV1(
          {agentContextHome: otherHome},
          {
            challengeId: differentChallenge.challengeId,
            proof: otherProof.receipt,
            runtimeFingerprint: differentContext.secondary.mcpServerFingerprint,
            surfaceId: differentContext.secondary.surfaceId,
          },
        );
        const differentCompleted = yield* issueSecondSurfaceProofChallengeV1(
          {agentContextHome: otherHome},
          differentContext,
        );
        const occupiedCompleted = yield* captureThreadnote5ProductEventV1(configuration, () => ({
          event: 'challenge',
          payload: differentCompleted,
          sequence: 161,
          source: 'activation',
        }));
        if (occupiedCompleted === undefined)
          throw new Error('Fixture did not occupy the completed challenge artifact.');
        const differentCompletedContent = yield* fs.readFileString(occupiedCompleted);
        expect(
          (yield* captureThreadnote5ActivationChallengeV1(completed).pipe(
            Effect.provideService(SystemInfo, captureSystem),
            Effect.result,
          ))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(occupiedCompleted)).toBe(differentCompletedContent);
        yield* fs.writeFileString(occupiedCompleted, 'malformed');
        expect(
          (yield* captureThreadnote5ActivationChallengeV1(completed).pipe(
            Effect.provideService(SystemInfo, captureSystem),
            Effect.result,
          ))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(occupiedCompleted)).toBe('malformed');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('captures Context Brief only through the runtime modes that authorize it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'context-brief-capture-home-'});
        const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'context-brief-capture-output-'});
        yield* fs.chmod(captureRoot, 0o700);
        const canonicalCaptureRoot = yield* fs.realPath(captureRoot);
        const request = {
          budgetTokens: 1_250,
          mode: 'brief' as const,
          scope: {callerCwd: home, kind: 'repository' as const, project: 'threadnote'},
          task: 'Locate the lifecycle evidence contract.',
        };
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'test-agent',
          manifestPath: path.join(home, 'manifest.yaml'),
          user: 'tester',
        };
        yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
        const withCapture = (trial: number) => {
          const identity = {attempt: 1, candidate, scenario: 'solo', trial, version: 1} as const;
          return {
            identity,
            system: SystemInfo.of({
              ...system,
              environment: () => ({
                ...system.environment(),
                [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: JSON.stringify({...identity, root: canonicalCaptureRoot}),
              }),
            }),
          };
        };
        const normal = withCapture(0);
        const deferred = withCapture(1);
        const validation = withCapture(2);
        const setup = withCapture(3);
        yield* compileContextBrief(config, request).pipe(Effect.provideService(SystemInfo, normal.system));
        const plan = createActivationPlanV1(planInput);
        const executor = {
          execute: ({operationId}: {readonly operationId: string}) => {
            const operation = plan.operations.find(candidate => candidate.id === operationId);
            if (operation === undefined)
              return Effect.fail(
                ActivationOperationExecutionError.make({message: 'Fixture activation operation is unknown.'}),
              );
            return Effect.gen(function* () {
              if (operation.kind === 'brief.verify') {
                yield* compileActivationContextBrief(config, request).pipe(
                  Effect.mapError(() =>
                    ActivationOperationExecutionError.make({message: 'Fixture activation Context Brief failed.'}),
                  ),
                );
              }
              return {
                ownership: 'preexisting' as const,
                status: operation.expectedOutcome,
                subsystemReceiptHash: digest(String(plan.operations.indexOf(operation) % 10)),
                undoEligible: false,
              };
            });
          },
        };
        const initial = yield* continueActivationV1(
          config,
          {apply: true, now: () => '2026-09-19T08:00:00.000Z', plan},
          executor,
        ).pipe(Effect.provideService(SystemInfo, deferred.system));
        expect(initial.status).toBe('awaiting-approval');
        const afterImports = yield* continueActivationV1(
          config,
          {
            apply: true,
            approval: {operationId: 'imports-review', reviewRevisionHash: digest('1')},
            now: () => '2026-09-19T08:00:01.000Z',
            plan,
          },
          executor,
        ).pipe(Effect.provideService(SystemInfo, deferred.system));
        expect(afterImports.status).toBe('awaiting-approval');
        yield* compileContextBriefForValidation(config, request).pipe(
          Effect.provideService(SystemInfo, validation.system),
        );
        yield* compileSetupSourceVerificationBrief(config, request).pipe(
          Effect.provideService(SystemInfo, setup.system),
        );

        expect(yield* captureNames(fs, path, canonicalCaptureRoot, normal.identity)).toEqual([
          'context-brief-000.json',
          'context-brief-001.json',
          'context-brief-002.json',
        ]);
        expect(
          (yield* captureNames(fs, path, canonicalCaptureRoot, deferred.identity)).filter(name =>
            name.startsWith('context-brief-'),
          ),
        ).toEqual(['context-brief-000.json', 'context-brief-001.json', 'context-brief-002.json']);
        const deferredCaptures = yield* readCaptures(fs, path, canonicalCaptureRoot, deferred.identity);
        expect(
          deferredCaptures
            .filter(capture => capture.source === 'context-brief')
            .map(capture => [capture.event, capture.sequence]),
        ).toEqual([
          ['request', 0],
          ['result', 1],
          ['event', 2],
        ]);
        const completion = deferredCaptures.find(
          capture => capture.source === 'context-brief' && capture.event === 'event',
        );
        const persistedBriefReceipt = deferredCaptures.find(
          capture =>
            capture.source === 'activation' &&
            capture.event === 'receipt' &&
            (capture.payload as {readonly firstBrief?: unknown}).firstBrief !== undefined,
        );
        expect(persistedBriefReceipt).toBeDefined();
        expect(completion).toMatchObject({
          payload: {
            activationId: plan.activationId,
            activationReceiptRevision: (persistedBriefReceipt?.payload as {readonly revision?: string})?.revision,
          },
          sequence: 2,
        });
        expect(yield* captureNames(fs, path, canonicalCaptureRoot, validation.identity)).toEqual([]);
        expect(yield* captureNames(fs, path, canonicalCaptureRoot, setup.identity)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('binds recorded feedback and activation value events to the exact report input and output', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-capture-home-'});
        const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'value-capture-output-'});
        yield* fs.chmod(captureRoot, 0o700);
        const identity = {attempt: 2, candidate, scenario: 'solo', trial: 0, version: 1} as const;
        const configuration = JSON.stringify({...identity, root: yield* fs.realPath(captureRoot)});
        const captureSystem = SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: configuration}),
        });
        const withCapture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provideService(SystemInfo, captureSystem));
        const feedback = yield* withCapture(
          recordRecallFeedback(home, {
            action: 'applied',
            project: 'threadnote',
            query: 'lifecycle capture',
            timestamp: '2026-09-19T08:00:00.000Z',
            uri: 'threadnote://memory/tn_lifecycle_capture',
          }),
        );
        expect(feedback.recorded).toBe(true);
        yield* withCapture(
          recordActivationValueEvent(home, {
            durationMilliseconds: 0,
            eventId: digest('4'),
            phase: 'started',
            timestamp: '2026-09-19T08:00:01.000Z',
          }),
        );
        const report = yield* withCapture(
          buildLocalValueReport({agentContextHome: home} as RuntimeConfig, {
            from: '2026-09-19',
            project: 'threadnote',
            to: '2026-09-20',
          }),
        );
        expect(report.feedback).toMatchObject({applied: 1, total: 1});
        expect(report.setup).toMatchObject({started: 1});

        const captures = yield* readCaptures(fs, path, captureRoot, identity);
        expect(captures.map(capture => [capture.event, capture.sequence])).toEqual([
          ['feedback', 0],
          ['value-event', 16],
          ['capture', 64],
        ]);
        expect(captures[0]?.payload).toMatchObject({
          event: feedback.event,
          laneId: productCaptureIdentityDigest(identity),
        });
        expect(captures[2]?.payload).toMatchObject({report});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('round trips arbitrary bounded feedback inputs and rejects any report or input drift', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('useful', 'wrong', 'pin', 'dismiss', 'applied'), {maxLength: 12}),
        actions => {
          const input = {
            feedbackEvents: actions.map((action, index) => ({
              action,
              queryFingerprint: digest(String(index % 10)),
              rankerVersion: 'test-ranker-v1',
              timestamp: new Date(Date.parse('2026-09-19T08:00:00.000Z') + index * 1_000).toISOString(),
              uri: `threadnote://memory/tn_feedback_${index}`,
              version: 1 as const,
            })),
            period: {from: '2026-09-19T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z'},
          };
          const report = aggregateValueReportV1(input);
          const identity = {attempt: 0, candidate, scenario: 'solo', trial: 0, version: 1} as const;
          const event = {event: 'capture', payload: {input, report}, sequence: 64, source: 'value-report'} as const;
          const capture = createThreadnote5ProductCaptureV1(identity, event);
          expect(parseThreadnote5ProductCaptureV1(capture)).toEqual(capture);
          expect(() =>
            createThreadnote5ProductCaptureV1(identity, {
              ...event,
              payload: {
                input,
                report: {...report, feedback: {...report.feedback, total: report.feedback.total + 1}},
              },
            }),
          ).toThrow(/replay/u);
          expect(() =>
            createThreadnote5ProductCaptureV1(identity, {
              ...event,
              payload: {input: {...input, rawQuery: 'private'}, report},
            }),
          ).toThrow();
        },
      ),
      {numRuns: 30},
    );
  });

  it('maps the full receipt bounds to a collision-free append-only identity independent of event order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            event: fc.constantFrom('approval', 'publication', 'receipt', 'resume'),
            generation: fc.oneof(fc.constantFrom(1, 31, 32, 36, 37, 1_000, 10_000), fc.integer({min: 1, max: 10_000})),
            operationIndex: fc.integer({min: 0, max: 9}),
          }),
          {minLength: 1, maxLength: 80},
        ),
        entries => {
          const distinctEntries = Array.from(
            new Map(
              entries.map(entry => [`${entry.event}:${entry.generation}:${entry.operationIndex}`, entry]),
            ).values(),
          );
          const expected = distinctEntries
            .map(
              entry =>
                `${entry.event}-g${String(entry.generation).padStart(5, '0')}-o${String(entry.operationIndex).padStart(2, '0')}`,
            )
            .sort();
          const actual = distinctEntries
            .map(entry => activationTransitionIdentityV1(entry.event, entry.generation, entry.operationIndex))
            .sort();
          expect(new Set(actual).size).toBe(distinctEntries.length);
          expect(actual).toEqual(expected);
        },
      ),
      {numRuns: 50},
    );
  });

  fcEffectProp(
    effectIt,
    'persists and strictly replays every receipt and approval across the former sequence boundary',
    [fc.integer({min: 33, max: 40})],
    ([failures]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const captureRoot = yield* fs.makeTempDirectoryScoped({prefix: 'lifecycle-capture-boundary-output-'});
          yield* fs.chmod(captureRoot, 0o700);
          const canonicalCaptureRoot = yield* fs.realPath(captureRoot);
          const identity = {attempt: 63, candidate, scenario: 'solo', trial: 63, version: 1} as const;
          const captureSystem = SystemInfo.of({
            ...system,
            environment: () => ({
              ...system.environment(),
              [PRODUCT_CAPTURE_ENVIRONMENT_VARIABLE]: JSON.stringify({...identity, root: canonicalCaptureRoot}),
            }),
          });
          const plan = createActivationPlanV1(planInput);
          const approvalOperation = plan.operations.find(operation => operation.approvalKind !== undefined);
          if (approvalOperation === undefined) throw new Error('Fixture activation plan has no approval operation.');
          let previous = createActivationReceiptV1(plan, '2026-09-19T08:00:00.000Z');
          for (const operation of plan.operations) {
            if (operation.id === approvalOperation.id) break;
            const transition = recordActivationOutcomeV1({
              now: '2026-09-19T08:00:01.000Z',
              operationId: operation.id,
              outcome: {
                ownership: 'preexisting',
                status: operation.expectedOutcome,
                subsystemReceiptHash: digest(String(previous.generation % 10)),
                undoEligible: false,
              },
              plan,
              receipt: previous,
            });
            if (transition.status !== 'updated') throw new Error('Fixture did not reach approval boundary.');
            previous = transition.receipt;
          }
          const expected: Array<readonly [number, number, string]> = [];
          for (let attempt = 1; attempt <= failures; attempt += 1) {
            const approval = bindActivationApprovalV1(
              plan,
              previous,
              approvalOperation.id,
              digest(String(attempt % 10)),
            );
            const transition = recordActivationOutcomeV1({
              approval,
              now: `2026-09-19T08:01:${String(attempt).padStart(2, '0')}Z`,
              operationId: approvalOperation.id,
              outcome: {failureCode: 'operation-failed', status: 'failed'},
              plan,
              receipt: previous,
            });
            if (transition.status !== 'updated') throw new Error('Fixture did not record retry.');
            yield* captureThreadnote5ActivationTransitionV1({
              approval,
              plan,
              previous,
              receipt: transition.receipt,
              resumed: false,
            }).pipe(Effect.provideService(SystemInfo, captureSystem));
            expected.push([transition.receipt.generation, attempt, approval.receiptRevision]);
            previous = transition.receipt;
          }
          const captures = yield* readCaptures(fs, path, canonicalCaptureRoot, identity);
          const receipts = captures.filter(capture => capture.source === 'activation' && capture.event === 'receipt');
          const approvals = captures.filter(capture => capture.source === 'activation' && capture.event === 'approval');
          expect(receipts).toHaveLength(failures);
          expect(approvals).toHaveLength(failures);
          expect(receipts.map(capture => (capture.payload as {readonly generation: number}).generation)).toEqual(
            expected.map(([generation]) => generation),
          );
          expect(
            approvals.map(capture => (capture.payload as {readonly receiptRevision: string}).receiptRevision),
          ).toEqual(expected.map(([, , receiptRevision]) => receiptRevision));
          const names = yield* captureNames(fs, path, canonicalCaptureRoot, identity);
          const operationIndex = plan.operations.findIndex(operation => operation.id === approvalOperation.id);
          expect(names).toEqual(
            expected
              .flatMap(([generation]) => [
                `activation-001-receipt-g${String(generation).padStart(5, '0')}-o${String(operationIndex).padStart(2, '0')}.json`,
                `activation-002-approval-g${String(generation).padStart(5, '0')}-o${String(operationIndex).padStart(2, '0')}.json`,
              ])
              .sort(),
          );
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );
});

function readCaptures(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  captureRoot: string,
  identity: Parameters<typeof productCaptureIdentityDigest>[0],
) {
  return Effect.gen(function* () {
    const directory = path.join(captureRoot, productCaptureIdentityDigest(identity));
    const names = (yield* fs.readDirectory(directory)).filter(name => name.endsWith('.json')).sort();
    return yield* Effect.forEach(names, name =>
      fs
        .readFileString(path.join(directory, name))
        .pipe(Effect.map(content => parseThreadnote5ProductCaptureV1(JSON.parse(content) as unknown))),
    );
  });
}

function captureNames(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  captureRoot: string,
  identity: Parameters<typeof productCaptureIdentityDigest>[0],
) {
  return Effect.gen(function* () {
    const directory = path.join(captureRoot, productCaptureIdentityDigest(identity));
    return (yield* fs.exists(directory))
      ? (yield* fs.readDirectory(directory)).filter(name => name.endsWith('.json')).sort()
      : [];
  });
}

function secondSurfaceContext() {
  return {
    activationId: digest('a'),
    activationReceiptRevision: digest('b'),
    catalogRevision: 'agent-catalog-v1-test',
    catalogSnapshotHash: digest('c'),
    decision: {
      canonicalUri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/activation.md',
      contentHash: digest('d'),
      memoryId: 'tn_lifecycle_capture',
      publicationReceiptHash: digest('e'),
    },
    primary: {
      access: 'local-stdio' as const,
      capabilitiesFingerprint: digest('f'),
      configurationState: 'current' as const,
      mcpCapability: 'managed' as const,
      mcpConfigFingerprint: digest('0'),
      mcpReceiptFingerprint: digest('1'),
      mcpServerFingerprint: digest('8'),
      surfaceId: 'codex-cli',
    },
    queryFingerprint: digest('3'),
    repositoryIdentityHash: digest('4'),
    repositoryState: 'clean' as const,
    secondary: {
      access: 'local-stdio' as const,
      capabilitiesFingerprint: digest('5'),
      configurationState: 'current' as const,
      mcpCapability: 'managed' as const,
      mcpConfigFingerprint: digest('6'),
      mcpReceiptFingerprint: digest('7'),
      mcpServerFingerprint: digest('8'),
      surfaceId: 'claude-code',
    },
    startedAt: '2026-09-19T08:00:00.000Z',
    teamId: 'default',
    teamShareStateHash: digest('9'),
  };
}

function secondSurfaceObservations(context: ReturnType<typeof secondSurfaceContext>) {
  const common = {
    activationReceiptRevision: context.activationReceiptRevision,
    capabilitiesFingerprint: context.secondary.capabilitiesFingerprint,
    catalogRevision: context.catalogRevision,
    catalogSnapshotHash: context.catalogSnapshotHash,
    mcpConfigFingerprint: context.secondary.mcpConfigFingerprint,
    mcpReceiptFingerprint: context.secondary.mcpReceiptFingerprint,
    mcpServerFingerprint: context.secondary.mcpServerFingerprint,
    repositoryIdentityHash: context.repositoryIdentityHash,
    surfaceId: context.secondary.surfaceId,
    teamShareStateHash: context.teamShareStateHash,
  };
  const recall = {
    ...common,
    complete: true,
    invocationId: digest('a'),
    observedAt: '2026-09-19T08:00:01.000Z',
    queryFingerprint: context.queryFingerprint,
    responseFingerprint: digest('b'),
    results: [
      {canonicalUri: context.decision.canonicalUri, identityConflict: false, memoryId: context.decision.memoryId},
    ],
    returnedResults: 1,
    totalResults: 1,
    truncated: false,
  };
  return {
    read: {
      ...common,
      canonicalUri: context.decision.canonicalUri,
      complete: true,
      contentHash: context.decision.contentHash,
      invocationId: digest('c'),
      memoryId: context.decision.memoryId,
      observedAt: '2026-09-19T08:00:02.000Z',
      readable: true,
      recallResponseFingerprint: recall.responseFingerprint,
      requestedMemoryId: context.decision.memoryId,
      requestedUri: context.decision.canonicalUri,
      resourceCount: 1,
      responseFingerprint: digest('d'),
    },
    recall,
  };
}
