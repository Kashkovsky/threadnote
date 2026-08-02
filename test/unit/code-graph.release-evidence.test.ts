import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {
  EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS,
  PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT,
  PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS,
  assertExternalPerformanceEvidence,
  assertExternalRepositoryEvidence,
  assertProductionReleaseEvidence,
  enforceCodeGraphBenchmarkBudget,
  externalSamplerMeasurements,
  materializationStorageMeasurements,
  parseCodeGraphBenchmarkArguments,
  resolvedReleaseEvidenceSource,
} from '../../scripts/benchmark-code-graph.js';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '../../src/evaluation/benchmark.js';
import {validateRetainedPerformancePayload} from '../../website/src/content/performance.js';

const CODE_GRAPH_BUDGETS = 'test/evaluation/baselines/code-graph-v1/budgets.json';
const POLYGLOT_BUDGETS = 'test/evaluation/baselines/code-graph-polyglot-v1/budgets.json';
const BETA30_STAGING_EVIDENCE = 'test/evaluation/baselines/code-graph-v1/beta30-staging-development.json';

describe('code graph release evidence', () => {
  it('keeps the sanitized direct-staging claims, timings, digests, and documentation consistent', () => {
    const evidence = readJson(BETA30_STAGING_EVIDENCE) as {
      readonly observations: readonly {
        readonly bytes?: Readonly<Record<string, number>>;
        readonly digests?: Readonly<Record<string, string>>;
        readonly milliseconds?: Readonly<Record<string, number>>;
        readonly name: string;
        readonly parity?: Readonly<Record<string, boolean>>;
        readonly reviewedClaims?: Readonly<Record<string, boolean | number>>;
      }[];
      readonly provenance: {
        readonly sourceArtifactSha256: Readonly<Record<string, string>>;
      };
    };
    const direct = evidence.observations.find(
      observation => observation.name === 'direct-persistent-materialization-10000',
    );
    expect(direct).toBeDefined();
    expect(evidence.provenance.sourceArtifactSha256['direct-persistent-10000']).toBe(
      '70ec59ed97e41ca085101fcc5fd58d759758a3094b4ec7ec2fc145f5039b511e',
    );
    expect(direct!.milliseconds).toEqual({
      'cold-activation-lexical-only': 667.274583,
      'cold-index': 10548.8525,
      'cold-inventory-and-extraction': 1812.783208,
      'cold-materialization': 5468.52625,
      'cold-post-committed-scan-overlay-and-workspace': 155.001584,
      'cold-pre-activation': 9881.577917,
      'cold-pre-activation-validation': 37.197625,
      'cold-reference-resolution': 2234.327791,
      'cold-registration-lock-and-database-setup': 210.032875,
      'cold-resolved-fact-accounting': 0.906209,
      'cold-snapshot-promotion': 62.470125,
      'cold-snapshot-write-and-checkpoint': 556.407083,
      'cold-vector-index': 0,
      'hot-exact-lexical-query': 208.784416,
      'one-file-reindex-activation-lexical-only': 377.245708,
      'one-file-reindex-index': 852.131708,
      'one-file-reindex-inventory-and-extraction': 32.3295,
      'one-file-reindex-materialization': 20.32775,
      'one-file-reindex-post-committed-scan-overlay-and-workspace': 19.5815,
      'one-file-reindex-pre-activation': 474.886,
      'one-file-reindex-pre-activation-validation': 77.896625,
      'one-file-reindex-reference-resolution': 161.245292,
      'one-file-reindex-registration-lock-and-database-setup': 240.196833,
      'one-file-reindex-resolved-fact-accounting': 1.205125,
      'one-file-reindex-snapshot-promotion': 156.893917,
      'one-file-reindex-snapshot-write-and-checkpoint': 131.654333,
      'one-file-reindex-vector-index': 0,
      'whole-graph-structural-analysis': 522.250625,
    });
    expect(direct!.bytes?.sqliteTempDatabasePagesHighWater).toBe(0);
    expect(direct!.reviewedClaims).toMatchObject({
      coldActivationCopyStagesObserved: 0,
      directPersistentPathObserved: true,
      releaseEvidenceEligible: false,
      temporaryDatabasePagesObserved: false,
    });
    const digests = direct!.digests!;
    expect(Object.values(digests)).toHaveLength(6);
    expect(Object.values(digests).every(digest => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
    expect(digests.primaryQueryCold).toBe(digests.primaryQueryIncremental);
    expect(digests.primaryQueryIncremental).toBe(digests.primaryQuerySameOverlayReference);
    expect(digests.structuralGraphCold).not.toBe(digests.structuralGraphIncremental);
    expect(digests.structuralGraphIncremental).toBe(digests.structuralGraphSameOverlayReference);
    expect(direct!.parity).toEqual({
      coldGraphDiffersAfterTheOneFileMutation: true,
      incrementalGraphMatchesIndependentSameOverlayRebuild: true,
      primaryQueryAcrossColdIncrementalAndReference: true,
    });

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/\/Users\/|[A-Za-z]:\\Users\\|threadnote:\/\/|src\/workspaces\//);
    const documentation = readFileSync('test/evaluation/README.md', 'utf8');
    const normalizedDocumentation = documentation.replace(/\s+/g, ' ');
    for (const [phase, value] of [
      ['cold-snapshot-write-and-checkpoint', 556.407083],
      ['cold-snapshot-promotion', 62.470125],
      ['one-file-reindex-snapshot-write-and-checkpoint', 131.654333],
      ['one-file-reindex-snapshot-promotion', 156.893917],
    ] as const) {
      expect(direct!.milliseconds?.[phase]).toBe(value);
      expect(documentation).toContain(`\`${phase}\`: ${value.toFixed(3)} ms`);
    }
    expect(documentation).toContain('Snapshot write-and-checkpoint ends at promotion start');
    for (const claim of [
      'beta30-staging-development.json',
      'zero observed TEMP database pages',
      'query parity across all three builds',
      'structural parity between the incremental overlay and its independent full rebuild',
    ]) {
      expect(normalizedDocumentation).toContain(claim);
    }
  });

  it('rejects missing, dirty, or mismatched release-source provenance', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() => assertProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, oneFileReindexMaterializationMode: 'full'},
      }),
    ).toThrow(/incremental-overlay materialization mode/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceRef: '', releaseEvidenceSha: ''},
      }),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertProductionReleaseEvidence({...artifact, environment: {...artifact.environment, dirty: true}}),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceSha: 'f'.repeat(40)},
      }),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceResolvedSha: 'f'.repeat(40)},
      }),
    ).toThrow(/clean exact release source provenance/);
  });

  it('requires the declared release ref to resolve to the measured checkout commit', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', commit, commit, commit, false)).toEqual({
      ref: 'refs/tags/v4.0.0-beta.30',
      resolvedSha: commit,
      sha: commit,
    });
    const sha256Commit = 'a'.repeat(64);
    expect(
      resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', sha256Commit, sha256Commit, sha256Commit, false),
    ).toMatchObject({sha: sha256Commit});
    for (const invalidLength of [39, 41, 63, 65]) {
      const invalidCommit = 'a'.repeat(invalidLength);
      expect(() =>
        resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', invalidCommit, invalidCommit, invalidCommit, false),
      ).toThrow(/locally resolvable tag/);
    }
    expect(() =>
      resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', commit, 'f'.repeat(40), commit, false),
    ).toThrow(/locally resolvable tag/);
    expect(() => resolvedReleaseEvidenceSource('refs/heads/main', commit, commit, commit, false)).toThrow(
      /locally resolvable tag/,
    );
    expect(() => resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', commit, commit, commit, true)).toThrow(
      /clean checkout/,
    );
  });

  it('requires aggregate materialization evidence in every production-large artifact', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() => assertProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.filter(measurement => measurement.name !== 'cold-materialization'),
      }),
    ).toThrow(/cold-materialization/);
  });

  it.each([
    'production-shape-file-target-attainment',
    'production-shape-symbol-target-attainment',
    'production-shape-edge-target-attainment',
    'production-shape-lexical-term-target-attainment',
  ])('rejects production evidence when %s misses the reviewed shape floor', measurementName => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    const belowFloor = PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT - 0.001;

    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === measurementName
            ? benchmarkMeasurement(measurement.name, 'percent', [belowFloor])
            : measurement,
        ),
      }),
    ).toThrow(
      new RegExp(
        `${measurementName} expected at least ${PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT}% target attainment`,
      ),
    );
  });

  it('rejects a reduced development profile even when it attains its smaller declared targets', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        profileDeclarationSymbols: 9,
        profileSourceFiles: 4,
        profileTargetEdges: 68,
        profileTargetEligibleFiles: 16,
        profileTargetLexicalTermRows: 300,
        profileTargetSymbols: 20,
        profileWorkspaces: 4,
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() => assertProductionReleaseEvidence(artifact)).toThrow(/reviewed default production-large profile/);
  });

  it('retains and requires split storage planning and relationship deduplication counters', () => {
    expect(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS).toEqual(
      expect.arrayContaining([
        {name: 'cold-materialization-cached-fact-bytes-total-n1', unit: 'bytes'},
        {name: 'cold-materialization-estimated-temp-filesystem-required-n1', unit: 'bytes'},
        {name: 'cold-materialization-estimated-durable-filesystem-required-n1', unit: 'bytes'},
        {name: 'cold-materialization-temp-filesystem-available-n1', unit: 'bytes'},
        {name: 'cold-materialization-durable-filesystem-available-n1', unit: 'bytes'},
        {name: 'cold-materialization-filesystems-shared-n1', unit: 'count'},
        {name: 'cold-materialization-deduplicated-edge-rows-n1', unit: 'count'},
        {name: 'cold-materialization-deduplicated-reference-rows-n1', unit: 'count'},
        {name: 'one-file-reindex-materialization-deduplicated-edge-rows-n1', unit: 'count'},
        {name: 'one-file-reindex-materialization-deduplicated-reference-rows-n1', unit: 'count'},
      ]),
    );
    const retained = new Map(
      materializationStorageMeasurements('cold', {
        cachedFactBytesTotal: 10,
        durableAvailableBytes: 20,
        estimateBasis: 'cached-fact-bytes',
        estimatedDurableFilesystemRequiredBytes: 30,
        estimatedTemporaryFilesystemRequiredBytes: 40,
        filesystemsShared: false,
        temporaryAvailableBytes: 50,
      }).map(measurement => [measurement.name, measurement.minimum]),
    );
    expect(retained).toEqual(
      new Map([
        ['cold-materialization-cached-fact-bytes-total-n1', 10],
        ['cold-materialization-estimated-temp-filesystem-required-n1', 40],
        ['cold-materialization-estimated-durable-filesystem-required-n1', 30],
        ['cold-materialization-temp-filesystem-available-n1', 50],
        ['cold-materialization-durable-filesystem-available-n1', 20],
        ['cold-materialization-filesystems-shared-n1', 0],
      ]),
    );

    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    for (const missing of [
      'cold-materialization-estimated-temp-filesystem-required-n1',
      'cold-materialization-estimated-durable-filesystem-required-n1',
      'cold-materialization-deduplicated-edge-rows-n1',
      'cold-materialization-deduplicated-reference-rows-n1',
    ]) {
      expect(() =>
        assertProductionReleaseEvidence({
          ...artifact,
          measurements: artifact.measurements.filter(measurement => measurement.name !== missing),
        }),
      ).toThrow(new RegExp(missing));
    }
  });

  it('retains and requires sampler v4 recursive process-tree and open temporary-file evidence', () => {
    const retained = new Map(
      externalSamplerMeasurements('cold', {
        intervalMilliseconds: 25,
        phases: {
          materializing: {
            cpuMilliseconds: 100,
            databasePeakBytes: 1_000,
            ioReadBytes: 2_000,
            ioWriteBytes: 3_000,
            processPeakCount: 5,
            processSampleAttempts: 7,
            processSampleFailures: 0,
            processSampleGapPeakMilliseconds: 25,
            processSamples: 7,
            rssPeakBytes: 4_000,
            samples: 8,
            shmPeakBytes: 6_000,
            temporaryOpenAttempts: 6,
            temporaryOpenFailures: 0,
            temporaryPeakBytes: 7_000,
            temporaryLinkedPeakBytes: 1_000,
            temporaryOpenPeakBytes: 6_500,
            temporaryOpenSamples: 6,
            walPeakBytes: 8_000,
          },
          scanning: {
            cpuMilliseconds: 10,
            databasePeakBytes: 100,
            ioReadBytes: 200,
            ioWriteBytes: 300,
            processPeakCount: 3,
            processSampleAttempts: 4,
            processSampleFailures: 0,
            processSampleGapPeakMilliseconds: 20,
            processSamples: 4,
            rssPeakBytes: 400,
            samples: 5,
            shmPeakBytes: 600,
            temporaryOpenAttempts: 3,
            temporaryOpenFailures: 0,
            temporaryPeakBytes: 700,
            temporaryLinkedPeakBytes: 100,
            temporaryOpenPeakBytes: 650,
            temporaryOpenSamples: 3,
            walPeakBytes: 800,
          },
        },
        platform: 'linux',
        processTelemetry: {
          availability: 'available',
          ioCounters: 'linux-proc-read-write-bytes',
          parentIdentityValidation: 'linux-proc-starttime',
          sampleIntervalMilliseconds: 25,
          scope: 'recursive-process-tree',
          source: 'linux-proc',
        },
        samples: 13,
        temporaryTelemetry: {
          availability: 'available',
          maximumOpenFileDescriptors: 65_536,
          maximumProcesses: 4_096,
          openFileSampleIntervalMilliseconds: 25,
          scope: 'temporary-root-linked-plus-process-tree-open-files',
          source: 'linux-proc-fd',
        },
        version: 4,
      }).map(measurement => [measurement.name, measurement.minimum]),
    );
    for (const [name, value] of [
      ['cold-external-sampler-version-n1', 4],
      ['cold-external-storage-samples-n1', 13],
      ['cold-external-process-tree-samples-n1', 11],
      ['cold-external-process-tree-attempts-n1', 11],
      ['cold-external-process-tree-failures-n1', 0],
      ['cold-external-process-tree-maximum-sample-gap-n1', 25],
      ['cold-external-process-count-peak-observed-n1', 5],
      ['cold-external-process-cpu-n1', 110],
      ['cold-external-rss-peak-observed-n1', 4_000],
      ['cold-external-process-physical-read-n1', 2_200],
      ['cold-external-process-physical-write-n1', 3_300],
      ['cold-materializing-external-process-samples-n1', 7],
      ['cold-external-open-temp-process-tree-attempts-n1', 9],
      ['cold-external-open-temp-process-tree-failures-n1', 0],
      ['cold-external-open-temp-process-tree-samples-n1', 9],
      ['cold-external-sqlite-temp-combined-peak-observed-n1', 7_000],
      ['cold-external-sqlite-temp-linked-peak-observed-n1', 1_000],
      ['cold-external-sqlite-temp-open-process-tree-peak-observed-n1', 6_500],
    ] as const) {
      expect(retained.get(name)).toBe(value);
    }

    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-external-process-tree-samples-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/cold-external-process-tree-samples-n1 positive result/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-external-process-tree-failures-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [1])
            : measurement,
        ),
      }),
    ).toThrow(/cold-external-process-tree-failures-n1 expected zero inspection loss/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'one-file-reindex-external-sampler-version-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [3])
            : measurement,
        ),
      }),
    ).toThrow(/one-file-reindex-external-sampler-version-n1 expected sampler v4 or newer/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'same-overlay-reference-external-storage-samples-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/same-overlay-reference-external-storage-samples-n1 positive result/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-external-open-temp-process-tree-failures-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [1])
            : measurement,
        ),
      }),
    ).toThrow(/cold-external-open-temp-process-tree-failures-n1 expected zero inspection loss/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: [
          ...artifact.measurements,
          benchmarkMeasurement('bootstrap-external-open-temp-process-tree-failures-n1', 'count', [1]),
        ],
      }),
    ).toThrow(/bootstrap-external-open-temp-process-tree-failures-n1 expected zero inspection loss/);
  });

  it('requires observed per-stage activation evidence for cold and incremental release runs', () => {
    expect(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS).toEqual(
      expect.arrayContaining([
        {name: 'cold-activation-copying-symbols-duration-n1', unit: 'milliseconds'},
        {name: 'cold-activation-copying-symbols-rows-n1', unit: 'count'},
        {name: 'one-file-reindex-activation-recording-completion-duration-n1', unit: 'milliseconds'},
        {name: 'one-file-reindex-activation-recording-completion-rows-n1', unit: 'count'},
        {name: 'cold-sqlite-durable-database-pages-high-water-n1', unit: 'bytes'},
        {name: 'cold-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
        {name: 'one-file-reindex-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
      ]),
    );
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        oneFileReindexMaterializationStorageMode: 'temporary-staged',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.filter(
          measurement => measurement.name !== 'cold-activation-copying-symbols-duration-n1',
        ),
      }),
    ).toThrow(/cold-activation-copying-symbols-duration-n1/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'one-file-reindex-activation-observed-stages-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/one-file-reindex-activation-observed-stages-n1 expected at least 9 real stages/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, coldMaterializationStorageMode: 'temporary-staged'},
      }),
    ).toThrow(/cold direct-persistent materialization storage mode/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-activation-copying-symbols-observed-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [1])
            : measurement,
        ),
      }),
    ).toThrow(/cold-activation-copying-symbols-observed-n1 expected zero direct-persistent activation copies/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-sqlite-durable-database-pages-high-water-n1'
            ? benchmarkMeasurement(measurement.name, 'bytes', [0])
            : measurement,
        ),
      }),
    ).toThrow(/cold-sqlite-durable-database-pages-high-water-n1 positive result/);
  });

  it('gates materialization independently from end-to-end indexing', () => {
    const measurements = [
      'cold-index',
      'cold-materialization',
      'one-file-reindex-index',
      'one-file-reindex-materialization',
      'hot-exact-lexical-query',
      'whole-graph-structural-analysis',
    ].map(name => benchmarkMeasurement(name, 'milliseconds', [10]));
    const artifact = benchmarkArtifact([
      ...measurements,
      benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [10]),
      benchmarkMeasurement('derived-index-disk', 'bytes', [10]),
    ]);
    const budget = {
      developmentPerformance: {
        coldIndexP95MillisecondsMaximum: 20,
        coldMaterializationP95MillisecondsMaximum: 20,
        derivedIndexBytesMaximum: 20,
        hotQueryP95MillisecondsMaximum: 20,
        oneFileIncrementalP95MillisecondsMaximum: 20,
        oneFileMaterializationP95MillisecondsMaximum: 20,
        processPeakRssBytesMaximum: 20,
        wholeGraphAnalysisP95MillisecondsMaximum: 20,
      },
    };

    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budget, undefined)).not.toThrow();
    const regressed = {
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        measurement.name === 'one-file-reindex-materialization'
          ? benchmarkMeasurement(measurement.name, 'milliseconds', [21])
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkBudget(regressed, budget, undefined)).toThrow(
      /one-file-reindex-materialization/,
    );
  });

  it('accepts repeatable structured controls without retaining them in the artifact contract', () => {
    const javaControl = JSON.stringify({
      expectedLanguage: 'java',
      expectedPath: 'src/Example.java',
      query: 'ExampleService',
    });
    const kotlinControl = JSON.stringify({
      expectedLanguage: 'kotlin',
      expectedPath: 'src/Example.kt',
      query: 'KotlinExample',
    });
    expect(
      parseCodeGraphBenchmarkArguments([
        '--repository',
        '/tmp/external-repository',
        '--incremental-path',
        'src/Example.java',
        '--control',
        javaControl,
        '--control',
        kotlinControl,
        '--output',
        'artifacts/external.json',
      ]),
    ).toMatchObject({
      externalControls: [
        {expectedLanguage: 'java', expectedPath: 'src/Example.java', query: 'ExampleService'},
        {expectedLanguage: 'kotlin', expectedPath: 'src/Example.kt', query: 'KotlinExample'},
      ],
      incrementalPath: 'src/Example.java',
      outputPath: 'artifacts/external.json',
      queryText: 'ExampleService',
      repository: '/tmp/external-repository',
    });
    expect(() =>
      parseCodeGraphBenchmarkArguments(['--repository', '/tmp/external-repository', '--output', 'artifact.json']),
    ).toThrow(/requires --incremental-path, at least one --control, and --output/);
    expect(() =>
      parseCodeGraphBenchmarkArguments([
        '--repository',
        '/tmp/external-repository',
        '--incremental-path',
        'src/Example.java',
        '--control',
        javaControl,
        '--output',
        'artifact.json',
        '--profile',
        'production-large',
      ]),
    ).toThrow(/cannot be combined/);
  });

  it('requires exact-commit aggregate evidence for an external repository soak', () => {
    const controlMeasurements = [
      'cold-materialized-file-rows-language-java',
      'cold-materialized-symbol-rows-language-java',
      'external-query-cold-java-returned-nodes',
      'external-query-cold-java-expected-path-language-nodes',
      'external-query-incremental-java-returned-nodes',
      'external-query-incremental-java-expected-path-language-nodes',
      'external-query-same-overlay-reference-java-returned-nodes',
      'external-query-same-overlay-reference-java-expected-path-language-nodes',
      'external-query-java-same-overlay-structural-parity',
    ].map(name => benchmarkMeasurement(name, 'count', [1]));
    controlMeasurements.push(benchmarkMeasurement('external-query-cold-java-duration', 'milliseconds', [10]));
    const mcpMeasurements = (['query', 'node', 'neighbors', 'explain', 'impact', 'path'] as const).flatMap(
      operation => [
        benchmarkMeasurement(`mcp-${operation}-duration`, 'milliseconds', [10]),
        benchmarkMeasurement(`mcp-${operation}-structured-output`, 'bytes', [1_024]),
        benchmarkMeasurement(`mcp-${operation}-text-output`, 'bytes', [1_024]),
      ],
    );
    const artifact = benchmarkArtifact(
      [
        ...requiredReleaseMeasurements(EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS),
        ...controlMeasurements,
        ...mcpMeasurements,
      ],
      {
        benchmarkDiskFilesystem: 'ext4',
        benchmarkDiskMedium: 'solid-state',
        benchmarkInventoryEligibleFiles: 1,
        benchmarkInventoryExcludedFiles: 0,
        benchmarkLogicalCpuCount: 8,
        coldMaterializationStorageMode: 'direct-persistent',
        externalControlCount: 1,
        externalControlEvidence: JSON.stringify({
          java: {
            path: 'src/Example.java',
            query: 'ExampleService',
            stableNodeId: `cgs_${'1'.repeat(32)}`,
          },
        }),
        externalControlLanguages: 'java',
        externalRepositoryCommit: '0123456789abcdef0123456789abcdef01234567',
        externalRepositoryName: 'Example/public-repository',
        externalRepositoryUrl: 'https://github.com/Example/public-repository',
        managerEdgeBudget: 1_500,
        managerNodeBudget: 500,
        managerSnapshotBindingPassed: true,
        managerStaleRequestCancellationPassed: true,
        managerStaleRequestControl:
          'overlapping real Manager queries; aborted stale result rejected by the GraphWorkspace request gate',
        mcpOperationCount: 6,
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        simultaneousWorktrees: 2,
        sqliteVersion: '3.49.1',
        worktreeIsolationIndexedFiles: 2,
        worktreeIsolationPassed: true,
        worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
      },
      'code-graph-external-repository-v1',
    );

    expect(() => assertExternalRepositoryEvidence(artifact)).not.toThrow();
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        metadata: {...artifact.metadata, oneFileReindexMaterializationMode: 'full'},
      }),
    ).toThrow(/incremental-overlay materialization mode/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        environment: {...artifact.environment, dirty: true},
      }),
    ).toThrow(/clean exact Threadnote source commit/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        environment: {...artifact.environment, fixtureHash: 'external-code-graph-v1:unrelated'},
      }),
    ).toThrow(/external fixture identity tied to its exact commit/);
    expect(() =>
      assertExternalRepositoryEvidence({...artifact, metadata: {...artifact.metadata, externalRepositoryCommit: ''}}),
    ).toThrow(/exact external repository commit/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'external-query-incremental-java-expected-path-language-nodes'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/external-query-incremental-java-expected-path-language-nodes positive result/);
    expect(JSON.stringify(artifact)).toContain('ExampleService');
    expect(JSON.stringify(artifact)).toContain('src/Example.java');
    expect(JSON.stringify(artifact)).not.toMatch(/\/Users\/|[A-Za-z]:\\Users\\|threadnote:\/\//);
  });

  it('requires the complete release-bound public-repository performance contract', () => {
    const languages = ['java', 'kotlin', 'typescript', 'bazel-build'] as const;
    const controls = Object.fromEntries(
      languages.map((language, index) => [
        language === 'bazel-build' ? 'bazel' : language,
        {
          path: `src/control-${index}.${language === 'java' ? 'java' : language === 'kotlin' ? 'kt' : 'ts'}`,
          query: `Control${index}`,
          stableNodeId: `cgs_${String(index + 1).repeat(32)}`,
        },
      ]),
    );
    const controlMeasurements = languages.flatMap(language => [
      benchmarkMeasurement(`cold-materialized-file-rows-language-${language}`, 'count', [1]),
      benchmarkMeasurement(`cold-materialized-symbol-rows-language-${language}`, 'count', [1]),
      benchmarkMeasurement(`external-query-cold-${language}-duration`, 'milliseconds', [10]),
      benchmarkMeasurement(`external-query-cold-${language}-returned-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-cold-${language}-expected-path-language-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-incremental-${language}-returned-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-incremental-${language}-expected-path-language-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-same-overlay-reference-${language}-returned-nodes`, 'count', [1]),
      benchmarkMeasurement(
        `external-query-same-overlay-reference-${language}-expected-path-language-nodes`,
        'count',
        [1],
      ),
      benchmarkMeasurement(`external-query-${language}-same-overlay-structural-parity`, 'count', [1]),
    ]);
    const mcpMeasurements = (['query', 'node', 'neighbors', 'explain', 'impact', 'path'] as const).flatMap(
      operation => [
        benchmarkMeasurement(`mcp-${operation}-duration`, 'milliseconds', [10]),
        benchmarkMeasurement(`mcp-${operation}-structured-output`, 'bytes', [1_024]),
        benchmarkMeasurement(`mcp-${operation}-text-output`, 'bytes', [1_024]),
      ],
    );
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const evidenceMeasurements = [
      ...requiredReleaseMeasurements(EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS),
      ...controlMeasurements,
      ...mcpMeasurements,
    ];
    const evidenceMeasurementNames = new Set(evidenceMeasurements.map(measurement => measurement.name));
    for (const [name, unit] of [
      ['cold-index', 'milliseconds'],
      ['cold-registration-lock-and-database-setup', 'milliseconds'],
      ['cold-inventory-and-extraction', 'milliseconds'],
      ['cold-materialization', 'milliseconds'],
      ['cold-reference-resolution', 'milliseconds'],
      ['cold-activation-lexical-only', 'milliseconds'],
      ['one-file-reindex-index', 'milliseconds'],
      ['same-overlay-full-rebuild-index', 'milliseconds'],
      ['hot-exact-lexical-query', 'milliseconds'],
      ['cold-materialized-file-rows', 'count'],
      ['cold-materialized-symbol-rows', 'count'],
      ['cold-materialized-edge-rows', 'count'],
      ['cold-materialization-deduplicated-reference-rows-n1', 'count'],
      ['cold-materialized-reference-candidate-rows-n1', 'count'],
      ['cold-materialized-lookup-key-rows-n1', 'count'],
      ['cold-materialized-lexical-term-rows', 'count'],
      ['sqlite-main-disk', 'bytes'],
      ['cold-process-peak-rss', 'bytes'],
      ['cold-sqlite-wal-peak-observed', 'bytes'],
      ['cold-sqlite-temp-peak-observed', 'bytes'],
      ['cold-sqlite-durable-database-pages-high-water-n1', 'bytes'],
      ['primary-query-structural-parity', 'count'],
      ['structural-graph-digest-parity', 'count'],
      ['manager-catalog-cold', 'milliseconds'],
      ['manager-catalog-warm', 'milliseconds'],
      ['manager-overview-cold', 'milliseconds'],
      ['manager-overview-warm', 'milliseconds'],
      ['manager-detail-cold', 'milliseconds'],
      ['manager-render-proxy', 'milliseconds'],
      ['manager-response-payload', 'bytes'],
      ['manager-bounded-query', 'milliseconds'],
      ['manager-bounded-query-payload', 'bytes'],
    ] as const) {
      if (!evidenceMeasurementNames.has(name)) evidenceMeasurements.push(benchmarkMeasurement(name, unit, [1]));
    }
    const artifact = benchmarkArtifact(
      evidenceMeasurements,
      {
        benchmarkDiskFilesystem: 'apfs',
        benchmarkDiskMedium: 'solid-state',
        benchmarkInventoryEligibleFiles: 100,
        benchmarkInventoryExcludedFiles: 10,
        benchmarkLogicalCpuCount: 10,
        benchmarkManagedDependencyInstallation: 'bun install --frozen-lockfile',
        benchmarkManagedExecutableSha256: 'c'.repeat(64),
        benchmarkManagedPayloadBytes: 1_024,
        benchmarkManagedPayloadFileCount: 10,
        benchmarkManagedPayloadManifestSha256: 'd'.repeat(64),
        benchmarkManagedProcessLeaseInspection: 'complete',
        benchmarkManagedReleaseMetadataSha256: 'e'.repeat(64),
        benchmarkManagedRuntime: 'bun-test',
        benchmarkManagedTarget: 'linux-x64',
        benchmarkManagedVersion: `4.0.0.local.g${commit}`,
        benchmarkRuntimeProvenanceMode: 'managed-exact-head',
        coldMaterializationStorageMode: 'direct-persistent',
        externalControlCount: 4,
        externalControlEvidence: JSON.stringify(controls),
        externalControlLanguages: languages.join(','),
        externalRepositoryCommit: commit,
        externalRepositoryName: 'JetBrains/intellij-community',
        externalRepositoryUrl: 'https://github.com/JetBrains/intellij-community',
        externalRepositoryMode: 'clean checkout with a byte-compared, scoped one-file overlay',
        managerEdgeBudget: 1_500,
        managerNodeBudget: 500,
        managerSnapshotBindingPassed: true,
        managerStaleRequestCancellationPassed: true,
        managerStaleRequestControl:
          'overlapping real Manager queries; aborted stale result rejected by the GraphWorkspace request gate',
        mcpOperationCount: 6,
        oneFileReindexMaterializationMode: 'incremental-overlay',
        releaseEvidenceRef: 'refs/tags/v4.0.0-beta.31',
        releaseEvidenceResolvedSha: commit,
        releaseEvidenceSha: commit,
        retrievalMode: 'lexical-only',
        sameOverlayReferenceMaterializationMode: 'full',
        simultaneousWorktrees: 2,
        sqliteVersion: '3.49.1',
        structuralGraphDigestCold: '1'.repeat(64),
        structuralGraphDigestIncremental: '2'.repeat(64),
        structuralGraphDigestSameOverlayReference: '2'.repeat(64),
        worktreeIsolationIndexedFiles: 2,
        worktreeIsolationPassed: true,
        worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
      },
      'code-graph-external-repository-v1',
    );

    expect(() => assertExternalPerformanceEvidence(artifact)).not.toThrow();
    expect(() => validateRetainedPerformancePayload(artifact)).not.toThrow();
    expect(() =>
      assertExternalPerformanceEvidence({
        ...artifact,
        metadata: {...artifact.metadata, benchmarkRuntimeProvenanceMode: 'github-actions-clean-source'},
      }),
    ).toThrow(/managed exact-head benchmark runtime provenance/);
    expect(() =>
      assertExternalPerformanceEvidence({
        ...artifact,
        metadata: {...artifact.metadata, managerSnapshotBindingPassed: false},
      }),
    ).toThrow(/Manager exact snapshot binding/);
    expect(() =>
      assertExternalPerformanceEvidence({
        ...artifact,
        metadata: {
          ...artifact.metadata,
          externalControlEvidence: JSON.stringify({
            ...controls,
            java: {...controls.java, stableNodeId: 'not-a-stable-node'},
          }),
        },
      }),
    ).toThrow(/privacy-safe external control evidence matching declared languages/);
  });

  it('keeps materialization ceilings reviewed for every checked graph profile', () => {
    for (const path of [CODE_GRAPH_BUDGETS, POLYGLOT_BUDGETS]) {
      const root = readJson(path) as Readonly<Record<string, unknown>>;
      const budgets = performanceBudgets(root);
      expect(budgets).toHaveLength(path === CODE_GRAPH_BUDGETS ? 6 : 1);
      for (const value of budgets) {
        expect(isPerformanceBudget(value)).toBe(true);
        if (!isPerformanceBudget(value)) continue;
        const budget = value;
        expect(budget.coldMaterializationP95MillisecondsMaximum).toBeGreaterThan(0);
        expect(budget.coldMaterializationP95MillisecondsMaximum).toBeLessThanOrEqual(
          budget.coldIndexP95MillisecondsMaximum,
        );
        expect(budget.oneFileMaterializationP95MillisecondsMaximum).toBeGreaterThan(0);
        expect(budget.oneFileMaterializationP95MillisecondsMaximum).toBeLessThanOrEqual(
          budget.oneFileIncrementalP95MillisecondsMaximum,
        );
      }
    }
  });

  it('runs exact-tag production-large evidence once and gates immutable publication on it', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8')) as BenchmarkWorkflow;
    const evidence = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8')) as BenchmarkWorkflow;
    const publish = load(readFileSync('.github/workflows/publish.yml', 'utf8')) as BenchmarkWorkflow;
    expect(workflow.on.push).toBeUndefined();

    const scheduled = workflow.jobs['code-graph-production-large']!;
    expect(scheduled.if).toContain("github.event_name == 'schedule'");
    expect(scheduled.if).toContain('inputs.include_production_large');
    expect(scheduled.uses).toBe('./.github/workflows/production-large-evidence.yml');

    const releaseGate = publish.jobs['production-large-evidence']!;
    expect(releaseGate.if).toContain("startsWith(github.ref, 'refs/tags/v4.0.0-beta.')");
    expect(releaseGate.if).toContain("startsWith(github.ref, 'refs/tags/v4.0.0-rc.')");
    expect(releaseGate.if).toContain("github.ref == 'refs/tags/v4.0.0'");
    expect(releaseGate.needs).toBe('verify');
    expect(releaseGate.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(releaseGate.with).toMatchObject({
      release_ref: '${{ github.ref }}',
      release_sha: '${{ github.sha }}',
    });
    expect(publish.jobs.publish?.if).toContain("needs.production-large-evidence.result == 'success'");

    const production = evidence.jobs['code-graph-production-large']!;
    const checkout = production.steps?.find(step => step.uses === 'actions/checkout@v7');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 1,
      ref: expect.stringContaining('inputs.release_ref'),
    });
    const verifyRef = production.steps?.find(step => step.name?.includes('release tag resolves'));
    expect(verifyRef?.if).toContain("inputs.release_ref != ''");
    expect(verifyRef?.run).toContain('git rev-parse --verify "${RELEASE_REF}^{commit}"');
    expect(verifyRef?.run).toContain('test "$resolved" = "$RELEASE_SHA"');
    const upload = production.steps?.find(step => step.id === 'upload-production-large');
    expect(upload?.with).toMatchObject({'if-no-files-found': 'error', 'retention-days': 90});
    const capture = production.steps?.find(step => step.name?.includes('Capture one production-large'));
    expect(capture?.env).toMatchObject({
      THREADNOTE_BENCHMARK_RELEASE_REF: '${{ inputs.release_ref }}',
      THREADNOTE_BENCHMARK_RELEASE_SHA: '${{ inputs.release_sha }}',
    });

    for (const jobName of [
      'code-graph',
      'code-graph-10k',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'code-graph-heavy-tail',
      'recall-10k',
    ]) {
      expect(workflow.jobs[jobName]?.if).not.toContain('refs/tags/');
    }
  });
});

