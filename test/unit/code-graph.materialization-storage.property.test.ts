import {expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  initialMaterializationStorageTelemetry,
  observeMaterializationStorage,
  type MaterializationStorageFiles,
} from '../../src/code_graph/indexer_materialization.js';

const bytes = FC.integer({max: 1_000_000_000, min: 0});
const storageFiles = FC.record({
  databaseBytes: bytes,
  journalBytes: bytes,
  sharedMemoryBytes: bytes,
  sidecarDatabaseBytes: bytes,
  sidecarJournalBytes: bytes,
  sidecarSharedMemoryBytes: bytes,
  sidecarWalBytes: bytes,
  walBytes: bytes,
}).map(
  fields =>
    ({
      ...fields,
      totalBytes: Object.values(fields).reduce((total, value) => total + value, 0),
    }) satisfies MaterializationStorageFiles,
);

it.prop(
  'keeps every physical storage high-water monotone while current bytes follow the latest observation',
  {
    includeSidecar: FC.boolean(),
    observations: FC.array(storageFiles, {maxLength: 20, minLength: 1}),
  },
  ({includeSidecar, observations}) => {
    const original = structuredClone(observations);
    let telemetry = initialMaterializationStorageTelemetry(observations[0], includeSidecar);
    for (const observation of observations.slice(1)) {
      const previous = telemetry;
      telemetry = observeMaterializationStorage(telemetry, observation);
      expect(telemetry.durableDatabaseFileHighWaterBytes).toBeGreaterThanOrEqual(
        previous.durableDatabaseFileHighWaterBytes,
      );
      expect(telemetry.durableFilesystemHighWaterBytes).toBeGreaterThanOrEqual(
        previous.durableFilesystemHighWaterBytes,
      );
      expect(telemetry.durableJournalHighWaterBytes).toBeGreaterThanOrEqual(previous.durableJournalHighWaterBytes);
      expect(telemetry.durableSharedMemoryHighWaterBytes).toBeGreaterThanOrEqual(
        previous.durableSharedMemoryHighWaterBytes,
      );
      expect(telemetry.durableWalHighWaterBytes).toBeGreaterThanOrEqual(previous.durableWalHighWaterBytes);
    }

    const latest = observations.at(-1)!;
    expect(telemetry).toMatchObject({
      durableDatabaseFileBytes: latest.databaseBytes,
      durableDatabaseFileHighWaterBytes: Math.max(...observations.map(value => value.databaseBytes)),
      durableDatabaseGrowthBytes: Math.max(0, latest.databaseBytes - observations[0].databaseBytes),
      durableDatabaseGrowthHighWaterBytes: Math.max(
        ...observations.map(value => Math.max(0, value.databaseBytes - observations[0].databaseBytes)),
      ),
      durableDatabaseStartBytes: observations[0].databaseBytes,
      durableFilesystemBytes: latest.totalBytes,
      durableFilesystemHighWaterBytes: Math.max(...observations.map(value => value.totalBytes)),
      durableJournalBytes: latest.journalBytes,
      durableJournalHighWaterBytes: Math.max(...observations.map(value => value.journalBytes)),
      durableSharedMemoryBytes: latest.sharedMemoryBytes,
      durableSharedMemoryHighWaterBytes: Math.max(...observations.map(value => value.sharedMemoryBytes)),
      durableWalBytes: latest.walBytes,
      durableWalHighWaterBytes: Math.max(...observations.map(value => value.walBytes)),
    });
    if (includeSidecar) {
      expect(telemetry).toMatchObject({
        durableSidecarDatabaseBytes: latest.sidecarDatabaseBytes,
        durableSidecarDatabaseHighWaterBytes: Math.max(...observations.map(value => value.sidecarDatabaseBytes)),
        durableSidecarJournalBytes: latest.sidecarJournalBytes,
        durableSidecarJournalHighWaterBytes: Math.max(...observations.map(value => value.sidecarJournalBytes)),
        durableSidecarWalBytes: latest.sidecarWalBytes,
        durableSidecarWalHighWaterBytes: Math.max(...observations.map(value => value.sidecarWalBytes)),
      });
    } else {
      expect(telemetry.durableSidecarDatabaseBytes).toBeUndefined();
      expect(telemetry.durableSidecarJournalBytes).toBeUndefined();
      expect(telemetry.durableSidecarWalBytes).toBeUndefined();
    }
    expect(observations).toEqual(original);
  },
  {fastCheck: {numRuns: 150}},
);
