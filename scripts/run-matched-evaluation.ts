#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This evaluation runner owns pinned local executable, artifact, and process-group boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  matchedEvaluationReferenceEnvironmentPolicyV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  MATCHED_EVALUATION_ARMS,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  parseMatchedEvaluationObservationV1,
  parseMatchedEvaluationOutcomesJsonlV1,
  runMatchedEvaluationV1,
  summarizeMatchedEvaluationV1,
  type MatchedEvaluationRunRequestV1,
  type MatchedEvaluationUnavailableReason,
} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  assertMatchedTokenEfficiencyObservationContextV1,
  assertMatchedTokenEfficiencyStudyMatchesV1,
  evaluateMatchedTokenEfficiencyV1,
  parseMatchedTokenEfficiencyStudyV1,
  renderMatchedTokenEfficiencyArticleEvidenceV1,
  type MatchedTokenEfficiencyStudyV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  assertMatchedEvaluationPinnedFileV1,
  assertMatchedEvaluationRepositoryV1,
  compareAndSwapMatchedEvaluationLedgerV1,
  type MatchedEvaluationRepositoryObservationV1,
  stageMatchedEvaluationPinnedFileV1,
  withMatchedEvaluationArtifactLockV1,
} from './matched-evaluation-runtime-integrity.js';

export const MATCHED_EVALUATION_RUNTIME_VERSION = 3 as const;

export interface MatchedEvaluationRuntimeV1 {
  readonly arms: readonly MatchedEvaluationRuntimeArmV1[];
  readonly artifactDirectory: string;
  readonly repositories: readonly MatchedEvaluationRuntimeRepositoryV1[];
  readonly timeoutMilliseconds: number;
  readonly version: typeof MATCHED_EVALUATION_RUNTIME_VERSION;
}

export interface MatchedEvaluationRuntimeArmV1 {
  readonly adapterArguments: readonly string[];
  readonly adapterConfigFile: string;
  readonly adapterExecutable: string;
  readonly arm: MatchedEvaluationArm;
  readonly environmentKeys: readonly string[];
  readonly toolExecutable: string | null;
  readonly toolLockFile: string | null;
}

export interface MatchedEvaluationRuntimeRepositoryV1 {
  readonly clusterId: string | null;
  readonly repositoryDirectory: string;
  readonly repositoryIdentityHash: string;
}

export function projectMatchedEvaluationAdapterTaskV1(
  request: Pick<MatchedEvaluationRunRequestV1, 'arm' | 'task'>,
  study: MatchedTokenEfficiencyStudyV1 | null,
) {
  const taskContext = study?.taskContexts.find(context => context.taskId === request.task.taskId) ?? null;
  if (study !== null && taskContext === null) {
    throw new Error(`Token-efficiency study has no prepared context for ${request.task.taskId}.`);
  }
  return {
    agentTask: {
      category: request.task.category,
      /** Memory contents must be discovered through the pinned arm, never injected into an adapter request. */
      memoryFixtures: [] as const,
      prompt: request.task.prompt,
      repositoryFixtureHash: request.task.repositoryFixtureHash,
      taskId: request.task.taskId,
      variant: request.task.variant,
    },
    preparedContext:
      request.arm === 'threadnote-compact' || request.arm === 'threadnote-source'
        ? {memoryAccess: 'linked' as const, studyHash: study?.studyHash ?? null, taskContext}
        : request.arm === 'threadnote-graph'
          ? {
              graphContext:
                taskContext === null
                  ? null
                  : {
                      clusterId: taskContext.clusterId,
                      graphContentHash: taskContext.graphContentHash,
                      graphSnapshotHash: taskContext.graphSnapshotHash,
                      repositoryFixtureHash: taskContext.repositoryFixtureHash,
                      taskId: taskContext.taskId,
                    },
              memoryAccess: 'disabled' as const,
              studyHash: study?.studyHash ?? null,
            }
          : null,
  };
}

