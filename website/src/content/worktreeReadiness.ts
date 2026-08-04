import worktreeReadinessArtifact from '../../../test/evaluation/candidates/threadnote-4.0.1/benchmarks/darwin-arm64-m1-max/code-graph-worktree-readiness-2026-08-04.json' with {type: 'json'};

export const worktreeReadinessArtifactPath = 'evidence/code-graph-worktree-readiness-v4.0.1.json';

export interface WorktreeReadinessDurationSummary {
  readonly maximumMilliseconds: number;
  readonly medianMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly samples: number;
}

export function summarizeWorktreeReadinessDurations(values: readonly number[]): WorktreeReadinessDurationSummary {
  if (values.length === 0 || values.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Worktree-readiness evidence requires positive finite duration samples.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    maximumMilliseconds: sorted.at(-1)!,
    medianMilliseconds: sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    minimumMilliseconds: sorted[0]!,
    samples: sorted.length,
  };
}

export function worktreeReadinessSpeedup(baselineMilliseconds: number, candidateMilliseconds: number): number {
  if (
    !Number.isFinite(baselineMilliseconds) ||
    !Number.isFinite(candidateMilliseconds) ||
    baselineMilliseconds <= 0 ||
    candidateMilliseconds <= 0
  ) {
    throw new Error('Worktree-readiness speedup requires positive finite durations.');
  }
  return baselineMilliseconds / candidateMilliseconds;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-12);
}

function validateStoredSummary(
  label: string,
  stored: WorktreeReadinessDurationSummary,
  durations: readonly number[],
): WorktreeReadinessDurationSummary {
  const computed = summarizeWorktreeReadinessDurations(durations);
  for (const key of ['maximumMilliseconds', 'medianMilliseconds', 'minimumMilliseconds'] as const) {
    if (!closeEnough(stored[key], computed[key])) {
      throw new Error(`Worktree-readiness ${label}.${key} does not match its raw observations.`);
    }
  }
  if (stored.samples !== computed.samples) {
    throw new Error(`Worktree-readiness ${label}.samples does not match its raw observations.`);
  }
  return computed;
}

type ScenarioName = 'graphEquivalentCommit' | 'oneFileChange';

function validateScenario(
  name: ScenarioName,
  expectedCandidateMode: 'incremental-clean' | 'reused-snapshot',
  expectedCandidateStagedFiles: number,
) {
  const scenario = worktreeReadinessArtifact.scenarios[name];
  if (!scenario.graphParityPassed || !scenario.queryParityPassed) {
    throw new Error(`Worktree-readiness ${name} did not retain graph and query parity.`);
  }
  const baselineDurations = scenario.baseline.observations.map(observation => observation.durationMilliseconds);
  const candidateDurations = scenario.candidate.observations.map(observation => observation.durationMilliseconds);
  const baseline = validateStoredSummary(name, scenario.baseline, baselineDurations);
  const candidate = validateStoredSummary(name, scenario.candidate, candidateDurations);
  if (baseline.samples !== worktreeReadinessArtifact.scope.samples || candidate.samples !== baseline.samples) {
    throw new Error(`Worktree-readiness ${name} does not contain the declared sample count.`);
  }
  if (
    scenario.baseline.materializationModes.length !== 1 ||
    scenario.baseline.materializationModes[0] !== 'full' ||
    scenario.baseline.observations.some(
      observation => observation.materializationMode !== 'full' || observation.stagedFiles !== observation.totalFiles,
    )
  ) {
    throw new Error(`Worktree-readiness ${name} baseline did not retain full-materialization controls.`);
  }
  if (
    scenario.candidate.materializationModes.length !== 1 ||
    scenario.candidate.materializationModes[0] !== expectedCandidateMode ||
    scenario.candidate.observations.some(
      observation =>
        observation.materializationMode !== expectedCandidateMode ||
        observation.stagedFiles !== expectedCandidateStagedFiles,
    )
  ) {
    throw new Error(`Worktree-readiness ${name} did not retain its v4.0.1 materialization path.`);
  }
  const medianSpeedup = worktreeReadinessSpeedup(baseline.medianMilliseconds, candidate.medianMilliseconds);
  if (!closeEnough(scenario.medianSpeedup, medianSpeedup) || medianSpeedup <= 1) {
    throw new Error(`Worktree-readiness ${name} speedup does not match its raw medians.`);
  }
  return {
    baseline,
    candidate,
    medianSpeedup,
    percentFaster: (1 - candidate.medianMilliseconds / baseline.medianMilliseconds) * 100,
  } as const;
}

if (
  worktreeReadinessArtifact.schemaVersion !== 1 ||
  worktreeReadinessArtifact.scope.name !== 'warm-linked-worktree-lexical-readiness' ||
  worktreeReadinessArtifact.scope.samples < 3 ||
  worktreeReadinessArtifact.source.candidate.ref !== 'v4.0.1' ||
  worktreeReadinessArtifact.source.fixtureCommit !== worktreeReadinessArtifact.source.candidate.commit ||
  !/^[a-f0-9]{40}$/.test(worktreeReadinessArtifact.source.candidate.commit) ||
  !/^[a-f0-9]{40}$/.test(worktreeReadinessArtifact.source.baseline.commit) ||
  !/^[a-f0-9]{64}$/.test(worktreeReadinessArtifact.source.harness.sha256) ||
  !worktreeReadinessArtifact.anchor.graphParityPassed ||
  JSON.stringify(worktreeReadinessArtifact.anchor.baseline) !==
    JSON.stringify(worktreeReadinessArtifact.anchor.candidate)
) {
  throw new Error('Checked-in worktree-readiness evidence has invalid provenance or anchor parity.');
}

const graphEquivalentCommit = validateScenario('graphEquivalentCommit', 'reused-snapshot', 0);
const oneFileChange = validateScenario('oneFileChange', 'incremental-clean', 1);

/**
 * Same-machine, same-fixture engineering evidence for the warm worktree paths
 * introduced by v4.0.1. It is intentionally separate from the comprehensive
 * exact-release large-repository evidence contract.
 */
export const checkedInWorktreeReadinessEvidence = {
  artifactPath: worktreeReadinessArtifactPath,
  generatedAt: worktreeReadinessArtifact.generatedAt,
  source: worktreeReadinessArtifact.source,
  environment: worktreeReadinessArtifact.environment,
  scale: worktreeReadinessArtifact.anchor.candidate,
  samples: worktreeReadinessArtifact.scope.samples,
  warmups: worktreeReadinessArtifact.scope.warmups,
  graphEquivalentCommit,
  oneFileChange,
} as const;
