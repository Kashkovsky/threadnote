import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {
  parseThreadnote5TrustedSourceV1,
  type Threadnote5ObservationV1,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';

export const THREADNOTE_5_BASELINE_LEDGER_VERSION = 1 as const;

/** Content-free capture index; its hash is supplied separately and never self-nominates trust. */
export interface Threadnote5BaselineTrialLedgerV1 {
  readonly observations: readonly {
    readonly measurements: readonly (
      | {readonly eligibleCount: number; readonly id: string; readonly positiveCount: number}
      | {readonly id: string; readonly sampleCount: number; readonly total: number}
    )[];
    readonly outcome: string;
    readonly receiptHash: string;
    readonly scenario: string;
    readonly transcriptDigest: string;
  }[];
  readonly source: Threadnote5SourceV1;
  readonly version: typeof THREADNOTE_5_BASELINE_LEDGER_VERSION;
}

export function threadnote5BaselineTrialLedger(
  source: Threadnote5SourceV1,
  observations: readonly Threadnote5ObservationV1[],
): Threadnote5BaselineTrialLedgerV1 {
  return {
    observations: observations
      .map(observation => ({
        measurements: observation.transcript.measurements,
        outcome: observation.transcript.outcome,
        receiptHash: observation.receiptHash,
        scenario: observation.scenario,
        transcriptDigest: observation.attestation.transcriptDigest,
      }))
      .sort((left, right) => left.scenario.localeCompare(right.scenario)),
    source: parseThreadnote5TrustedSourceV1(source, 'baseline'),
    version: THREADNOTE_5_BASELINE_LEDGER_VERSION,
  };
}

export function threadnote5BaselineTrialLedgerHash(value: unknown): string {
  return sha256HexSync(
    `threadnote-5-baseline-trial-ledger-v1\0${canonicalJson(parseThreadnote5BaselineTrialLedger(value))}`,
  );
}

export function parseThreadnote5BaselineTrialLedger(value: unknown): Threadnote5BaselineTrialLedgerV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Baseline trial ledger must be an object.');
  const source = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(source).sort()) !== canonicalJson(['observations', 'source', 'version'])) {
    throw new Error('Baseline trial ledger has unsupported or missing fields.');
  }
  if (source.version !== 1 || !Array.isArray(source.observations)) {
    throw new Error('Baseline trial ledger version or observations are invalid.');
  }
  const observations = source.observations.map(observation => {
    if (typeof observation !== 'object' || observation === null || Array.isArray(observation))
      throw new Error('Baseline trial ledger observation is invalid.');
    const item = observation as Record<string, unknown>;
    if (
      canonicalJson(Object.keys(item).sort()) !==
      canonicalJson(['measurements', 'outcome', 'receiptHash', 'scenario', 'transcriptDigest'])
    )
      throw new Error('Baseline trial ledger observation has unsupported fields.');
    if (!Array.isArray(item.measurements) || typeof item.outcome !== 'string' || typeof item.scenario !== 'string')
      throw new Error('Baseline trial ledger observation is invalid.');
    return {
      measurements: item.measurements as Threadnote5BaselineTrialLedgerV1['observations'][number]['measurements'],
      outcome: item.outcome,
      receiptHash: hash(item.receiptHash),
      scenario: item.scenario,
      transcriptDigest: hash(item.transcriptDigest),
    };
  });
  if (
    observations.length > 15 ||
    new Set(observations.map(item => item.receiptHash)).size !== observations.length ||
    canonicalJson(observations.map(item => item.scenario)) !==
      canonicalJson(observations.map(item => item.scenario).sort())
  ) {
    throw new Error('Baseline trial ledger observations must be unique, sorted, and bounded.');
  }
  return {observations, source: parseThreadnote5TrustedSourceV1(source.source, 'baseline'), version: 1};
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error('Baseline trial ledger hash is invalid.');
  return value;
}
