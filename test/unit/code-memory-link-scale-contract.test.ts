import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseCodeMemoryLinkScaleTargetArguments} from '../../scripts/benchmark-code-memory-link-scale-target.js';
import {
  CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
  CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
  CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
  CODE_MEMORY_LINK_SCALE_SCENARIOS,
  codeMemoryLinkScaleExpectedTruncatedSelectorCount,
  codeMemoryLinkScaleExpectedUris,
  codeMemoryLinkScaleFixtureHash,
  evaluateCodeMemoryLinkScaleCapture,
  parseCodeMemoryLinkScaleArtifactV1,
  parseCodeMemoryLinkScaleBudgetV1,
  type CodeMemoryLinkScaleIdentityV1,
} from '../../src/evaluation/code-memory-link-scale-contract.js';

const BUDGET_FILE = 'test/evaluation/baselines/code-memory-link-scale-v1/budget.json';
const budget = parseCodeMemoryLinkScaleBudgetV1(JSON.parse(await Bun.file(BUDGET_FILE).text()) as unknown);

describe('code-memory-link inverse-selector scale contract', () => {
  it('pins the exact governed 100k release shape and fixed CLI defaults', () => {
    expect(budget).toEqual(CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET);
    expect(codeMemoryLinkScaleFixtureHash()).toBe(CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH);
    expect(
      parseCodeMemoryLinkScaleTargetArguments([
        '--candidate-commit',
        '1'.repeat(40),
        '--built-artifact-sha256',
        '2'.repeat(64),
      ]),
    ).toMatchObject({
      candidateCommit: '1'.repeat(40),
      developmentSmoke: false,
      memoryCandidates: 100_000,
      samples: 25,
      warmups: 5,
    });
    expect(() =>
      parseCodeMemoryLinkScaleTargetArguments(['--candidate-commit', '1'.repeat(40), '--memory-candidates', '99999']),
    ).toThrow('require --development-smoke');
  });

  it('passes exact candidate identity, correctness, no-answer, direct-first, and resource budgets', () => {
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });

    expect(artifact.evidenceClass).toBe('release-scale');
    expect(artifact.gate).toEqual({failures: [], passed: true});
    expect(artifact.metrics).toMatchObject({
      boundedResultAccuracy: 1,
      canonicalMismatchCount: 0,
      directFirstRate: 1,
      directPrecision: 1,
      directRecall: 1,
      duplicateResultCount: 0,
      maximumReturnedMemories: 8,
      noAnswerAccuracy: 1,
      truncatedSelectorCount: 62,
      unexpectedResultCount: 0,
      warmupCountMinimum: 5,
    });
    expect(artifact.metrics.lookupMilliseconds.samples).toBe(100);
    expect(parseCodeMemoryLinkScaleArtifactV1(JSON.parse(JSON.stringify(artifact)), budget)).toEqual(artifact);
  });

  it('cannot relabel a small or dirty run as release-scale evidence', () => {
    const explicitSmoke = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: {...releaseIdentity(), invocationMode: 'development-smoke'},
    });
    expect(explicitSmoke.evidenceClass).toBe('development-smoke');
    expect(explicitSmoke.gate.failures).toContain('invocation mode is development-smoke');

    const smoke = releaseCapture();
    smoke.corpus.materializedMemoryCount = 1_000;
    smoke.corpus.indexedMemoryCount = 1_000;
    smoke.corpus.denseBacklinkMemoryCount = 996;
    smoke.corpus.noiseMemoryCount = 996;
    for (const scenario of smoke.scenarios) {
      scenario.warmups = scenario.warmups.slice(0, 1);
      scenario.samples = scenario.samples.slice(0, 3);
    }
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture: smoke,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: {...releaseIdentity(), dirty: true, invocationMode: 'development-smoke'},
    });
    expect(artifact.evidenceClass).toBe('development-smoke');
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toEqual(
      expect.arrayContaining([
        'artifact is a development smoke, not release-scale evidence',
        'candidate checkout is dirty; required dirty=false',
        'indexed memory corpus 1000; required 100000',
        'materialized memory corpus 1000; required 100000',
      ]),
    );
    expect(() => parseCodeMemoryLinkScaleArtifactV1({...artifact, evidenceClass: 'release-scale'}, budget)).toThrow(
      'evidence class is not derived correctly',
    );
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1(
        {...artifact, execution: {...artifact.execution, inverseLookup: 'toy-array'}},
        budget,
      ),
    ).toThrow('execution path does not match');
    expect(() =>
      parseCodeMemoryLinkScaleArtifactV1({...artifact, metrics: {...artifact.metrics, directRecall: 0}}, budget),
    ).toThrow('metrics do not match');
  });

  it('fails closed when release-scale evidence is relabeled from another runner class', () => {
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture: releaseCapture(),
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: {...releaseIdentity(), runnerClass: 'local-unpinned'},
    });

    expect(artifact.evidenceClass).toBe('development-smoke');
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toContain(
      `runner class local-unpinned; required ${CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS}`,
    );
    expect(() => parseCodeMemoryLinkScaleArtifactV1({...artifact, evidenceClass: 'release-scale'}, budget)).toThrow(
      'evidence class is not derived correctly',
    );
  });

  it('fails on a no-answer leak, repository-isolation decoy, duplicate, or canonical mismatch', () => {
    const capture = releaseCapture();
    const noAnswer = capture.scenarios.find(scenario => scenario.id === 'no-answer')!;
    noAnswer.samples[0] = observation(['threadnote://user/inverse-scale/memories/leaked.md'], 10, 1);
    const file = capture.scenarios.find(scenario => scenario.id === 'file-backlinks')!;
    file.samples[0] = observation([file.expectedUris[0]!, file.expectedUris[0]!, 'threadnote://foreign/decoy.md']);
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });

    expect(artifact.gate.passed).toBe(false);
    expect(artifact.metrics).toMatchObject({
      canonicalMismatchCount: 1,
      duplicateResultCount: 1,
      unexpectedResultCount: 2,
    });
    expect(artifact.metrics.noAnswerAccuracy).toBeLessThan(1);
    expect(artifact.gate.failures).toEqual(
      expect.arrayContaining([
        'canonical selector mismatches 1; required 0',
        'duplicate selector results 1; required 0',
        'unexpected selector results 2; required 0',
      ]),
    );
  });

  it('does not let retained observations redefine frozen URI truth', () => {
    const capture = releaseCapture();
    capture.scenarios[0]!.expectedUris = ['threadnote://foreign/decoy.md'];
    capture.scenarios[0]!.cold.returnedUris = ['threadnote://foreign/decoy.md'];
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toContain('file-backlinks expected URI truth does not match the frozen fixture');
  });

  it('requires the frozen dense scenario to observe bounded shadow-search abstention', () => {
    const capture = releaseCapture();
    const dense = capture.scenarios.find(scenario => scenario.id === 'dense-shared-selector')!;
    dense.samples[0]!.truncatedSelectorCount = 0;
    const artifact = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    expect(artifact.gate.passed).toBe(false);
    expect(artifact.gate.failures).toContain(
      'dense-shared-selector must report exactly 2 bounded selector truncations per lookup',
    );
  });

  it('keeps metrics invariant under measured-sample order', () => {
    const capture = releaseCapture();
    const expected = evaluateCodeMemoryLinkScaleCapture({
      budget,
      capture,
      createdAt: '2026-08-29T00:00:00.000Z',
      identity: releaseIdentity(),
    });
    fc.assert(
      fc.property(fc.shuffledSubarray([...Array(25).keys()], {maxLength: 25, minLength: 25}), order => {
        const permuted = releaseCapture();
        for (const scenario of permuted.scenarios) {
          scenario.samples = order.map(index => scenario.samples[index]!);
        }
        const actual = evaluateCodeMemoryLinkScaleCapture({
          budget,
          capture: permuted,
          createdAt: '2026-08-29T00:00:00.000Z',
          identity: releaseIdentity(),
        });
        expect(actual.metrics).toEqual(expected.metrics);
        expect(actual.gate).toEqual(expected.gate);
      }),
      {numRuns: 40},
    );
  });

  it.each([
    ['corpusMemoryCount', 99_999],
    ['denseBacklinkMemoryCount', 99_995],
    ['minimumSamples', 24],
    ['minimumWarmups', 4],
    ['maximumLookupP95Milliseconds', 251],
    ['maximumAddedPeakRssBytes', CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.maximumAddedPeakRssBytes + 1],
    ['maximumRecallStorageBytes', CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.maximumRecallStorageBytes + 1],
  ] as const)('rejects a weakened %s budget', (key, value) => {
    expect(() => parseCodeMemoryLinkScaleBudgetV1({...budget, [key]: value})).toThrow(`budget ${key}`);
  });
});