interface ResolvedRuntimeArm {
  readonly config: MatchedEvaluationRuntimeArmV1;
  readonly adapterConfigFile: string;
  readonly definition: MatchedEvaluationArmDefinitionV1;
  readonly toolExecutable: string | null;
}

export interface ResolvedRuntimeRepository {
  readonly clusterId: string | null;
  readonly expected: MatchedEvaluationRepositoryObservationV1;
  readonly repositoryDirectory: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  'DO_NOT_TRACK',
  'HOME',
  'LANG',
  'LC_ALL',
  'MATCHED_EVALUATION_ADAPTER_CONFIG',
  'MATCHED_EVALUATION_ADAPTER_EXECUTABLE',
  'MATCHED_EVALUATION_TOOL',
  'PATH',
  'THREADNOTE_TELEMETRY',
  'TMPDIR',
]);
const MAXIMUM_JSON_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_TRANSCRIPT_BYTES = 64 * 1_024 * 1_024;

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => runMatchedEvaluationFromFilesV1(options),
    catch: cause => ScriptError.make({message: 'Matched evaluation stopped.', cause}),
  });
});

export async function runMatchedEvaluationFromFilesV1(options: {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath?: string | null;
}): Promise<void> {
  const [corpus, manifest, runtime, study] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.manifestPath).then(parseMatchedEvaluationManifestV1),
    readJson(options.runtimePath).then(parseMatchedEvaluationRuntimeV1),
    options.studyPath === null || options.studyPath === undefined
      ? Promise.resolve(null)
      : readJson(options.studyPath).then(parseMatchedTokenEfficiencyStudyV1),
  ]);
  if (study !== null) assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  const repositories = await resolveMatchedEvaluationRuntimeRepositoriesV1(runtime, study, manifest.repository);
  await assertLocalArtifactDirectory(runtime.artifactDirectory);
  await withMatchedEvaluationArtifactLockV1(runtime.artifactDirectory, async () => {
    await assertResolvedRuntimeRepositories(repositories);
    const outcomesPath = resolve(runtime.artifactDirectory, 'outcomes.jsonl');
    const summaryPath = resolve(runtime.artifactDirectory, 'summary.json');
    let expectedLedgerText = await readOptionalText(outcomesPath, 16 * 1_024 * 1_024);
    const existing = parseMatchedEvaluationOutcomesJsonlV1(expectedLedgerText);
    const ledgerOutcomes = [...existing];
    const resolved = new Map<MatchedEvaluationArm, ResolvedRuntimeArm>();
    const unavailable = new Map<
      MatchedEvaluationArm,
      {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}
    >();
    const outcomes = await runMatchedEvaluationV1({
      availability: async (arm, definition) => {
        const resolution = await resolveRuntimeArm(runtime, arm, definition);
        if ('reason' in resolution) {
          unavailable.set(arm, resolution);
          return {available: false, ...resolution};
        }
        resolved.set(arm, resolution);
        return {available: true};
      },
      corpus,
      execute: async request => {
        const repository = requiredRuntimeRepository(repositories, request.task.taskId, study);
        await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
        const result = await executeArm(
          runtime,
          requiredResolvedArm(resolved, request.arm),
          repository,
          request,
          study,
        );
        await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected);
        return result;
      },
      manifest,
      onOutcome: async outcome => {
        if (ledgerOutcomes.length !== outcome.runOrder) {
          throw new Error('Outcome ledger prefix differs from the in-memory run prefix.');
        }
        const replacement = `${[...ledgerOutcomes, outcome].map(value => JSON.stringify(value)).join('\n')}\n`;
        await compareAndSwapMatchedEvaluationLedgerV1(outcomesPath, expectedLedgerText, replacement);
        expectedLedgerText = replacement;
        ledgerOutcomes.push(outcome);
      },
      outcomes: existing,
    });
    await assertResolvedRuntimeRepositories(repositories);
    const summary = summarizeMatchedEvaluationV1(manifest, outcomes);
    await atomicWrite(summaryPath, `${JSON.stringify(summary, undefined, 2)}\n`);
    const tokenEfficiencyReport =
      study === null ? null : evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes, study});
    if (tokenEfficiencyReport !== null) {
      await Promise.all([
        atomicWrite(
          resolve(runtime.artifactDirectory, 'token-efficiency-report.json'),
          `${JSON.stringify(tokenEfficiencyReport, undefined, 2)}\n`,
        ),
        atomicWrite(
          resolve(runtime.artifactDirectory, 'article-evidence.md'),
          renderMatchedTokenEfficiencyArticleEvidenceV1(tokenEfficiencyReport),
        ),
      ]);
    }
    process.stdout.write(
      `${JSON.stringify({
        artifactDirectory: runtime.artifactDirectory,
        completed: outcomes.filter(outcome => outcome.status === 'completed').length,
        comparativeClaimsEligible: summary.comparativeClaimsEligible,
        manifestHash: manifest.manifestHash,
        tokenEfficiencyReportHash: tokenEfficiencyReport?.reportHash ?? null,
        unavailable: Object.fromEntries(unavailable),
        version: MATCHED_EVALUATION_RUNTIME_VERSION,
      })}\n`,
    );
  });
}

