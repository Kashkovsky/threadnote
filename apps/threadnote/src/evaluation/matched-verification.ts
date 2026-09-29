import {sha256HexSync} from '@threadnote/platform/sha256';

export const MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION = 1 as const;
export const MATCHED_EVALUATION_VERIFICATION_STATUSES = ['passed', 'task-failed'] as const;

export type MatchedEvaluationVerificationStatus = (typeof MATCHED_EVALUATION_VERIFICATION_STATUSES)[number];

export interface MatchedEvaluationVerificationCalibrationV1 {
  readonly baseDiagnosticHash: string;
  readonly baseExitCode: 1;
  readonly baseRepositoryFixtureHash: string;
  readonly baseRevision: string;
  readonly fixDiagnosticHash: string;
  readonly fixExitCode: 0;
  readonly fixRepositoryFixtureHash: string;
  readonly fixRevision: string;
  readonly receiptHash: string;
}

export interface MatchedEvaluationVerificationTaskV1 {
  readonly calibration: MatchedEvaluationVerificationCalibrationV1;
  readonly selector: string;
  readonly taskId: string;
  readonly verificationId: string;
}

export interface MatchedEvaluationVerificationPlanV1 {
  readonly environmentDirectory: string;
  readonly environmentHash: string;
  readonly interpreter: string;
  readonly interpreterHash: string;
  readonly planHash: string;
  readonly runner: string;
  readonly runnerHash: string;
  readonly sandbox: {
    readonly executable: string;
    readonly executableHash: string;
    readonly policy: 'darwin-seatbelt-v1';
  };
  readonly tasks: readonly MatchedEvaluationVerificationTaskV1[];
  readonly timeoutMilliseconds: number;
  readonly version: typeof MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION;
}

export interface MatchedEvaluationVerificationReceiptV1 {
  readonly artifactHash: string;
  readonly diagnosticHash: string;
  readonly durationMilliseconds: number;
  readonly environmentHash: string;
  readonly exitCode: 0 | 1;
  readonly interpreterHash: string;
  readonly planHash: string;
  readonly receiptHash: string;
  readonly runnerHash: string;
  readonly sandboxExecutableHash: string;
  readonly status: MatchedEvaluationVerificationStatus;
  readonly taskId: string;
  readonly verificationId: string;
  readonly version: typeof MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const SELECTOR = /^[a-z][a-z0-9-]{0,63}$/u;

export function createMatchedEvaluationVerificationCalibrationV1(
  input: Omit<MatchedEvaluationVerificationCalibrationV1, 'receiptHash'>,
): MatchedEvaluationVerificationCalibrationV1 {
  const canonical = parseCalibration({...input, receiptHash: '0'.repeat(64)}, false);
  return {...canonical, receiptHash: matchedEvaluationVerificationCalibrationHashV1(canonical)};
}

export function createMatchedEvaluationVerificationPlanV1(
  input: Omit<MatchedEvaluationVerificationPlanV1, 'planHash' | 'version'>,
): MatchedEvaluationVerificationPlanV1 {
  const canonical = parsePlan(
    {
      ...input,
      planHash: '0'.repeat(64),
      tasks: [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId)),
      version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION,
    },
    false,
  );
  return {...canonical, planHash: matchedEvaluationVerificationPlanHashV1(canonical)};
}

export function parseMatchedEvaluationVerificationPlanV1(value: unknown): MatchedEvaluationVerificationPlanV1 {
  return parsePlan(value, true);
}

export function createMatchedEvaluationVerificationReceiptV1(
  input: Omit<MatchedEvaluationVerificationReceiptV1, 'receiptHash' | 'version'>,
): MatchedEvaluationVerificationReceiptV1 {
  const canonical = parseReceipt(
    {...input, receiptHash: '0'.repeat(64), version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION},
    false,
  );
  return {...canonical, receiptHash: matchedEvaluationVerificationReceiptHashV1(canonical)};
}

export function parseMatchedEvaluationVerificationReceiptV1(value: unknown): MatchedEvaluationVerificationReceiptV1 {
  return parseReceipt(value, true);
}

export function matchedEvaluationVerificationIdV1(taskId: string, selector: string): string {
  return digest('matched-evaluation-verification-id-v1', {
    selector: matching(selector, SELECTOR, 'verification selector'),
    taskId: matching(taskId, TASK_ID, 'verification task id'),
  });
}

