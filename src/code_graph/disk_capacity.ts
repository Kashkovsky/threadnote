import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  CodeGraphStoreNoSpaceError,
  CodeGraphStoreTransientIoError,
} from './types.js';

export const CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION = 2 as const;

const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_WAL_FRAME_HEADER_BYTES = 24;

export type CodeGraphDirectPersistentCapacityOperation =
  | 'admit code graph vector retirement'
  | 'cache code graph file facts'
  | 'cache materialized code graph file shards'
  | 'prepare code graph vector retirement schema'
  | 'maintain code graph vector retirement'
  | 'publish persistent code graph snapshot'
  | 'promote ready code graph snapshot'
  | 'register persistent code graph materialization plan'
  | 'restore persistent code graph query indexes'
  | 'resolve persistent code graph reexport aliases'
  | 'resolve persistent code graph references'
  | 'retire code graph vector generation'
  | 'retire code graph vector pointer'
  | 'stage persistent code graph facts'
  | 'stage persistent code graph inventory'
  | 'stage persistent code graph workspace'
  | 'prepare temporary incremental code graph activation'
  | 'publish temporary code graph snapshot'
  | 'resolve temporary code graph reexport aliases'
  | 'resolve temporary code graph references'
  | 'stage temporary code graph facts'
  | 'stage temporary code graph inventory'
  | 'stage temporary code graph workspace';

export const CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS = [
  'admit code graph vector retirement',
  'cache code graph file facts',
  'cache materialized code graph file shards',
  'prepare code graph vector retirement schema',
  'maintain code graph vector retirement',
  'publish persistent code graph snapshot',
  'promote ready code graph snapshot',
  'register persistent code graph materialization plan',
  'restore persistent code graph query indexes',
  'resolve persistent code graph reexport aliases',
  'resolve persistent code graph references',
  'retire code graph vector generation',
  'retire code graph vector pointer',
  'stage persistent code graph facts',
  'stage persistent code graph inventory',
  'stage persistent code graph workspace',
  'prepare temporary incremental code graph activation',
  'publish temporary code graph snapshot',
  'resolve temporary code graph reexport aliases',
  'resolve temporary code graph references',
  'stage temporary code graph facts',
  'stage temporary code graph inventory',
  'stage temporary code graph workspace',
] as const satisfies readonly CodeGraphDirectPersistentCapacityOperation[];

type CodeGraphCapacityFailureOperation = CodeGraphDirectPersistentCapacityOperation | 'protect code graph storage';

export interface CodeGraphDirectPersistentCapacityBoundary {
  /** Exact UTF-8 bytes of the bounded logical payload when that evidence is available. */
  readonly finalFactBytes: number;
  readonly operation: CodeGraphDirectPersistentCapacityOperation;
  /** Main pager allocation target; omitted for the durable graph database. */
  readonly mainFilesystem?: 'durable' | 'temporary';
  /** Conservative maximum rows written by the bounded transaction. */
  readonly rowCount: number;
  /** SQLite TEMP writes consume the runtime temporary filesystem, not necessarily the durable graph filesystem. */
  readonly transientFilesystem?: 'durable' | 'temporary';
}

/**
 * The beta.30 production-shaped run is the retained seed for this envelope.
 * It is deliberately versioned with the store and extractor identities so a
 * future format cannot silently inherit stale byte amplification evidence.
 * Direct-persistent transactions write finalized normalized rows, not source
 * blobs; source/cache pressure belongs to the separately bounded cache phase.
 */
export const CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION = {
  identityBase:
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}:${CODE_GRAPH_EXTRACTOR_SET_VERSION}:direct-persistent:` +
    `capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}:extension-r${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}`,
  mainFactAmplification: 5,
  // The beta.30 production-shaped audit observed roughly 100 bytes of both
  // main-DB growth and WAL high-water per staged primary row. Round that
  // retained whole-run ratio up to 256 bytes so row-heavy batches cannot hide
  // behind unusually compact final-fact JSON.
  mainRowBytes: 256,
  transientFactAmplification: 3,
  transientRowBytes: 256,
} as const;

/**
 * Cache blobs have a separately versioned payload calibration. They write the
 * serialized JSON itself, so they must not silently inherit the normalized-row
 * evidence used by direct materialization transactions.
 */
export const CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION = {
  identityBase:
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}:${CODE_GRAPH_EXTRACTOR_SET_VERSION}:cache-payload:` +
    `capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}:extension-r${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}`,
  mainFactAmplification: 5,
  mainRowBytes: 256,
  transientFactAmplification: 3,
  transientRowBytes: 256,
} as const;

