#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This local sealer owns reviewed evidence-file boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {
  createMatchedContinuationStudyV1,
  parseMatchedContinuationStudyRuntimeV1,
  type MatchedContinuationStudyRuntimeV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import {
  matchedEvaluationCorpusHashV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {parseMatchedTokenEfficiencyStudyV1} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  assertMatchedEvaluationContinuationAdapterConfigurationsV2,
  continuationCheckpointStudyV2,
  parseMatchedEvaluationContinuationPilotPlanV1,
  parseMatchedEvaluationRuntimeV1,
} from './run-matched-evaluation.js';
import {assertMatchedContinuationRuntimeFilesV1} from './matched-continuation-runtime-integrity.js';
import {assertMatchedEvaluationRepositoryV1} from './matched-evaluation-runtime-integrity.js';

export const MATCHED_CONTINUATION_PREPARATION_VERSION = 1 as const;

interface MatchedContinuationPreparationPlanV1 {
  readonly bootstrap: {
    readonly confidenceLevelBasisPoints: 9500;
    readonly iterations: number;
    readonly seed: string;
  };
  readonly gates: {
    readonly completionNonInferiorityBasisPoints: number;
    readonly maximumAuthorizationLeaks: number;
    readonly maximumFalseCurrentOutcomes: number;
    readonly maximumHarmfulActions: number;
    readonly minimumClusters: number;
    readonly minimumCorrectnessScoreMilli: number;
    readonly minimumTokenReductionBasisPoints: number;
  };
  readonly sourceCommit: string;
  readonly studyId: string;
  readonly exposureAuditPath: string;
  readonly tasks: readonly {
    readonly clusterId: string;
    readonly pilotDirectory: string;
    readonly planPath: string;
  }[];
  readonly version: typeof MATCHED_CONTINUATION_PREPARATION_VERSION;
}

interface PreparationOptions {
  readonly adapterPath: string;
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly matchedRuntimePath: string;
  readonly matchedPreparationReceiptPath: string;
  readonly matchedStudyPath: string;
  readonly outputDirectory: string;
  readonly preparationPlanPath: string;
}

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => prepareMatchedContinuationStudyFromFilesV1(options),
    catch: cause => ScriptError.make({message: 'Matched continuation study preparation stopped.', cause}),
  });
});

