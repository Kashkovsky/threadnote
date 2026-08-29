import type {CodeMemoryLinkAgentAbArm, CodeMemoryLinkAgentAbScenarioFamily} from './code-memory-link-agent-ab.js';

export interface CodeMemoryLinkAgentAbMetricsV1 {
  readonly adherence: AdherenceMetricV1;
  readonly firstUsefulMemoryUse: {
    readonly steps: FirstUseMetricV1;
    readonly tokens: FirstUseMetricV1;
  };
  readonly hiddenTaskPass: PairedPassMetricV1;
  readonly negativeControl: NegativeControlMetricV1;
  readonly perClient: readonly PerClientMetricV1[];
  readonly staleOrHarmfulAcceptance: Readonly<Record<CodeMemoryLinkAgentAbArm, ArmAcceptanceMetricV1>>;
  readonly totalTaskUsage: {
    readonly steps: TotalTaskUsageMetricV1;
    readonly tokens: TotalTaskUsageMetricV1;
  };
}

export interface AdherenceMetricV1 {
  readonly anchoredRate: number;
  readonly deltaPercentagePoints: number;
  readonly minimumScenarioFamilyDeltaPercentagePoints: number | null;
  readonly noMemoryRate: number;
  readonly pairedTrials: number;
  readonly scenarioFamilies: readonly BinaryScenarioFamilyMetricV1[];
  readonly taskOnlyRate: number;
  readonly taskOnlyVsNoMemoryDeltaPercentagePoints: number;
  readonly taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: number | null;
}

export interface PairedPassMetricV1 {
  readonly anchoredPassRate: number;
  readonly deltaPercentagePoints: number;
  readonly minimumScenarioFamilyDeltaPercentagePoints: number | null;
  readonly noMemoryPassRate: number;
  readonly pairedTrials: number;
  readonly scenarioFamilies: readonly BinaryScenarioFamilyMetricV1[];
  readonly taskOnlyPassRate: number;
  readonly taskOnlyVsNoMemoryDeltaPercentagePoints: number;
  readonly taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: number | null;
}

export interface BinaryScenarioFamilyMetricV1 {
  readonly anchoredRate: number;
  readonly anchoredVsTaskOnlyDeltaPercentagePoints: number;
  readonly noMemoryRate: number;
  readonly pairedTrials: number;
  readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
  readonly taskOnlyRate: number;
  readonly taskOnlyVsNoMemoryDeltaPercentagePoints: number;
}

export interface NegativeControlMetricV1 {
  readonly anchoredMaximumScenarioFamilyRegressionEventRate: number | null;
  readonly anchoredMinimumScenarioFamilyPassRate: number | null;
  readonly anchoredPassRate: number;
  readonly anchoredRegressionEventRate: number;
  readonly anchoredRegressionPercentagePoints: number;
  readonly noMemoryMinimumScenarioFamilyPassRate: number | null;
  readonly noMemoryPassRate: number;
  readonly pairedTrials: number;
  readonly scenarioFamilies: readonly NegativeControlScenarioFamilyMetricV1[];
  readonly taskOnlyMaximumScenarioFamilyRegressionEventRate: number | null;
  readonly taskOnlyMinimumScenarioFamilyPassRate: number | null;
  readonly taskOnlyPassRate: number;
  readonly taskOnlyRegressionEventRate: number;
  readonly taskOnlyRegressionPercentagePoints: number;
}

export interface NegativeControlScenarioFamilyMetricV1 {
  readonly anchoredPassRate: number;
  readonly anchoredRegressionEventRate: number;
  readonly noMemoryPassRate: number;
  readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
  readonly taskClusters: number;
  readonly taskOnlyPassRate: number;
  readonly taskOnlyRegressionEventRate: number;
}

export interface PerClientMetricV1 {
  readonly adherenceDeltaPercentagePoints: number;
  readonly anchoredFirstUseStepsReductionPercent: number;
  readonly anchoredFirstUseTokensReductionPercent: number;
  readonly anchoredNegativeControlPassRate: number;
  readonly anchoredNegativeControlRegressionPercentagePoints: number;
  readonly clientId: string;
  readonly hiddenTaskPassDeltaPercentagePoints: number;
  readonly noMemoryNegativeControlPassRate: number;
  readonly taskOnlyAdherenceDeltaPercentagePoints: number;
  readonly taskOnlyHiddenTaskPassDeltaPercentagePoints: number;
  readonly taskOnlyNegativeControlPassRate: number;
  readonly taskOnlyNegativeControlRegressionPercentagePoints: number;
  readonly taskOnlyTotalStepsReductionPercent: number;
  readonly taskOnlyTotalTokensReductionPercent: number;
}

export interface FirstUseMetricV1 {
  readonly anchoredCensoredTrials: number;
  readonly anchoredMean: number;
  readonly minimumScenarioFamilyReductionPercent: number | null;
  readonly reductionPercent: number;
  readonly scenarioFamilies: readonly ReductionScenarioFamilyMetricV1[];
  readonly taskOnlyCensoredTrials: number;
  readonly taskOnlyMean: number;
}

export interface TotalTaskUsageMetricV1 {
  readonly minimumScenarioFamilyReductionPercent: number | null;
  readonly noMemoryMean: number;
  readonly reductionPercent: number;
  readonly scenarioFamilies: readonly ReductionScenarioFamilyMetricV1[];
  readonly taskOnlyMean: number;
}

export interface ReductionScenarioFamilyMetricV1 {
  readonly leftMean: number;
  readonly reductionPercent: number;
  readonly rightMean: number;
  readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
  readonly trials: number;
}

export interface ArmAcceptanceMetricV1 {
  readonly acceptedTrials: number;
  readonly rate: number;
  readonly trials: number;
}
