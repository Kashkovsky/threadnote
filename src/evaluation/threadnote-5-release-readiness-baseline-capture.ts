import {canonicalJson} from '../code_graph/checkpoint/canonical_json.js';
import {sha256HexSync} from '../crypto/sha256.js';

export const THREADNOTE_5_BASELINE_CAPTURE_PLAN_SUITE = 'threadnote-5-baseline-capture-plan' as const;
export const THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL = 'threadnote-5-baseline-observer' as const;
export const THREADNOTE_5_BASELINE_JUDGE_PROTOCOL = 'threadnote-5-baseline-judge' as const;
export const THREADNOTE_5_BASELINE_PRIVATE_REPLAY_SUITE = 'threadnote-5-baseline-private-replay' as const;
const THREADNOTE_5_BASELINE_SOURCE_ID = 'threadnote-4.7.x';

export interface Threadnote5BaselineObserverIdentityV1 {
  readonly executableSha256: string;
  readonly id: string;
  readonly protocol: typeof THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL;
  readonly version: 1;
}

export interface Threadnote5BaselineJudgeIdentityV1 {
  readonly executableSha256: string;
  readonly id: string;
  readonly protocol: typeof THREADNOTE_5_BASELINE_JUDGE_PROTOCOL;
  readonly version: 1;
}

export interface Threadnote5BaselineCaptureTrialV1 {
  readonly allowedMemoryUris: readonly string[];
  readonly budgetTokens: number;
  readonly homeFixturePath: string;
  readonly homeFixtureSha256: string;
  readonly repositoryFixturePath: string;
  readonly repositoryFixtureSha256: string;
  readonly requiredMemoryUris: readonly string[];
  readonly task: string;
  readonly trialId: string;
  readonly wrongMemoryEligible: boolean;
}

export interface Threadnote5BaselineCapturePlanV1 {
  readonly judge: Threadnote5BaselineJudgeIdentityV1;
  readonly observer: Threadnote5BaselineObserverIdentityV1;
  readonly suite: typeof THREADNOTE_5_BASELINE_CAPTURE_PLAN_SUITE;
  readonly trials: readonly Threadnote5BaselineCaptureTrialV1[];
  readonly version: 1;
}

export interface Threadnote5BaselineObserverRequestV1 {
  readonly capturePlanSha256: string;
  readonly contextBrief: Readonly<Record<string, unknown>>;
  readonly contextBriefOutputSha256: string;
  readonly homeFixtureSha256: string;
  readonly protocol: typeof THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL;
  readonly repositoryFixtureSha256: string;
  readonly requestSha256: string;
  readonly source: {
    readonly commit: string;
    readonly executableSha256: string;
    readonly version: string;
  };
  readonly task: string;
  readonly trialId: string;
  readonly version: 1;
}

export interface Threadnote5BaselineObserverResponseV1 {
  readonly citedMemoryUris: readonly string[];
  readonly firstCitedPlan: string;
  readonly measurementReceipt: Threadnote5BaselineObserverMeasurementReceiptV1;
  readonly observerId: string;
  readonly protocol: typeof THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL;
  readonly requestSha256: string;
  readonly trialId: string;
  readonly version: 1;
}

export interface Threadnote5BaselineJudgeRequestV1 {
  readonly capturePlanSha256: string;
  readonly citedMemoryUris: readonly string[];
  readonly citedMemoryUrisSha256: string;
  readonly contextBriefOutput: string;
  readonly contextBriefOutputSha256: string;
  readonly firstCitedPlan: string;
  readonly firstCitedPlanSha256: string;
  readonly observerRequest: Threadnote5BaselineObserverRequestV1;
  readonly observerRequestSha256: string;
  readonly protocol: typeof THREADNOTE_5_BASELINE_JUDGE_PROTOCOL;
  readonly requestSha256: string;
  readonly trialId: string;
  readonly version: 1;
}