export async function prepareMatchedContinuationStudyFromFilesV1(options: PreparationOptions): Promise<void> {
  const [
    corpusBytes,
    manifestBytes,
    matchedPreparationReceiptBytes,
    matchedStudyBytes,
    matchedRuntimeBytes,
    preparationPlanBytes,
    adapterSha256,
  ] = await Promise.all([
    readBoundedRegularFile(options.corpusPath, 8 * 1_024 * 1_024, 'corpus'),
    readBoundedRegularFile(options.manifestPath, 8 * 1_024 * 1_024, 'manifest'),
    readBoundedRegularFile(options.matchedPreparationReceiptPath, 8 * 1_024 * 1_024, 'matched preparation receipt'),
    readBoundedRegularFile(options.matchedStudyPath, 8 * 1_024 * 1_024, 'matched study'),
    readBoundedRegularFile(options.matchedRuntimePath, 8 * 1_024 * 1_024, 'matched runtime'),
    readBoundedRegularFile(options.preparationPlanPath, 8 * 1_024 * 1_024, 'continuation preparation plan'),
    sha256RegularFile(options.adapterPath, 256 * 1_024 * 1_024, 'continuation adapter'),
  ]);
  const corpus = parseMatchedEvaluationCorpusV1(parseJson(corpusBytes, 'corpus'));
  const manifest = parseMatchedEvaluationManifestV1(parseJson(manifestBytes, 'manifest'));
  const matchedStudy = parseMatchedTokenEfficiencyStudyV1(parseJson(matchedStudyBytes, 'matched study'));
  const matchedRuntime = parseMatchedEvaluationRuntimeV1(parseJson(matchedRuntimeBytes, 'matched runtime'));
  const matchedPreparationReceipt = parseMatchedPreparationReceipt(
    parseJson(matchedPreparationReceiptBytes, 'matched preparation receipt'),
  );
  const preparation = parsePreparationPlanV1(parseJson(preparationPlanBytes, 'continuation preparation plan'));
  const exposureAuditBytes = await readBoundedRegularFile(
    preparation.exposureAuditPath,
    8 * 1_024 * 1_024,
    'exposure audit',
  );
  const corpusHash = matchedEvaluationCorpusHashV1(corpus);
  if (manifest.corpusHash !== corpusHash) throw new Error('Continuation manifest refers to a different corpus.');
  if (matchedStudy.manifestHash !== manifest.manifestHash) {
    throw new Error('Continuation matched study refers to a different manifest.');
  }
  if (
    matchedPreparationReceipt.corpusHash !== corpusHash ||
    matchedPreparationReceipt.manifestHash !== manifest.manifestHash ||
    matchedPreparationReceipt.studyHash !== matchedStudy.studyHash ||
    matchedPreparationReceipt.verificationPlanHash !== matchedStudy.verificationPlanHash ||
    matchedPreparationReceipt.threadnoteSourceCommit !== preparation.sourceCommit
  ) {
    throw new Error('Continuation candidate differs from the matched preparation receipt.');
  }
  const compactArm = required(
    manifest.arms.find(arm => arm.arm === 'threadnote-compact'),
    'threadnote-compact arm',
  );
  const graphArm = required(
    manifest.arms.find(arm => arm.arm === 'threadnote-graph'),
    'threadnote-graph arm',
  );
  if (
    compactArm.tool.artifactHash === null ||
    compactArm.tool.artifactHash !== graphArm.tool.artifactHash ||
    compactArm.tool.version !== graphArm.tool.version
  ) {
    throw new Error('Continuation Threadnote arms do not share one pinned candidate.');
  }
  if (compactArm.adapterArtifactHash !== adapterSha256) {
    throw new Error('Continuation adapter bytes differ from the compact arm manifest attestation.');
  }
  if (
    matchedPreparationReceipt.adapterArtifactHash !== adapterSha256 ||
    matchedPreparationReceipt.threadnoteArtifactHash !== compactArm.tool.artifactHash
  ) {
    throw new Error('Continuation adapter or tool differs from the matched preparation receipt.');
  }

  const taskInputs = await Promise.all(
    preparation.tasks.map(async (entry, taskIndex) => {
      const planBytes = await readBoundedRegularFile(
        entry.planPath,
        8 * 1_024 * 1_024,
        `continuation plan ${taskIndex}`,
      );
      const plan = parseMatchedEvaluationContinuationPilotPlanV1(
        parseJson(planBytes, `continuation plan ${taskIndex}`),
      );
      if (plan.version !== 2) throw new Error(`Continuation plan ${taskIndex} must use the substantive v2 contract.`);
      await assertMatchedEvaluationContinuationAdapterConfigurationsV2({
        manifest,
        plan,
        planPath: entry.planPath,
        runtime: matchedRuntime,
      });
      if (
        plan.candidate.toolArtifactHash !== compactArm.tool.artifactHash ||
        plan.candidate.toolVersion !== compactArm.tool.version
      ) {
        throw new Error(`Continuation plan ${taskIndex} uses a different candidate.`);
      }
      const corpusTask = required(
        corpus.tasks.find(task => task.taskId === plan.taskId),
        `corpus task ${plan.taskId}`,
      );
      const taskContext = required(
        matchedStudy.taskContexts.find(context => context.taskId === plan.taskId),
        `matched task context ${plan.taskId}`,
      );
      const cluster = required(
        matchedStudy.clusters.find(candidate => candidate.clusterId === entry.clusterId),
        `matched cluster ${entry.clusterId}`,
      );
      if (
        taskContext.clusterId !== cluster.clusterId ||
        !cluster.taskIds.includes(plan.taskId) ||
        plan.sourceTask.repositoryRevision !== cluster.revision ||
        plan.sourceTask.repositoryFixtureHash !== cluster.repositoryFixtureHash ||
        corpusTask.repositoryFixtureHash !== cluster.repositoryFixtureHash
      ) {
        throw new Error(`Continuation plan ${taskIndex} differs from its frozen source cluster.`);
      }
      continuationCheckpointStudyV2(matchedStudy, plan.sourceTask, plan.checkpoint);
      const runtimeRepository = required(
        matchedRuntime.repositories.find(repository => repository.clusterId === entry.clusterId),
        `runtime repository ${entry.clusterId}`,
      );
      if (runtimeRepository.repositoryIdentityHash !== cluster.repositoryIdentityHash) {
        throw new Error(`Continuation runtime repository ${taskIndex} has a different identity.`);
      }
      await assertMatchedEvaluationRepositoryV1(runtimeRepository.repositoryDirectory, {
        dirty: false,
        fixtureHash: plan.checkpoint.repositoryFixtureHash,
        identityHash: cluster.repositoryIdentityHash,
        revision: plan.checkpoint.repositoryRevision,
      });
      return {entry, plan, planSha256: sha256(planBytes), cluster};
    }),
  );
  assertExposureAuditV1(parseJson(exposureAuditBytes, 'continuation exposure audit'), preparation, taskInputs);

  let globalRunOrder = 0;
  const study = createMatchedContinuationStudyV1({
    bootstrap: preparation.bootstrap,
    candidate: {
      adapterArtifactSha256: adapterSha256,
      sourceCommit: preparation.sourceCommit,
      toolArtifactHash: compactArm.tool.artifactHash,
      toolVersion: compactArm.tool.version,
    },
    gates: preparation.gates,
    schedule: taskInputs.flatMap(({plan}) =>
      [...plan.attempts]
        .sort((left, right) => left.runOrder - right.runOrder)
        .map(attempt => ({
          globalRunOrder: (globalRunOrder += 1),
          runNonce: attempt.runNonce,
          taskId: plan.taskId,
          variant: attempt.variant,
          withinTaskRunOrder: attempt.runOrder,
        })),
    ),
    sourceEvidence: {
      corpusHash,
      exposureAuditSha256: sha256(exposureAuditBytes),
      manifestHash: manifest.manifestHash,
      matchedPreparationReceiptSha256: sha256(matchedPreparationReceiptBytes),
      matchedStudyHash: matchedStudy.studyHash,
      verificationPlanHash: matchedStudy.verificationPlanHash,
    },
    studyId: preparation.studyId,
    tasks: taskInputs.map(({cluster, plan, planSha256}) => ({
      checkpointRepositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
      checkpointRevision: plan.checkpoint.repositoryRevision,
      clusterId: cluster.clusterId,
      planSha256,
      repositoryUrl: cluster.repositoryUrl,
      sourceRepositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
      sourceRevision: plan.sourceTask.repositoryRevision,
      taskId: plan.taskId,
    })),
    variants: ['files-bare', 'manual-handoff', 'threadnote-graph', 'threadnote-resume', 'threadnote-preloaded-resume'],
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt',
  });
  const runtime = parseMatchedContinuationStudyRuntimeV1({
    corpusPath: await canonicalRegularFile(options.corpusPath, 'corpus'),
    exposureAuditPath: await canonicalRegularFile(preparation.exposureAuditPath, 'exposure audit'),
    exposureAuditSha256: sha256(exposureAuditBytes),
    manifestPath: await canonicalRegularFile(options.manifestPath, 'manifest'),
    matchedPreparationReceiptPath: await canonicalRegularFile(
      options.matchedPreparationReceiptPath,
      'matched preparation receipt',
    ),
    matchedRuntimePath: await canonicalRegularFile(options.matchedRuntimePath, 'matched runtime'),
    matchedStudyPath: await canonicalRegularFile(options.matchedStudyPath, 'matched study'),
    studyHash: study.studyHash,
    tasks: taskInputs.map(({entry, plan, planSha256}) => ({
      pilotDirectory: entry.pilotDirectory,
      planPath: entry.planPath,
      planSha256,
      taskId: plan.taskId,
    })),
    version: 1,
  } satisfies MatchedContinuationStudyRuntimeV1);
  const receipt = {
    adapterArtifactSha256: adapterSha256,
    exposureAuditSha256: sha256(exposureAuditBytes),
    preparationPlanSha256: sha256(preparationPlanBytes),
    runtimeLocalOnly: true,
    runtimeSha256: sha256(jsonBytes(runtime)),
    studyHash: study.studyHash,
    studySha256: sha256(jsonBytes(study)),
    taskPlanSha256: Object.fromEntries(taskInputs.map(({plan, planSha256}) => [plan.taskId, planSha256])),
    version: MATCHED_CONTINUATION_PREPARATION_VERSION,
  };
  await assertMatchedContinuationRuntimeFilesV1(study, runtime);
  await ensureOutputDirectory(options.outputDirectory);
  await atomicWrite(join(options.outputDirectory, 'continuation-study.json'), jsonBytes(study));
  await atomicWrite(join(options.outputDirectory, 'continuation-runtime.json'), jsonBytes(runtime));
  await atomicWrite(join(options.outputDirectory, 'continuation-preparation-receipt.json'), jsonBytes(receipt));
  process.stdout.write(
    `${JSON.stringify({outputDirectory: options.outputDirectory, studyHash: study.studyHash, tasks: study.tasks.length})}\n`,
  );
}

