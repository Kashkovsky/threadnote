import {
  parseActivationApprovalV1,
  parseActivationPlanV1,
  parseActivationReceiptV1,
  type ActivationApprovalV1,
} from '../activation/contract.js';
import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {parseSecondSurfaceProofChallengeV1} from '../activation/second_surface_store.js';
import {parseContextBriefV1, renderContextBriefText} from '../context_brief/projector.js';
import {parseContextBriefRequestV1} from '../context_brief/types.js';
import {parseContextCheckReportJson} from '../context_check/index.js';
import {parseGuidanceReceiptV2} from '../guidance/index.js';
import {parseProcedureManifest, parseProcedureVerificationReceipt} from '../procedure/contract.js';
import type {RecallFeedbackEvent} from '../recall/feedback.js';
import type {ActivationValueEventV1} from '../value_report/events.js';
import {
  aggregateValueReportV1,
  parseValueReportInputV1,
  parseValueReportV1,
  type ValueReportInputV1,
  type ValueReportV1,
} from '../value_report/index.js';
import {exactObject, integerIn, object} from './threadnote-5-release-readiness-validation.js';

export const PRODUCT_CAPTURE_SOURCES = [
  'activation',
  'context-brief',
  'value-report',
  'context-check',
  'context-health',
  'guidance',
  'git-proposal',
  'procedure',
  'closeout',
] as const;

export type ProductCaptureSource = (typeof PRODUCT_CAPTURE_SOURCES)[number];
const RECALL_FEEDBACK_ACTIONS = ['useful', 'wrong', 'pin', 'dismiss', 'applied'] as const;

type NativeEvent<Source extends ProductCaptureSource, Event extends string, Payload> = {
  readonly event: Event;
  readonly payload: Payload;
  readonly sequence: number;
  readonly source: Source;
};

export interface ActivationResumeCaptureV1 {
  readonly activationId: string;
  readonly generation: number;
  readonly receiptRevision: string;
}

export interface ActivationPublicationCaptureV1 {
  readonly activationId: string;
  readonly mode: 'direct' | 'proposal';
  readonly operationId: 'decision-publish' | 'decision-propose';
  readonly receiptRevision: string;
  readonly subsystemReceiptHash: string;
}

export interface ContextBriefResultCaptureV1 {
  readonly structuredContent: ReturnType<typeof parseContextBriefV1>;
  readonly text: string;
}

export type ContextBriefCompletionCaptureV1 = {
  readonly completedAt: string;
  readonly durationMilliseconds: number;
} & (
  | {readonly activationId: string; readonly activationReceiptRevision: string}
  | {readonly activationId?: never; readonly activationReceiptRevision?: never}
);

export interface RecallFeedbackCaptureV1 {
  readonly event: RecallFeedbackEvent;
  readonly laneId: string;
}

export interface ValueReportCaptureV1 {
  readonly input: ValueReportInputV1;
  readonly report: ValueReportV1;
}

export type Threadnote5ProductEventV1 =
  | NativeEvent<'activation', 'plan', ReturnType<typeof parseActivationPlanV1>>
  | NativeEvent<'activation', 'receipt', ReturnType<typeof parseActivationReceiptV1>>
  | NativeEvent<'activation', 'approval', ActivationApprovalV1>
  | NativeEvent<'activation', 'resume', ActivationResumeCaptureV1>
  | NativeEvent<'activation', 'publication', ActivationPublicationCaptureV1>
  | NativeEvent<'activation', 'challenge', ReturnType<typeof parseSecondSurfaceProofChallengeV1>>
  | NativeEvent<'context-brief', 'request', ReturnType<typeof parseContextBriefRequestV1>>
  | NativeEvent<'context-brief', 'result', ContextBriefResultCaptureV1>
  | NativeEvent<'context-brief', 'event', ContextBriefCompletionCaptureV1>
  | NativeEvent<'context-check', 'report', ReturnType<typeof parseContextCheckReportJson>>
  | NativeEvent<'guidance', 'receipt', ReturnType<typeof parseGuidanceReceiptV2>>
  | NativeEvent<'value-report', 'feedback', RecallFeedbackCaptureV1>
  | NativeEvent<'value-report', 'value-event', ActivationValueEventV1>
  | NativeEvent<'value-report', 'capture', ValueReportCaptureV1>
  | NativeEvent<'value-report', 'report', ReturnType<typeof parseValueReportV1>>
  | NativeEvent<'procedure', 'manifest', ReturnType<typeof parseProcedureManifest>>
  | NativeEvent<'procedure', 'receipt', ReturnType<typeof parseProcedureVerificationReceipt>>;

