import {parseResourceId} from '../storage/resource-id.js';

const MEMORY_ID = /^tn_[A-Za-z0-9_-]{1,128}$/u;

/** Stable, bounded read selector whose target is resolved inside the authorized memory corpus. */
export function memoryIdentityAlias(memoryId: string): string {
  if (!isMemoryId(memoryId)) throw new Error('Memory identity must use the bounded tn_ format.');
  return `threadnote://memory/${memoryId}`;
}

export function memoryIdFromIdentityAlias(input: string): string | undefined {
  try {
    const resource = parseResourceId(input);
    if (
      resource.anchor !== undefined ||
      resource.namespace !== 'memory' ||
      resource.segments.length !== 1 ||
      !isMemoryId(resource.segments[0]!)
    ) {
      return undefined;
    }
    return resource.segments[0];
  } catch {
    return undefined;
  }
}

export function isMemoryId(value: string): boolean {
  return MEMORY_ID.test(value);
}
