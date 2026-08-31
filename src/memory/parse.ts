import type {MemoryStatus} from '../types.js';
import type {CompactableMemoryKind} from './hygiene.js';
import {MemoryOperationError} from './migrations.js';

export function parseMemoryStatus(value: string): MemoryStatus {
  if (['active', 'archived', 'expired', 'superseded'].includes(value)) return value as MemoryStatus;
  throw new MemoryOperationError(
    `Unsupported memory status "${value}". Expected active, archived, expired, or superseded.`,
  );
}

export function parseCompactKind(value: string): CompactableMemoryKind {
  if (['durable', 'handoff', 'incident'].includes(value)) return value as CompactableMemoryKind;
  throw new MemoryOperationError(`Unsupported compact kind "${value}". Expected durable, handoff, or incident.`);
}