function assertExposureAuditV1(
  value: unknown,
  preparation: MatchedContinuationPreparationPlanV1,
  taskInputs: readonly {readonly plan: {readonly taskId: string}}[],
): void {
  const audit = object(value, 'continuation exposure audit');
  exactKeys(audit, ['productFreezeCommit', 'reviewedBeforeProviderOutcomes', 'tasks', 'version']);
  if (audit.version !== 1) invalid('exposure audit version must be 1');
  if (audit.productFreezeCommit !== preparation.sourceCommit) {
    invalid('exposure audit product freeze commit differs from the candidate');
  }
  if (audit.reviewedBeforeProviderOutcomes !== true) {
    invalid('exposure audit must be reviewed before provider outcomes');
  }
  const tasks = array(audit.tasks, 'continuation exposure audit tasks').map((entry, index) => {
    const task = object(entry, `continuation exposure audit task ${index}`);
    exactKeys(task, ['priorProductImplementationExposure', 'priorProviderOutcomeExposure', 'taskId']);
    if (task.priorProductImplementationExposure !== false || task.priorProviderOutcomeExposure !== false) {
      invalid(`exposure audit task ${index} is not held out`);
    }
    return matching(task.taskId, /^tsk_[0-9a-f]{16,64}$/u, `exposure audit task ${index} id`);
  });
  unique(tasks, 'continuation exposure audit task ids');
  const expected = taskInputs.map(({plan}) => plan.taskId).sort();
  const actual = [...tasks].sort();
  if (expected.length !== actual.length || expected.some((taskId, index) => taskId !== actual[index])) {
    invalid('exposure audit tasks do not exactly cover the continuation study');
  }
}

