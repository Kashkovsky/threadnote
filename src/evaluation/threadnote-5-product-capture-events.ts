import {parseActivationPlanV1, parseActivationReceiptV1} from '../activation/contract.js';
import {parseSecondSurfaceProofChallengeV1} from '../activation/second/surface_store.js';
import {parseContextBriefRequestV1} from '../context_brief/types.js';
import {parseContextCheckReportJson} from '../context_check/index.js';
import {parseGuidanceReceiptV2} from '../guidance/index.js';
import {parseProcedureManifest, parseProcedureVerificationReceipt} from '../procedure/contract.js';
import {parseValueReportV1} from '../value_report/index.js';
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

type NativeEvent<Source extends ProductCaptureSource, Event extends string, Payload> = {
  readonly event: Event;
  readonly payload: Payload;
  readonly sequence: number;
  readonly source: Source;
};

export type Threadnote5ProductEventV1 =
  | NativeEvent<'activation', 'plan', ReturnType<typeof parseActivationPlanV1>>
  | NativeEvent<'activation', 'receipt', ReturnType<typeof parseActivationReceiptV1>>
  | NativeEvent<'activation', 'challenge', ReturnType<typeof parseSecondSurfaceProofChallengeV1>>
  | NativeEvent<'context-brief', 'request', ReturnType<typeof parseContextBriefRequestV1>>
  | NativeEvent<'context-check', 'report', ReturnType<typeof parseContextCheckReportJson>>
  | NativeEvent<'guidance', 'receipt', ReturnType<typeof parseGuidanceReceiptV2>>
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
  if (input.source === 'value-report' && input.event === 'report') {
    return {event: 'report', payload: parseValueReportV1(input.payload), sequence, source: 'value-report'};
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
