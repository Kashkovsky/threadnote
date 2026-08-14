import embeddingContextArtifact from '../../../test/evaluation/candidates/threadnote-4.2.5/benchmarks/darwin-arm64-m1-max/code-graph-embedding-contexts-10000-2026-08-14.json' with {type: 'json'};

export const embeddingContextPerformanceArtifactPath = 'evidence/code-graph-embedding-contexts-10000-v4.2.5.json';

export const embeddingContextCapacities = [1, 2, 4, 8] as const;

export interface EmbeddingContextDistribution {
  readonly maximum: number;
  readonly median: number;
  readonly minimum: number;
  readonly p25: number;
  readonly p75: number;
}

export function summarizeEmbeddingContextValues(values: readonly number[]): EmbeddingContextDistribution {
  if (values.length === 0 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('Embedding-context evidence requires non-negative finite observations.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
  return {
    maximum: sorted.at(-1)!,
    median: percentile(0.5),
    minimum: sorted[0]!,
    p25: percentile(0.25),
    p75: percentile(0.75),
  };
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-12);
}

function validateDistribution(label: string, stored: EmbeddingContextDistribution, values: readonly number[]): void {
  const computed = summarizeEmbeddingContextValues(values);
  for (const key of ['maximum', 'median', 'minimum', 'p25', 'p75'] as const) {
    if (!closeEnough(stored[key], computed[key])) {
      throw new Error(`Embedding-context ${label}.${key} does not match its raw observations.`);
    }
  }
}

const sha256Pattern = /^[a-f0-9]{64}$/;

if (
  embeddingContextArtifact.schemaVersion !== 1 ||
  embeddingContextArtifact.scope.name !== 'cpu-code-graph-embedding-context-sweep' ||
  embeddingContextArtifact.scope.scaleSymbols !== 10_000 ||
  embeddingContextArtifact.scope.rounds < 4 ||
  embeddingContextArtifact.scope.rounds % 4 !== 0 ||
  embeddingContextArtifact.scope.schedule.length !== embeddingContextArtifact.scope.rounds ||
  embeddingContextArtifact.scope.observations !== embeddingContextArtifact.observations.length ||
  embeddingContextArtifact.scope.observations !==
    embeddingContextArtifact.scope.rounds * embeddingContextCapacities.length ||
  !/^[a-f0-9]{40}$/.test(embeddingContextArtifact.source.threadnoteCommit) ||
  embeddingContextArtifact.source.harness.commit !== embeddingContextArtifact.source.threadnoteCommit ||
  embeddingContextArtifact.source.harness.path !== 'scripts/benchmark-code-graph-embedding-contexts.ts' ||
  !/^[a-f0-9]{64}$/.test(embeddingContextArtifact.source.harness.sha256) ||
  embeddingContextArtifact.environment.dirty !== false ||
  embeddingContextArtifact.environment.cpuMathCores < 1 ||
  embeddingContextArtifact.environment.modelGpuLayers !== 0 ||
  embeddingContextArtifact.controls.vectorMappingDigests.length !== 1 ||
  embeddingContextArtifact.controls.coldStructuralGraphDigests.length !== 1 ||
  embeddingContextArtifact.controls.incrementalStructuralGraphDigests.length !== 1 ||
  embeddingContextArtifact.controls.sameOverlayStructuralGraphDigests.length !== 1 ||
  embeddingContextArtifact.controls.vectorRowCounts.length !== 1 ||
  !embeddingContextArtifact.controls.vectorMappingDigests.every(digest => sha256Pattern.test(digest)) ||
  !embeddingContextArtifact.controls.coldStructuralGraphDigests.every(digest => sha256Pattern.test(digest)) ||
  !embeddingContextArtifact.controls.incrementalStructuralGraphDigests.every(digest => sha256Pattern.test(digest)) ||
  !embeddingContextArtifact.controls.sameOverlayStructuralGraphDigests.every(digest => sha256Pattern.test(digest)) ||
  embeddingContextArtifact.controls.incrementalStructuralGraphDigests[0] !==
    embeddingContextArtifact.controls.sameOverlayStructuralGraphDigests[0] ||
  !embeddingContextArtifact.controls.allIncrementalDigestsMatchIndependentRebuild ||
  embeddingContextArtifact.controls.samplerVersionMinimum < 4 ||
  embeddingContextArtifact.controls.processTreeFailures !== 0 ||
  embeddingContextArtifact.controls.maximumColdSamplerGapMilliseconds > 1_000 ||
  !embeddingContextArtifact.promotion.eligibleForReviewedDefaultChange
) {
  throw new Error('Checked-in embedding-context evidence has invalid provenance, controls, or promotion state.');
}

const observationKeys = new Set(
  embeddingContextArtifact.observations.map(observation => `${observation.round}:${observation.position}`),
);
if (
  observationKeys.size !== embeddingContextArtifact.observations.length ||
  embeddingContextArtifact.observations.some(
    observation => observation.vectorRows !== embeddingContextArtifact.controls.vectorRowCounts[0],
  )
) {
  throw new Error('Checked-in embedding-context observations have duplicate slots or inconsistent vector rows.');
}

for (const [roundIndex, order] of embeddingContextArtifact.scope.schedule.entries()) {
  if (
    order.length !== embeddingContextCapacities.length ||
    [...order].sort((left, right) => left - right).some((value, index) => value !== embeddingContextCapacities[index])
  ) {
    throw new Error(`Embedding-context round ${roundIndex + 1} is not a complete candidate order.`);
  }
  for (const [positionIndex, contexts] of order.entries()) {
    const observation = embeddingContextArtifact.observations.find(
      candidate => candidate.round === roundIndex + 1 && candidate.position === positionIndex + 1,
    );
    if (observation?.contexts !== contexts) {
      throw new Error(`Embedding-context round ${roundIndex + 1} does not match its retained schedule.`);
    }
  }
}

const results = embeddingContextCapacities.map(contexts => {
  const observations = embeddingContextArtifact.observations.filter(observation => observation.contexts === contexts);
  const stored = embeddingContextArtifact.contexts[String(contexts) as keyof typeof embeddingContextArtifact.contexts];
  if (observations.length !== embeddingContextArtifact.scope.rounds || stored.observations !== observations.length) {
    throw new Error(`Embedding-context capacity ${contexts} has incomplete observations.`);
  }
  validateDistribution(
    `${contexts}.coldEmbeddingCpuMilliseconds`,
    stored.coldEmbeddingCpuMilliseconds,
    observations.map(observation => observation.coldEmbeddingCpuMilliseconds),
  );
  validateDistribution(
    `${contexts}.coldEmbeddingRssBytes`,
    stored.coldEmbeddingRssBytes,
    observations.map(observation => observation.coldEmbeddingRssBytes),
  );
  validateDistribution(
    `${contexts}.coldIndexMilliseconds`,
    stored.coldIndexMilliseconds,
    observations.map(observation => observation.coldIndexMilliseconds),
  );
  validateDistribution(
    `${contexts}.coldSamplerGapMilliseconds`,
    stored.coldSamplerGapMilliseconds,
    observations.map(observation => observation.coldSamplerGapMilliseconds),
  );
  validateDistribution(
    `${contexts}.coldVectorMilliseconds`,
    stored.coldVectorMilliseconds,
    observations.map(observation => observation.coldVectorMilliseconds),
  );
  validateDistribution(
    `${contexts}.heartbeatGapMilliseconds`,
    stored.heartbeatGapMilliseconds,
    observations.map(observation => observation.heartbeatGapMilliseconds),
  );
  validateDistribution(
    `${contexts}.vectorIndexBytes`,
    stored.vectorIndexBytes,
    observations.map(observation => observation.vectorIndexBytes),
  );
  const pairedSpeedups = observations.map(observation => {
    const baseline = embeddingContextArtifact.observations.find(
      candidate => candidate.round === observation.round && candidate.contexts === 1,
    );
    if (!baseline) throw new Error(`Embedding-context round ${observation.round} has no serial baseline.`);
    return baseline.coldIndexMilliseconds / observation.coldIndexMilliseconds;
  });
  const pairedMedianSpeedup = summarizeEmbeddingContextValues(pairedSpeedups).median;
  if (!closeEnough(stored.medianSpeedupAgainstOne, pairedMedianSpeedup)) {
    throw new Error(`Embedding-context capacity ${contexts} has an invalid paired median speedup.`);
  }
  return {
    contexts,
    coldEmbeddingRssBytes: stored.coldEmbeddingRssBytes,
    coldIndexMilliseconds: stored.coldIndexMilliseconds,
    coldVectorMilliseconds: stored.coldVectorMilliseconds,
    pairedMedianSpeedup,
  } as const;
});

const baseline = results[0];
const winner = results.reduce((selected, candidate) =>
  candidate.coldIndexMilliseconds.median < selected.coldIndexMilliseconds.median ? candidate : selected,
);
const roundWinsAgainstOne = embeddingContextArtifact.observations.filter(observation => {
  if (observation.contexts !== winner.contexts) return false;
  const pairedBaseline = embeddingContextArtifact.observations.find(
    candidate => candidate.round === observation.round && candidate.contexts === baseline.contexts,
  );
  return pairedBaseline !== undefined && observation.coldIndexMilliseconds < pairedBaseline.coldIndexMilliseconds;
}).length;
if (
  embeddingContextArtifact.promotion.candidate !== winner.contexts ||
  embeddingContextArtifact.promotion.roundWinsAgainstOne !== roundWinsAgainstOne ||
  roundWinsAgainstOne < embeddingContextArtifact.promotion.requiredRoundWins ||
  winner.pairedMedianSpeedup < embeddingContextArtifact.promotion.minimumMedianSpeedup
) {
  throw new Error('Checked-in embedding-context promotion does not match its raw observations.');
}

/**
 * Same-machine, generated-fixture evidence for the CPU embedding pool selected
 * for graph builds in v4.2.5. Accelerator and interactive-query behavior are
 * intentionally outside this comparison.
 */
export const checkedInEmbeddingContextPerformance = {
  artifactPath: embeddingContextPerformanceArtifactPath,
  controls: embeddingContextArtifact.controls,
  environment: embeddingContextArtifact.environment,
  generatedAt: embeddingContextArtifact.generatedAt,
  promotion: embeddingContextArtifact.promotion,
  results,
  rssIncreasePercent: (winner.coldEmbeddingRssBytes.median / baseline.coldEmbeddingRssBytes.median - 1) * 100,
  scope: embeddingContextArtifact.scope,
  source: embeddingContextArtifact.source,
  winner,
} as const;
