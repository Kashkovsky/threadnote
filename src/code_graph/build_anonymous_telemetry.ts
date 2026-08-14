import type {CodeGraphIndexSummary, CodeGraphOverlayFallbackReason} from './types.js';

export const CODE_GRAPH_TELEMETRY_SMALL_DELTA_MAX_FILES = 8;
export const CODE_GRAPH_TELEMETRY_HIGH_REWRITE_AMPLIFICATION = 256;
export const CODE_GRAPH_TELEMETRY_CRITICAL_REWRITE_AMPLIFICATION = 1_024;
export const CODE_GRAPH_TELEMETRY_HIGH_FACT_REPLAY_BYTES = 256 * 1_048_576;
export const CODE_GRAPH_TELEMETRY_CRITICAL_FACT_REPLAY_BYTES = 1_024 * 1_048_576;

const MAX_POWER_OF_TWO_BUCKET_EXPONENT = 52;

export type CodeGraphBuildKind = 'clean' | 'dirty';
export type CodeGraphMaterializationMode = NonNullable<CodeGraphIndexSummary['materialization']>['mode'];
export type CodeGraphResolutionClosure = 'none' | 'changed' | 'full' | 'project';
export type CodeGraphPowerOfTwoBucket = '0' | `2^${number}`;
export type CodeGraphBuildEfficiencyClass =
  | 'critical-amplification-full'
  | 'expected-full'
  | 'full'
  | 'high-amplification-full'
  | 'incremental'
  | 'small-delta-full';

/** Path-free evidence retained until a graph build reaches a terminal state. */
export interface CodeGraphBuildAnonymousTelemetryInput {
  readonly buildKind: CodeGraphBuildKind;
  readonly cachedFactReplayBytes?: number;
  readonly changedFactBytes?: number;
  readonly changedFiles?: number;
  readonly deletedFiles?: number;
  readonly extractedFiles?: number;
  readonly fallbackReason?: CodeGraphOverlayFallbackReason;
  readonly finalFactBytes?: number;
  readonly mode: CodeGraphMaterializationMode;
  readonly resolutionClosure?: Exclude<CodeGraphResolutionClosure, 'none'>;
  readonly reusedFiles?: number;
  readonly stagedFiles?: number;
  readonly totalFiles?: number;
}

/** Closed, pre-bucketed fields safe to attach to anonymous terminal telemetry. */
export interface CodeGraphBuildAnonymousTelemetryFields {
  readonly buildKind: CodeGraphBuildKind;
  readonly cachedFactReplayBytesBucket: CodeGraphPowerOfTwoBucket;
  readonly changedFactBytesBucket: CodeGraphPowerOfTwoBucket;
  readonly changedFilesBucket: CodeGraphPowerOfTwoBucket;
  readonly deletedFilesBucket: CodeGraphPowerOfTwoBucket;
  readonly deltaFilesBucket: CodeGraphPowerOfTwoBucket;
  readonly efficiencyClass: CodeGraphBuildEfficiencyClass;
  readonly extractedFilesBucket: CodeGraphPowerOfTwoBucket;
  readonly factReplayAmplificationBucket: CodeGraphPowerOfTwoBucket;
  readonly fallbackReason: 'none' | CodeGraphOverlayFallbackReason;
  readonly finalFactBytesBucket: CodeGraphPowerOfTwoBucket;
  readonly mode: CodeGraphMaterializationMode;
  readonly resolutionClosure: CodeGraphResolutionClosure;
  readonly reusedFilesBucket: CodeGraphPowerOfTwoBucket;
  readonly rewriteAmplificationBucket: CodeGraphPowerOfTwoBucket;
  readonly stagedFilesBucket: CodeGraphPowerOfTwoBucket;
  readonly totalFilesBucket: CodeGraphPowerOfTwoBucket;
}