/**
 * Vector-v2 retirement mutates a separate SQLite database with a different
 * row and index shape from the repository graph. Keep its conservative
 * envelope independently versioned so vector cleanup cannot silently inherit
 * a calibration for normalized lexical facts.
 */
export const CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:index-publication:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 6,
  mainRowBytes: 1_024,
  transientFactAmplification: 6,
  transientRowBytes: 1_024,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:vector-page:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_ADMISSION_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:admission:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

/**
 * Conservative pre-telemetry envelope for an ordinary retirement unit. The
 * unit combines one exact schema/admission/page plan with two bounded atomic
 * cursor publications, so it must not inherit any single DB-only calibration.
 */
export const CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:ordinary-unit:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 12,
  mainRowBytes: 2_048,
  transientFactAmplification: 12,
  transientRowBytes: 2_048,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_POINTER_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:pointer-transition:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

export interface CodeGraphDirectPersistentCapacityDemandInput {
  readonly finalFactBytes: number;
  readonly lexicalFormatVersion: number;
  readonly mainFilesystem?: 'durable' | 'temporary';
  readonly observedMainHighWaterBytes?: number;
  readonly observedTransientHighWaterBytes?: number;
  readonly operation?: CodeGraphDirectPersistentCapacityOperation;
  readonly pageSize: number;
  readonly rowCount: number;
  readonly transientFilesystem?: 'durable' | 'temporary';
  readonly walAutoCheckpointPages: number;
}

export interface CodeGraphPersistentCapacityDemandInput extends Omit<
  CodeGraphDirectPersistentCapacityDemandInput,
  'finalFactBytes' | 'rowCount'
> {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
}

export interface CodeGraphMeasuredDiskCapacityDemand {
  readonly calibrationIdentity: string;
  readonly mainFilesystem?: 'durable' | 'temporary';
  readonly mainHighWaterBytes: number;
  readonly recoveryFloorBytes: number;
  readonly state: 'measured';
  readonly transientFilesystem: 'durable' | 'temporary';
  readonly transientHighWaterBytes: number;
}

export interface CodeGraphUnknownDiskCapacityDemand {
  readonly calibrationIdentity: string;
  readonly reason: 'calibration-input-unknown' | 'page-storage-unknown';
  readonly state: 'unknown';
}

export type CodeGraphDiskCapacityDemand = CodeGraphMeasuredDiskCapacityDemand | CodeGraphUnknownDiskCapacityDemand;

export interface CodeGraphDiskCapacityReservationProjectionInput {
  readonly demand: CodeGraphDiskCapacityDemand;
  readonly durableFilesystemKey: string;
  readonly freelistBytes: number;
  readonly temporaryFilesystemKey: string;
}

export type CodeGraphDiskCapacityReservationProjection =
  | {
      readonly calibrationIdentity: string;
      readonly filesystems: readonly {readonly bytes: number; readonly key: string}[];
      readonly state: 'measured';
    }
  | {
      readonly calibrationIdentity: string;
      readonly reason: CodeGraphUnknownDiskCapacityDemand['reason'] | 'filesystem-topology-unknown';
      readonly state: 'unknown';
    };

export interface CodeGraphDiskCapacityInput {
  readonly demand: CodeGraphDiskCapacityDemand;
  readonly durableAvailableBytes: number | undefined;
  readonly filesystemsShared: boolean | undefined;
  readonly freelistBytes: number;
  readonly reservedDurableBytes: number;
  readonly reservedTemporaryBytes: number;
  readonly temporaryAvailableBytes: number | undefined;
}

export interface CodeGraphDiskCapacityFilesystemDecision {
  readonly availableBytes: number;
  readonly requiredBytes: number;
  readonly role: 'durable' | 'shared' | 'temporary';
}

