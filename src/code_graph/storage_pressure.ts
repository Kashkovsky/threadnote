import {saturatingCapacityAdd, saturatingCapacityMultiply} from './disk_capacity.js';
import {type CodeGraphActiveStorage} from './storage.js';

export const CODE_GRAPH_STORAGE_CRITICAL_FLOOR_BYTES = 512 * 1_024 * 1_024;
export const CODE_GRAPH_STORAGE_ELEVATED_FLOOR_BYTES = 2 * 1_024 * 1_024 * 1_024;

export type CodeGraphStoragePressure = 'critical' | 'elevated' | 'normal' | 'unknown';

export interface CodeGraphStoragePressureObservation {
  readonly availableBytes?: number;
  readonly filesystemBytes: number;
  readonly reclaimablePageBytes: number;
  readonly temporaryBytes: number;
  readonly walBytes: number;
}

export interface CodeGraphStoragePressureClassification {
  readonly criticalBelowBytes: number;
  readonly elevatedBelowBytes: number;
  readonly pressure: CodeGraphStoragePressure;
}

export interface CodeGraphStorageAccounting {
  readonly availableBytes?: number;
  /** Exact DB, rollback journal, WAL, and SHM bytes visible on the durable filesystem. */
  readonly filesystemBytes: number;
  /** Logical rows deleted by the maintenance unit; this is not a filesystem-byte claim. */
  readonly logicalRowsDeleted: number;
  /** SQLite freelist pages that remain allocated until explicit safe compaction. */
  readonly reclaimablePageBytes: number;
  readonly pressure: CodeGraphStoragePressure;
  /** Active SQLite TEMP database bytes reported by the current build. */
  readonly temporaryBytes: number;
  readonly walBytes: number;
}

/**
 * Classifies physical pressure without treating SQLite freelist pages or
 * logical deletions as free disk. Falling available space can only strengthen
 * the classification, which keeps pressure-triggered maintenance monotonic.
 */
export function classifyCodeGraphStoragePressure(
  observation: CodeGraphStoragePressureObservation,
): CodeGraphStoragePressureClassification {
  const criticalBelowBytes = Math.max(
    CODE_GRAPH_STORAGE_CRITICAL_FLOOR_BYTES,
    saturatingCapacityMultiply(saturatingCapacityAdd(observation.walBytes, observation.temporaryBytes), 2),
  );
  const elevatedBelowBytes = Math.max(
    CODE_GRAPH_STORAGE_ELEVATED_FLOOR_BYTES,
    Math.floor(Math.max(0, observation.filesystemBytes) / 4),
    saturatingCapacityMultiply(criticalBelowBytes, 2),
  );
  const availableBytes = validBytes(observation.availableBytes) ? observation.availableBytes : undefined;
  const pressure =
    availableBytes === undefined
      ? 'unknown'
      : availableBytes < criticalBelowBytes
        ? 'critical'
        : availableBytes < elevatedBelowBytes
          ? 'elevated'
          : 'normal';
  return {criticalBelowBytes, elevatedBelowBytes, pressure};
}

/** Path-free accounting projection shared by diagnostics and operator output. */
export function codeGraphStorageAccounting(
  storage: Pick<
    CodeGraphActiveStorage,
    'availableBytes' | 'filesystemBytes' | 'pageStorage' | 'temporaryBytes' | 'walBytes'
  >,
  logicalRowsDeleted = 0,
): CodeGraphStorageAccounting {
  const reclaimablePageBytes = storage.pageStorage.state === 'available' ? storage.pageStorage.reclaimableBytes : 0;
  const observation = {
    ...(validBytes(storage.availableBytes) ? {availableBytes: storage.availableBytes} : {}),
    filesystemBytes: storage.filesystemBytes,
    reclaimablePageBytes,
    temporaryBytes: storage.temporaryBytes,
    walBytes: storage.walBytes,
  };
  return {
    ...(observation.availableBytes === undefined ? {} : {availableBytes: observation.availableBytes}),
    filesystemBytes: storage.filesystemBytes,
    logicalRowsDeleted: validBytes(logicalRowsDeleted) ? logicalRowsDeleted : 0,
    pressure: classifyCodeGraphStoragePressure(observation).pressure,
    reclaimablePageBytes,
    temporaryBytes: storage.temporaryBytes,
    walBytes: storage.walBytes,
  };
}

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
