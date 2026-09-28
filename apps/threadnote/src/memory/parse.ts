import type {MemoryStatus} from '@threadnote/memory/types';
import type {CompactableMemoryKind} from '@threadnote/memory/hygiene';
import {MemoryOperationError} from '@threadnote/memory/migrations';

export function parseMemoryStatus(value: string): MemoryStatus {
  if (value === 'active' || value === 'archived' || value === 'expired' || value === 'superseded') return value;
  throw MemoryOperationError.make({
    message: `Unsupported memory status "${value}". Expected active, archived, expired, or superseded.`,
  });
}

export function isRawMemoryDocument(text: string): boolean {
  return /^(?:HANDOFF|MEMORY)(?:\n|\r\n?)/u.test(text);
}

export function parseCompactKind(value: string): CompactableMemoryKind {
  if (value === 'durable' || value === 'handoff' || value === 'incident') return value;
  throw MemoryOperationError.make({
    message: `Unsupported compact kind "${value}". Expected durable, handoff, or incident.`,
  });
}