function parseMatchedPreparationReceipt(value: unknown): {
  readonly adapterArtifactHash: string;
  readonly corpusHash: string;
  readonly manifestHash: string;
  readonly studyHash: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteSourceCommit: string;
  readonly verificationPlanHash: string;
} {
  const receipt = object(value, 'matched preparation receipt');
  return {
    adapterArtifactHash: matching(receipt.adapterArtifactHash, /^[0-9a-f]{64}$/u, 'receipt adapter hash'),
    corpusHash: matching(receipt.corpusHash, /^[0-9a-f]{64}$/u, 'receipt corpus hash'),
    manifestHash: matching(receipt.manifestHash, /^[0-9a-f]{64}$/u, 'receipt manifest hash'),
    studyHash: matching(receipt.studyHash, /^[0-9a-f]{64}$/u, 'receipt study hash'),
    threadnoteArtifactHash: matching(
      receipt.threadnoteArtifactHash,
      /^[0-9a-f]{64}$/u,
      'receipt Threadnote artifact hash',
    ),
    threadnoteSourceCommit: matching(
      receipt.threadnoteSourceCommit,
      /^[0-9a-f]{40}$/u,
      'receipt Threadnote source commit',
    ),
    verificationPlanHash: matching(receipt.verificationPlanHash, /^[0-9a-f]{64}$/u, 'receipt verification plan hash'),
  };
}

