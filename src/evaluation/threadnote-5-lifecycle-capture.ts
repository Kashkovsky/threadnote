import {Effect} from 'effect';
import type {ActivationApprovalV1, ActivationPlanV1, ActivationReceiptV1} from '../activation/contract.js';
import type {SecondSurfaceProofChallengeV1} from '../activation/second_surface_store.js';
import type {ProjectedContextBriefV1, ContextBriefRequestV1} from '../context_brief/types.js';
import type {RecallFeedbackEvent} from '../recall/feedback.js';
import type {ActivationValueEventV1} from '../value_report/events.js';
import type {ValueReportInputV1, ValueReportV1} from '../value_report/index.js';
import {captureConfiguredThreadnote5ProductEventV1} from './threadnote-5-product-capture-sink.js';

const ACTIVATION_RECEIPT_SEQUENCE = 1;
const ACTIVATION_APPROVAL_SEQUENCE = 2;
const ACTIVATION_RESUME_SEQUENCE = 3;
const ACTIVATION_PUBLICATION_SEQUENCE = 4;
const ACTIVATION_CHALLENGE_SEQUENCE_BASE = 160;
const VALUE_EVENT_SEQUENCE_BASE = 16;
const VALUE_REPORT_CAPTURE_SEQUENCE = 64;

export const captureThreadnote5ActivationInitializationV1 = Effect.fn('productCapture.activation.initialize')(
  function* (plan: ActivationPlanV1, receipt: ActivationReceiptV1) {
    yield* captureConfiguredThreadnote5ProductEventV1('activation', () => ({
      event: 'plan',
      payload: plan,
      sequence: 0,
      source: 'activation',
    }));
    yield* captureConfiguredThreadnote5ProductEventV1(
      'activation',
      () => ({
        event: 'receipt',
        payload: receipt,
        sequence: ACTIVATION_RECEIPT_SEQUENCE,
        source: 'activation',
      }),
      {appendOnlyIdentity: activationInitialReceiptIdentity(receipt)},
    );
  },
);

export const captureThreadnote5ActivationTransitionV1 = Effect.fn('productCapture.activation.transition')(
  function* (input: {
    readonly approval?: ActivationApprovalV1;
    readonly plan: ActivationPlanV1;
    readonly previous: ActivationReceiptV1;
    readonly receipt: ActivationReceiptV1;
    readonly resumed: boolean;
  }) {
    if (input.receipt.generation !== input.previous.generation + 1) {
      throw new Error('Activation capture transition lacks one receipt generation.');
    }
    const operations = input.receipt.operations.filter(candidate => {
      const previous = input.previous.operations.find(operation => operation.id === candidate.id);
      return previous !== undefined && candidate.attempt === previous.attempt + 1;
    });
    if (operations.length !== 1) throw new Error('Activation capture transition lacks one attempted operation.');
    const operation = operations[0];
    const operationIndex = input.plan.operations.findIndex(candidate => candidate.id === operation.id);
    if (operationIndex < 0) throw new Error('Activation capture operation is not planned.');
    yield* captureConfiguredThreadnote5ProductEventV1(
      'activation',
      () => ({
        event: 'receipt',
        payload: input.receipt,
        sequence: ACTIVATION_RECEIPT_SEQUENCE,
        source: 'activation',
      }),
      {appendOnlyIdentity: activationTransitionIdentityV1('receipt', input.receipt.generation, operationIndex)},
    );
    if (input.approval !== undefined) {
      yield* captureConfiguredThreadnote5ProductEventV1(
        'activation',
        () => ({
          event: 'approval',
          payload: input.approval!,
          sequence: ACTIVATION_APPROVAL_SEQUENCE,
          source: 'activation',
        }),
        {appendOnlyIdentity: activationTransitionIdentityV1('approval', input.receipt.generation, operationIndex)},
      );
    }
    if (input.resumed) {
      yield* captureConfiguredThreadnote5ProductEventV1(
        'activation',
        () => ({
          event: 'resume',
          payload: {
            activationId: input.plan.activationId,
            generation: input.previous.generation,
            receiptRevision: input.previous.revision,
          },
          sequence: ACTIVATION_RESUME_SEQUENCE,
          source: 'activation',
        }),
        {appendOnlyIdentity: activationTransitionIdentityV1('resume', input.receipt.generation, operationIndex)},
      );
    }
    if (operation.kind === 'decision.publish' || operation.kind === 'decision.propose') {
      if (operation.subsystemReceiptHash === undefined) {
        throw new Error('Activation publication capture lacks subsystem receipt evidence.');
      }
      yield* captureConfiguredThreadnote5ProductEventV1(
        'activation',
        () => ({
          event: 'publication',
          payload: {
            activationId: input.plan.activationId,
            mode: operation.kind === 'decision.publish' ? 'direct' : 'proposal',
            operationId: operation.id as 'decision-publish' | 'decision-propose',
            receiptRevision: input.receipt.revision,
            subsystemReceiptHash: operation.subsystemReceiptHash!,
          },
          sequence: ACTIVATION_PUBLICATION_SEQUENCE,
          source: 'activation',
        }),
        {appendOnlyIdentity: activationTransitionIdentityV1('publication', input.receipt.generation, operationIndex)},
      );
    }
  },
);