export interface Threadnote5BaselineJudgeResponseV1 {
  readonly firstCitedPlanIndependentlyJudgedCorrect: true;
  readonly firstCitedPlanSha256: string;
  readonly judgeId: string;
  readonly protocol: typeof THREADNOTE_5_BASELINE_JUDGE_PROTOCOL;
  readonly receiptSha256: string;
  readonly requestSha256: string;
  readonly trialId: string;
  readonly version: 1;
}

export interface Threadnote5BaselinePrivateReplayTrialV1 {
  readonly judgeRequest: Threadnote5BaselineJudgeRequestV1;
  readonly judgeResponse: Threadnote5BaselineJudgeResponseV1;
  readonly judgeResponseOutput: string;
  readonly observerRequest: Threadnote5BaselineObserverRequestV1;
  readonly observerResponse: Threadnote5BaselineObserverResponseV1;
  readonly observerResponseOutput: string;
  readonly trialId: string;
}

export interface Threadnote5BaselinePrivateReplayV1 {
  readonly capturePlan: Threadnote5BaselineCapturePlanV1;
  readonly capturePlanSha256: string;
  readonly suite: typeof THREADNOTE_5_BASELINE_PRIVATE_REPLAY_SUITE;
  readonly trials: readonly Threadnote5BaselinePrivateReplayTrialV1[];
  readonly version: 1;
}

export interface Threadnote5BaselineObserverMeasurementReceiptV1 {
  readonly estimatedTokensToFirstCitedPlan: number;
  readonly firstCitedPlanSha256: string;
  readonly observerId: string;
  readonly receiptSha256: string;
  readonly requestSha256: string;
  readonly timeFromObserverRequestToFirstCitedPlanMilliseconds: number;
  readonly trialId: string;
  readonly version: 1;
}

export function threadnote5BaselineCapturePlanHash(value: unknown): string {
  return sha256HexSync(
    `threadnote-5-baseline-capture-plan-v1\0${canonicalJson(parseThreadnote5BaselineCapturePlanV1(value))}`,
  );
}

export function parseThreadnote5BaselineCapturePlanV1(value: unknown): Threadnote5BaselineCapturePlanV1 {
  const plan = record(value, 'baseline capture plan');
  exactKeys(plan, ['judge', 'observer', 'suite', 'trials', 'version'], 'baseline capture plan');
  if (plan.version !== 1 || plan.suite !== THREADNOTE_5_BASELINE_CAPTURE_PLAN_SUITE || !Array.isArray(plan.trials)) {
    throw new Error('Baseline capture plan version, suite, or trials are invalid.');
  }
  if (plan.trials.length < 10 || plan.trials.length > 10_000) {
    throw new Error('Baseline capture plan requires 10 through 10000 trials.');
  }
  const trials = plan.trials.map(parseTrial);
  if (new Set(trials.map(trial => trial.trialId)).size !== trials.length) {
    throw new Error('Baseline capture plan trial ids must be unique.');
  }
  const observer = parseObserverIdentity(plan.observer);
  const judge = parseJudgeIdentity(plan.judge);
  if (
    new Set([THREADNOTE_5_BASELINE_SOURCE_ID, observer.id, judge.id]).size !== 3 ||
    observer.executableSha256 === judge.executableSha256
  ) {
    throw new Error(
      'Baseline source, observer, and judge identities are invalid: distinct identities and executable bytes are required.',
    );
  }
  return {
    judge,
    observer,
    suite: THREADNOTE_5_BASELINE_CAPTURE_PLAN_SUITE,
    trials,
    version: 1,
  };
}

export function threadnote5BaselineObserverRequestHash(
  value: Omit<Threadnote5BaselineObserverRequestV1, 'requestSha256'>,
): string {
  return sha256HexSync(`threadnote-5-baseline-observer-request-v1\0${canonicalJson(value)}`);
}

