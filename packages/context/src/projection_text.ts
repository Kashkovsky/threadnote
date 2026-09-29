import type {ContextBriefV1} from './types.js';

export function compactContextBriefTask(task: string): ContextBriefV1['task'] {
  const summary = jsonStringPrefix(task, 162);
  return {summary, truncated: summary !== task};
}

/** Bound the serialized JSON string, including quotes and escape expansion. */
export function jsonStringPrefix(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(value)).byteLength <= maximumBytes) return value;
  let prefix = '';
  for (const character of value) {
    if (encoder.encode(JSON.stringify(`${prefix}${character}…`)).byteLength > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}…`;
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let prefix = '';
  for (const character of value) {
    if (encoder.encode(`${prefix}${character}…`).byteLength > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}…`;
}
