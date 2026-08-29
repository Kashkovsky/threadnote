import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_DOGFOOD_CASE_IDS,
  codeMemoryLinkDogfoodArtifactHash,
  createCodeMemoryLinkDogfoodObservationV1,
  evaluateCodeMemoryLinkDogfood,
  parseCodeMemoryLinkDogfoodArtifactV1,
  type CodeMemoryLinkDogfoodArtifactV1,
  type CodeMemoryLinkDogfoodObservationSummaryV1,
} from '../../src/evaluation/code-memory-link-dogfood.js';

const CANDIDATE = {buildIdentityHash: 'b'.repeat(64), commit: 'c'.repeat(40), dirty: false as const};
const RUNTIME = {executableSha256: CANDIDATE.buildIdentityHash, sourceCommit: CANDIDATE.commit};
const HARNESS_COMMIT = 'a'.repeat(40);
const RUN_ID = `run_${'d'.repeat(16)}`;

describe('Code Memory Link practical dogfood evidence', () => {
  it('keeps a complete practical matrix insufficient until its exact evidence hash is reviewed', () => {
    const artifact = validArtifact();
    const result = evaluateCodeMemoryLinkDogfood(artifact);

    expect(result).toMatchObject({
      artifactHash: artifact.artifactHash,
      candidate: artifact.candidate,
      evidenceApproved: false,
      gate: {
        failures: ['practical dogfood evidence hash is not in the code-reviewed release allowlist'],
        insufficiencies: ['practical dogfood evidence hash is not in the code-reviewed release allowlist'],
        qualityFailures: [],
        status: 'insufficient',
      },
      version: 1,
    });
  });

  it('fails unsafe, duplicate, unbounded, and semantically wrong practical observations', () => {
    const artifact = validArtifact();
    const observations = artifact.observations.map(observation => {
      if (observation.id === 'file-backlink') return reseal({...observation, duplicateMemoryCount: 1});
      if (observation.id === 'symbol-backlink') return reseal({...observation, estimatedTokens: 1_251});
      if (observation.id === 'no-backlink') {
        return reseal({...observation, directCodeCitationMatches: 1, falseCurrentCount: 1});
      }
      return observation;
    });
    const degraded = withHash({...artifact, observations});
    const result = evaluateCodeMemoryLinkDogfood(degraded);

    expect(result.gate.status).toBe('failed');
    expect(result.gate.qualityFailures).toEqual(
      expect.arrayContaining([
        'file-backlink returned duplicate memories',
        'no-backlink did not satisfy its practical retrieval contract',
        'no-backlink made a false-current claim',
        'symbol-backlink exceeded token budget',
      ]),
    );
  });

  it('hashes every practical outcome and rejects tampering or a noncanonical matrix', () => {
    const artifact = validArtifact();
    expect(() => parseCodeMemoryLinkDogfoodArtifactV1({...artifact, artifactHash: 'f'.repeat(64)})).toThrow(
      /hash does not match/,
    );
    expect(() =>
      codeMemoryLinkDogfoodArtifactHash({
        candidate: artifact.candidate,
        harnessCommit: artifact.harnessCommit,
        observations: artifact.observations.map((observation, index) =>
          index === 0 ? {...observation, responseBytes: observation.responseBytes + 1} : observation,
        ),
        runId: artifact.runId,
        version: 1,
      }),
    ).toThrow(/output digest|summary digest/);
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1(withHash({...artifact, observations: [...artifact.observations].reverse()})),
    ).toThrow(/invocation digest|canonical required case order/);
  });

  it('rejects another-runtime attestations and replayed case summaries', () => {
    const artifact = validArtifact();
    const [first, second] = artifact.observations;
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1({
        ...artifact,
        observations: artifact.observations.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                attestation: {
                  ...entry.attestation,
                  postRuntime: {...entry.attestation.postRuntime, executableSha256: 'e'.repeat(64)},
                },
              }
            : entry,
        ),
      }),
    ).toThrow(/runtime identities differ|exact candidate executable/);
    expect(() =>
      parseCodeMemoryLinkDogfoodArtifactV1({
        ...artifact,
        observations: artifact.observations.map((entry, index) =>
          index === 1 ? {...second!, attestation: first!.attestation} : entry,
        ),
      }),
    ).toThrow(/invocation digest|replayed harness receipts/);
  });

  it('requires the stale-abstention case to retain an independently observed clean snapshot status', () => {
    const artifact = validArtifact();
    const staleIndex = CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.indexOf('stale-graph-abstention');
    const stale = artifact.observations[staleIndex]!;
    const notStale = reseal({...stale, graphStatus: {...stale.graphStatus!, stale: false}});
    const wrongSnapshot = reseal({
      ...stale,
      graphStatus: {...stale.graphStatus!, readySnapshotCommit: 'e'.repeat(40)},
    });

    expect(
      evaluateCodeMemoryLinkDogfood(
        withHash({
          ...artifact,
          observations: artifact.observations.map((entry, index) => (index === staleIndex ? notStale : entry)),
        }),
      ).gate.qualityFailures,
    ).toContain('stale-graph-abstention did not independently observe a stale graph');
    expect(
      evaluateCodeMemoryLinkDogfood(
        withHash({
          ...artifact,
          observations: artifact.observations.map((entry, index) => (index === staleIndex ? wrongSnapshot : entry)),
        }),
      ).gate.qualityFailures,
    ).toContain('stale-graph-abstention graph snapshot does not match the reviewed harness checkout');
  });
});