export function threadnote5BaselineJudgeRequestHash(
  value: Omit<Threadnote5BaselineJudgeRequestV1, 'requestSha256'>,
): string {
  return sha256HexSync(`threadnote-5-baseline-judge-request-v1\0${canonicalJson(value)}`);
}

export function threadnote5BaselineJudgeReceiptHash(
  value: Omit<Threadnote5BaselineJudgeResponseV1, 'receiptSha256'>,
): string {
  return sha256HexSync(`threadnote-5-baseline-judge-receipt-v1\0${canonicalJson(value)}`);
}

export function threadnote5BaselineObserverMeasurementReceiptHash(
  value: Omit<Threadnote5BaselineObserverMeasurementReceiptV1, 'receiptSha256'>,
): string {
  return sha256HexSync(`threadnote-5-baseline-observer-measurement-v1\0${canonicalJson(value)}`);
}

export function threadnote5BaselineObserverCitationsHash(citedMemoryUris: readonly string[]): string {
  return sha256HexSync(`threadnote-5-baseline-observer-citations-v1\0${canonicalJson(citedMemoryUris)}`);
}

export function parseThreadnote5BaselineObserverResponseV1(
  value: unknown,
  expected: {
    readonly allowedMemoryUris: readonly string[];
    readonly identity: Threadnote5BaselineObserverIdentityV1;
    readonly requestSha256: string;
    readonly requiredMemoryUris: readonly string[];
    readonly returnedMemoryUris: readonly string[];
    readonly trialId: string;
  },
): Threadnote5BaselineObserverResponseV1 {
  const response = record(value, 'baseline observer response');
  exactKeys(
    response,
    [
      'citedMemoryUris',
      'firstCitedPlan',
      'measurementReceipt',
      'observerId',
      'protocol',
      'requestSha256',
      'trialId',
      'version',
    ],
    'baseline observer response',
  );
  if (
    response.version !== 1 ||
    response.protocol !== THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL ||
    response.observerId !== expected.identity.id ||
    response.requestSha256 !== expected.requestSha256 ||
    response.trialId !== expected.trialId
  ) {
    throw new Error('Baseline observer response does not match the reviewed observer request.');
  }
  const citedMemoryUris = stringArray(response.citedMemoryUris, 'observer cited memory URIs');
  if (
    !citedMemoryUris.every(uri => expected.returnedMemoryUris.includes(uri)) ||
    !citedMemoryUris.every(uri => expected.allowedMemoryUris.includes(uri)) ||
    !expected.requiredMemoryUris.every(uri => citedMemoryUris.includes(uri))
  ) {
    throw new Error('Baseline observer plan citations do not match the source-native Context Brief.');
  }
  const firstCitedPlan = boundedContent(response.firstCitedPlan, 1_048_576, 'observer first cited plan');
  const firstCitedPlanSha256 = sha256HexSync(firstCitedPlan);
  const measurementReceipt = parseMeasurementReceipt(response.measurementReceipt, {
    firstCitedPlanSha256,
    identity: expected.identity,
    requestSha256: expected.requestSha256,
    trialId: expected.trialId,
  });
  return {
    citedMemoryUris,
    firstCitedPlan,
    measurementReceipt,
    observerId: expected.identity.id,
    protocol: THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL,
    requestSha256: expected.requestSha256,
    trialId: expected.trialId,
    version: 1,
  };
}

