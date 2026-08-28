export type CanonicalJsonPrimitive = boolean | null | number | string;
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}
export type CanonicalJsonValue = CanonicalJsonPrimitive | readonly CanonicalJsonValue[] | CanonicalJsonObject;

export interface CanonicalJsonLimits {
  readonly maximumContainerEntries: number;
  readonly maximumDepth: number;
  readonly maximumInputCodeUnits: number;
  readonly maximumStringCodeUnits: number;
}

export const DEFAULT_CANONICAL_JSON_LIMITS: CanonicalJsonLimits = {
  maximumContainerEntries: 1_000_000,
  maximumDepth: 64,
  maximumInputCodeUnits: 16 * 1_048_576,
  maximumStringCodeUnits: 8 * 1_048_576,
};

export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

/**
 * RFC 8785 JSON Canonicalization Scheme serialization for the I-JSON data
 * model used by checkpoints. JavaScript's primitive serializer supplies the
 * specified ECMAScript number and string spelling; this traversal supplies
 * strict input validation and UTF-16 property ordering.
 */
export function canonicalJson(value: unknown, limits: Partial<CanonicalJsonLimits> = {}): string {
  const resolved = resolveLimits(limits);
  const ancestors = new Set<object>();
  let entries = 0;

  const visitString = (value: string, label: string): string => {
    if (value.length > resolved.maximumStringCodeUnits) {
      throw new CanonicalJsonError(`${label} exceeds the canonical JSON string limit.`);
    }
    ensureUnicodeScalarString(value, label);
    return JSON.stringify(value);
  };

  const visit = (current: unknown, depth: number): string => {
    if (depth > resolved.maximumDepth) {
      throw new CanonicalJsonError('Canonical JSON exceeds the maximum nesting depth.');
    }
    if (current === null) return 'null';
    switch (typeof current) {
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current)) {
          throw new CanonicalJsonError('Canonical JSON numbers must be finite IEEE-754 values.');
        }
        return JSON.stringify(current);
      case 'string':
        return visitString(current, 'Canonical JSON string');
      case 'object':
        break;
      default:
        throw new CanonicalJsonError(`Canonical JSON does not support ${typeof current} values.`);
    }

    if (ancestors.has(current)) throw new CanonicalJsonError('Canonical JSON cannot contain cycles.');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        entries = checkedEntryTotal(entries, current.length, resolved.maximumContainerEntries);
        const ownKeys = Reflect.ownKeys(current);
        const expectedKeys = new Set<string>(['length']);
        for (let index = 0; index < current.length; index += 1) expectedKeys.add(String(index));
        for (const key of ownKeys) {
          if (typeof key === 'symbol' || !expectedKeys.has(key)) {
            throw new CanonicalJsonError('Canonical JSON arrays cannot contain extra own properties.');
          }
        }
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new CanonicalJsonError('Canonical JSON array slots must be enumerable data properties.');
          }
          values.push(visit(descriptor.value, depth + 1));
        }
        return `[${values.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError('Canonical JSON objects must have a plain or null prototype.');
      }
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some(key => typeof key === 'symbol')) {
        throw new CanonicalJsonError('Canonical JSON objects cannot contain symbol keys.');
      }
      const keys = ownKeys as string[];
      entries = checkedEntryTotal(entries, keys.length, resolved.maximumContainerEntries);
      const object = current as Record<string, unknown>;
      const properties: string[] = [];
      for (const key of keys.sort(compareCodeUnits)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new CanonicalJsonError('Canonical JSON objects may contain only enumerable data properties.');
        }
        properties.push(`${visitString(key, 'Canonical JSON property name')}:${visit(descriptor.value, depth + 1)}`);
      }
      return `{${properties.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  const rendered = visit(value, 0);
  if (rendered.length > resolved.maximumInputCodeUnits) {
    throw new CanonicalJsonError('Canonical JSON output exceeds the input limit.');
  }
  return rendered;
}

/** Parse only the single RFC 8785 spelling accepted by {@link canonicalJson}. */
export function parseCanonicalJson(value: string, limits: Partial<CanonicalJsonLimits> = {}): CanonicalJsonValue {
  const resolved = resolveLimits(limits);
  if (value.length > resolved.maximumInputCodeUnits) {
    throw new CanonicalJsonError('Canonical JSON input exceeds the input limit.');
  }
  ensureUnicodeScalarString(value, 'Canonical JSON input');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new CanonicalJsonError(cause instanceof Error ? cause.message : 'Canonical JSON is malformed.');
  }
  const rendered = canonicalJson(parsed, resolved);
  if (rendered !== value) throw new CanonicalJsonError('JSON input is not in RFC 8785 canonical form.');
  return parsed as CanonicalJsonValue;
}

function resolveLimits(overrides: Partial<CanonicalJsonLimits>): CanonicalJsonLimits {
  const limits = {...DEFAULT_CANONICAL_JSON_LIMITS, ...overrides};
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CanonicalJsonError(`${name} must be a non-negative safe integer.`);
    }
  }
  return limits;
}

function checkedEntryTotal(current: number, added: number, maximum: number): number {
  if (added > maximum - current) {
    throw new CanonicalJsonError('Canonical JSON contains too many container entries.');
  }
  return current + added;
}

function ensureUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) throw new CanonicalJsonError(`${label} contains a lone surrogate.`);
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new CanonicalJsonError(`${label} contains a lone surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError(`${label} contains a lone surrogate.`);
    }
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