export type CodeGraphDiskCapacityDecision =
  | {
      readonly calibrationIdentity: string;
      readonly filesystems: readonly CodeGraphDiskCapacityFilesystemDecision[];
      readonly state: 'healthy';
    }
  | {
      readonly calibrationIdentity: string;
      readonly filesystems: readonly CodeGraphDiskCapacityFilesystemDecision[];
      readonly state: 'pressure';
    }
  | {
      readonly calibrationIdentity: string;
      readonly reason:
        | 'available-space-unknown'
        | 'calibration-input-unknown'
        | 'filesystem-topology-unknown'
        | 'page-storage-unknown'
        | 'reservation-input-unknown';
      readonly state: 'unknown';
    };

export class CodeGraphDiskCapacityObservationError extends CodeGraphStoreTransientIoError {
  constructor() {
    super('Code graph storage capacity could not be observed; the bounded write was not started.', {
      operation: 'observe code graph storage capacity',
    });
  }
}

/** A proactive pressure decision made before its guarded persistent transaction starts. */
export class CodeGraphDiskCapacityPressureError extends CodeGraphStoreNoSpaceError {
  constructor(operation: CodeGraphCapacityFailureOperation) {
    super('Code graph storage capacity is insufficient; the bounded write was not started.', {operation});
  }
}

export function codeGraphDirectPersistentCapacityDemand(
  input: CodeGraphDirectPersistentCapacityDemandInput,
): CodeGraphDiskCapacityDemand {
  return codeGraphPersistentCapacityDemandForCalibration(input, CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION);
}

export function codeGraphPersistentCapacityDemand(
  input: CodeGraphPersistentCapacityDemandInput,
): CodeGraphDiskCapacityDemand {
  const calibration =
    input.boundary.operation === 'cache code graph file facts' ||
    input.boundary.operation === 'cache materialized code graph file shards'
      ? CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION
      : CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION;
  return codeGraphPersistentCapacityDemandForCalibration(
    {
      ...input,
      finalFactBytes: input.boundary.finalFactBytes,
      mainFilesystem: input.boundary.mainFilesystem,
      rowCount: input.boundary.rowCount,
      transientFilesystem: input.boundary.transientFilesystem,
    },
    calibration,
  );
}

export function codeGraphVectorRetirementCapacityDemand(
  input: CodeGraphDirectPersistentCapacityDemandInput,
): CodeGraphDiskCapacityDemand {
  const calibration =
    input.operation === 'prepare code graph vector retirement schema'
      ? CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_CAPACITY_CALIBRATION
      : input.operation === 'retire code graph vector generation'
        ? CODE_GRAPH_VECTOR_RETIREMENT_PAGE_CAPACITY_CALIBRATION
        : input.operation === 'admit code graph vector retirement'
          ? CODE_GRAPH_VECTOR_RETIREMENT_ADMISSION_CAPACITY_CALIBRATION
          : input.operation === 'maintain code graph vector retirement'
            ? CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION
            : input.operation === 'retire code graph vector pointer'
              ? CODE_GRAPH_VECTOR_RETIREMENT_POINTER_CAPACITY_CALIBRATION
              : undefined;
  return calibration === undefined
    ? {
        calibrationIdentity: 'vector-v2:retirement-r1:operation-unknown',
        reason: 'calibration-input-unknown',
        state: 'unknown',
      }
    : codeGraphPersistentCapacityDemandForCalibration(input, calibration);
}