/** Closed native schema registry. New exporter pairs must extend this union and parser together. */
export function parseThreadnote5ProductEventV1(value: unknown): Threadnote5ProductEventV1 {
  const input = exactObject(value, ['event', 'payload', 'sequence', 'source'], 'Product capture event');
  if (!integerIn(input.sequence, 0, 255)) throw new Error('Product capture sequence must be from 0 to 255.');
  const sequence = input.sequence;
  if (input.source === 'activation') {
    switch (input.event) {
      case 'plan':
        return {event: 'plan', payload: parseActivationPlanV1(input.payload), sequence, source: 'activation'};
      case 'receipt':
        return {event: 'receipt', payload: parseActivationReceiptV1(input.payload), sequence, source: 'activation'};
      case 'approval':
        return {event: 'approval', payload: parseActivationApprovalV1(input.payload), sequence, source: 'activation'};
      case 'resume':
        return {event: 'resume', payload: parseActivationResumeCapture(input.payload), sequence, source: 'activation'};
      case 'publication':
        return {
          event: 'publication',
          payload: parseActivationPublicationCapture(input.payload),
          sequence,
          source: 'activation',
        };
      case 'challenge':
        return {
          event: 'challenge',
          payload: parseSecondSurfaceProofChallengeV1(input.payload),
          sequence,
          source: 'activation',
        };
    }
  }
  if (input.source === 'context-brief' && input.event === 'request') {
    return {event: 'request', payload: parseContextBriefRequestV1(input.payload), sequence, source: 'context-brief'};
  }
  if (input.source === 'context-brief' && input.event === 'result') {
    return {event: 'result', payload: parseContextBriefResultCapture(input.payload), sequence, source: 'context-brief'};
  }
  if (input.source === 'context-brief' && input.event === 'event') {
    return {
      event: 'event',
      payload: parseContextBriefCompletionCapture(input.payload),
      sequence,
      source: 'context-brief',
    };
  }
  if (input.source === 'value-report') {
    if (input.event === 'feedback') {
      return {event: 'feedback', payload: parseRecallFeedbackCapture(input.payload), sequence, source: 'value-report'};
    }
    if (input.event === 'value-event') {
      return {
        event: 'value-event',
        payload: parseActivationValueEvent(input.payload),
        sequence,
        source: 'value-report',
      };
    }
    if (input.event === 'capture') {
      return {event: 'capture', payload: parseValueReportCapture(input.payload), sequence, source: 'value-report'};
    }
    if (input.event === 'report') {
      return {event: 'report', payload: parseValueReportV1(input.payload), sequence, source: 'value-report'};
    }
  }
  if (input.source === 'context-check' && input.event === 'report') {
    return {
      event: 'report',
      payload: parseContextCheckReportJson(JSON.stringify(input.payload)),
      sequence,
      source: 'context-check',
    };
  }
  if (input.source === 'guidance' && input.event === 'receipt') {
    const receipt = object(input.payload, 'Guidance capture receipt');
    if (
      typeof receipt.project !== 'string' ||
      typeof receipt.repositoryId !== 'string' ||
      typeof receipt.targetIdentity !== 'string' ||
      typeof receipt.targetPath !== 'string'
    ) {
      throw new Error('Guidance capture receipt lacks its native identity.');
    }
    return {
      event: 'receipt',
      payload: parseGuidanceReceiptV2(receipt, {
        project: receipt.project,
        repositoryId: receipt.repositoryId,
        targetIdentity: receipt.targetIdentity,
        targetPath: receipt.targetPath,
      }),
      sequence,
      source: 'guidance',
    };
  }
  if (input.source === 'procedure') {
    if (input.event === 'manifest')
      return {event: 'manifest', payload: parseProcedureManifest(input.payload), sequence, source: 'procedure'};
    if (input.event === 'receipt')
      return {
        event: 'receipt',
        payload: parseProcedureVerificationReceipt(input.payload),
        sequence,
        source: 'procedure',
      };
  }
  throw new Error('Unsupported product capture source/event pair.');
}

function parseActivationResumeCapture(value: unknown): ActivationResumeCaptureV1 {
  const input = exactObject(value, ['activationId', 'generation', 'receiptRevision'], 'Activation resume capture');
  if (!hash(input.activationId) || !hash(input.receiptRevision) || !integerIn(input.generation, 0, 10_000)) {
    throw new Error('Activation resume capture is invalid.');
  }
  return input as unknown as ActivationResumeCaptureV1;
}

