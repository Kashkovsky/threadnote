import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  codeGraphHeavyTailRatchetArtifact,
  createCodeGraphHeavyTailRatchet,
  parseCodeGraphHeavyTailBenchmarkArguments,
  parseCodeGraphHeavyTailBenchmarkArtifact,
  parseHeavyTailChildRun,
  type CodeGraphHeavyTailBenchmarkArtifact,
  type HeavyTailChildRun,
  type HeavyTailGovernanceEvidence,
} from '../../scripts/benchmark-code-graph-heavy-tail.js';
import {enforceCodeGraphBenchmarkRatchet} from '../../scripts/benchmark-code-graph.js';
import {
  CODE_GRAPH_HEAVY_TAIL_PROFILE,
  CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES,
  CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE,
  codeGraphHeavyTailEligibleFiles,
  codeGraphHeavyTailGeneratedTypeScript,
  codeGraphHeavyTailJsonFixtures,
  codeGraphHeavyTailLowSignalJson,
  codeGraphHeavyTailPathologicalTypeScript,
  codeGraphHeavyTailRepositoryFiles,
  codeGraphHeavyTailTextlessSvg,
  parseCodeGraphHeavyTailProfile,
} from '../../scripts/code-graph-heavy-tail-fixture.js';

describe('code graph large-monorepo heavy-tail benchmark', () => {
  it('keeps the checked profile synchronized with the reviewed workload shape', async () => {
    const baseline = (await Bun.file('test/evaluation/baselines/code-graph-v1/heavy-tail-profile.json').json()) as {
      readonly profile: unknown;
      readonly reviewedShape: {
        readonly eligibleFiles: number;
        readonly latencyBudget: string;
        readonly repositoryFiles: number;
      };
      readonly version: number;
    };

    expect(baseline.version).toBe(1);
    expect(parseCodeGraphHeavyTailProfile(baseline.profile)).toEqual(CODE_GRAPH_HEAVY_TAIL_PROFILE);
    expect(baseline.reviewedShape.eligibleFiles).toBe(codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE));
    expect(baseline.reviewedShape.repositoryFiles).toBe(
      codeGraphHeavyTailRepositoryFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
    );
    expect(baseline.reviewedShape.latencyBudget).toContain('same-run comparison');
    expect(CODE_GRAPH_HEAVY_TAIL_PROFILE.lowSignalJsonBytes).toBe(25 * 1_048_576);
    expect(CODE_GRAPH_HEAVY_TAIL_PROFILE.textlessSvgFiles).toBeGreaterThanOrEqual(1_000);
    const jsonFixtures = codeGraphHeavyTailJsonFixtures(CODE_GRAPH_HEAVY_TAIL_PROFILE);
    expect([...new Set(jsonFixtures.map(fixture => fixture.bytes))]).toEqual([
      64 * 1_024,
      Math.round(0.8 * 1_048_576),
      Math.round(5.7 * 1_048_576),
      25 * 1_048_576,
    ]);
    expect(jsonFixtures).toHaveLength(4 * CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES);
  });

  it('retains the historical pre-admission observation without turning local latency into a portable gate', async () => {
    const baseline = (await Bun.file('test/evaluation/baselines/code-graph-v1/heavy-tail-development.json').json()) as {
      readonly assertions: Readonly<Record<string, boolean>>;
      readonly interpretation: {readonly latency: string};
      readonly profile: unknown;
      readonly result: {
        readonly cacheFactsBytes: number;
        readonly graphDigest: string;
        readonly lowSignalJsonFactsBytes: number;
      };
      readonly runs: {
        readonly interrupted: {readonly cacheFiles: number};
        readonly resumed: {readonly reusedFiles: number};
      };
    };

    expect(parseCodeGraphHeavyTailProfile(baseline.profile)).toEqual(CODE_GRAPH_HEAVY_TAIL_PROFILE);
    expect(Object.values(baseline.assertions)).toEqual(expect.arrayContaining([true]));
    expect(Object.values(baseline.assertions)).not.toContain(false);
    expect(baseline.result.graphDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.result.lowSignalJsonFactsBytes).toBeLessThanOrEqual(16 * 1_024);
    expect(baseline.result.cacheFactsBytes).toBeLessThan(CODE_GRAPH_HEAVY_TAIL_PROFILE.lowSignalJsonBytes);
    expect(baseline.runs.resumed.reusedFiles).toBe(baseline.runs.interrupted.cacheFiles);
    expect(baseline.interpretation.latency).toContain('one local observation');
  });

  it('generates exact, valid, low-signal JSON without checking a large blob into git', () => {
    const json = codeGraphHeavyTailLowSignalJson(4_096);

    expect(new TextEncoder().encode(json)).toHaveLength(4_096);
    expect(JSON.parse(json)).toMatchObject({frames: [], kind: 'test-snapshot'});
  });

  it('keeps duplicate JSON fixture paths and repository accounting deterministic', () => {
    fc.assert(
      fc.property(fc.integer({max: 2 * 1_048_576, min: 2_048}), lowSignalJsonBytes => {
        const profile = {...CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE, lowSignalJsonBytes};
        const fixtures = codeGraphHeavyTailJsonFixtures(profile);
        expect(fixtures).toHaveLength(4 * CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES);
        expect(new Set(fixtures.map(fixture => fixture.path))).toHaveLength(fixtures.length);
        for (const bytes of new Set(fixtures.map(fixture => fixture.bytes))) {
          expect(fixtures.filter(fixture => fixture.bytes === bytes)).toHaveLength(
            CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES,
          );
        }
        expect(codeGraphHeavyTailRepositoryFiles(profile)).toBe(
          codeGraphHeavyTailEligibleFiles(profile) + fixtures.length + profile.textlessSvgFiles,
        );
      }),
      {numRuns: 64},
    );
  });

  it('keeps generated heavy-tail source sizes and tail declarations valid across bounded shapes', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 64 * 1_024, min: 256}),
        fc.integer({max: 64 * 1_024, min: 512}),
        fc.integer({max: 128, min: 1}),
        (jsonBytes, typescriptBytes, calls) => {
          const json = codeGraphHeavyTailLowSignalJson(jsonBytes);
          const generated = codeGraphHeavyTailGeneratedTypeScript(typescriptBytes);
          const callHeavy = codeGraphHeavyTailPathologicalTypeScript(1, calls);

          expect(new TextEncoder().encode(json)).toHaveLength(jsonBytes);
          expect(() => JSON.parse(json)).not.toThrow();
          expect(new TextEncoder().encode(generated)).toHaveLength(typescriptBytes);
          expect(generated).toContain('interface GeneratedSurfaceTail');
          expect(callHeavy.match(/value \+= dependency\(/g)).toHaveLength(calls);
          expect(callHeavy).toContain('interface PreservedTail001');
        },
      ),
      {numRuns: 64},
    );
  });

  it('generates call-heavy and large-surface TypeScript with declarations after expensive content', () => {
    const callHeavy = codeGraphHeavyTailPathologicalTypeScript(7, 12);
    const generated = codeGraphHeavyTailGeneratedTypeScript(8_192);

    expect(callHeavy.match(/value \+= dependency\(/g)).toHaveLength(12);
    expect(callHeavy).toContain('import {dependency}');
    expect(callHeavy).toContain('export {dependency as forwarded007}');
    expect(callHeavy).toContain('interface PreservedTail007');
    expect(new TextEncoder().encode(generated)).toHaveLength(8_192);
    expect(generated).toContain('interface GeneratedSurfaceTail');
  });

  it('generates textless SVG metadata fixtures', () => {
    const svg = codeGraphHeavyTailTextlessSvg();

    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<text(?:\s|>)/i);
  });

  it('rejects incomplete interruption and aggregate artifacts', () => {
    expect(() =>
      parseHeavyTailChildRun({
        cache: {factsBytes: 1, files: 1, lowSignalJsonFactsBytes: 0},
        cpuMilliseconds: 1,
        durationMilliseconds: 1,
        extraction: {activeWallMilliseconds: 1, averageConcurrency: 1, peakConcurrency: 1, requestMilliseconds: 1},
        languages: {},
        peakRssBytes: 1,
        readingMilliseconds: 1,
        slowFiles: [],
        state: 'interrupted',
        version: 2,
        workerCount: 1,
      }),
    ).toThrow(/interruption point/i);
    expect(() =>
      parseHeavyTailChildRun({
        cache: {factsBytes: 1, files: 1, lowSignalJsonFactsBytes: 0},
        cpuMilliseconds: 1,
        durationMilliseconds: 1,
        extraction: {activeWallMilliseconds: 1, averageConcurrency: 1, peakConcurrency: 1, requestMilliseconds: 1},
        interruptedAfterPersistedFiles: 2,
        languages: {},
        peakRssBytes: 1,
        readingMilliseconds: 1,
        slowFiles: [],
        state: 'interrupted',
        version: 2,
        workerCount: 1,
      }),
    ).toThrow(/cache accounting/i);
    expect(() =>
      parseCodeGraphHeavyTailBenchmarkArtifact({
        createdAt: new Date(0).toISOString(),
        profile: CODE_GRAPH_HEAVY_TAIL_PROFILE,
        runs: {},
        suite: 'code-graph-large-monorepo-heavy-tail-v2',
        version: 2,
      }),
    ).toThrow(/child artifact/i);
  });

  it('requires retained governed evidence before enforcing a ratchet', () => {
    expect(() => parseCodeGraphHeavyTailBenchmarkArguments(['--governed'])).toThrow(/requires --output/u);
    expect(() =>
      parseCodeGraphHeavyTailBenchmarkArguments(['--governed', '--minimum-free-gib', '119', '--output', '/tmp/a']),
    ).toThrow(/at least 120/u);
    expect(() => parseCodeGraphHeavyTailBenchmarkArguments(['--ratchet', '/tmp/r', '--output', '/tmp/a'])).toThrow(
      /requires --governed/u,
    );
    expect(() => parseCodeGraphHeavyTailBenchmarkArguments(['--child', '--governed'])).toThrow(/parent-only/iu);
    expect(
      parseCodeGraphHeavyTailBenchmarkArguments([
        '--governed',
        '--output',
        '/tmp/evidence.json',
        '--ratchet',
        '/tmp/ratchet.json',
      ]),
    ).toMatchObject({governed: true, minimumFreeGiB: 120, ratchetPath: '/tmp/ratchet.json'});
  });

  it('independently ratchets every emitted scheduler, resource, language, resume, and graph measurement', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    const ratchet = createCodeGraphHeavyTailRatchet(artifacts);
    const names = artifacts[0]!.ratchetArtifact.measurements.map(measurement => measurement.name).sort();

    expect(Object.keys(ratchet.measurements).sort()).toEqual(names);
    expect(names).toHaveLength(254);
    expect(names).toEqual(expect.arrayContaining(['parallel-duration', 'parallel-peak-rss']));
    expect(names).toEqual(
      expect.arrayContaining([
        'parallel-extraction-average-concurrency',
        'parallel-extraction-request',
        'resumed-reused-files',
        'resume-retained-cache-coverage',
      ]),
    );
    expect(() => enforceCodeGraphBenchmarkRatchet(artifacts[0]!.ratchetArtifact, ratchet)).not.toThrow();
    expect(ratchet.measurements['interrupted-interrupted-after-persisted-files']).toMatchObject({
      maximum: 268,
      minimum: 256,
    });
    expect(ratchet.measurements['resumed-reused-files']).toMatchObject({maximum: 268, minimum: 256});
    expect(ratchet.measurements['single-reused-files']).toMatchObject({maximum: 0, minimum: 0});
    expect(ratchet.measurements['resume-retained-cache-coverage']).toMatchObject({maximum: 100, minimum: 100});
    const reducedInterruptionOvershoot = {
      ...artifacts[0]!.ratchetArtifact,
      measurements: artifacts[0]!.ratchetArtifact.measurements.map(measurement =>
        ['interrupted-cache-files', 'interrupted-interrupted-after-persisted-files', 'resumed-reused-files'].includes(
          measurement.name,
        )
          ? {...measurement, maximum: 256, mean: 256, minimum: 256, p50: 256, p95: 256, p99: 256}
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkRatchet(reducedInterruptionOvershoot, ratchet)).not.toThrow();

    const durationLimit = ratchet.measurements['parallel-duration']!.p95Maximum!;
    const regressed = {
      ...artifacts[0]!.ratchetArtifact,
      measurements: artifacts[0]!.ratchetArtifact.measurements.map(measurement =>
        measurement.name === 'parallel-duration'
          ? {
              ...measurement,
              maximum: durationLimit + 1,
              mean: durationLimit + 1,
              minimum: durationLimit + 1,
              p50: durationLimit + 1,
              p95: durationLimit + 1,
              p99: durationLimit + 1,
            }
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkRatchet(regressed, ratchet)).toThrow(/parallel-duration/u);
  });

  it('rejects ratchet generation across different exact source commits', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    const mixed = artifacts[2]!;
    const differentCommit = 'e'.repeat(40);
    artifacts[2] = {
      ...mixed,
      environment: {
        ...mixed.environment,
        commit: differentCommit,
        provenance: {...mixed.environment.provenance!, sourceCommit: differentCommit},
      },
      ratchetArtifact: {
        ...mixed.ratchetArtifact,
        environment: {...mixed.ratchetArtifact.environment, commit: differentCommit},
      },
    };

    expect(() => createCodeGraphHeavyTailRatchet(artifacts)).toThrow(/exact source\/runtime\/storage/u);
  });
});