function codeGraphPersistentCapacityDemandForCalibration(
  input: CodeGraphDirectPersistentCapacityDemandInput,
  calibration:
    | typeof CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_ADMISSION_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_POINTER_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_PAGE_CAPACITY_CALIBRATION,
): CodeGraphDiskCapacityDemand {
  const unknown = (reason: CodeGraphUnknownDiskCapacityDemand['reason']): CodeGraphUnknownDiskCapacityDemand => ({
    calibrationIdentity: `${calibration.identityBase}:unmeasured`,
    reason,
    state: 'unknown',
  });
  if (!positiveSafeInteger(input.pageSize)) return unknown('page-storage-unknown');
  if (!positiveSafeInteger(input.lexicalFormatVersion)) return unknown('calibration-input-unknown');
  // Zero disables automatic checkpoints, so there is no measured pager floor
  // for this calibration version. Treat it as unknown instead of inventing a
  // WAL envelope.
  if (!positiveSafeInteger(input.walAutoCheckpointPages)) return unknown('calibration-input-unknown');
  if (
    !nonNegativeSafeInteger(input.finalFactBytes) ||
    !nonNegativeSafeInteger(input.observedMainHighWaterBytes ?? 0) ||
    !nonNegativeSafeInteger(input.observedTransientHighWaterBytes ?? 0) ||
    !nonNegativeSafeInteger(input.rowCount)
  ) {
    return unknown('calibration-input-unknown');
  }
  const finalFactBytes = input.finalFactBytes;
  const pageSize = input.pageSize;
  const rowCount = input.rowCount;
  const mainHighWaterBytes = Math.max(
    pageSize,
    saturatingCapacityMultiply(finalFactBytes, calibration.mainFactAmplification),
    saturatingCapacityMultiply(rowCount, calibration.mainRowBytes),
    input.observedMainHighWaterBytes ?? 0,
  );
  const transientHighWaterBytes = Math.max(
    pageSize,
    saturatingCapacityMultiply(finalFactBytes, calibration.transientFactAmplification),
    saturatingCapacityMultiply(rowCount, calibration.transientRowBytes),
    input.observedTransientHighWaterBytes ?? 0,
  );
  return {
    calibrationIdentity:
      `${calibration.identityBase}:` +
      `lexical-${input.lexicalFormatVersion}:page-${pageSize}:wal-${input.walAutoCheckpointPages}`,
    mainHighWaterBytes,
    ...(input.mainFilesystem === undefined ? {} : {mainFilesystem: input.mainFilesystem}),
    recoveryFloorBytes: Math.max(
      transientHighWaterBytes,
      sqliteWalCapacityBytes(pageSize, input.walAutoCheckpointPages),
    ),
    state: 'measured',
    transientFilesystem: input.transientFilesystem ?? 'durable',
    transientHighWaterBytes,
  };
}

/** Exact bytes occupied by a WAL header and the configured number of full page frames. */
export function sqliteWalCapacityBytes(pageSize: number, pageFrames: number): number {
  return saturatingCapacityAdd(
    SQLITE_WAL_HEADER_BYTES,
    saturatingCapacityMultiply(pageFrames, saturatingCapacityAdd(pageSize, SQLITE_WAL_FRAME_HEADER_BYTES)),
  );
}

/**
 * Projects one bounded transaction onto the exact filesystems that must carry
 * its durable and transient high-water allocations. The receipt ledger and
 * the independent admission oracle share this helper so shared filesystems
 * cannot be counted twice by one of those paths.
 */
export function codeGraphDiskCapacityReservationProjection(
  input: CodeGraphDiskCapacityReservationProjectionInput,
): CodeGraphDiskCapacityReservationProjection {
  const calibrationIdentity = input.demand.calibrationIdentity;
  if (input.demand.state === 'unknown') {
    return {calibrationIdentity, reason: input.demand.reason, state: 'unknown'};
  }
  if (
    !nonNegativeSafeInteger(input.demand.mainHighWaterBytes) ||
    !nonNegativeSafeInteger(input.demand.recoveryFloorBytes) ||
    !nonNegativeSafeInteger(input.demand.transientHighWaterBytes)
  ) {
    return {calibrationIdentity, reason: 'calibration-input-unknown', state: 'unknown'};
  }
  if (!validFilesystemKey(input.durableFilesystemKey) || !validFilesystemKey(input.temporaryFilesystemKey)) {
    return {calibrationIdentity, reason: 'filesystem-topology-unknown', state: 'unknown'};
  }

  const mainHighWaterBytes = capacityBytes(input.demand.mainHighWaterBytes);
  const mainOnDurable = input.demand.mainFilesystem !== 'temporary';
  const freelistBytes = mainOnDurable ? Math.min(mainHighWaterBytes, capacityBytes(input.freelistBytes)) : 0;
  const externalMainBytes = mainHighWaterBytes - freelistBytes;
  const transientHighWaterBytes = capacityBytes(input.demand.transientHighWaterBytes);
  const recoveryFloorBytes = capacityBytes(input.demand.recoveryFloorBytes);
  if (input.durableFilesystemKey === input.temporaryFilesystemKey) {
    return {
      calibrationIdentity,
      filesystems: [
        {
          bytes: saturatingCapacityAdd(externalMainBytes, transientHighWaterBytes, recoveryFloorBytes),
          key: input.durableFilesystemKey,
        },
      ],
      state: 'measured',
    };
  }

  const transientOnDurable = input.demand.transientFilesystem === 'durable';
  const filesystems = [
    {
      bytes: saturatingCapacityAdd(
        mainOnDurable ? externalMainBytes : 0,
        transientOnDurable ? transientHighWaterBytes : 0,
        transientOnDurable ? recoveryFloorBytes : 0,
      ),
      key: input.durableFilesystemKey,
    },
    ...(!mainOnDurable || !transientOnDurable
      ? [
          {
            bytes: saturatingCapacityAdd(
              mainOnDurable ? 0 : externalMainBytes,
              transientOnDurable ? 0 : transientHighWaterBytes,
              transientOnDurable ? 0 : recoveryFloorBytes,
            ),
            key: input.temporaryFilesystemKey,
          },
        ]
      : []),
  ].filter(value => value.bytes > 0);
  return {calibrationIdentity, filesystems, state: 'measured'};
}

