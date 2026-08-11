import {ScriptError} from './effect/errors.js';
import {Database} from 'bun:sqlite';

const MEBIBYTE = 1024 * 1024;

export const VECTOR_DATABASE_BYTES_PER_DOCUMENT = 4_096;
export const VECTOR_DATABASE_FIXED_OVERHEAD_BYTES = 4 * MEBIBYTE;
export const VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM = 64 * 1024;

export interface VectorDatabaseStorageMeasurement {
  readonly compactedBytes: number;
  readonly databaseBytes: number;
}

export interface VectorDatabaseStorageBudget {
  readonly databaseBytesMaximum: number;
  readonly databaseBytesWithinBudget: boolean;
  readonly incrementalCompactedBytes: number;
  readonly incrementalCompactedBytesMaximum: number;
  readonly incrementalCompactedBytesWithinBudget: boolean;
}

export function createCompactedSqliteSnapshot(databasePath: string, snapshotPath: string): void {
  const database = new Database(databasePath, {readonly: true});
  try {
    database.run('VACUUM INTO ?', [snapshotPath]);
  } finally {
    database.close();
  }
}

export function assessVectorDatabaseStorage(
  documents: number,
  initial: VectorDatabaseStorageMeasurement,
  incremental: VectorDatabaseStorageMeasurement,
): VectorDatabaseStorageBudget {
  if (!Number.isSafeInteger(documents) || documents <= 0) {
    throw new ScriptError('Vector database storage budget requires a positive document count.');
  }
  assertMeasurement(initial);
  assertMeasurement(incremental);
  const databaseBytesMaximum = safeSum(
    safeProduct(documents, VECTOR_DATABASE_BYTES_PER_DOCUMENT, 'per-document storage budget'),
    VECTOR_DATABASE_FIXED_OVERHEAD_BYTES,
    'database storage budget',
  );
  const incrementalCompactedBytes = incremental.compactedBytes - initial.compactedBytes;
  return {
    databaseBytesMaximum,
    databaseBytesWithinBudget: Math.max(initial.databaseBytes, incremental.databaseBytes) <= databaseBytesMaximum,
    incrementalCompactedBytes,
    incrementalCompactedBytesMaximum: VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM,
    incrementalCompactedBytesWithinBudget:
      incrementalCompactedBytes <= VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM,
  };
}

function assertMeasurement(measurement: VectorDatabaseStorageMeasurement): void {
  if (
    !Number.isSafeInteger(measurement.compactedBytes) ||
    measurement.compactedBytes < 0 ||
    !Number.isSafeInteger(measurement.databaseBytes) ||
    measurement.databaseBytes < 0
  ) {
    throw new ScriptError('Invalid vector database storage measurement.');
  }
}

function safeProduct(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) throw new ScriptError(`Invalid ${label}.`);
  return value;
}

function safeSum(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new ScriptError(`Invalid ${label}.`);
  return value;
}