function heavyTailArtifact(offset: number): CodeGraphHeavyTailBenchmarkArtifact {
  const governance: HeavyTailGovernanceEvidence = {
    availableBytes: 200 * 1_073_741_824,
    minimumFreeBytes: 120 * 1_073_741_824,
    runtimeProvenance: {
      mode: 'github-actions-clean-source',
      sourceCommit: 'a'.repeat(40),
      sourceLockfileSha256: 'b'.repeat(64),
      sourcePackageManifestSha256: 'c'.repeat(64),
    },
    storage: {filesystem: 'apfs', location: 'internal', medium: 'solid-state'},
  };
  const single = completeRun(1, 3_200 + offset, 1, offset);
  const parallel = completeRun(4, 2_800 + offset, 3.25, offset);
  const sixWorkers = completeRun(6, 2_900 + offset, 5.1, offset);
  const eightWorkers = completeRun(8, 3_000 + offset, 7.1, offset);
  const interrupted: HeavyTailChildRun = {
    ...baseRun(4, 1_900 + offset, 3.2, offset),
    cache: {factsBytes: 260_396, files: 266, lowSignalJsonFactsBytes: 0},
    interruptedAfterPersistedFiles: 266,
    state: 'interrupted',
  };
  const resumed = {...completeRun(4, 1_600 + offset, 2, offset), reusedFiles: 266};
  const base: Omit<CodeGraphHeavyTailBenchmarkArtifact, 'ratchetArtifact'> = {
    assertions: {
      interruptionRetainedCache: true,
      lowSignalJsonExcluded: true,
      parallelMatchesSingle: true,
      sixWorkersMatchSingle: true,
      pathologicalTypeScriptSurfacePreserved: true,
      resumeMatchesClean: true,
      resumeReusedCache: true,
      textlessSvgExcluded: true,
      eightWorkersMatchSingle: true,
    },
    createdAt: new Date(offset).toISOString(),
    environment: {
      architecture: 'arm64',
      availableBytes: governance.availableBytes,
      commit: 'a'.repeat(40),
      cpu: 'Apple M1 Max',
      dirty: false,
      memoryBytes: 64 * 1_073_741_824,
      minimumFreeBytes: governance.minimumFreeBytes,
      operatingSystem: 'macOS 27.0',
      provenance: governance.runtimeProvenance,
      runtime: 'bun/1.3.14',
      runnerClass: 'pinned-apple-m1-max',
      runnerIdentity: 'local-apple-m1-max',
      storage: governance.storage,
    },
    profile: CODE_GRAPH_HEAVY_TAIL_PROFILE,
    runs: {eightWorkers, interrupted, parallel, resumed, sixWorkers, single},
    suite: 'code-graph-large-monorepo-heavy-tail-v2' as const,
    version: 3 as const,
  };
  return {...base, ratchetArtifact: codeGraphHeavyTailRatchetArtifact(base, 'darwin', governance)};
}