/** Pure capacity decision. Unknown topology or measurements always fail closed. */
export function evaluateCodeGraphDiskCapacity(input: CodeGraphDiskCapacityInput): CodeGraphDiskCapacityDecision {
  const calibrationIdentity = input.demand.calibrationIdentity;
  if (input.demand.state === 'unknown') {
    return {calibrationIdentity, reason: input.demand.reason, state: 'unknown'};
  }
  if (!nonNegativeSafeInteger(input.reservedDurableBytes) || !nonNegativeSafeInteger(input.reservedTemporaryBytes)) {
    return {calibrationIdentity, reason: 'reservation-input-unknown', state: 'unknown'};
  }
  if (input.filesystemsShared === undefined) {
    return {calibrationIdentity, reason: 'filesystem-topology-unknown', state: 'unknown'};
  }
  const durableAvailableBytes = availableCapacityBytes(input.durableAvailableBytes);
  const temporaryAvailableBytes = availableCapacityBytes(input.temporaryAvailableBytes);
  const reservedDurableBytes = capacityBytes(input.reservedDurableBytes);
  const reservedTemporaryBytes = capacityBytes(input.reservedTemporaryBytes);
  const durableKey = 'd'.repeat(64);
  const temporaryKey = input.filesystemsShared ? durableKey : 'e'.repeat(64);
  const projection = codeGraphDiskCapacityReservationProjection({
    demand: input.demand,
    durableFilesystemKey: durableKey,
    freelistBytes: input.freelistBytes,
    temporaryFilesystemKey: temporaryKey,
  });
  if (projection.state === 'unknown') {
    return {calibrationIdentity, reason: projection.reason, state: 'unknown'};
  }

  if (input.filesystemsShared) {
    const availableBytes = minimumDefined(durableAvailableBytes, temporaryAvailableBytes);
    if (availableBytes === undefined) {
      return {calibrationIdentity, reason: 'available-space-unknown', state: 'unknown'};
    }
    const filesystems = [
      {
        availableBytes,
        requiredBytes: saturatingCapacityAdd(
          projection.filesystems[0]?.bytes ?? 0,
          reservedDurableBytes,
          reservedTemporaryBytes,
        ),
        role: 'shared',
      },
    ] as const;
    return {
      calibrationIdentity,
      filesystems,
      state: filesystems[0].availableBytes >= filesystems[0].requiredBytes ? 'healthy' : 'pressure',
    };
  }

  if (durableAvailableBytes === undefined) {
    return {calibrationIdentity, reason: 'available-space-unknown', state: 'unknown'};
  }
  const ownerBytes = new Map(projection.filesystems.map(value => [value.key, value.bytes]));
  const durableRequiredBytes = saturatingCapacityAdd(ownerBytes.get(durableKey) ?? 0, reservedDurableBytes);
  const temporaryRequiredBytes = saturatingCapacityAdd(ownerBytes.get(temporaryKey) ?? 0, reservedTemporaryBytes);
  if (temporaryRequiredBytes > 0 && temporaryAvailableBytes === undefined) {
    return {calibrationIdentity, reason: 'available-space-unknown', state: 'unknown'};
  }
  const filesystems: CodeGraphDiskCapacityFilesystemDecision[] = [
    {availableBytes: durableAvailableBytes, requiredBytes: durableRequiredBytes, role: 'durable'},
  ];
  if (temporaryRequiredBytes > 0) {
    filesystems.push({
      availableBytes: temporaryAvailableBytes!,
      requiredBytes: temporaryRequiredBytes,
      role: 'temporary',
    });
  }
  return {
    calibrationIdentity,
    filesystems,
    state: filesystems.every(value => value.availableBytes >= value.requiredBytes) ? 'healthy' : 'pressure',
  };
}

