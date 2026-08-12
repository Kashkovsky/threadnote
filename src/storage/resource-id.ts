import {Schema} from 'effect';

export const RESOURCE_ID_SCHEMES = ['threadnote', 'viking'] as const;
export type ResourceIdScheme = (typeof RESOURCE_ID_SCHEMES)[number];

export interface ResourceId {
  readonly anchor?: string;
  readonly canonicalUri: string;
  readonly inputScheme: ResourceIdScheme;
  readonly namespace: string;
  readonly segments: readonly string[];
}

export class InvalidResourceId extends Schema.TaggedErrorClass<InvalidResourceId>()('InvalidResourceId', {
  input: Schema.String,
  message: Schema.String,
  reason: Schema.String,
}) {}

const RESOURCE_ID_PATTERN = /^(threadnote|viking):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PORTABLE_UNSAFE_CHARACTERS = /[<>:"|?*\\/]/;

export function parseResourceId(input: string): ResourceId {
  const trimmed = input.trim();
  const match = RESOURCE_ID_PATTERN.exec(trimmed);
  if (!match) return invalid(input, 'expected threadnote:// URI syntax (legacy viking:// aliases are accepted)');
  const inputScheme = match[1]!.toLowerCase() as ResourceIdScheme;
  const namespace = decodeSegment(match[2]!, input, 'namespace');
  const rawPath = match[3] ?? '';
  if (match[4] !== undefined) return invalid(input, 'query parameters are not supported');
  if (rawPath && !rawPath.startsWith('/')) return invalid(input, 'resource path must start with /');
  if (rawPath.includes('//')) return invalid(input, 'empty path segments are not allowed');
  const rawSegments = rawPath.split('/').slice(1);
  if (rawSegments.at(-1) === '') rawSegments.pop();
  const segments = rawSegments.map((segment, index) => decodeSegment(segment, input, `path segment ${index + 1}`));
  const anchor = match[5] ? decodeAnchor(match[5], input) : undefined;
  return {
    ...(anchor ? {anchor} : {}),
    canonicalUri: canonicalResourceUri(namespace, segments, anchor),
    inputScheme,
    namespace,
    segments,
  };
}

export function canonicalResourceUri(namespace: string, segments: readonly string[], anchor?: string): string {
  validatePortableSegment(namespace, namespace);
  for (const segment of segments) validatePortableSegment(segment, segment);
  const path = segments.length > 0 ? `/${segments.map(encodeURIComponent).join('/')}` : '';
  const fragment = anchor ? `#${encodeURIComponent(validateAnchor(anchor, anchor))}` : '';
  return `threadnote://${encodeURIComponent(namespace)}${path}${fragment}`;
}

export function resourceIdWithoutAnchor(resourceId: ResourceId): ResourceId {
  if (!resourceId.anchor) return resourceId;
  return {
    canonicalUri: canonicalResourceUri(resourceId.namespace, resourceId.segments),
    inputScheme: resourceId.inputScheme,
    namespace: resourceId.namespace,
    segments: resourceId.segments,
  };
}

export function resourceIdIsWithin(candidateUri: string, rootUri: string): boolean {
  const candidate = resourceIdWithoutAnchor(parseResourceId(candidateUri));
  const root = resourceIdWithoutAnchor(parseResourceId(rootUri));
  return (
    candidate.namespace === root.namespace &&
    root.segments.every((segment, index) => candidate.segments[index] === segment)
  );
}

export function validatePortableSegment(value: string, input = value): string {
  if (!value) return invalid(input, 'empty path segments are not allowed');
  if (value !== value.normalize('NFC')) return invalid(input, 'path segments must use NFC Unicode normalization');
  if (value === '.' || value === '..') return invalid(input, 'dot path segments are not allowed');
  if (hasControlCharacter(value) || PORTABLE_UNSAFE_CHARACTERS.test(value)) {
    return invalid(input, 'path segment contains a non-portable character');
  }
  if (/[ .]$/.test(value)) return invalid(input, 'path segment may not end with a space or dot');
  if (WINDOWS_RESERVED_NAME.test(value)) return invalid(input, 'path segment is a Windows reserved name');
  if (Buffer.byteLength(value, 'utf8') > 255) return invalid(input, 'path segment exceeds 255 UTF-8 bytes');
  return value;
}

function decodeSegment(raw: string, input: string, label: string): string {
  if (!raw) return invalid(input, `${label} is empty`);
  if (/%(?:2f|5c|00)/i.test(raw)) return invalid(input, `${label} contains an encoded separator or NUL`);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalid(input, `${label} has invalid percent encoding`);
  }
  try {
    return validatePortableSegment(decoded, input);
  } catch (cause) {
    if (cause instanceof InvalidResourceId) {
      return invalid(input, `${label}: ${cause.reason}`);
    }
    throw cause;
  }
}

function decodeAnchor(raw: string, input: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalid(input, 'anchor has invalid percent encoding');
  }
  return validateAnchor(decoded, input);
}

function validateAnchor(value: string, input: string): string {
  if (!value || hasControlCharacter(value)) return invalid(input, 'anchor is empty or contains control characters');
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => character.codePointAt(0)! <= 0x1f);
}

function invalid(input: string, reason: string): never {
  throw new InvalidResourceId({
    input,
    message: `Invalid resource identifier "${input}": ${reason}.`,
    reason,
  });
}