export function codeGraphBuildAnonymousTelemetryFields(
  input: CodeGraphBuildAnonymousTelemetryInput,
): CodeGraphBuildAnonymousTelemetryFields {
  const changedFiles = boundedCount(input.changedFiles);
  const deletedFiles = boundedCount(input.deletedFiles);
  const deltaFiles = saturatingAdd(changedFiles, deletedFiles);
  const extractedFiles = boundedCount(input.extractedFiles);
  const reusedFiles = boundedCount(input.reusedFiles);
  const stagedFiles = boundedCount(input.stagedFiles);
  const totalFiles = boundedCount(input.totalFiles);
  const cachedFactReplayBytes = boundedCount(input.cachedFactReplayBytes);
  const changedFactBytes = boundedCount(input.changedFactBytes);
  const finalFactBytes = boundedCount(input.finalFactBytes);
  const rewriteAmplification = amplification(stagedFiles, deltaFiles);
  const factReplayAmplification = amplification(cachedFactReplayBytes, changedFactBytes);
  const fallbackReason = input.fallbackReason ?? 'none';
  const resolutionClosure = input.resolutionClosure ?? (input.mode === 'full' ? 'full' : 'none');

  return {
    buildKind: input.buildKind,
    cachedFactReplayBytesBucket: codeGraphPowerOfTwoBucket(cachedFactReplayBytes),
    changedFactBytesBucket: codeGraphPowerOfTwoBucket(changedFactBytes),
    changedFilesBucket: codeGraphPowerOfTwoBucket(changedFiles),
    deletedFilesBucket: codeGraphPowerOfTwoBucket(deletedFiles),
    deltaFilesBucket: codeGraphPowerOfTwoBucket(deltaFiles),
    efficiencyClass: classifyCodeGraphBuildEfficiency({
      buildKind: input.buildKind,
      cachedFactReplayBytes,
      deltaFiles,
      fallbackReason,
      mode: input.mode,
      rewriteAmplification,
    }),
    extractedFilesBucket: codeGraphPowerOfTwoBucket(extractedFiles),
    factReplayAmplificationBucket: codeGraphPowerOfTwoBucket(factReplayAmplification),
    fallbackReason,
    finalFactBytesBucket: codeGraphPowerOfTwoBucket(finalFactBytes),
    mode: input.mode,
    resolutionClosure,
    reusedFilesBucket: codeGraphPowerOfTwoBucket(reusedFiles),
    rewriteAmplificationBucket: codeGraphPowerOfTwoBucket(rewriteAmplification),
    stagedFilesBucket: codeGraphPowerOfTwoBucket(stagedFiles),
    totalFilesBucket: codeGraphPowerOfTwoBucket(totalFiles),
  };
}

export function codeGraphPowerOfTwoBucket(value: number): CodeGraphPowerOfTwoBucket {
  const bounded = boundedCount(value);
  if (bounded === 0) return '0';
  return `2^${Math.min(MAX_POWER_OF_TWO_BUCKET_EXPONENT, Math.floor(Math.log2(bounded)))}`;
}

function classifyCodeGraphBuildEfficiency(input: {
  readonly buildKind: CodeGraphBuildKind;
  readonly cachedFactReplayBytes: number;
  readonly deltaFiles: number;
  readonly fallbackReason: 'none' | CodeGraphOverlayFallbackReason;
  readonly mode: CodeGraphMaterializationMode;
  readonly rewriteAmplification: number;
}): CodeGraphBuildEfficiencyClass {
  if (input.mode !== 'full') return 'incremental';
  if (
    input.buildKind === 'clean' ||
    input.fallbackReason === 'forced-full-rebuild' ||
    input.fallbackReason === 'disabled'
  ) {
    return 'expected-full';
  }
  if (input.deltaFiles > CODE_GRAPH_TELEMETRY_SMALL_DELTA_MAX_FILES) return 'full';
  if (
    input.rewriteAmplification >= CODE_GRAPH_TELEMETRY_CRITICAL_REWRITE_AMPLIFICATION &&
    input.cachedFactReplayBytes >= CODE_GRAPH_TELEMETRY_CRITICAL_FACT_REPLAY_BYTES
  ) {
    return 'critical-amplification-full';
  }
  if (
    input.rewriteAmplification >= CODE_GRAPH_TELEMETRY_HIGH_REWRITE_AMPLIFICATION ||
    input.cachedFactReplayBytes >= CODE_GRAPH_TELEMETRY_HIGH_FACT_REPLAY_BYTES
  ) {
    return 'high-amplification-full';
  }
  return 'small-delta-full';
}

function amplification(numerator: number, denominator: number): number {
  if (numerator === 0) return 0;
  return boundedCount(Math.floor(numerator / Math.max(1, denominator)));
}

function boundedCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}