function completeRun(workerCount: number, durationMilliseconds: number, concurrency: number, offset: number) {
  return {
    ...baseRun(workerCount, durationMilliseconds, concurrency, offset),
    graph: {
      digest: 'd'.repeat(64),
      edges: 327,
      files: 268,
      generatedTypeScriptTailPreserved: true,
      lowSignalJsonSymbols: 0,
      pathologicalTypeScriptTails: 8,
      symbols: 550,
      textlessSvgSymbols: 0,
    },
    reusedFiles: 0,
    state: 'complete' as const,
  } satisfies HeavyTailChildRun;
}

function baseRun(workerCount: number, durationMilliseconds: number, concurrency: number, offset: number) {
  const compactLanguage = {
    degradedFiles: 0,
    factsBytes: 128,
    files: 1,
    parseMilliseconds: 1 + offset,
    persistenceMilliseconds: 1 + offset,
    relations: 0,
    requestMilliseconds: 2 + offset,
    sourceBytes: 256,
    symbols: 1,
  };
  return {
    cache: {factsBytes: 260_876, files: 268, lowSignalJsonFactsBytes: 0},
    cpuMilliseconds: 2_700 + offset,
    durationMilliseconds,
    extraction: {
      activeWallMilliseconds: 1_300 + offset,
      averageConcurrency: concurrency,
      peakConcurrency: workerCount,
      requestMilliseconds: 4_300 + offset,
    },
    languages: {
      mixed: compactLanguage,
      'npm-manifest': compactLanguage,
      typescript: {
        degradedFiles: 0,
        factsBytes: 552_458,
        files: 266,
        parseMilliseconds: 1_300 + offset,
        persistenceMilliseconds: 50 + offset,
        requestMilliseconds: 4_290 + offset,
        relations: 327,
        sourceBytes: 5_952_842,
        symbols: 549,
      },
      'typescript-config': compactLanguage,
    },
    peakRssBytes: 390_000_000 + offset,
    readingMilliseconds: 60 + offset,
    slowFiles: [],
    version: 2 as const,
    workerCount,
  };
}