export function matchedEvaluationVerificationCalibrationHashV1(
  input: Omit<MatchedEvaluationVerificationCalibrationV1, 'receiptHash'>,
): string {
  const {receiptHash: _receiptHash, ...withoutHash} = input as MatchedEvaluationVerificationCalibrationV1;
  return digest('matched-evaluation-verification-calibration-v1', withoutHash);
}

export function matchedEvaluationVerificationPlanHashV1(
  input: Omit<MatchedEvaluationVerificationPlanV1, 'planHash'>,
): string {
  const {planHash: _planHash, ...withoutHash} = input as MatchedEvaluationVerificationPlanV1;
  return digest('matched-evaluation-verification-plan-v1', withoutHash);
}

export function matchedEvaluationVerificationReceiptHashV1(
  input: Omit<MatchedEvaluationVerificationReceiptV1, 'receiptHash'>,
): string {
  const {receiptHash: _receiptHash, ...withoutHash} = input as MatchedEvaluationVerificationReceiptV1;
  return digest('matched-evaluation-verification-receipt-v1', withoutHash);
}

function parsePlan(value: unknown, verifyHash: boolean): MatchedEvaluationVerificationPlanV1 {
  const plan = object(value, 'verification plan');
  exactKeys(plan, [
    'environmentDirectory',
    'environmentHash',
    'interpreter',
    'interpreterHash',
    'planHash',
    'runner',
    'runnerHash',
    'sandbox',
    'tasks',
    'timeoutMilliseconds',
    'version',
  ]);
  if (plan.version !== MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION) invalid('verification plan version must be 1');
  const sandbox = object(plan.sandbox, 'verification sandbox');
  exactKeys(sandbox, ['executable', 'executableHash', 'policy']);
  if (sandbox.policy !== 'darwin-seatbelt-v1') invalid('verification sandbox policy is unsupported');
  const tasks = array(plan.tasks, 'verification tasks')
    .map((task, index) => parseTask(task, index))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (tasks.length === 0 || tasks.length > 64) invalid('verification plan must contain 1-64 tasks');
  unique(
    tasks.map(task => task.taskId),
    'verification task ids',
  );
  unique(
    tasks.map(task => task.verificationId),
    'verification ids',
  );
  const withoutHash = {
    environmentDirectory: absolutePath(plan.environmentDirectory, 'verification environment directory'),
    environmentHash: matching(plan.environmentHash, HASH, 'verification environment hash'),
    interpreter: absolutePath(plan.interpreter, 'verification interpreter'),
    interpreterHash: matching(plan.interpreterHash, HASH, 'verification interpreter hash'),
    runner: absolutePath(plan.runner, 'verification runner'),
    runnerHash: matching(plan.runnerHash, HASH, 'verification runner hash'),
    sandbox: {
      executable: absolutePath(sandbox.executable, 'verification sandbox executable'),
      executableHash: matching(sandbox.executableHash, HASH, 'verification sandbox executable hash'),
      policy: 'darwin-seatbelt-v1' as const,
    },
    tasks,
    timeoutMilliseconds: integer(plan.timeoutMilliseconds, 1_000, 600_000, 'verification timeout'),
    version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION,
  };
  const planHash = matching(plan.planHash, HASH, 'verification plan hash');
  if (verifyHash && planHash !== matchedEvaluationVerificationPlanHashV1(withoutHash)) {
    invalid('verification plan hash does not match its contents');
  }
  return {...withoutHash, planHash};
}

function parseTask(value: unknown, index: number): MatchedEvaluationVerificationTaskV1 {
  const task = object(value, `verification task ${index}`);
  exactKeys(task, ['calibration', 'selector', 'taskId', 'verificationId']);
  const taskId = matching(task.taskId, TASK_ID, `verification task ${index} id`);
  const selector = matching(task.selector, SELECTOR, `verification task ${index} selector`);
  const verificationId = matching(task.verificationId, HASH, `verification task ${index} verification id`);
  if (verificationId !== matchedEvaluationVerificationIdV1(taskId, selector)) {
    invalid(`verification task ${index} id does not match its task and selector`);
  }
  return {calibration: parseCalibration(task.calibration, true), selector, taskId, verificationId};
}