export function parseMatchedEvaluationRuntimeV1(value: unknown): MatchedEvaluationRuntimeV1 {
  const runtime = object(value, 'runtime');
  exactKeys(runtime, ['arms', 'artifactDirectory', 'repositories', 'timeoutMilliseconds', 'version'], 'runtime');
  if (runtime.version !== MATCHED_EVALUATION_RUNTIME_VERSION) invalid('runtime version must be 3');
  const arms = array(runtime.arms, 'runtime arms').map((entry, index) => parseRuntimeArm(entry, index));
  const repositories = array(runtime.repositories, 'runtime repositories').map((entry, index) =>
    parseRuntimeRepository(entry, index),
  );
  if (repositories.length === 0 || repositories.length > 64) invalid('runtime repositories must contain 1-64 entries');
  unique(
    arms.map(arm => arm.arm),
    'runtime arm ids',
  );
  unique(
    repositories.map(repository => repository.clusterId ?? 'single-repository'),
    'runtime repository cluster ids',
  );
  unique(
    repositories.map(repository => repository.repositoryDirectory),
    'runtime repository directories',
  );
  return {
    arms,
    artifactDirectory: absolutePath(runtime.artifactDirectory, 'runtime artifact directory'),
    repositories,
    timeoutMilliseconds: boundedPositiveInteger(runtime.timeoutMilliseconds, 60_000, 7_200_000, 'runtime timeout'),
    version: MATCHED_EVALUATION_RUNTIME_VERSION,
  };
}