export function codeGraphDiskCapacityFailure(
  decision: CodeGraphDiskCapacityDecision,
  operation: string,
): CodeGraphDiskCapacityPressureError | CodeGraphDiskCapacityObservationError {
  return decision.state === 'pressure'
    ? new CodeGraphDiskCapacityPressureError(capacityOperation(operation))
    : new CodeGraphDiskCapacityObservationError();
}

/** Only these typed failures preserve a deterministic persistent receipt prefix. */
export function isCodeGraphCapacityPause(cause: unknown): boolean {
  return cause instanceof CodeGraphDiskCapacityPressureError || cause instanceof CodeGraphDiskCapacityObservationError;
}

export function saturatingCapacityAdd(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    const next = capacityBytes(value);
    if (next >= Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
    total += next;
  }
  return total;
}

export function saturatingCapacityMultiply(value: number, multiplier: number): number {
  const left = capacityBytes(value);
  const right = capacityBytes(multiplier);
  if (left === 0 || right === 0) return 0;
  if (left > Number.MAX_SAFE_INTEGER / right) return Number.MAX_SAFE_INTEGER;
  return left * right;
}

/** Allocation-free UTF-8 byte count with TextEncoder-compatible lone-surrogate handling. */
export function codeGraphUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let encodedBytes: number;
    if (codeUnit <= 0x7f) encodedBytes = 1;
    else if (codeUnit <= 0x7ff) encodedBytes = 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encodedBytes = 4;
        index += 1;
      } else {
        // WHATWG UTF-8 encoders replace an unpaired surrogate with U+FFFD.
        encodedBytes = 3;
      }
    } else {
      // BMP code points and unpaired low surrogates both occupy three bytes.
      encodedBytes = 3;
    }
    bytes = saturatingCapacityAdd(bytes, encodedBytes);
  }
  return bytes;
}

function capacityBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function availableCapacityBytes(value: number | undefined): number | undefined {
  return value === undefined || !Number.isSafeInteger(value) || value < 0 ? undefined : value;
}

function capacityOperation(operation: string): CodeGraphCapacityFailureOperation {
  switch (operation) {
    case 'admit code graph vector retirement':
    case 'cache code graph file facts':
    case 'cache materialized code graph file shards':
    case 'maintain code graph vector retirement':
    case 'prepare code graph vector retirement schema':
    case 'publish persistent code graph snapshot':
    case 'promote ready code graph snapshot':
    case 'register persistent code graph materialization plan':
    case 'restore persistent code graph query indexes':
    case 'resolve persistent code graph reexport aliases':
    case 'resolve persistent code graph references':
    case 'retire code graph vector generation':
    case 'retire code graph vector pointer':
    case 'stage persistent code graph facts':
    case 'stage persistent code graph inventory':
    case 'stage persistent code graph workspace':
    case 'prepare temporary incremental code graph activation':
    case 'publish temporary code graph snapshot':
    case 'resolve temporary code graph reexport aliases':
    case 'resolve temporary code graph references':
    case 'stage temporary code graph facts':
    case 'stage temporary code graph inventory':
    case 'stage temporary code graph workspace':
      return operation;
    default:
      return 'protect code graph storage';
  }
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validFilesystemKey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
