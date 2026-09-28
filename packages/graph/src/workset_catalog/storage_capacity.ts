import {Effect} from 'effect';
import {CodeGraphWorksetCatalogError} from './types.js';

const CATALOG_DISK_SAFETY_BYTES = 512 * 1_024 * 1_024;
const CATALOG_WRITE_AMPLIFICATION = 5;
const CATALOG_ROW_STORAGE_OVERHEAD_BYTES = 256;

export function codeGraphWorksetCatalogWriteRequiredFreeBytes(payloadBytes: number, rows: number): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || !Number.isSafeInteger(rows) || rows < 0) {
    throw invalidCapacityInput();
  }
  const safetyBytes = Math.max(CATALOG_DISK_SAFETY_BYTES, Math.ceil(payloadBytes * 0.1));
  const requiredBytes =
    payloadBytes * CATALOG_WRITE_AMPLIFICATION + rows * CATALOG_ROW_STORAGE_OVERHEAD_BYTES + safetyBytes;
  if (!Number.isSafeInteger(requiredBytes)) throw invalidCapacityInput();
  return requiredBytes;
}

export function verifyCodeGraphWorksetCatalogDiskCapacity(
  probe: (target: string) => Effect.Effect<number | undefined, unknown>,
  target: string,
  requiredBytes: number,
  operation: string,
) {
  return probe(target).pipe(
    Effect.mapError(cause =>
      CodeGraphWorksetCatalogError.of(
        'storage',
        `Could not inspect free disk space before ${operation}. Verify at least ${String(requiredBytes)} bytes are free and retry; the requested data was not staged.`,
        {cause},
      ),
    ),
    Effect.flatMap(availableBytes => {
      if (availableBytes === undefined || !Number.isSafeInteger(availableBytes) || availableBytes < 0) {
        return Effect.fail(
          CodeGraphWorksetCatalogError.of(
            'storage',
            `Could not determine free disk space before ${operation}. Verify at least ${String(requiredBytes)} bytes are free and retry; the requested data was not staged.`,
          ),
        );
      }
      if (availableBytes < requiredBytes) {
        return Effect.fail(
          CodeGraphWorksetCatalogError.of(
            'capacity',
            `${operation} needs ${String(requiredBytes)} bytes free, but only ${String(availableBytes)} bytes are available. Free disk space and retry; the requested data was not staged.`,
          ),
        );
      }
      return Effect.void;
    }),
  );
}

function invalidCapacityInput() {
  return CodeGraphWorksetCatalogError.of('invalid-input', 'Workset catalog storage estimate is invalid.');
}