function releaseIdentity(): CodeMemoryLinkScaleIdentityV1 {
  return {
    architecture: 'arm64',
    builtArtifactSha256: '2'.repeat(64),
    candidateCommit: '1'.repeat(40),
    cpu: 'reviewed-cpu',
    dirty: false,
    invocationMode: 'release-scale',
    memoryBytes: 64 * 1024 * 1024 * 1024,
    observedCommit: '1'.repeat(40),
    operatingSystem: 'reviewed-os',
    runnerClass: CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS,
    runtime: 'bun/1.3.14',
    sourceVersion: 'threadnote-4.6.0',
  };
}

function releaseCapture() {
  const fileUris = codeMemoryLinkScaleExpectedUris('file-backlinks');
  const symbolUris = codeMemoryLinkScaleExpectedUris('symbol-backlink');
  const denseUris = codeMemoryLinkScaleExpectedUris('dense-shared-selector');
  return {
    corpus: {
      corpusBytes: 32 * 1024 * 1024,
      denseBacklinkMemoryCount: 99_996,
      directBacklinkMemoryCount: 3,
      indexedMemoryCount: 100_000,
      isolationDecoyMemoryCount: 1,
      materializedMemoryCount: 100_000,
      noiseMemoryCount: 99_996,
    },
    fixtureHash: CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH,
    resources: {
      addedPeakRssBytes: 1024 * 1024 * 1024,
      baselineRssBytes: 128 * 1024 * 1024,
      indexBuildMilliseconds: 90_000,
      materializationMilliseconds: 20_000,
      peakRssBytes: 1152 * 1024 * 1024,
      recallDatabaseBytes: 300 * 1024 * 1024,
      recallStorageBytes: 320 * 1024 * 1024,
    },
    scenarios: [
      scenario('file-backlinks', fileUris, 1),
      scenario('symbol-backlink', symbolUris, 2),
      scenario('dense-shared-selector', denseUris, 3),
      scenario('no-answer', [], 4),
    ],
  };
}

function scenario(id: (typeof CODE_MEMORY_LINK_SCALE_SCENARIOS)[number], uris: readonly string[], offset: number) {
  const truncatedSelectorCount = codeMemoryLinkScaleExpectedTruncatedSelectorCount(id);
  return {
    cold: observation(uris, offset, 0, truncatedSelectorCount),
    expectedTruncatedSelectorCount: truncatedSelectorCount,
    expectedUris: [...uris],
    id,
    samples: Array.from({length: 25}, (_, index) => observation(uris, index + 1 + offset, 0, truncatedSelectorCount)),
    warmups: Array.from({length: 5}, (_, index) => observation(uris, index + offset, 0, truncatedSelectorCount)),
  };
}

function observation(
  returnedUris: readonly string[],
  milliseconds = 10,
  canonicalMismatchCount = 0,
  truncatedSelectorCount = 0,
) {
  return {canonicalMismatchCount, milliseconds, returnedUris: [...returnedUris], truncatedSelectorCount};
}