export async function resolveMatchedEvaluationRuntimeRepositoriesV1(
  runtime: MatchedEvaluationRuntimeV1,
  study: MatchedTokenEfficiencyStudyV1 | null,
  manifestRepository: MatchedEvaluationRepositoryObservationV1,
): Promise<ReadonlyMap<string | null, ResolvedRuntimeRepository>> {
  const resolved = new Map<string | null, ResolvedRuntimeRepository>();
  if (study === null) {
    if (runtime.repositories.length !== 1 || runtime.repositories[0]?.clusterId !== null) {
      throw new Error('A non-study matched evaluation requires one unclustered runtime repository.');
    }
    const repository = runtime.repositories[0];
    if (repository.repositoryIdentityHash !== manifestRepository.identityHash) {
      throw new Error('Runtime repository identity differs from the content-addressed manifest.');
    }
    await canonicalDirectory(repository.repositoryDirectory, 'runtime repository directory');
    await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, manifestRepository);
    resolved.set(null, {
      clusterId: null,
      expected: manifestRepository,
      repositoryDirectory: repository.repositoryDirectory,
    });
    return resolved;
  }
  if (
    runtime.repositories.length !== study.clusters.length ||
    runtime.repositories.some(entry => entry.clusterId === null)
  ) {
    throw new Error('Token-efficiency runtime repositories do not exactly cover the held-out clusters.');
  }
  await Promise.all(
    study.clusters.map(async cluster => {
      const repository = runtime.repositories.find(candidate => candidate.clusterId === cluster.clusterId);
      if (repository === undefined) throw new Error(`Runtime repository is missing cluster ${cluster.clusterId}.`);
      if (repository.repositoryIdentityHash !== cluster.repositoryIdentityHash) {
        throw new Error(`Runtime repository identity differs for cluster ${cluster.clusterId}.`);
      }
      const expected = {
        dirty: false,
        fixtureHash: cluster.repositoryFixtureHash,
        identityHash: cluster.repositoryIdentityHash,
        revision: cluster.revision,
      } satisfies MatchedEvaluationRepositoryObservationV1;
      await canonicalDirectory(repository.repositoryDirectory, `runtime repository ${cluster.clusterId}`);
      await assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, expected);
      resolved.set(cluster.clusterId, {
        clusterId: cluster.clusterId,
        expected,
        repositoryDirectory: repository.repositoryDirectory,
      });
    }),
  );
  return resolved;
}

async function assertResolvedRuntimeRepositories(
  repositories: ReadonlyMap<string | null, ResolvedRuntimeRepository>,
): Promise<void> {
  await Promise.all(
    [...repositories.values()].map(repository =>
      assertMatchedEvaluationRepositoryV1(repository.repositoryDirectory, repository.expected),
    ),
  );
}

function requiredRuntimeRepository(
  repositories: ReadonlyMap<string | null, ResolvedRuntimeRepository>,
  taskId: string,
  study: MatchedTokenEfficiencyStudyV1 | null,
): ResolvedRuntimeRepository {
  const clusterId = study?.taskContexts.find(context => context.taskId === taskId)?.clusterId ?? null;
  const repository = repositories.get(clusterId);
  if (repository === undefined) throw new Error(`No runtime repository is bound to task ${taskId}.`);
  return repository;
}

async function resolveRuntimeArm(
  runtime: MatchedEvaluationRuntimeV1,
  arm: MatchedEvaluationArm,
  definition: MatchedEvaluationArmDefinitionV1,
): Promise<ResolvedRuntimeArm | {readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}> {
  const config = runtime.arms.find(candidate => candidate.arm === arm);
  if (config === undefined) return {detail: `${arm} has no local runtime mapping`, reason: 'runtime-not-configured'};
  const [adapter, adapterConfigFile] = await Promise.all([
    optionalCanonicalRegularFile(config.adapterExecutable, true),
    optionalCanonicalRegularFile(config.adapterConfigFile, false),
  ]);
  if (adapter === null) return {detail: `${arm} adapter executable is missing`, reason: 'adapter-missing'};
  if (adapterConfigFile === null) {
    return {detail: `${arm} adapter configuration is missing`, reason: 'adapter-config-missing'};
  }
  if ((await sha256File(adapter)) !== definition.adapterArtifactHash) {
    throw new Error(`${arm} adapter executable differs from its pinned manifest identity.`);
  }
  if ((await sha256File(adapterConfigFile)) !== definition.adapterConfigurationHash) {
    throw new Error(`${arm} adapter configuration differs from its pinned manifest identity.`);
  }
  if (definition.tool.artifactHash === null) {
    if (config.toolExecutable !== null || config.toolLockFile !== null) {
      throw new Error(`${arm} runtime unexpectedly configures a separate tool executable or lock.`);
    }
    return {
      adapterConfigFile,
      config: {...config, adapterConfigFile, adapterExecutable: adapter},
      definition,
      toolExecutable: null,
    };
  }
  if (config.toolExecutable === null || config.toolLockFile === null) {
    return {detail: `${arm} tool executable or lock identity is not configured`, reason: 'tool-missing'};
  }
  const [tool, lock] = await Promise.all([
    optionalCanonicalRegularFile(config.toolExecutable, true),
    optionalCanonicalRegularFile(config.toolLockFile, false),
  ]);
  if (tool === null || lock === null) {
    return {detail: `${arm} pinned tool executable or lock identity is missing`, reason: 'tool-missing'};
  }
  const [toolHash, lockHash] = await Promise.all([sha256File(tool), sha256File(lock)]);
  if (toolHash !== definition.tool.artifactHash || lockHash !== definition.tool.lockIdentityHash) {
    throw new Error(`${arm} tool executable or lock differs from its pinned manifest identity.`);
  }
  return {
    adapterConfigFile,
    config: {...config, adapterExecutable: adapter, toolExecutable: tool, toolLockFile: lock},
    definition,
    toolExecutable: tool,
  };
}