function parseCalibration(value: unknown, verifyHash: boolean): MatchedEvaluationVerificationCalibrationV1 {
  const calibration = object(value, 'verification calibration');
  exactKeys(calibration, [
    'baseExitCode',
    'baseDiagnosticHash',
    'baseRepositoryFixtureHash',
    'baseRevision',
    'fixExitCode',
    'fixDiagnosticHash',
    'fixRepositoryFixtureHash',
    'fixRevision',
    'receiptHash',
  ]);
  if (calibration.baseExitCode !== 1 || calibration.fixExitCode !== 0) {
    invalid('verification calibration must fail at base and pass at the known fix');
  }
  const withoutHash = {
    baseDiagnosticHash: matching(calibration.baseDiagnosticHash, HASH, 'verification base diagnostic hash'),
    baseExitCode: 1 as const,
    baseRepositoryFixtureHash: matching(
      calibration.baseRepositoryFixtureHash,
      HASH,
      'verification base repository fixture hash',
    ),
    baseRevision: matching(calibration.baseRevision, REVISION, 'verification base revision'),
    fixDiagnosticHash: matching(calibration.fixDiagnosticHash, HASH, 'verification fix diagnostic hash'),
    fixExitCode: 0 as const,
    fixRepositoryFixtureHash: matching(
      calibration.fixRepositoryFixtureHash,
      HASH,
      'verification fix repository fixture hash',
    ),
    fixRevision: matching(calibration.fixRevision, REVISION, 'verification fix revision'),
  };
  const receiptHash = matching(calibration.receiptHash, HASH, 'verification calibration receipt hash');
  if (verifyHash && receiptHash !== matchedEvaluationVerificationCalibrationHashV1(withoutHash)) {
    invalid('verification calibration receipt hash does not match its contents');
  }
  return {...withoutHash, receiptHash};
}

function parseReceipt(value: unknown, verifyHash: boolean): MatchedEvaluationVerificationReceiptV1 {
  const receipt = object(value, 'verification receipt');
  exactKeys(receipt, [
    'artifactHash',
    'diagnosticHash',
    'durationMilliseconds',
    'environmentHash',
    'exitCode',
    'interpreterHash',
    'planHash',
    'receiptHash',
    'runnerHash',
    'sandboxExecutableHash',
    'status',
    'taskId',
    'verificationId',
    'version',
  ]);
  if (receipt.version !== MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION) {
    invalid('verification receipt version must be 1');
  }
  const status = literal(receipt.status, MATCHED_EVALUATION_VERIFICATION_STATUSES, 'verification receipt status');
  const exitCode: 0 | 1 =
    receipt.exitCode === 0 ? 0 : receipt.exitCode === 1 ? 1 : invalid('verification exit code is invalid');
  if ((status === 'passed') !== (exitCode === 0)) invalid('verification status and exit code disagree');
  const withoutHash = {
    artifactHash: matching(receipt.artifactHash, HASH, 'verification artifact hash'),
    diagnosticHash: matching(receipt.diagnosticHash, HASH, 'verification diagnostic hash'),
    durationMilliseconds: integer(receipt.durationMilliseconds, 0, 600_000, 'verification duration'),
    environmentHash: matching(receipt.environmentHash, HASH, 'verification environment hash'),
    exitCode,
    interpreterHash: matching(receipt.interpreterHash, HASH, 'verification interpreter hash'),
    planHash: matching(receipt.planHash, HASH, 'verification plan hash'),
    runnerHash: matching(receipt.runnerHash, HASH, 'verification runner hash'),
    sandboxExecutableHash: matching(receipt.sandboxExecutableHash, HASH, 'verification sandbox executable hash'),
    status,
    taskId: matching(receipt.taskId, TASK_ID, 'verification receipt task id'),
    verificationId: matching(receipt.verificationId, HASH, 'verification receipt verification id'),
    version: MATCHED_EVALUATION_VERIFICATION_PLAN_VERSION,
  };
  const receiptHash = matching(receipt.receiptHash, HASH, 'verification receipt hash');
  if (verifyHash && receiptHash !== matchedEvaluationVerificationReceiptHashV1(withoutHash)) {
    invalid('verification receipt hash does not match its contents');
  }
  return {...withoutHash, receiptHash};
}

function digest(domain: string, value: unknown): string {
  return sha256HexSync(`${domain}\0${JSON.stringify(value)}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    invalid('verification object has unsupported or missing fields');
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const text = boundedText(value, 1, 4_096, label);
  if (!pattern.test(text)) invalid(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid(`${label} is invalid`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (!path.startsWith('/')) invalid(`${label} must be absolute`);
  return path;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function literal<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (!values.includes(value as T[number])) invalid(`${label} is invalid`);
  return value as T[number];
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation verification: ${message}.`);
}