function validArtifact(): CodeMemoryLinkDogfoodArtifactV1 {
  const observations = CODE_MEMORY_LINK_DOGFOOD_CASE_IDS.map((id, index) => {
    const summary = observation(id);
    return createCodeMemoryLinkDogfoodObservationV1({
      candidate: CANDIDATE,
      harnessCommit: HARNESS_COMMIT,
      invocationNonce: opaqueInvocation(index),
      observation: summary,
      postRuntime: RUNTIME,
      preRuntime: RUNTIME,
      runId: RUN_ID,
    });
  });
  return withHash({
    candidate: CANDIDATE,
    harnessCommit: HARNESS_COMMIT,
    observations,
    runId: RUN_ID,
    version: 1,
  });
}

function observation(
  id: (typeof CODE_MEMORY_LINK_DOGFOOD_CASE_IDS)[number],
): CodeMemoryLinkDogfoodObservationSummaryV1 {
  const base = {
    budgetTokens: 1_250,
    directCodeCitationMatches: 0,
    duplicateMemoryCount: 0,
    estimatedTokens: 500,
    falseCurrentCount: 0,
    graphStatus: null,
    id,
    memoryMatches: 0,
    responseBytes: 1_000,
  } as const;
  if (id === 'task-only-memory') {
    return {
      ...base,
      codeAnchorCoverageComplete: null,
      memoryMatches: 1,
      outputVersion: 2,
      requestedAnchors: 0,
      resolvedAnchors: 0,
    };
  }
  if (id === 'stale-graph-abstention') {
    return {
      ...base,
      codeAnchorCoverageComplete: false,
      graphStatus: {
        readySnapshotCommit: HARNESS_COMMIT,
        readySnapshotDirty: false,
        readySnapshotId: `cgsn_${'f'.repeat(40)}`,
        stale: true,
      },
      outputVersion: 3,
      requestedAnchors: 1,
      resolvedAnchors: 0,
    };
  }
  const anchors = id === 'multi-anchor' ? 2 : 1;
  return {
    ...base,
    codeAnchorCoverageComplete: true,
    directCodeCitationMatches: id === 'no-backlink' ? 0 : 1,
    memoryMatches: id === 'no-backlink' ? 0 : 1,
    outputVersion: 3,
    requestedAnchors: anchors,
    resolvedAnchors: anchors,
  };
}

function reseal(input: ReturnType<typeof validArtifact>['observations'][number]) {
  const {attestation, ...summary} = input;
  return createCodeMemoryLinkDogfoodObservationV1({
    candidate: CANDIDATE,
    harnessCommit: HARNESS_COMMIT,
    invocationNonce: attestation.invocationNonce,
    observation: summary,
    postRuntime: RUNTIME,
    preRuntime: RUNTIME,
    runId: RUN_ID,
  });
}

function opaqueInvocation(index: number): string {
  return `inv_${index.toString(16).padStart(16, '0')}`;
}

function withHash(
  artifact: Omit<CodeMemoryLinkDogfoodArtifactV1, 'artifactHash'> & {readonly artifactHash?: string},
): CodeMemoryLinkDogfoodArtifactV1 {
  const normalized = {
    candidate: artifact.candidate,
    harnessCommit: artifact.harnessCommit,
    observations: artifact.observations,
    runId: artifact.runId,
    version: artifact.version,
  } as const;
  return {...normalized, artifactHash: codeMemoryLinkDogfoodArtifactHash(normalized)};
}