async function executeArm(
  runtime: MatchedEvaluationRuntimeV1,
  resolvedArm: ResolvedRuntimeArm,
  repository: ResolvedRuntimeRepository,
  request: MatchedEvaluationRunRequestV1,
  study: MatchedTokenEfficiencyStudyV1 | null,
) {
  const runDirectory = resolve(runtime.artifactDirectory, 'runs', request.schedule.runNonce);
  const transcriptDirectory = resolve(runtime.artifactDirectory, 'transcripts');
  const requestPath = resolve(runDirectory, 'request.json');
  const responsePath = resolve(runDirectory, 'response.json');
  const artifactPath = resolve(runDirectory, 'artifact.json');
  const transcriptPath = resolve(transcriptDirectory, `${request.schedule.runNonce}.jsonl`);
  const stagedDirectory = resolve(runDirectory, 'runtime');
  await rm(stagedDirectory, {force: true, recursive: true});
  await Promise.all([
    mkdir(runDirectory, {recursive: true, mode: 0o700}),
    mkdir(transcriptDirectory, {recursive: true, mode: 0o700}),
    mkdir(stagedDirectory, {recursive: true, mode: 0o700}),
  ]);
  const stagedArm = await stageResolvedRuntimeArmV1(resolvedArm, stagedDirectory);
  if (request.arm === 'reference-scope')
    await mkdir(resolve(runDirectory, 'reference-home'), {recursive: true, mode: 0o700});
  const projectedTask = projectMatchedEvaluationAdapterTaskV1(request, study);
  await atomicWrite(
    requestPath,
    `${JSON.stringify(
      {
        adapterArtifactHash: stagedArm.definition.adapterArtifactHash,
        adapterProtocol: stagedArm.definition.adapterProtocol,
        adapterConfigurationHash: stagedArm.definition.adapterConfigurationHash,
        arm: request.arm,
        environmentPolicyHash: stagedArm.definition.environmentPolicyHash,
        agentTask: projectedTask.agentTask,
        artifactPath,
        blindLabel: request.schedule.blindLabel,
        judgeTask: {
          negativeControls: request.task.negativeControls,
          rubric: request.task.rubric,
          sourceGold: request.task.sourceGold,
        },
        manifestHash: request.manifest.manifestHash,
        model: request.manifest.model,
        repository: repository.expected,
        preparedContext: projectedTask.preparedContext,
        runNonce: request.schedule.runNonce,
        runOrder: request.schedule.runOrder,
        tool: {
          artifactHash: stagedArm.definition.tool.artifactHash,
          detail:
            request.arm === 'threadnote-source'
              ? 'source'
              : request.arm === 'threadnote-compact'
                ? 'compact'
                : request.arm === 'threadnote-graph'
                  ? 'graph-only'
                  : null,
          executable: stagedArm.toolExecutable,
          lockIdentityHash: stagedArm.definition.tool.lockIdentityHash,
          name: stagedArm.definition.tool.name,
          version: stagedArm.definition.tool.version,
        },
        transcriptPath,
        version: MATCHED_EVALUATION_RUNTIME_VERSION,
      },
      undefined,
      2,
    )}\n`,
  );
  await assertResolvedRuntimeArmArtifactsV1(stagedArm);
  let result;
  try {
    result = await captureCodeMemoryLinkProcessGroup({
      allowFailure: true,
      arguments: [...stagedArm.config.adapterArguments, '--request', requestPath, '--response', responsePath],
      command: stagedArm.config.adapterExecutable,
      cwd: repository.repositoryDirectory,
      environment: runtimeEnvironment(stagedArm, runDirectory),
      label: `Matched evaluation ${request.arm}`,
      maxOutputBytes: 1 * 1_024 * 1_024,
      timeoutMilliseconds: runtime.timeoutMilliseconds,
    });
  } finally {
    await assertResolvedRuntimeArmArtifactsV1(stagedArm);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${request.arm} adapter failed with exit code ${result.exitCode}: ${boundedDiagnostic(result)}`);
  }
  const observation = parseMatchedEvaluationObservationV1(await readJson(responsePath));
  if (study !== null) {
    assertMatchedTokenEfficiencyObservationContextV1({
      arm: request.arm,
      metrics: observation.metrics,
      study,
      taskId: request.task.taskId,
    });
  }
  const [artifactHash, transcriptHash] = await Promise.all([
    boundedRegularFileHash(artifactPath, MAXIMUM_JSON_BYTES, 'adapter artifact'),
    boundedRegularFileHash(transcriptPath, MAXIMUM_TRANSCRIPT_BYTES, 'local transcript'),
  ]);
  if (artifactHash !== observation.artifactHash || transcriptHash !== observation.transcriptHash) {
    throw new Error(`${request.arm} adapter observation does not bind its local artifact and transcript bytes.`);
  }
  return observation;
}

async function stageResolvedRuntimeArmV1(
  resolvedArm: ResolvedRuntimeArm,
  stagedDirectory: string,
): Promise<ResolvedRuntimeArm> {
  const [adapterExecutable, adapterConfigFile] = await Promise.all([
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.adapterExecutable,
      resolve(stagedDirectory, 'adapter'),
      resolvedArm.definition.adapterArtifactHash,
      true,
      `${resolvedArm.definition.arm} adapter executable`,
    ),
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.adapterConfigFile,
      resolve(stagedDirectory, 'adapter-config.json'),
      resolvedArm.definition.adapterConfigurationHash,
      false,
      `${resolvedArm.definition.arm} adapter configuration`,
    ),
  ]);
  if (resolvedArm.definition.tool.artifactHash === null) {
    return {
      adapterConfigFile,
      config: {...resolvedArm.config, adapterConfigFile, adapterExecutable},
      definition: resolvedArm.definition,
      toolExecutable: null,
    };
  }
  if (
    resolvedArm.config.toolExecutable === null ||
    resolvedArm.config.toolLockFile === null ||
    resolvedArm.definition.tool.lockIdentityHash === null
  ) {
    throw new Error(`${resolvedArm.definition.arm} lost its pinned tool configuration.`);
  }
  const [toolExecutable, toolLockFile] = await Promise.all([
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolExecutable,
      resolve(stagedDirectory, 'tool'),
      resolvedArm.definition.tool.artifactHash,
      true,
      `${resolvedArm.definition.arm} tool executable`,
    ),
    stageMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolLockFile,
      resolve(stagedDirectory, 'tool.lock'),
      resolvedArm.definition.tool.lockIdentityHash,
      false,
      `${resolvedArm.definition.arm} tool lock`,
    ),
  ]);
  return {
    adapterConfigFile,
    config: {...resolvedArm.config, adapterConfigFile, adapterExecutable, toolExecutable, toolLockFile},
    definition: resolvedArm.definition,
    toolExecutable,
  };
}

async function assertResolvedRuntimeArmArtifactsV1(resolvedArm: ResolvedRuntimeArm): Promise<void> {
  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.adapterExecutable,
      resolvedArm.definition.adapterArtifactHash,
      true,
      `${resolvedArm.definition.arm} adapter executable`,
    ),
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.adapterConfigFile,
      resolvedArm.definition.adapterConfigurationHash,
      false,
      `${resolvedArm.definition.arm} adapter configuration`,
    ),
  ]);
  if (resolvedArm.definition.tool.artifactHash === null) return;
  if (
    resolvedArm.config.toolExecutable === null ||
    resolvedArm.config.toolLockFile === null ||
    resolvedArm.definition.tool.lockIdentityHash === null
  ) {
    throw new Error(`${resolvedArm.definition.arm} lost its pinned tool configuration.`);
  }
  await Promise.all([
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolExecutable,
      resolvedArm.definition.tool.artifactHash,
      true,
      `${resolvedArm.definition.arm} tool executable`,
    ),
    assertMatchedEvaluationPinnedFileV1(
      resolvedArm.config.toolLockFile,
      resolvedArm.definition.tool.lockIdentityHash,
      false,
      `${resolvedArm.definition.arm} tool lock`,
    ),
  ]);
}

function runtimeEnvironment(resolvedArm: ResolvedRuntimeArm, runDirectory: string): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
  };
  environment.MATCHED_EVALUATION_ADAPTER_CONFIG = resolvedArm.adapterConfigFile;
  environment.MATCHED_EVALUATION_ADAPTER_EXECUTABLE = resolvedArm.config.adapterExecutable;
  for (const key of resolvedArm.config.environmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (resolvedArm.definition.arm === 'reference-scope') {
    Object.assign(environment, matchedEvaluationReferenceEnvironmentPolicyV1(), {
      HOME: resolve(runDirectory, 'reference-home'),
    });
  }
  if (resolvedArm.toolExecutable !== null) environment.MATCHED_EVALUATION_TOOL = resolvedArm.toolExecutable;
  return environment;
}

function parseRuntimeArm(value: unknown, index: number): MatchedEvaluationRuntimeArmV1 {
  const arm = object(value, `runtime arm ${index}`);
  exactKeys(
    arm,
    [
      'adapterArguments',
      'adapterConfigFile',
      'adapterExecutable',
      'arm',
      'environmentKeys',
      'toolExecutable',
      'toolLockFile',
    ],
    `runtime arm ${index}`,
  );
  const environmentKeys = stringArray(arm.environmentKeys, 0, 32, 64, `runtime arm ${index} environment keys`);
  unique(environmentKeys, `runtime arm ${index} environment keys`);
  if (environmentKeys.some(key => !ENVIRONMENT_KEY.test(key) || BLOCKED_ENVIRONMENT_KEYS.has(key))) {
    invalid(`runtime arm ${index} contains a reserved or invalid environment key`);
  }
  return {
    adapterArguments: stringArray(arm.adapterArguments, 0, 64, 4_096, `runtime arm ${index} adapter arguments`),
    adapterConfigFile: absolutePath(arm.adapterConfigFile, `runtime arm ${index} adapter configuration`),
    adapterExecutable: absolutePath(arm.adapterExecutable, `runtime arm ${index} adapter executable`),
    arm: literal(arm.arm, MATCHED_EVALUATION_ARMS, `runtime arm ${index} id`),
    environmentKeys,
    toolExecutable:
      arm.toolExecutable === null ? null : absolutePath(arm.toolExecutable, `runtime arm ${index} tool executable`),
    toolLockFile:
      arm.toolLockFile === null ? null : absolutePath(arm.toolLockFile, `runtime arm ${index} tool lock file`),
  };
}

function parseRuntimeRepository(value: unknown, index: number): MatchedEvaluationRuntimeRepositoryV1 {
  const repository = object(value, `runtime repository ${index}`);
  exactKeys(repository, ['clusterId', 'repositoryDirectory', 'repositoryIdentityHash'], `runtime repository ${index}`);
  return {
    clusterId:
      repository.clusterId === null
        ? null
        : matchingString(repository.clusterId, CLUSTER_ID, `runtime repository ${index} cluster id`),
    repositoryDirectory: absolutePath(repository.repositoryDirectory, `runtime repository ${index} directory`),
    repositoryIdentityHash: matchingString(
      repository.repositoryIdentityHash,
      HASH,
      `runtime repository ${index} identity hash`,
    ),
  };
}

function parseArguments(args: readonly string[]): {
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly studyPath: string | null;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--corpus', '--manifest', '--runtime', '--study'].includes(option) || values.has(option)) {
      throw ScriptError.make({message: `Unknown or repeated matched evaluation option: ${option}`});
    }
    values.set(option, required(args[++index], option));
  }
  return {
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    manifestPath: absolutePath(required(values.get('--manifest'), '--manifest'), '--manifest'),
    runtimePath: absolutePath(required(values.get('--runtime'), '--runtime'), '--runtime'),
    studyPath:
      values.get('--study') === undefined ? null : absolutePath(required(values.get('--study'), '--study'), '--study'),
  };
}

async function assertLocalArtifactDirectory(path: string): Promise<void> {
  if (!path.split(sep).includes('.context')) {
    throw new Error('Runtime artifact directory must be inside a local .context directory.');
  }
  await mkdir(path, {recursive: true, mode: 0o700});
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Runtime artifact directory must use its canonical path.');
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

async function optionalCanonicalRegularFile(path: string, executable: boolean): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${path} must be one regular non-linked file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${path} must be executable.`);
  const canonical = await realpath(path);
  const current = await stat(canonical);
  if (canonical !== path || current.dev !== metadata.dev || current.ino !== metadata.ino) {
    throw new Error(`${path} changed or is not canonical.`);
  }
  return canonical;
}