export function parseThreadnote5BaselineJudgeResponseV1(
  value: unknown,
  expected: {
    readonly firstCitedPlanSha256: string;
    readonly identity: Threadnote5BaselineJudgeIdentityV1;
    readonly requestSha256: string;
    readonly trialId: string;
  },
): Threadnote5BaselineJudgeResponseV1 {
  const response = record(value, 'baseline judge response');
  exactKeys(
    response,
    [
      'firstCitedPlanIndependentlyJudgedCorrect',
      'firstCitedPlanSha256',
      'judgeId',
      'protocol',
      'receiptSha256',
      'requestSha256',
      'trialId',
      'version',
    ],
    'baseline judge response',
  );
  if (
    response.version !== 1 ||
    response.protocol !== THREADNOTE_5_BASELINE_JUDGE_PROTOCOL ||
    response.firstCitedPlanIndependentlyJudgedCorrect !== true ||
    response.judgeId !== expected.identity.id ||
    response.requestSha256 !== expected.requestSha256 ||
    response.trialId !== expected.trialId ||
    response.firstCitedPlanSha256 !== expected.firstCitedPlanSha256
  ) {
    throw new Error('Baseline judge response does not match the reviewed trial.');
  }
  const projection = {
    firstCitedPlanIndependentlyJudgedCorrect: true,
    firstCitedPlanSha256: expected.firstCitedPlanSha256,
    judgeId: expected.identity.id,
    protocol: THREADNOTE_5_BASELINE_JUDGE_PROTOCOL,
    requestSha256: expected.requestSha256,
    trialId: expected.trialId,
    version: 1,
  } as const;
  const receiptSha256 = matchingText(response.receiptSha256, /^[0-9a-f]{64}$/u, 'judge receipt hash');
  if (receiptSha256 !== threadnote5BaselineJudgeReceiptHash(projection)) {
    throw new Error('Baseline judge receipt hash does not match.');
  }
  return {...projection, receiptSha256};
}

function parseMeasurementReceipt(
  value: unknown,
  expected: {
    readonly firstCitedPlanSha256: string;
    readonly identity: Threadnote5BaselineObserverIdentityV1;
    readonly requestSha256: string;
    readonly trialId: string;
  },
): Threadnote5BaselineObserverMeasurementReceiptV1 {
  const receipt = record(value, 'baseline observer measurement receipt');
  exactKeys(
    receipt,
    [
      'estimatedTokensToFirstCitedPlan',
      'firstCitedPlanSha256',
      'observerId',
      'receiptSha256',
      'requestSha256',
      'timeFromObserverRequestToFirstCitedPlanMilliseconds',
      'trialId',
      'version',
    ],
    'baseline observer measurement receipt',
  );
  if (
    receipt.version !== 1 ||
    receipt.observerId !== expected.identity.id ||
    receipt.requestSha256 !== expected.requestSha256 ||
    receipt.trialId !== expected.trialId ||
    receipt.firstCitedPlanSha256 !== expected.firstCitedPlanSha256
  ) {
    throw new Error('Baseline observer measurement receipt does not match the reviewed trial.');
  }
  const projection = {
    estimatedTokensToFirstCitedPlan: integer(
      receipt.estimatedTokensToFirstCitedPlan,
      0,
      1_000_000_000,
      'observer estimated tokens',
    ),
    firstCitedPlanSha256: expected.firstCitedPlanSha256,
    observerId: expected.identity.id,
    requestSha256: expected.requestSha256,
    timeFromObserverRequestToFirstCitedPlanMilliseconds: integer(
      receipt.timeFromObserverRequestToFirstCitedPlanMilliseconds,
      0,
      1_000_000_000_000,
      'observer time to first plan',
    ),
    trialId: expected.trialId,
    version: 1,
  } as const;
  const receiptSha256 = matchingText(receipt.receiptSha256, /^[0-9a-f]{64}$/u, 'measurement receipt hash');
  if (receiptSha256 !== threadnote5BaselineObserverMeasurementReceiptHash(projection)) {
    throw new Error('Baseline observer measurement receipt hash does not match.');
  }
  return {...projection, receiptSha256};
}

function parseObserverIdentity(value: unknown): Threadnote5BaselineObserverIdentityV1 {
  const observer = record(value, 'baseline observer identity');
  exactKeys(observer, ['executableSha256', 'id', 'protocol', 'version'], 'baseline observer identity');
  if (observer.version !== 1 || observer.protocol !== THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL) {
    throw new Error('Baseline observer protocol or version is invalid.');
  }
  const id = matchingText(observer.id, /^[a-z0-9][a-z0-9._-]{0,127}$/u, 'observer id');
  return {
    executableSha256: matchingText(observer.executableSha256, /^[0-9a-f]{64}$/u, 'observer executable hash'),
    id,
    protocol: THREADNOTE_5_BASELINE_OBSERVER_PROTOCOL,
    version: 1,
  };
}