export const captureThreadnote5ActivationChallengeV1 = Effect.fn('productCapture.activation.challenge')(function* (
  challenge: SecondSurfaceProofChallengeV1,
) {
  yield* captureConfiguredThreadnote5ProductEventV1(
    'activation',
    () => ({
      event: 'challenge',
      payload: challenge,
      sequence: ACTIVATION_CHALLENGE_SEQUENCE_BASE + (challenge.receipt === undefined ? 0 : 1),
      source: 'activation',
    }),
    {idempotent: 'exact'},
  );
});

function activationInitialReceiptIdentity(receipt: ActivationReceiptV1): string {
  if (receipt.generation !== 0) throw new Error('Activation capture initial receipt generation is invalid.');
  return 'receipt-g00000-initial';
}

export function activationTransitionIdentityV1(
  event: 'approval' | 'publication' | 'receipt' | 'resume',
  generation: number,
  operationIndex: number,
): string {
  if (!Number.isInteger(generation) || generation < 1 || generation > 10_000) {
    throw new Error('Activation capture generation is invalid.');
  }
  if (!Number.isInteger(operationIndex) || operationIndex < 0 || operationIndex >= 10) {
    throw new Error('Activation capture operation index is invalid.');
  }
  return `${event}-g${String(generation).padStart(5, '0')}-o${String(operationIndex).padStart(2, '0')}`;
}

export const captureThreadnote5ContextBriefRequestV1 = Effect.fn('productCapture.contextBrief.request')(function* (
  request: ContextBriefRequestV1,
) {
  yield* captureConfiguredThreadnote5ProductEventV1('context-brief', () => ({
    event: 'request',
    payload: request,
    sequence: 0,
    source: 'context-brief',
  }));
});

export const captureThreadnote5ContextBriefResultV1 = Effect.fn('productCapture.contextBrief.result')(function* (
  projected: ProjectedContextBriefV1,
) {
  yield* captureConfiguredThreadnote5ProductEventV1('context-brief', () => ({
    event: 'result',
    payload: {structuredContent: projected.structuredContent, text: projected.text},
    sequence: 1,
    source: 'context-brief',
  }));
});

export const captureThreadnote5ContextBriefCompletionV1 = Effect.fn('productCapture.contextBrief.completion')(
  function* (input: {
    readonly activationId?: string;
    readonly activationReceiptRevision?: string;
    readonly completedAt: string;
    readonly durationMilliseconds: number;
  }) {
    yield* captureConfiguredThreadnote5ProductEventV1('context-brief', () => ({
      event: 'event',
      payload:
        input.activationId === undefined || input.activationReceiptRevision === undefined
          ? {completedAt: input.completedAt, durationMilliseconds: input.durationMilliseconds}
          : {
              activationId: input.activationId,
              activationReceiptRevision: input.activationReceiptRevision,
              completedAt: input.completedAt,
              durationMilliseconds: input.durationMilliseconds,
            },
      sequence: 2,
      source: 'context-brief',
    }));
  },
);

export const captureThreadnote5RecallFeedbackV1 = Effect.fn('productCapture.value.feedback')(function* (
  event: RecallFeedbackEvent,
) {
  yield* captureConfiguredThreadnote5ProductEventV1('value-report', context => ({
    event: 'feedback',
    payload: {event, laneId: context.laneId},
    sequence: 0,
    source: 'value-report',
  }));
});

export const captureThreadnote5ActivationValueEventV1 = Effect.fn('productCapture.value.activationEvent')(function* (
  event: ActivationValueEventV1,
) {
  const phaseIndex = ['started', 'first-evidence', 'completed', 'second-surface-proof'].indexOf(event.phase);
  if (phaseIndex < 0) throw new Error('Activation value capture phase is unsupported.');
  yield* captureConfiguredThreadnote5ProductEventV1('value-report', () => ({
    event: 'value-event',
    payload: event,
    sequence: VALUE_EVENT_SEQUENCE_BASE + phaseIndex,
    source: 'value-report',
  }));
});

export const captureThreadnote5ValueReportV1 = Effect.fn('productCapture.value.report')(function* (
  input: ValueReportInputV1,
  report: ValueReportV1,
) {
  yield* captureConfiguredThreadnote5ProductEventV1('value-report', () => ({
    event: 'capture',
    payload: {input, report},
    sequence: VALUE_REPORT_CAPTURE_SEQUENCE,
    source: 'value-report',
  }));
});
