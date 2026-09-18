import {Effect} from 'effect';
import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';
import type {RuntimeConfig} from '../types.js';
import {recordActivationValueEvent} from '../value_report/events.js';
import type {ActivationStateV1} from './store.js';

export const reconcileActivationValueEventsV1 = Effect.fn('activation.value.reconcile')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  state: ActivationStateV1,
) {
  const receipt = state.receipt;
  const event = (phase: 'started' | 'first-evidence' | 'completed' | 'second-surface-proof') =>
    sha256HexSync(
      canonicalJson({activationId: receipt.activationId, phase, type: 'threadnote-activation-value-event', version: 1}),
    );
  yield* recordActivationValueEvent(config.agentContextHome, {
    durationMilliseconds: 0,
    eventId: event('started'),
    phase: 'started',
    timestamp: receipt.startedAt,
  });
  if (receipt.firstBrief !== undefined) {
    yield* recordActivationValueEvent(config.agentContextHome, {
      durationMilliseconds: receipt.firstBrief.durationMilliseconds,
      eventId: event('first-evidence'),
      phase: 'first-evidence',
      timestamp: receipt.firstBrief.completedAt,
    });
  }
  const secondSurface = receipt.operations.find(operation => operation.kind === 'secondary.prove');
  if (secondSurface?.status === 'verified') {
    yield* recordActivationValueEvent(config.agentContextHome, {
      durationMilliseconds: elapsed(receipt.startedAt, receipt.updatedAt),
      eventId: event('second-surface-proof'),
      phase: 'second-surface-proof',
      timestamp: receipt.updatedAt,
    });
  }
  if (receipt.status === 'completed' && receipt.completedAt !== undefined) {
    yield* recordActivationValueEvent(config.agentContextHome, {
      durationMilliseconds: elapsed(receipt.startedAt, receipt.completedAt),
      eventId: event('completed'),
      phase: 'completed',
      timestamp: receipt.completedAt,
    });
  }
});

function elapsed(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
}