function parseJudgeIdentity(value: unknown): Threadnote5BaselineJudgeIdentityV1 {
  const judge = record(value, 'baseline judge identity');
  exactKeys(judge, ['executableSha256', 'id', 'protocol', 'version'], 'baseline judge identity');
  if (judge.version !== 1 || judge.protocol !== THREADNOTE_5_BASELINE_JUDGE_PROTOCOL) {
    throw new Error('Baseline judge protocol or version is invalid.');
  }
  return {
    executableSha256: matchingText(judge.executableSha256, /^[0-9a-f]{64}$/u, 'judge executable hash'),
    id: matchingText(judge.id, /^[a-z0-9][a-z0-9._-]{0,127}$/u, 'judge id'),
    protocol: THREADNOTE_5_BASELINE_JUDGE_PROTOCOL,
    version: 1,
  };
}

function parseTrial(value: unknown): Threadnote5BaselineCaptureTrialV1 {
  const trial = record(value, 'baseline capture trial');
  exactKeys(
    trial,
    [
      'allowedMemoryUris',
      'budgetTokens',
      'homeFixturePath',
      'homeFixtureSha256',
      'repositoryFixturePath',
      'repositoryFixtureSha256',
      'requiredMemoryUris',
      'task',
      'trialId',
      'wrongMemoryEligible',
    ],
    'baseline capture trial',
  );
  const allowedMemoryUris = stringArray(trial.allowedMemoryUris, 'allowed memory URIs');
  const requiredMemoryUris = stringArray(trial.requiredMemoryUris, 'required memory URIs');
  if (!requiredMemoryUris.every(uri => allowedMemoryUris.includes(uri))) {
    throw new Error('Baseline capture required memory URIs must be allowed.');
  }
  if (typeof trial.wrongMemoryEligible !== 'boolean') throw new Error('Baseline capture eligibility is invalid.');
  return {
    allowedMemoryUris,
    budgetTokens: integer(trial.budgetTokens, 800, 1_500, 'budget tokens'),
    homeFixturePath: absolutePath(trial.homeFixturePath, 'home fixture path'),
    homeFixtureSha256: matchingText(trial.homeFixtureSha256, /^[0-9a-f]{64}$/u, 'home fixture hash'),
    repositoryFixturePath: absolutePath(trial.repositoryFixturePath, 'repository fixture path'),
    repositoryFixtureSha256: matchingText(trial.repositoryFixtureSha256, /^[0-9a-f]{64}$/u, 'repository fixture hash'),
    requiredMemoryUris,
    task: boundedText(trial.task, 4_096, 'task'),
    trialId: matchingText(trial.trialId, /^[a-z0-9][a-z0-9._-]{0,127}$/u, 'trial id'),
    wrongMemoryEligible: trial.wrongMemoryEligible,
  };
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 4_096, label);
  if (!/^(?:\/|[A-Za-z]:[\\/])/u.test(path)) throw new Error(`Baseline capture ${label} must be absolute.`);
  return path;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error(`Baseline capture ${label} are invalid.`);
  }
  const items = value.map(item => boundedText(item, 4_096, label));
  if (new Set(items).size !== items.length) throw new Error(`Baseline capture ${label} must be unique.`);
  return items;
}

function boundedText(value: unknown, maximumBytes: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Array.from(value).some(character => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    }) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`Baseline capture ${label} is invalid.`);
  }
  return value;
}

function boundedContent(value: unknown, maximumBytes: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`Baseline capture ${label} is invalid.`);
  }
  return value;
}

function matchingText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Baseline capture ${label} is invalid.`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Baseline capture ${label} is invalid.`);
  }
  return value as number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}
