import {Schema} from 'effect';
import {parseRemoteShareAddress} from './address.js';
import {validatePortableSegment} from '../storage/resource-id.js';

export const REMOTE_MEMORY_CONTRACT_VERSION = 1 as const;
export const REMOTE_MEMORY_KINDS = ['durable', 'handoff'] as const;

export type RemoteMemoryKind = (typeof REMOTE_MEMORY_KINDS)[number];

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const BoundedIdentifier = NonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const BoundedPortableSegment = NonEmptyString.check(Schema.isMaxLength(255));
const BoundedQuery = NonEmptyString.check(Schema.isMaxLength(8_192));
const BoundedMemoryText = NonEmptyString.check(Schema.isMaxLength(1_000_000));
const RecallLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100));
const IsoInstant = NonEmptyString.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u));

export const RemoteRecallInputSchemaV1 = Schema.Struct({
  kinds: Schema.optionalKey(
    Schema.Array(Schema.Literals(REMOTE_MEMORY_KINDS)).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  ),
  limit: Schema.optionalKey(RecallLimit),
  project: BoundedPortableSegment,
  query: BoundedQuery,
  version: Schema.Literal(REMOTE_MEMORY_CONTRACT_VERSION),
});

export type RemoteRecallInputV1 = typeof RemoteRecallInputSchemaV1.Type;

export const RemoteReadInputSchemaV1 = Schema.Struct({
  revision: Schema.optionalKey(BoundedIdentifier),
  uri: NonEmptyString.check(Schema.isMaxLength(4_096)),
  version: Schema.Literal(REMOTE_MEMORY_CONTRACT_VERSION),
});

export type RemoteReadInputV1 = typeof RemoteReadInputSchemaV1.Type;

export const RemoteLifecycleInputSchemaV1 = Schema.Struct({
  expiresAt: Schema.optionalKey(IsoInstant),
  retentionClass: Schema.optionalKey(BoundedIdentifier),
});

export type RemoteLifecycleInputV1 = typeof RemoteLifecycleInputSchemaV1.Type;

export const RemoteRememberInputSchemaV1 = Schema.Struct({
  attestationId: Schema.optionalKey(BoundedIdentifier),
  baseRevision: Schema.optionalKey(BoundedIdentifier),
  kind: Schema.Literals(REMOTE_MEMORY_KINDS),
  lifecycle: Schema.optionalKey(RemoteLifecycleInputSchemaV1),
  operationId: BoundedIdentifier,
  project: BoundedPortableSegment,
  text: BoundedMemoryText,
  topic: BoundedPortableSegment,
  version: Schema.Literal(REMOTE_MEMORY_CONTRACT_VERSION),
});

export type RemoteRememberInputV1 = typeof RemoteRememberInputSchemaV1.Type;

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseRemoteRecallInputV1(value: unknown): RemoteRecallInputV1 {
  const parsed = Schema.decodeUnknownSync(RemoteRecallInputSchemaV1, STRICT_PARSE_OPTIONS)(value);
  validatePortableSegment(parsed.project);
  return parsed;
}

export function parseRemoteReadInputV1(value: unknown): RemoteReadInputV1 {
  const parsed = Schema.decodeUnknownSync(RemoteReadInputSchemaV1, STRICT_PARSE_OPTIONS)(value);
  parseRemoteShareAddress(parsed.uri);
  return parsed;
}

export function parseRemoteRememberInputV1(value: unknown): RemoteRememberInputV1 {
  const parsed = Schema.decodeUnknownSync(RemoteRememberInputSchemaV1, STRICT_PARSE_OPTIONS)(value);
  validatePortableSegment(parsed.project);
  validatePortableSegment(parsed.topic);
  if (parsed.kind === 'durable' && parsed.lifecycle !== undefined) {
    throw new TypeError('Remote memory lifecycle controls are only supported for handoffs.');
  }
  if (parsed.lifecycle?.expiresAt !== undefined && Number.isNaN(Date.parse(parsed.lifecycle.expiresAt))) {
    throw new TypeError('Remote memory expiry must be a valid UTC instant.');
  }
  return parsed;
}