async function boundedRegularFileHash(path: string, maximumBytes: number, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} is not one bounded regular file.`);
  }
  return sha256Bytes(await readFile(path));
}

async function readJson(path: string): Promise<unknown> {
  const text = await readRequiredText(path, MAXIMUM_JSON_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, {cause});
  }
}

async function readRequiredText(path: string, maximumBytes: number): Promise<string> {
  const text = await readOptionalTextOrNull(path, maximumBytes);
  if (text === null) throw new Error(`${path} does not exist.`);
  return text;
}

async function readOptionalText(path: string, maximumBytes: number): Promise<string> {
  return (await readOptionalTextOrNull(path, maximumBytes)) ?? '';
}

async function readOptionalTextOrNull(path: string, maximumBytes: number): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${path} is not one bounded regular file.`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${path} changed while it was read.`);
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(resolve(path, '..'), {recursive: true, mode: 0o700});
  try {
    await rm(temporary, {force: true});
    await writeFile(temporary, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedDiagnostic(result: {readonly stderr: string; readonly stdout: string}): string {
  const diagnostic = [result.stderr && `stderr: ${result.stderr}`, result.stdout && `stdout: ${result.stdout}`]
    .filter(Boolean)
    .join('\n');
  return diagnostic.slice(-2_048) || '(no output)';
}

function requiredResolvedArm(
  resolved: ReadonlyMap<MatchedEvaluationArm, ResolvedRuntimeArm>,
  arm: MatchedEvaluationArm,
): ResolvedRuntimeArm {
  const value = resolved.get(arm);
  if (value === undefined) throw new Error(`${arm} runtime was not resolved before execution.`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is outside its allowed range`);
  }
  return value;
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumLength: number,
  label: string,
): readonly string[] {
  const values = array(value, label);
  if (values.length < minimum || values.length > maximum) invalid(`${label} has invalid bounds`);
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maximumLength || entry.includes('\0')) {
      invalid(`${label} ${index} is invalid`);
    }
    return entry;
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation runtime: ${message}.`);
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
