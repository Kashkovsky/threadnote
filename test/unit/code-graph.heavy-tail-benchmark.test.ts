import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  parseCodeGraphHeavyTailBenchmarkArtifact,
  parseHeavyTailChildRun,
} from '../../scripts/benchmark-code-graph-heavy-tail.js';
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
        languages: {},
        peakRssBytes: 1,
        readingMilliseconds: 1,
        slowFiles: [],
        state: 'interrupted',
        version: 1,
        workerCount: 1,
      }),
    ).toThrow(/interruption point/i);
    expect(() =>
      parseCodeGraphHeavyTailBenchmarkArtifact({
        createdAt: new Date(0).toISOString(),
        profile: CODE_GRAPH_HEAVY_TAIL_PROFILE,
        runs: {},
        suite: 'code-graph-large-monorepo-heavy-tail-v1',
        version: 1,
      }),
    ).toThrow(/child artifact/i);
  });
});