function parseActivationPublicationCapture(value: unknown): ActivationPublicationCaptureV1 {
  const input = exactObject(
    value,
    ['activationId', 'mode', 'operationId', 'receiptRevision', 'subsystemReceiptHash'],
    'Activation publication capture',
  );
  if (
    !hash(input.activationId) ||
    !hash(input.receiptRevision) ||
    !hash(input.subsystemReceiptHash) ||
    !['direct', 'proposal'].includes(input.mode as string) ||
    !['decision-publish', 'decision-propose'].includes(input.operationId as string) ||
    (input.mode === 'direct') !== (input.operationId === 'decision-publish')
  ) {
    throw new Error('Activation publication capture is invalid.');
  }
  return input as unknown as ActivationPublicationCaptureV1;
}

function parseContextBriefResultCapture(value: unknown): ContextBriefResultCaptureV1 {
  const input = exactObject(value, ['structuredContent', 'text'], 'Context Brief result capture');
  const structuredContent = parseContextBriefV1(input.structuredContent);
  if (typeof input.text !== 'string' || input.text !== renderContextBriefText(structuredContent)) {
    throw new Error('Context Brief result capture does not replay its text projection.');
  }
  return {structuredContent, text: input.text};
}

function parseContextBriefCompletionCapture(value: unknown): ContextBriefCompletionCaptureV1 {
  const candidate = object(value, 'Context Brief completion capture');
  const activation = Object.hasOwn(candidate, 'activationId') || Object.hasOwn(candidate, 'activationReceiptRevision');
  const input = exactObject(
    value,
    activation
      ? ['activationId', 'activationReceiptRevision', 'completedAt', 'durationMilliseconds']
      : ['completedAt', 'durationMilliseconds'],
    'Context Brief completion capture',
  );
  if (
    !isoInstant(input.completedAt) ||
    !integerIn(input.durationMilliseconds, 0, 7 * 24 * 60 * 60 * 1_000) ||
    (activation && (!hash(input.activationId) || !hash(input.activationReceiptRevision)))
  ) {
    throw new Error('Context Brief completion capture is invalid.');
  }
  return input as unknown as ContextBriefCompletionCaptureV1;
}

function parseRecallFeedbackCapture(value: unknown): RecallFeedbackCaptureV1 {
  const input = exactObject(value, ['event', 'laneId'], 'Recall feedback capture');
  const raw = object(input.event, 'Recall feedback event');
  const keys =
    raw.project === undefined
      ? ['action', 'queryFingerprint', 'rankerVersion', 'timestamp', 'uri', 'version']
      : ['action', 'project', 'queryFingerprint', 'rankerVersion', 'timestamp', 'uri', 'version'];
  const event = exactObject(raw, keys, 'Recall feedback event');
  if (
    event.version !== 1 ||
    !RECALL_FEEDBACK_ACTIONS.includes(event.action as RecallFeedbackEvent['action']) ||
    !hash(event.queryFingerprint) ||
    !boundedText(event.rankerVersion, 128) ||
    !isoInstant(event.timestamp) ||
    !boundedText(event.uri, 2_048) ||
    (event.project !== undefined && !boundedText(event.project, 256)) ||
    !hash(input.laneId)
  ) {
    throw new Error('Recall feedback capture is invalid.');
  }
  return {event: event as unknown as RecallFeedbackEvent, laneId: input.laneId};
}

function parseActivationValueEvent(value: unknown): ActivationValueEventV1 {
  const input = exactObject(
    value,
    ['durationMilliseconds', 'eventId', 'kind', 'phase', 'timestamp', 'version'],
    'Activation value event',
  );
  if (
    input.kind !== 'activation' ||
    input.version !== 1 ||
    !hash(input.eventId) ||
    !['started', 'first-evidence', 'completed', 'second-surface-proof'].includes(input.phase as string) ||
    !integerIn(input.durationMilliseconds, 0, 7 * 24 * 60 * 60 * 1_000) ||
    !isoInstant(input.timestamp)
  ) {
    throw new Error('Activation value event capture is invalid.');
  }
  return input as unknown as ActivationValueEventV1;
}

function parseValueReportCapture(value: unknown): ValueReportCaptureV1 {
  const input = exactObject(value, ['input', 'report'], 'Value report capture');
  const reportInput = parseValueReportInputV1(input.input);
  const report = parseValueReportV1(input.report);
  if (canonicalJson(aggregateValueReportV1(reportInput)) !== canonicalJson(report)) {
    throw new Error('Value report capture does not replay from its exact input.');
  }
  return {input: reportInput, report};
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    ![...value].some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}
