import {Schema} from 'effect';
import {canonicalJson} from '../checkpoint/canonical_json.js';
import {graphSharingFailure} from './errors.js';
import {SHA256_DIGEST, SHA256_HEX, sha256Digest, type Sha256Digest} from './digest.js';

const STRICT = {errors: 'all', onExcessProperty: 'error'} as const;
const ORGANIZATION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const GIT_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,255}$/u;
const COORDINATOR_URL =
  /^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:127\.0\.0\.1|localhost))(?::\d{1,5})?(?:\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]*)?$/u;
const CAS_REGISTRY = /^cas:\/\/local(?:\/(?:canonical|worker))?$/u;
const OCI_REGISTRY = /^oci:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+$/u;
const CAS_PROFILE = /^cas:\/\/sha256:[0-9a-f]{64}$/u;
const OCI_PROFILE = /^oci:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+@sha256:[0-9a-f]{64}$/u;
const CANONICAL_REMOTE = /^[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/u;

const HexId = Schema.String.check(Schema.isPattern(SHA256_HEX));
const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const NonEmptyShort = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const GRAPH_SHARE_ENROLLMENT_SCHEMA_VERSION = 1 as const;
export const GRAPH_SHARE_PROFILE_SCHEMA_VERSION = 1 as const;

export const GraphShareEnrollmentSchemaV1 = Schema.Struct({
  profile: Schema.String.check(Schema.isPattern(new RegExp(`${CAS_PROFILE.source}|${OCI_PROFILE.source}`, 'u'))),
  publisherKeyFingerprint: Digest,
  repositoryId: HexId,
  schemaVersion: Schema.Literal(GRAPH_SHARE_ENROLLMENT_SCHEMA_VERSION),
});

export type GraphShareEnrollmentV1 = typeof GraphShareEnrollmentSchemaV1.Type;

const RegistryReference = Schema.String.check(
  Schema.isPattern(new RegExp(`${CAS_REGISTRY.source}|${OCI_REGISTRY.source}`, 'u')),
);

export const GraphShareProfileSchemaV1 = Schema.Struct({
  contribution: Schema.Struct({
    activeOnlyOnAcPower: Schema.Boolean,
    activeOnlyWhenIdle: Schema.Boolean,
    defaultMode: Schema.Literals(['off', 'passive', 'idle', 'dedicated']),
    maximumCpus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(64)),
    maximumMemoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    maximumUploadBytesPerSecond: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  coordinator: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String.check(Schema.isPattern(COORDINATOR_URL)),
    }),
  ),
  frontier: Schema.Struct({
    batchMaximumAgeSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    batchMaximumChangedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    batchMaximumChangedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    compactAfterDeltaBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    compactAfterDeltas: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    compactAfterSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    targetMaximumLagSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  organization: Schema.String.check(Schema.isPattern(ORGANIZATION)),
  registry: Schema.Struct({
    canonical: RegistryReference,
    worker: RegistryReference,
  }),
  repositoryId: HexId,
  retention: Schema.Struct({
    checkpointCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32)),
    workMaximumAgeSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  schemaVersion: Schema.Literal(GRAPH_SHARE_PROFILE_SCHEMA_VERSION),
  source: Schema.Struct({
    branches: Schema.Array(Schema.String.check(Schema.isPattern(GIT_REF))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
    canonicalRemote: Schema.String.check(Schema.isPattern(CANONICAL_REMOTE), Schema.isMaxLength(512)),
  }),
  trust: Schema.Struct({
    contributorPolicy: NonEmptyShort,
    publisherKeys: Schema.Array(Digest).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
});

export type GraphShareProfileV1 = typeof GraphShareProfileSchemaV1.Type;

export interface GraphShareProfilePointer {
  readonly digest: Sha256Digest;
  readonly kind: 'cas' | 'oci';
  readonly namespace?: string;
}

export function parseGraphShareEnrollment(value: unknown): GraphShareEnrollmentV1 {
  try {
    return Schema.decodeUnknownSync(GraphShareEnrollmentSchemaV1, STRICT)(value);
  } catch (cause) {
    throw graphSharingFailure('Enrollment pointer is invalid.', cause);
  }
}

export function parseGraphShareProfile(value: unknown): GraphShareProfileV1 {
  try {
    return Schema.decodeUnknownSync(GraphShareProfileSchemaV1, STRICT)(value);
  } catch (cause) {
    throw graphSharingFailure('Organization graph profile is invalid.', cause);
  }
}

export function graphShareProfileDigest(profile: GraphShareProfileV1): Sha256Digest {
  return sha256Digest(canonicalJson(profile));
}

export function parseGraphShareProfilePointer(value: string): GraphShareProfilePointer {
  if (CAS_PROFILE.test(value)) {
    return {digest: `sha256:${value.slice('cas://sha256:'.length)}`, kind: 'cas'};
  }
  if (OCI_PROFILE.test(value)) {
    const at = value.lastIndexOf('@');
    return {
      digest: value.slice(at + 1) as Sha256Digest,
      kind: 'oci',
      namespace: value.slice('oci://'.length, at),
    };
  }
  throw graphSharingFailure('Enrollment profile pointer must be a digest-pinned cas:// or oci:// reference.');
}

export function parseGraphShareCoordinatorUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (cause) {
    throw graphSharingFailure('Coordinator URL is invalid.', cause);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol === 'http:' && !loopback) {
    throw graphSharingFailure('HTTP coordinator URLs must be loopback.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw graphSharingFailure('Coordinator URL must be https or loopback http.');
  }
  if (!COORDINATOR_URL.test(trimmed)) {
    throw graphSharingFailure('Coordinator URL is invalid.');
  }
  const port = parsed.port.length === 0 ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw graphSharingFailure('Coordinator URL port is invalid.');
  }
  return trimmed;
}

export function casProfilePointer(digest: Sha256Digest): string {
  return `cas://${digest}`;
}

export function defaultGraphShareProfile(input: {
  readonly branch: string;
  readonly canonicalRemote: string;
  readonly coordinatorUrl?: string;
  readonly organization: string;
  readonly publisherKeyFingerprint: Sha256Digest;
  readonly repositoryId: string;
}): GraphShareProfileV1 {
  return {
    contribution: {
      activeOnlyOnAcPower: true,
      activeOnlyWhenIdle: true,
      defaultMode: 'passive',
      maximumCpus: 2,
      maximumMemoryBytes: 4_294_967_296,
      maximumUploadBytesPerSecond: 1_048_576,
    },
    ...(input.coordinatorUrl === undefined
      ? {}
      : {coordinator: {url: parseGraphShareCoordinatorUrl(input.coordinatorUrl)}}),
    frontier: {
      batchMaximumAgeSeconds: 30,
      batchMaximumChangedBytes: 104_857_600,
      batchMaximumChangedFiles: 1_000,
      compactAfterDeltaBytes: 1_073_741_824,
      compactAfterDeltas: 16,
      compactAfterSeconds: 21_600,
      targetMaximumLagSeconds: 120,
    },
    organization: input.organization,
    registry: {
      canonical: 'cas://local',
      worker: 'cas://local/worker',
    },
    repositoryId: input.repositoryId,
    retention: {
      checkpointCount: 3,
      workMaximumAgeSeconds: 2_592_000,
    },
    schemaVersion: GRAPH_SHARE_PROFILE_SCHEMA_VERSION,
    source: {
      branches: [input.branch.startsWith('refs/') ? input.branch : `refs/heads/${input.branch}`],
      canonicalRemote: input.canonicalRemote,
    },
    trust: {
      contributorPolicy: 'explicit-join',
      publisherKeys: [input.publisherKeyFingerprint],
    },
  };
}

export function assertEnrollmentMatchesIdentity(enrollment: GraphShareEnrollmentV1, repositoryId: string): void {
  if (enrollment.repositoryId !== repositoryId) {
    throw graphSharingFailure('Enrollment repositoryId does not match the credential-free checkout identity.');
  }
}

export function assertProfileMatchesEnrollment(
  profile: GraphShareProfileV1,
  enrollment: GraphShareEnrollmentV1,
  digest: Sha256Digest,
): void {
  const pointer = parseGraphShareProfilePointer(enrollment.profile);
  if (pointer.digest !== digest) {
    throw graphSharingFailure('Profile digest does not match the enrollment pointer.');
  }
  if (profile.repositoryId !== enrollment.repositoryId) {
    throw graphSharingFailure('Profile repositoryId does not match the enrollment pointer.');
  }
  if (!profile.trust.publisherKeys.includes(enrollment.publisherKeyFingerprint)) {
    throw graphSharingFailure('Enrollment publisher key is not listed in the profile.');
  }
}