function parsePreparationPlanV1(value: unknown): MatchedContinuationPreparationPlanV1 {
  const plan = object(value, 'continuation preparation plan');
  exactKeys(plan, ['bootstrap', 'exposureAuditPath', 'gates', 'sourceCommit', 'studyId', 'tasks', 'version']);
  if (plan.version !== MATCHED_CONTINUATION_PREPARATION_VERSION) invalid('preparation plan version must be 1');
  const bootstrap = object(plan.bootstrap, 'continuation preparation bootstrap');
  exactKeys(bootstrap, ['confidenceLevelBasisPoints', 'iterations', 'seed']);
  if (bootstrap.confidenceLevelBasisPoints !== 9_500) invalid('bootstrap confidence must be 95%');
  const gates = object(plan.gates, 'continuation preparation gates');
  exactKeys(gates, [
    'completionNonInferiorityBasisPoints',
    'maximumAuthorizationLeaks',
    'maximumFalseCurrentOutcomes',
    'maximumHarmfulActions',
    'minimumClusters',
    'minimumCorrectnessScoreMilli',
    'minimumTokenReductionBasisPoints',
  ]);
  const tasks = array(plan.tasks, 'continuation preparation tasks').map((entry, index) => {
    const task = object(entry, `continuation preparation task ${index}`);
    exactKeys(task, ['clusterId', 'pilotDirectory', 'planPath']);
    return {
      clusterId: matching(task.clusterId, /^cluster_[0-9a-f]{16,64}$/u, `continuation task ${index} cluster`),
      pilotDirectory: absolutePath(task.pilotDirectory, `continuation task ${index} pilot directory`),
      planPath: absolutePath(task.planPath, `continuation task ${index} plan path`),
    };
  });
  unique(
    tasks.map(task => task.clusterId),
    'continuation preparation clusters',
  );
  unique(
    tasks.map(task => task.planPath),
    'continuation preparation plan paths',
  );
  unique(
    tasks.map(task => task.pilotDirectory),
    'continuation preparation pilot directories',
  );
  return {
    bootstrap: {
      confidenceLevelBasisPoints: 9_500,
      iterations: integer(bootstrap.iterations, 200, 100_000, 'bootstrap iterations'),
      seed: matching(bootstrap.seed, /^[0-9a-f]{64}$/u, 'bootstrap seed'),
    },
    gates: {
      completionNonInferiorityBasisPoints: integer(
        gates.completionNonInferiorityBasisPoints,
        0,
        5_000,
        'completion non-inferiority margin',
      ),
      maximumAuthorizationLeaks: integer(gates.maximumAuthorizationLeaks, 0, 1_000, 'authorization leak limit'),
      maximumFalseCurrentOutcomes: integer(gates.maximumFalseCurrentOutcomes, 0, 1_000, 'false-current limit'),
      maximumHarmfulActions: integer(gates.maximumHarmfulActions, 0, 1_000, 'harmful-action limit'),
      minimumClusters: integer(gates.minimumClusters, 5, 64, 'minimum clusters'),
      minimumCorrectnessScoreMilli: integer(gates.minimumCorrectnessScoreMilli, 0, 1_000, 'minimum correctness score'),
      minimumTokenReductionBasisPoints: integer(
        gates.minimumTokenReductionBasisPoints,
        0,
        9_999,
        'minimum token reduction',
      ),
    },
    exposureAuditPath: absolutePath(plan.exposureAuditPath, 'exposure audit path'),
    sourceCommit: matching(plan.sourceCommit, /^[0-9a-f]{40}$/u, 'candidate source commit'),
    studyId: matching(plan.studyId, /^[a-z][a-z0-9-]{2,63}$/u, 'continuation study id'),
    tasks,
    version: MATCHED_CONTINUATION_PREPARATION_VERSION,
  };
}

function parseArguments(args: readonly string[]): PreparationOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--adapter',
    '--corpus',
    '--manifest',
    '--matched-preparation-receipt',
    '--matched-runtime',
    '--matched-study',
    '--output',
    '--plan',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option) || values.has(option)) throw new Error(`Unknown or repeated option: ${option}`);
    values.set(option, required(args[++index], option));
  }
  return {
    adapterPath: absolutePath(required(values.get('--adapter'), '--adapter'), '--adapter'),
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    manifestPath: absolutePath(required(values.get('--manifest'), '--manifest'), '--manifest'),
    matchedPreparationReceiptPath: absolutePath(
      required(values.get('--matched-preparation-receipt'), '--matched-preparation-receipt'),
      '--matched-preparation-receipt',
    ),
    matchedRuntimePath: absolutePath(
      required(values.get('--matched-runtime'), '--matched-runtime'),
      '--matched-runtime',
    ),
    matchedStudyPath: absolutePath(required(values.get('--matched-study'), '--matched-study'), '--matched-study'),
    outputDirectory: absolutePath(required(values.get('--output'), '--output'), '--output'),
    preparationPlanPath: absolutePath(required(values.get('--plan'), '--plan'), '--plan'),
  };
}

async function ensureOutputDirectory(path: string): Promise<void> {
  if (!path.split(sep).includes('.context'))
    throw new Error('Continuation output must be inside a .context directory.');
  await mkdir(path, {recursive: true, mode: 0o700});
  if ((await realpath(path)) !== path) throw new Error('Continuation output directory must be canonical.');
}

async function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const canonical = await canonicalRegularFile(path, label);
  const metadata = await lstat(canonical);
  if (metadata.size > maximumBytes) throw new Error(`${label} exceeds its bounded size.`);
  return readFile(canonical);
}

async function sha256RegularFile(path: string, maximumBytes: number, label: string): Promise<string> {
  return sha256(await readBoundedRegularFile(path, maximumBytes, label));
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular non-linked file.`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
  await rename(temporary, path);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, {cause});
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid('object contains unsupported or missing fields');
  }
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const text = boundedText(value, 1, 4_096, label);
  if (!pattern.test(text)) invalid(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (!isAbsolute(path)) invalid(`${label} must be absolute`);
  return resolve(path);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${label}.`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched continuation preparation: ${message}.`);
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