interface PerformanceBudget {
  readonly coldIndexP95MillisecondsMaximum: number;
  readonly coldMaterializationP95MillisecondsMaximum: number;
  readonly oneFileIncrementalP95MillisecondsMaximum: number;
  readonly oneFileMaterializationP95MillisecondsMaximum: number;
}

interface BenchmarkWorkflow {
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if?: string;
        readonly needs?: string | readonly string[];
        readonly steps?: readonly {
          readonly env?: Readonly<Record<string, unknown>>;
          readonly if?: string;
          readonly id?: string;
          readonly name?: string;
          readonly run?: string;
          readonly uses?: string;
          readonly with?: Readonly<Record<string, unknown>>;
        }[];
        readonly uses?: string;
        readonly with?: Readonly<Record<string, unknown>>;
      }
    >
  >;
  readonly on: {readonly push?: {readonly tags: readonly string[]}};
}

function benchmarkArtifact(
  measurements: BenchmarkArtifactV1['measurements'],
  metadata: BenchmarkArtifactV1['metadata'] = {},
  suite = 'code-graph-v1',
): BenchmarkArtifactV1 {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const externalCommit =
    typeof metadata.externalRepositoryCommit === 'string' ? metadata.externalRepositoryCommit : undefined;
  return {
    createdAt: '2026-08-01T00:00:00.000Z',
    environment: {
      architecture: 'x64',
      commit,
      cpu: 'test',
      dirty: false,
      fixtureHash:
        suite === 'code-graph-external-repository-v1' && externalCommit
          ? `external-code-graph-v1:${externalCommit}`
          : 'fixture',
      memoryBytes: 1,
      node: 'bun/test',
      operatingSystem: 'linux',
      packageManager: 'bun/test',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements,
    metadata: {
      benchmarkRuntimeProvenanceMode: 'github-actions-clean-source',
      benchmarkRuntimeSourceCommit: commit,
      benchmarkRuntimeSourceLockfileSha256: 'a'.repeat(64),
      benchmarkRuntimeSourcePackageManifestSha256: 'b'.repeat(64),
      ...(suite.startsWith('code-graph-production-large-')
        ? {
            profile: 'production-large',
            profileDeclarationSymbols: 752_000,
            profileSourceFiles: 47_880,
            profileTargetEdges: 2_700_000,
            profileTargetEligibleFiles: 48_000,
            profileTargetLexicalTermRows: 12_000_000,
            profileTargetSymbols: 800_000,
            profileVersion: 1,
            profileWorkspaces: 24,
            releaseEvidenceRef: 'refs/tags/v4.0.0-beta.30',
            releaseEvidenceResolvedSha: commit,
            releaseEvidenceSha: commit,
          }
        : {}),
      ...metadata,
    },
    suite,
    version: 1,
    warmups: 0,
  };
}

function requiredReleaseMeasurements(
  required: readonly {
    readonly name: string;
    readonly unit: BenchmarkArtifactV1['measurements'][number]['unit'];
  }[],
): BenchmarkArtifactV1['measurements'] {
  return required.map(measurement =>
    benchmarkMeasurement(measurement.name, measurement.unit, [
      measurement.name === 'cold-activation-observed-stages-n1'
        ? 3
        : measurement.name.startsWith('production-shape-')
          ? 100
          : measurement.name.startsWith('cold-activation-copying-') && measurement.name.endsWith('-observed-n1')
            ? 0
            : measurement.name.endsWith('-activation-observed-stages-n1')
              ? 32
              : measurement.name.endsWith('-external-sampler-version-n1')
                ? 4
                : measurement.name.endsWith('-external-process-tree-failures-n1') ||
                    measurement.name.endsWith('-external-open-temp-process-tree-failures-n1')
                  ? 0
                  : 1,
    ]),
  );
}

function performanceBudgets(root: Readonly<Record<string, unknown>>): readonly unknown[] {
  const direct = ['developmentPerformance', 'vectorPerformance'].flatMap(name => {
    const value = root[name];
    return value === undefined ? [] : [value];
  });
  const scaled = ['scalePerformance', 'vectorScalePerformance'].flatMap(name => {
    const value = root[name];
    if (typeof value !== 'object' || value === null) return [];
    return Object.values(value);
  });
  return [...direct, ...scaled];
}

function isPerformanceBudget(value: unknown): value is PerformanceBudget {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PerformanceBudget>;
  return [
    candidate.coldIndexP95MillisecondsMaximum,
    candidate.coldMaterializationP95MillisecondsMaximum,
    candidate.oneFileIncrementalP95MillisecondsMaximum,
    candidate.oneFileMaterializationP95MillisecondsMaximum,
  ].every(item => typeof item === 'number' && Number.isFinite(item));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
