#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This local evidence preparer owns reviewed filesystem and child-process boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  createMatchedEvaluationManifestV1,
  matchedEvaluationReferenceEnvironmentPolicyHashV1,
  parseMatchedEvaluationCorpusV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  type MatchedEvaluationCorpusV1,
  MATCHED_EVALUATION_ADAPTER_PROTOCOL,
  MATCHED_EVALUATION_ARMS,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  createMatchedTokenEfficiencyStudyV1,
  createMatchedTokenEfficiencyTaskContextV1,
  matchedTokenEfficiencyCitationHashV1,
  matchedTokenEfficiencyGraphContentHashV1,
  matchedTokenEfficiencyGraphSnapshotHashV1,
  type MatchedTokenEfficiencyLifecycleArmV1,
  type MatchedTokenEfficiencyStudyV1,
  type MatchedTokenEfficiencyTaskContextV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {assertCodeMemoryLinkGraphStatusPreflight} from './code-memory-link-codex-preflight.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  matchedEvaluationCodexEnvironmentPolicyHashV1,
  matchedEvaluationPreparedHomeFixtureHashV1,
  parseMatchedEvaluationCodexAdapterConfigV1,
  type MatchedEvaluationCodexAdapterConfigV1,
  type MatchedEvaluationPreparedContextHomeV1,
  MATCHED_EVALUATION_CODEX_ADAPTER_VERSION,
} from './matched-evaluation-codex-adapter.js';
import {
  observeMatchedEvaluationRepositoryV1,
  type MatchedEvaluationRepositoryObservationV1,
} from './matched-evaluation-runtime-integrity.js';
import {
  parseMatchedEvaluationRuntimeV1,
  type MatchedEvaluationRuntimeArmV1,
  type MatchedEvaluationRuntimeV1,
} from './run-matched-evaluation.js';

export const MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION = 1 as const;
export const MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION = '5.0.6' as const;

interface PreparationPlanV1 {
  readonly adapter: {
    readonly appServer: {
      readonly argumentsAfterSubcommand: readonly string[];
      readonly argumentsBeforeSubcommand: readonly string[];
      readonly executable: string;
      readonly version: string;
    };
    readonly authSourcePath: string;
    readonly contextBudgetTokens: number;
    readonly executable: string;
    readonly gitExecutable: string;
    readonly judgeModel: ModelPlanV1;
    readonly model: ModelPlanV1;
    readonly pricingMicrosPerMillionTokens: {
      readonly cachedInput: number;
      readonly input: number;
      readonly output: number;
    } | null;
    readonly safeBinaries: readonly string[];
    readonly safeExecutablePath: string;
    readonly taskBudget: {readonly steps: number; readonly tokens: number};
    readonly temporaryRoot: string;
  };
  readonly bootstrap: MatchedTokenEfficiencyStudyV1['bootstrap'];
  readonly clusters: readonly ClusterPlanV1[];
  readonly gates: MatchedTokenEfficiencyStudyV1['gates'];
  readonly lifecycle: readonly MatchedTokenEfficiencyLifecycleArmV1[];
  readonly project: string;
  readonly repetitions: number;
  readonly scheduleSeed: string;
  readonly studyId: string;
  readonly taskContexts: readonly TaskContextPlanV1[];
  readonly threadnote: {
    readonly executable: string;
    readonly lockFile: string;
    readonly requiredReleaseCommit: string;
    readonly sourceDirectory: string;
  };
  readonly timeoutMilliseconds: number;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION;
}

interface ModelPlanV1 {
  readonly id: string;
  readonly provider: string;
  readonly reasoningEffort: string;
}

interface ClusterPlanV1 {
  readonly clusterId: string;
  readonly repositoryDirectory: string;
  readonly repositoryUrl: string;
}

interface TaskContextPlanV1 {
  readonly asIssuedContext: {
    readonly assessmentFile: string;
    readonly contentFile: string | null;
    readonly sufficiency: MatchedTokenEfficiencyTaskContextV1['asIssuedContext']['sufficiency'];
  };
  readonly clusterId: string;
  readonly graphHomeDirectory: string;
  readonly linkedMemoryIdentities: readonly LinkedMemoryIdentityPlanV1[];
  readonly linkedHomeDirectory: string;
  readonly taskId: string;
}

interface LinkedMemoryIdentityPlanV1 {
  readonly fixtureMemoryId: string;
  readonly managedMemoryId: string;
}

interface PreparedTask {
  readonly graphHome: MatchedEvaluationPreparedContextHomeV1;
  readonly linkedHome: MatchedEvaluationPreparedContextHomeV1;
  readonly taskContext: MatchedTokenEfficiencyTaskContextV1;
}

export interface MatchedTokenEfficiencyPreparationReceiptV1 {
  readonly adapterArtifactHash: string;
  readonly adapterConfigurationHashes: Readonly<Record<MatchedEvaluationArm, string>>;
  readonly corpusHash: string;
  readonly manifestHash: string;
  readonly outputHashes: Readonly<Record<string, string>>;
  readonly receiptHash: string;
  readonly referenceArm: 'unavailable';
  readonly requiredProductVersion: typeof MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION;
  readonly studyHash: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteLockHash: string;
  readonly threadnoteSourceCommit: string;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const FIXTURE_MEMORY_ID = /^mem_[0-9a-f]{16,64}$/u;
const MANAGED_MEMORY_ID = /^tn_[A-Za-z0-9_-]{1,128}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION_OUTPUT = /^threadnote v5\.0\.6-local\.g([0-9a-f]{40})\s*$/u;
const MAXIMUM_JSON_BYTES = 8 * 1_024 * 1_024;

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => prepareMatchedTokenEfficiencyStudyV1(options),
    catch: cause => ScriptError.make({message: 'Matched token-efficiency preparation stopped.', cause}),
  });
});

export async function prepareMatchedTokenEfficiencyStudyV1(options: {
  readonly corpusPath: string;
  readonly outputRoot: string;
  readonly planPath: string;
}): Promise<MatchedTokenEfficiencyPreparationReceiptV1> {
  const [corpus, plan] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.planPath).then(parsePreparationPlanV1),
  ]);
  const outputRoot = absolutePath(options.outputRoot, 'output root');
  if (!outputRoot.split(sep).includes('.context'))
    throw new Error('Output root must be inside a local .context directory.');
  const outputParent = await canonicalDirectory(dirname(outputRoot), 'output parent');
  if (dirname(outputRoot) !== outputParent) throw new Error('Output parent must use its canonical path.');
  await assertAbsent(outputRoot, 'output root');
  const sourceCommit = await assertThreadnote506SourceAndExecutable(plan.threadnote);
  const [adapterExecutable, adapterArtifactHash, threadnoteArtifactHash, threadnoteLockHash] = await Promise.all([
    canonicalRegularFile(plan.adapter.executable, true, 'adapter executable'),
    hashCanonicalFile(plan.adapter.executable, true, 'adapter executable'),
    hashCanonicalFile(plan.threadnote.executable, true, 'Threadnote executable'),
    hashCanonicalFile(plan.threadnote.lockFile, false, 'Threadnote lock file'),
  ]);
  const runtimeFileHashes = new Map<string, string>();
  await Promise.all(
    [plan.adapter.appServer.executable, plan.adapter.gitExecutable, ...plan.adapter.safeBinaries].map(async path => {
      runtimeFileHashes.set(path, await hashCanonicalFile(path, true, `runtime executable ${path}`));
    }),
  );
  await assertPrivateAuthFile(plan.adapter.authSourcePath);
  const clusterObservations = await prepareClusters(plan, corpus);
  const provisionalManifest = createMatchedEvaluationManifestV1({
    arms: placeholderArmDefinitions(),
    corpus,
    model: manifestModel(plan.adapter.model),
    repetitions: plan.repetitions,
    repository: firstObservation(clusterObservations),
    scheduleSeed: plan.scheduleSeed,
  });
  const tasks = await prepareTasks({clusterObservations, corpus, manifest: provisionalManifest, plan});
  const finalRoot = outputRoot;
  const configs = createAdapterConfigs({
    plan,
    prepared: tasks,
    runtimeFileHashes,
  });
  const configBytes = new Map(configs.map(([arm, config]) => [arm, jsonBytes(config)]));
  const configHashes = Object.fromEntries(
    MATCHED_EVALUATION_ARMS.map(arm => [arm, sha256(required(configBytes.get(arm), `adapter config ${arm}`))]),
  ) as Readonly<Record<MatchedEvaluationArm, string>>;
  const unavailableReference = Buffer.from(
    `${JSON.stringify({reason: 'reference-scope runtime is not configured by the production Codex preparer', version: 1})}\n`,
  );
  const unavailableReferenceHash = sha256(unavailableReference);
  const arms = armDefinitions({
    adapterArtifactHash,
    configHashes,
    referenceArtifactHash: unavailableReferenceHash,
    threadnoteArtifactHash,
    threadnoteLockHash,
  });
  const manifest = createMatchedEvaluationManifestV1({
    arms,
    corpus,
    model: manifestModel(plan.adapter.model),
    repetitions: plan.repetitions,
    repository: firstObservation(clusterObservations),
    scheduleSeed: plan.scheduleSeed,
  });
  const study = createMatchedTokenEfficiencyStudyV1({
    bootstrap: plan.bootstrap,
    clusters: plan.clusters.map(cluster => {
      const observation = required(clusterObservations.get(cluster.clusterId), `cluster ${cluster.clusterId}`);
      return {
        clusterId: cluster.clusterId,
        heldOut: true as const,
        repositoryFixtureHash: observation.fixtureHash,
        repositoryIdentityHash: observation.identityHash,
        repositoryUrl: cluster.repositoryUrl,
        revision: observation.revision,
        taskIds: tasks
          .filter(task => task.taskContext.clusterId === cluster.clusterId)
          .map(task => task.taskContext.taskId),
      };
    }),
    gates: plan.gates,
    lifecycle: plan.lifecycle,
    manifestHash: manifest.manifestHash,
    promptPolicy: 'identical-as-issued',
    studyId: plan.studyId,
    targetArms: ['threadnote-compact', 'threadnote-source'],
    taskContexts: tasks.map(task => task.taskContext),
  });
  const runtime = createRuntime({
    adapterExecutable,
    clusterObservations,
    outputRoot: finalRoot,
    plan,
  });
  const files = new Map<string, Uint8Array>([
    ['corpus.json', jsonBytes(corpus)],
    ['manifest.json', jsonBytes(manifest)],
    ['study.json', jsonBytes(study)],
    ['runtime.json', jsonBytes(runtime)],
    ['reference-scope-unavailable.json', unavailableReference],
  ]);
  for (const [arm, bytes] of configBytes) files.set(`adapter-config/${arm}.json`, bytes);
  const outputHashes = Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)]));
  const receiptWithoutHash = {
    adapterArtifactHash,
    adapterConfigurationHashes: configHashes,
    corpusHash: manifest.corpusHash,
    manifestHash: manifest.manifestHash,
    outputHashes,
    referenceArm: 'unavailable' as const,
    requiredProductVersion: MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION,
    studyHash: study.studyHash,
    threadnoteArtifactHash,
    threadnoteLockHash,
    threadnoteSourceCommit: sourceCommit,
    version: MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION,
  };
  const receipt: MatchedTokenEfficiencyPreparationReceiptV1 = {
    ...receiptWithoutHash,
    receiptHash: digest('matched-token-efficiency-preparation-receipt-v1', receiptWithoutHash),
  };
  files.set('preparation-receipt.json', jsonBytes(receipt));
  const staging = await realpath(await mkdtemp(join(outputParent, '.matched-token-efficiency-staging-')));
  let promoted = false;
  try {
    await writePreparedFiles(staging, files);
    await verifyPreparedFiles(staging, files);
    await assertPreparationInputsUnchanged({
      adapterArtifactHash,
      clusterObservations,
      plan,
      prepared: tasks,
      runtimeFileHashes,
      sourceCommit,
      threadnoteArtifactHash,
      threadnoteLockHash,
    });
    await rename(staging, outputRoot);
    promoted = true;
  } finally {
    if (!promoted) await rm(staging, {force: true, recursive: true});
  }
  process.stdout.write(
    `${JSON.stringify({
      manifestHash: receipt.manifestHash,
      outputRoot,
      receiptHash: receipt.receiptHash,
      scheduledRuns: manifest.schedule.length,
      studyHash: receipt.studyHash,
      version: MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION,
    })}\n`,
  );
  return receipt;
}

async function assertPreparationInputsUnchanged(input: {
  readonly adapterArtifactHash: string;
  readonly clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>;
  readonly plan: PreparationPlanV1;
  readonly prepared: readonly PreparedTask[];
  readonly runtimeFileHashes: ReadonlyMap<string, string>;
  readonly sourceCommit: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteLockHash: string;
}): Promise<void> {
  const sourceCommit = await assertThreadnote506SourceAndExecutable(input.plan.threadnote);
  if (sourceCommit !== input.sourceCommit) throw new Error('Threadnote source changed during preparation.');
  const [adapterHash, threadnoteHash, lockHash] = await Promise.all([
    hashCanonicalFile(input.plan.adapter.executable, true, 'adapter executable'),
    hashCanonicalFile(input.plan.threadnote.executable, true, 'Threadnote executable'),
    hashCanonicalFile(input.plan.threadnote.lockFile, false, 'Threadnote lock file'),
  ]);
  if (
    adapterHash !== input.adapterArtifactHash ||
    threadnoteHash !== input.threadnoteArtifactHash ||
    lockHash !== input.threadnoteLockHash
  ) {
    throw new Error('A pinned evaluation executable or lock changed during preparation.');
  }
  await Promise.all(
    [...input.runtimeFileHashes].map(async ([path, expected]) => {
      if ((await hashCanonicalFile(path, true, `runtime executable ${path}`)) !== expected) {
        throw new Error(`Runtime executable changed during preparation: ${path}`);
      }
    }),
  );
  await assertPrivateAuthFile(input.plan.adapter.authSourcePath);
  for (const cluster of input.plan.clusters) {
    const observed = await observeMatchedEvaluationRepositoryV1(cluster.repositoryDirectory);
    const expected = required(input.clusterObservations.get(cluster.clusterId), cluster.clusterId);
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error(`Held-out repository changed during preparation: ${cluster.clusterId}`);
    }
  }
  for (const task of input.prepared) {
    const [graphHash, linkedHash] = await Promise.all([
      matchedEvaluationPreparedHomeFixtureHashV1(task.graphHome.homeDirectory),
      matchedEvaluationPreparedHomeFixtureHashV1(task.linkedHome.homeDirectory),
    ]);
    if (graphHash !== task.graphHome.homeFixtureHash || linkedHash !== task.linkedHome.homeFixtureHash) {
      throw new Error(`Prepared Threadnote home changed during preparation: ${task.taskContext.taskId}`);
    }
  }
}

async function prepareClusters(
  plan: PreparationPlanV1,
  corpus: MatchedEvaluationCorpusV1,
): Promise<ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>> {
  const result = new Map<string, MatchedEvaluationRepositoryObservationV1>();
  for (const cluster of plan.clusters) {
    const repository = await canonicalDirectory(cluster.repositoryDirectory, `cluster ${cluster.clusterId} repository`);
    await assertRepositoryRemote(repository, cluster.repositoryUrl);
    const observation = await observeMatchedEvaluationRepositoryV1(repository);
    if (observation.dirty) throw new Error(`Cluster ${cluster.clusterId} repository must be clean.`);
    if (!COMMIT.test(observation.revision))
      throw new Error(`Cluster ${cluster.clusterId} revision is not a full commit.`);
    result.set(cluster.clusterId, observation);
  }
  for (const task of corpus.tasks) {
    const context = required(
      plan.taskContexts.find(candidate => candidate.taskId === task.taskId),
      `task ${task.taskId}`,
    );
    const observation = required(result.get(context.clusterId), `cluster ${context.clusterId}`);
    if (task.repositoryFixtureHash !== observation.fixtureHash) {
      throw new Error(`Task ${task.taskId} repository fixture hash differs from its clean held-out checkout.`);
    }
  }
  return result;
}

async function prepareTasks(input: {
  readonly clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>;
  readonly corpus: MatchedEvaluationCorpusV1;
  readonly manifest: ReturnType<typeof createMatchedEvaluationManifestV1>;
  readonly plan: PreparationPlanV1;
}): Promise<readonly PreparedTask[]> {
  const prepared: PreparedTask[] = [];
  const linkedHomes = new Set<string>();
  for (const planContext of [...input.plan.taskContexts].sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  )) {
    const task = required(
      input.corpus.tasks.find(candidate => candidate.taskId === planContext.taskId),
      `task ${planContext.taskId}`,
    );
    const manifestTask = required(
      input.manifest.tasks.find(candidate => candidate.taskId === planContext.taskId),
      `manifest task ${planContext.taskId}`,
    );
    const cluster = required(
      input.plan.clusters.find(candidate => candidate.clusterId === planContext.clusterId),
      `cluster ${planContext.clusterId}`,
    );
    const observation = required(
      input.clusterObservations.get(planContext.clusterId),
      `cluster ${planContext.clusterId}`,
    );
    const graphHome = await canonicalDirectory(planContext.graphHomeDirectory, `task ${task.taskId} graph-only home`);
    const linkedHome = await canonicalDirectory(planContext.linkedHomeDirectory, `task ${task.taskId} linked home`);
    if (graphHome === linkedHome) throw new Error(`Task ${task.taskId} graph-only and linked homes must differ.`);
    if (linkedHomes.has(linkedHome)) throw new Error('Every task requires its own independently reviewed linked home.');
    linkedHomes.add(linkedHome);
    const graphMemories = await collectMemoryDocuments(graphHome, input.plan.project);
    if (graphMemories.length !== 0) throw new Error(`Task ${task.taskId} graph-only home contains memories.`);
    const linkedMemories = await collectMemoryDocuments(linkedHome, input.plan.project);
    await assertContextCheckClean(input.plan, cluster, linkedHome);
    const [graphIdentity, linkedIdentity] = await Promise.all([
      graphIdentityForHome(input.plan, cluster, graphHome, observation),
      graphIdentityForHome(input.plan, cluster, linkedHome, observation),
    ]);
    if (JSON.stringify(graphIdentity) !== JSON.stringify(linkedIdentity)) {
      throw new Error(`Task ${task.taskId} graph-only and linked homes do not share the exact ready graph.`);
    }
    await assertGraphOnlyContextHasNoMemory(input.plan, cluster, graphHome, task.prompt);
    await assertLinkedContextSurfacesMemories(
      input.plan,
      cluster,
      linkedHome,
      task.prompt,
      task.taskId,
      linkedMemories,
    );
    const linkReceipts = linkReceiptsForTask(
      task,
      linkedMemories,
      planContext.linkedMemoryIdentities,
      observation,
      linkedIdentity,
    );
    const graphContentHash = matchedTokenEfficiencyGraphContentHashV1(graphIdentity.graphContentId);
    const graphSnapshotHash = matchedTokenEfficiencyGraphSnapshotHashV1(graphIdentity.snapshotId);
    const taskContext = createMatchedTokenEfficiencyTaskContextV1({
      asIssuedContext: await prepareAsIssuedContext(planContext),
      clusterId: planContext.clusterId,
      graphContentHash,
      graphSnapshotHash,
      linkReceipts,
      memoryFixtureHash: manifestTask.memoryFixtureHash,
      repositoryFixtureHash: observation.fixtureHash,
      taskId: task.taskId,
    });
    const [graphHomeFixtureHash, linkedHomeFixtureHash] = await Promise.all([
      matchedEvaluationPreparedHomeFixtureHashV1(graphHome),
      matchedEvaluationPreparedHomeFixtureHashV1(linkedHome),
    ]);
    prepared.push({
      graphHome: {
        expectedContext: {
          graphContentHash,
          graphSnapshotHash,
          linkReceiptsHash: null,
          memoryAccess: 'disabled',
          taskContextHash: null,
        },
        homeDirectory: graphHome,
        homeFixtureHash: graphHomeFixtureHash,
        project: input.plan.project,
        taskId: task.taskId,
      },
      linkedHome: {
        expectedContext: {
          graphContentHash,
          graphSnapshotHash,
          linkReceiptsHash: taskContext.linkReceiptsHash,
          memoryAccess: 'linked',
          taskContextHash: taskContext.taskContextHash,
        },
        homeDirectory: linkedHome,
        homeFixtureHash: linkedHomeFixtureHash,
        project: input.plan.project,
        taskId: task.taskId,
      },
      taskContext,
    });
  }
  return prepared;
}

function createAdapterConfigs(input: {
  readonly plan: PreparationPlanV1;
  readonly prepared: readonly PreparedTask[];
  readonly runtimeFileHashes: ReadonlyMap<string, string>;
}): readonly [MatchedEvaluationArm, MatchedEvaluationCodexAdapterConfigV1][] {
  return MATCHED_EVALUATION_ARMS.map(arm => {
    const contextHomes =
      arm === 'threadnote-graph'
        ? input.prepared.map(task => task.graphHome)
        : arm === 'threadnote-compact' || arm === 'threadnote-source'
          ? input.prepared.map(task => task.linkedHome)
          : [];
    const config = parseMatchedEvaluationCodexAdapterConfigV1({
      appServer: {
        ...input.plan.adapter.appServer,
        executableSha256: required(
          input.runtimeFileHashes.get(input.plan.adapter.appServer.executable),
          'app-server executable hash',
        ),
      },
      arm,
      authSourcePath: input.plan.adapter.authSourcePath,
      contextBudgetTokens: input.plan.adapter.contextBudgetTokens,
      contextHomes,
      environmentPolicyHash:
        arm === 'reference-scope'
          ? matchedEvaluationReferenceEnvironmentPolicyHashV1()
          : matchedEvaluationCodexEnvironmentPolicyHashV1(),
      git: {
        executable: input.plan.adapter.gitExecutable,
        executableSha256: required(
          input.runtimeFileHashes.get(input.plan.adapter.gitExecutable),
          'Git executable hash',
        ),
      },
      judgeModel: modelConfiguration(input.plan.adapter.judgeModel),
      model: modelConfiguration(input.plan.adapter.model),
      pricingMicrosPerMillionTokens: input.plan.adapter.pricingMicrosPerMillionTokens,
      safeBinaries: input.plan.adapter.safeBinaries.map(path => ({
        path,
        sha256: required(input.runtimeFileHashes.get(path), `safe binary hash ${path}`),
      })),
      safeExecutablePath: input.plan.adapter.safeExecutablePath,
      taskBudget: input.plan.adapter.taskBudget,
      temporaryRoot: input.plan.adapter.temporaryRoot,
      version: MATCHED_EVALUATION_CODEX_ADAPTER_VERSION,
    });
    return [arm, config];
  });
}

function createRuntime(input: {
  readonly adapterExecutable: string;
  readonly clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>;
  readonly outputRoot: string;
  readonly plan: PreparationPlanV1;
}): MatchedEvaluationRuntimeV1 {
  const runtimeArms: MatchedEvaluationRuntimeArmV1[] = [
    runtimeArm('files', input),
    runtimeArm('threadnote-graph', input),
    runtimeArm('threadnote-compact', input),
    runtimeArm('threadnote-source', input),
  ];
  return parseMatchedEvaluationRuntimeV1({
    arms: runtimeArms,
    artifactDirectory: resolve(input.outputRoot, 'artifacts'),
    repositories: input.plan.clusters.map(cluster => ({
      clusterId: cluster.clusterId,
      repositoryDirectory: cluster.repositoryDirectory,
      repositoryIdentityHash: required(input.clusterObservations.get(cluster.clusterId), cluster.clusterId)
        .identityHash,
    })),
    timeoutMilliseconds: input.plan.timeoutMilliseconds,
    version: 3,
  });
}

function runtimeArm(
  arm: Exclude<MatchedEvaluationArm, 'reference-scope'>,
  input: {
    readonly adapterExecutable: string;
    readonly outputRoot: string;
    readonly plan: PreparationPlanV1;
  },
): MatchedEvaluationRuntimeArmV1 {
  const threadnote = arm === 'files' ? null : input.plan.threadnote;
  return {
    adapterArguments: [],
    adapterConfigFile: resolve(input.outputRoot, 'adapter-config', `${arm}.json`),
    adapterExecutable: input.adapterExecutable,
    arm,
    environmentKeys: [],
    toolExecutable: threadnote?.executable ?? null,
    toolLockFile: threadnote?.lockFile ?? null,
  };
}

function armDefinitions(input: {
  readonly adapterArtifactHash: string;
  readonly configHashes: Readonly<Record<MatchedEvaluationArm, string>>;
  readonly referenceArtifactHash: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteLockHash: string;
}): readonly MatchedEvaluationArmDefinitionV1[] {
  return MATCHED_EVALUATION_ARMS.map(arm => ({
    adapterArtifactHash: input.adapterArtifactHash,
    adapterConfigurationHash: input.configHashes[arm],
    adapterProtocol: MATCHED_EVALUATION_ADAPTER_PROTOCOL,
    arm,
    environmentPolicyHash:
      arm === 'reference-scope'
        ? matchedEvaluationReferenceEnvironmentPolicyHashV1()
        : matchedEvaluationCodexEnvironmentPolicyHashV1(),
    tool:
      arm === 'files'
        ? {artifactHash: null, lockIdentityHash: null, name: 'repository-files', version: 'builtin-v1'}
        : arm === 'reference-scope'
          ? {
              artifactHash: input.referenceArtifactHash,
              lockIdentityHash: input.referenceArtifactHash,
              name: 'unavailable-reference-scope',
              version: 'not-configured-v1',
            }
          : {
              artifactHash: input.threadnoteArtifactHash,
              lockIdentityHash: input.threadnoteLockHash,
              name: 'threadnote',
              version: MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION,
            },
  }));
}

function placeholderArmDefinitions(): readonly MatchedEvaluationArmDefinitionV1[] {
  return armDefinitions({
    adapterArtifactHash: '1'.repeat(64),
    configHashes: Object.fromEntries(MATCHED_EVALUATION_ARMS.map(arm => [arm, '2'.repeat(64)])) as Readonly<
      Record<MatchedEvaluationArm, string>
    >,
    referenceArtifactHash: '3'.repeat(64),
    threadnoteArtifactHash: '4'.repeat(64),
    threadnoteLockHash: '5'.repeat(64),
  });
}

async function graphIdentityForHome(
  plan: PreparationPlanV1,
  cluster: ClusterPlanV1,
  home: string,
  observation: MatchedEvaluationRepositoryObservationV1,
): Promise<{readonly graphContentId: string; readonly repositoryId: string; readonly snapshotId: string}> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'status',
      '--home',
      home,
      '--cwd',
      cluster.repositoryDirectory,
      '--project',
      plan.project,
      '--json',
    ],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath),
    label: `Matched evaluation graph status ${cluster.clusterId}`,
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const parsed = JSON.parse(result.stdout) as unknown;
  const validated = assertCodeMemoryLinkGraphStatusPreflight(parsed, {
    commit: observation.revision,
    origin: cluster.repositoryUrl,
    repositoryRoot: cluster.repositoryDirectory,
  });
  const status = object(parsed, 'graph status');
  const identity = object(status.identity, 'graph repository identity');
  return {
    ...validated,
    repositoryId: boundedText(identity.repositoryId, 1, 256, 'graph repository id'),
  };
}

async function assertContextCheckClean(plan: PreparationPlanV1, cluster: ClusterPlanV1, home: string): Promise<void> {
  const result = await captureCodeMemoryLinkProcessGroup({
    allowFailure: true,
    arguments: ['context', 'check', '--home', home, '--project', plan.project, '--json'],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath),
    label: `Matched evaluation context check ${cluster.clusterId}`,
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (result.exitCode !== 0) throw new Error(`Linked home context check failed for ${cluster.clusterId}.`);
}

async function assertGraphOnlyContextHasNoMemory(
  plan: PreparationPlanV1,
  cluster: ClusterPlanV1,
  home: string,
  task: string,
): Promise<void> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'context',
      'brief',
      '--json',
      '--task',
      task,
      '--cwd',
      cluster.repositoryDirectory,
      '--home',
      home,
      '--project',
      plan.project,
      '--mode',
      'brief',
      '--detail',
      'compact',
      '--budget-tokens',
      String(plan.adapter.contextBudgetTokens),
    ],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath),
    label: `Matched evaluation graph-only Context Brief ${cluster.clusterId}`,
    maxOutputBytes: 2 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const brief = object(JSON.parse(result.stdout) as unknown, 'graph-only Context Brief');
  if (brief.type !== 'context-brief' || (brief.version !== 2 && brief.version !== 3)) {
    throw new Error('Graph-only home did not return a supported Context Brief.');
  }
  if (!Array.isArray(brief.durableDecisions) || !Array.isArray(brief.activeHandoffs)) {
    throw new Error('Graph-only Context Brief is missing its memory evidence arrays.');
  }
  if (brief.durableDecisions.length !== 0 || brief.activeHandoffs.length !== 0) {
    throw new Error('Graph-only home exposes memory evidence for the preregistered task prompt.');
  }
}

async function assertLinkedContextSurfacesMemories(
  plan: PreparationPlanV1,
  cluster: ClusterPlanV1,
  home: string,
  task: string,
  taskId: string,
  memories: readonly MemoryRecord[],
): Promise<void> {
  const topics = memories.map(memory => memory.metadata.topic);
  if (
    topics.some(topic => topic === undefined) ||
    new Set(topics).size !== topics.length ||
    memories.some(memory => memory.headerTitle !== 'MEMORY' || memory.metadata.kind !== 'durable')
  ) {
    throw new Error(`Task ${taskId} linked home requires unique durable memory topics.`);
  }
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'context',
      'brief',
      '--json',
      '--task',
      task,
      '--cwd',
      cluster.repositoryDirectory,
      '--home',
      home,
      '--project',
      plan.project,
      '--mode',
      'brief',
      '--detail',
      'compact',
      '--budget-tokens',
      String(plan.adapter.contextBudgetTokens),
    ],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath),
    label: `Matched evaluation linked-memory Context Brief ${cluster.clusterId}`,
    maxOutputBytes: 2 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  assertMatchedTokenEfficiencyLinkedBriefV1(
    JSON.parse(result.stdout) as unknown,
    plan.project,
    taskId,
    topics as readonly string[],
  );
}

export function assertMatchedTokenEfficiencyLinkedBriefV1(
  value: unknown,
  project: string,
  taskId: string,
  expectedTopics: readonly string[],
): void {
  const brief = object(value, 'linked-memory Context Brief');
  if (brief.type !== 'context-brief' || (brief.version !== 2 && brief.version !== 3)) {
    throw new Error('Linked home did not return a supported Context Brief.');
  }
  if (!Array.isArray(brief.durableDecisions) || !Array.isArray(brief.activeHandoffs)) {
    throw new Error('Linked-memory Context Brief is missing its memory evidence arrays.');
  }
  if (brief.activeHandoffs.length !== 0) {
    throw new Error(`Task ${taskId} linked-memory Context Brief exposes an unexpected handoff.`);
  }
  const surfacedTopics = brief.durableDecisions.map((entry, index) => {
    const decision = object(entry, `linked-memory Context Brief decision ${index}`);
    if (decision.kind !== 'durable' || decision.project !== project) {
      throw new Error(`Task ${taskId} linked-memory Context Brief exposes an unexpected memory.`);
    }
    return boundedText(decision.topic, 1, 512, `linked-memory Context Brief decision ${index} topic`);
  });
  const expected = [...expectedTopics].sort((left, right) => left.localeCompare(right));
  const surfaced = [...surfacedTopics].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(surfaced) !== JSON.stringify(expected)) {
    throw new Error(`Task ${taskId} exact prompt does not surface its complete reviewed memory roster.`);
  }
}

function linkReceiptsForTask(
  task: MatchedEvaluationCorpusV1['tasks'][number],
  memories: readonly MemoryRecord[],
  linkedMemoryIdentities: readonly LinkedMemoryIdentityPlanV1[],
  observation: MatchedEvaluationRepositoryObservationV1,
  graphIdentity: {readonly graphContentId: string; readonly repositoryId: string; readonly snapshotId: string},
): MatchedTokenEfficiencyTaskContextV1['linkReceipts'] {
  if (memories.length !== task.memoryFixtures.length) {
    throw new Error(`Task ${task.taskId} linked home does not contain exactly its preregistered memories.`);
  }
  if (
    linkedMemoryIdentities.length !== task.memoryFixtures.length ||
    task.memoryFixtures.some(
      fixture => !linkedMemoryIdentities.some(identity => identity.fixtureMemoryId === fixture.memoryId),
    )
  ) {
    throw new Error(`Task ${task.taskId} linked-memory identity roster differs from its corpus fixtures.`);
  }
  const used = new Set<MemoryRecord>();
  const receipts = task.memoryFixtures.flatMap(fixture => {
    const plannedIdentity = required(
      linkedMemoryIdentities.find(identity => identity.fixtureMemoryId === fixture.memoryId),
      `managed memory identity for ${fixture.memoryId}`,
    );
    const candidates = memories.filter(
      memory =>
        memory.body === fixture.text &&
        memory.metadata.status === fixture.status &&
        memory.metadata.memoryId === plannedIdentity.managedMemoryId,
    );
    if (candidates.length !== 1 || used.has(candidates[0])) {
      throw new Error(`Task ${task.taskId} memory ${fixture.memoryId} is missing or ambiguous in its linked home.`);
    }
    const memory = candidates[0];
    used.add(memory);
    if (fixture.source === null) return [];
    const citations = (memory.metadata.codeCitations ?? []).filter(citation => citation.path === fixture.source?.path);
    if (citations.length !== 1) {
      throw new Error(`Task ${task.taskId} memory ${fixture.memoryId} lacks one exact source citation.`);
    }
    const citation = citations[0];
    if (
      citation.sourceCommit !== observation.revision ||
      citation.sourceDirty !== false ||
      citation.repositoryId !== graphIdentity.repositoryId ||
      citation.repositoryIdentityKind !== 'remote' ||
      citation.sourceSnapshotId !== graphIdentity.snapshotId ||
      citation.sourceGraphContentId !== graphIdentity.graphContentId ||
      citation.target.kind !== 'file'
    ) {
      throw new Error(`Task ${task.taskId} memory ${fixture.memoryId} citation is not from the held-out revision.`);
    }
    return [
      {
        citationHash: matchedTokenEfficiencyCitationHashV1({
          citationId: citation.id,
          fixtureMemoryId: fixture.memoryId,
          managedMemoryId: plannedIdentity.managedMemoryId,
        }),
        memoryId: fixture.memoryId,
        status: 'exact' as const,
      },
    ];
  });
  return receipts.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

async function collectMemoryDocuments(home: string, project: string): Promise<readonly MemoryRecord[]> {
  const files = await walkFiles(home);
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const normalized = relative(home, file).replaceAll('\\', '/');
    if (!normalized.endsWith('.md') || !normalized.split('/').includes('memories')) continue;
    const parsed = parseMemoryDocument(
      `threadnote://user/evaluation/memories/durable/projects/${project}/prepared-${records.length}.md`,
      await readFile(file, 'utf8'),
    );
    if (parsed === undefined || parsed.metadata.project !== project) {
      throw new Error('Prepared Threadnote home contains a memory outside the preregistered project.');
    }
    records.push(parsed);
  }
  return records;
}

async function prepareAsIssuedContext(
  task: TaskContextPlanV1,
): Promise<MatchedTokenEfficiencyTaskContextV1['asIssuedContext']> {
  const assessment = await readCanonicalFile(task.asIssuedContext.assessmentFile, false, 'context assessment');
  if (task.asIssuedContext.sufficiency === 'none') {
    if (task.asIssuedContext.contentFile !== null)
      throw new Error('A none context classification must not supply content.');
    return {assessmentHash: sha256(assessment), contentHash: null, sufficiency: 'none', suppliedBytes: 0};
  }
  if (task.asIssuedContext.contentFile === null) throw new Error('Supplied manual context requires a content file.');
  const content = await readCanonicalFile(task.asIssuedContext.contentFile, false, 'as-issued context');
  if (content.byteLength === 0) throw new Error('Supplied manual context must not be empty.');
  return {
    assessmentHash: sha256(assessment),
    contentHash: sha256(content),
    sufficiency: task.asIssuedContext.sufficiency,
    suppliedBytes: content.byteLength,
  };
}

async function assertThreadnote506SourceAndExecutable(input: PreparationPlanV1['threadnote']): Promise<string> {
  const [sourceDirectory, executable] = await Promise.all([
    canonicalDirectory(input.sourceDirectory, 'Threadnote source directory'),
    canonicalRegularFile(input.executable, true, 'Threadnote executable'),
  ]);
  const status = await captureGit(sourceDirectory, ['status', '--porcelain=v1']);
  if (status.stdout !== '') throw new Error('Threadnote 5.0.6 source checkout must be clean.');
  const head = singleLine(
    (await captureGit(sourceDirectory, ['rev-parse', 'HEAD'])).stdout,
    'Threadnote source commit',
  );
  if (!COMMIT.test(head)) throw new Error('Threadnote source commit is invalid.');
  const requiredReleaseCommit = matching(input.requiredReleaseCommit, COMMIT, 'required 5.0.6 release commit');
  const ancestry = await captureGit(
    sourceDirectory,
    ['merge-base', '--is-ancestor', requiredReleaseCommit, head],
    true,
  );
  if (ancestry.exitCode !== 0)
    throw new Error('Threadnote source commit does not contain the required 5.0.6 release commit.');
  const packageVersion = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (packageVersion.version !== MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION) {
    throw new Error('Threadnote source checkout is not version 5.0.6.');
  }
  const version = await captureCodeMemoryLinkProcessGroup({
    arguments: ['--version'],
    command: executable,
    cwd: sourceDirectory,
    environment: {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin'},
    label: 'Threadnote 5.0.6 version',
    maxOutputBytes: 16 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  assertMatchedTokenEfficiencyThreadnoteVersionOutputV1(version.stdout, head);
  return head;
}

export function assertMatchedTokenEfficiencyThreadnoteVersionOutputV1(output: string, sourceCommit: string): void {
  const expectedCommit = matching(sourceCommit, COMMIT, 'Threadnote source commit');
  const match = VERSION_OUTPUT.exec(output);
  if (match === null) {
    throw new Error('Threadnote executable must be an exact commit-reporting 5.0.6 local build.');
  }
  if (match[1] !== expectedCommit) {
    throw new Error('Threadnote local executable source commit differs from the reviewed source checkout.');
  }
}

function parsePreparationPlanV1(value: unknown): PreparationPlanV1 {
  const plan = object(value, 'preparation plan');
  exactKeys(plan, [
    'adapter',
    'bootstrap',
    'clusters',
    'gates',
    'lifecycle',
    'project',
    'repetitions',
    'scheduleSeed',
    'studyId',
    'taskContexts',
    'threadnote',
    'timeoutMilliseconds',
    'version',
  ]);
  if (plan.version !== MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION) invalid('preparation plan version must be 1');
  const adapter = object(plan.adapter, 'adapter plan');
  exactKeys(adapter, [
    'appServer',
    'authSourcePath',
    'contextBudgetTokens',
    'executable',
    'gitExecutable',
    'judgeModel',
    'model',
    'pricingMicrosPerMillionTokens',
    'safeBinaries',
    'safeExecutablePath',
    'taskBudget',
    'temporaryRoot',
  ]);
  const appServer = object(adapter.appServer, 'app server plan');
  exactKeys(appServer, ['argumentsAfterSubcommand', 'argumentsBeforeSubcommand', 'executable', 'version']);
  const threadnote = object(plan.threadnote, 'Threadnote plan');
  exactKeys(threadnote, ['executable', 'lockFile', 'requiredReleaseCommit', 'sourceDirectory']);
  const clusters = array(plan.clusters, 'clusters').map(parseClusterPlan);
  unique(
    clusters.map(cluster => cluster.clusterId),
    'cluster ids',
  );
  unique(
    clusters.map(cluster => cluster.repositoryDirectory),
    'cluster repositories',
  );
  const taskContexts = array(plan.taskContexts, 'task contexts').map(parseTaskContextPlan);
  unique(
    taskContexts.map(context => context.taskId),
    'task context ids',
  );
  const pricing = adapter.pricingMicrosPerMillionTokens;
  const taskBudget = object(adapter.taskBudget, 'task budget');
  exactKeys(taskBudget, ['steps', 'tokens']);
  return {
    adapter: {
      appServer: {
        argumentsAfterSubcommand: stringArray(appServer.argumentsAfterSubcommand, 'app-server trailing arguments'),
        argumentsBeforeSubcommand: stringArray(appServer.argumentsBeforeSubcommand, 'app-server leading arguments'),
        executable: absolutePath(appServer.executable, 'app-server executable'),
        version: boundedText(appServer.version, 1, 256, 'app-server version'),
      },
      authSourcePath: absolutePath(adapter.authSourcePath, 'auth source'),
      contextBudgetTokens: integer(adapter.contextBudgetTokens, 800, 1_500, 'context budget'),
      executable: absolutePath(adapter.executable, 'adapter executable'),
      gitExecutable: absolutePath(adapter.gitExecutable, 'Git executable'),
      judgeModel: parseModelPlan(adapter.judgeModel, 'judge model'),
      model: parseModelPlan(adapter.model, 'agent model'),
      pricingMicrosPerMillionTokens:
        pricing === null
          ? null
          : (() => {
              const parsed = object(pricing, 'pricing');
              exactKeys(parsed, ['cachedInput', 'input', 'output']);
              return {
                cachedInput: integer(parsed.cachedInput, 0, Number.MAX_SAFE_INTEGER, 'cached-input price'),
                input: integer(parsed.input, 0, Number.MAX_SAFE_INTEGER, 'input price'),
                output: integer(parsed.output, 0, Number.MAX_SAFE_INTEGER, 'output price'),
              };
            })(),
      safeBinaries: stringArray(adapter.safeBinaries, 'safe binaries').map((path, index) =>
        absolutePath(path, `safe binary ${index}`),
      ),
      safeExecutablePath: boundedText(adapter.safeExecutablePath, 1, 16_384, 'safe executable PATH'),
      taskBudget: {
        steps: integer(taskBudget.steps, 1, 1_000, 'task step budget'),
        tokens: integer(taskBudget.tokens, 1, 10_000_000, 'task token budget'),
      },
      temporaryRoot: absolutePath(adapter.temporaryRoot, 'temporary root'),
    },
    bootstrap: plan.bootstrap as PreparationPlanV1['bootstrap'],
    clusters,
    gates: plan.gates as PreparationPlanV1['gates'],
    lifecycle: array(plan.lifecycle, 'lifecycle') as unknown as readonly MatchedTokenEfficiencyLifecycleArmV1[],
    project: matching(plan.project, PROJECT, 'project'),
    repetitions: (() => {
      const repetitions = integer(plan.repetitions, 5, 1_000, 'repetitions');
      if (repetitions % 5 !== 0) invalid('repetitions must be a multiple of 5');
      return repetitions;
    })(),
    scheduleSeed: matching(plan.scheduleSeed, HASH, 'schedule seed'),
    studyId: boundedText(plan.studyId, 3, 64, 'study id'),
    taskContexts,
    threadnote: {
      executable: absolutePath(threadnote.executable, 'Threadnote executable'),
      lockFile: absolutePath(threadnote.lockFile, 'Threadnote lock file'),
      requiredReleaseCommit: matching(threadnote.requiredReleaseCommit, COMMIT, 'required release commit'),
      sourceDirectory: absolutePath(threadnote.sourceDirectory, 'Threadnote source directory'),
    },
    timeoutMilliseconds: integer(plan.timeoutMilliseconds, 60_000, 7_200_000, 'runtime timeout'),
    version: MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION,
  };
}

function parseClusterPlan(value: unknown, index: number): ClusterPlanV1 {
  const cluster = object(value, `cluster ${index}`);
  exactKeys(cluster, ['clusterId', 'repositoryDirectory', 'repositoryUrl']);
  const repositoryUrl = boundedText(cluster.repositoryUrl, 8, 2_048, `cluster ${index} repository URL`);
  const url = new URL(repositoryUrl);
  if (url.protocol !== 'https:' || url.username || url.password) invalid(`cluster ${index} must use public HTTPS`);
  return {
    clusterId: matching(cluster.clusterId, CLUSTER_ID, `cluster ${index} id`),
    repositoryDirectory: absolutePath(cluster.repositoryDirectory, `cluster ${index} repository`),
    repositoryUrl,
  };
}

function parseTaskContextPlan(value: unknown, index: number): TaskContextPlanV1 {
  const task = object(value, `task context ${index}`);
  exactKeys(task, [
    'asIssuedContext',
    'clusterId',
    'graphHomeDirectory',
    'linkedHomeDirectory',
    'linkedMemoryIdentities',
    'taskId',
  ]);
  const context = object(task.asIssuedContext, `task context ${index} as-issued context`);
  exactKeys(context, ['assessmentFile', 'contentFile', 'sufficiency']);
  if (!['none', 'lacking', 'sufficient', 'excessive'].includes(String(context.sufficiency))) {
    invalid(`task context ${index} sufficiency is invalid`);
  }
  const linkedMemoryIdentities = array(
    task.linkedMemoryIdentities,
    `task context ${index} linked-memory identities`,
  ).map((value, memoryIndex) => {
    const identity = object(value, `task context ${index} linked-memory identity ${memoryIndex}`);
    exactKeys(identity, ['fixtureMemoryId', 'managedMemoryId']);
    return {
      fixtureMemoryId: matching(
        identity.fixtureMemoryId,
        FIXTURE_MEMORY_ID,
        `task context ${index} fixture memory id ${memoryIndex}`,
      ),
      managedMemoryId: matching(
        identity.managedMemoryId,
        MANAGED_MEMORY_ID,
        `task context ${index} managed memory id ${memoryIndex}`,
      ),
    };
  });
  unique(
    linkedMemoryIdentities.map(identity => identity.fixtureMemoryId),
    `task context ${index} fixture memory ids`,
  );
  unique(
    linkedMemoryIdentities.map(identity => identity.managedMemoryId),
    `task context ${index} managed memory ids`,
  );
  return {
    asIssuedContext: {
      assessmentFile: absolutePath(context.assessmentFile, `task context ${index} assessment`),
      contentFile:
        context.contentFile === null
          ? null
          : absolutePath(context.contentFile, `task context ${index} supplied context`),
      sufficiency: context.sufficiency as TaskContextPlanV1['asIssuedContext']['sufficiency'],
    },
    clusterId: matching(task.clusterId, CLUSTER_ID, `task context ${index} cluster`),
    graphHomeDirectory: absolutePath(task.graphHomeDirectory, `task context ${index} graph home`),
    linkedHomeDirectory: absolutePath(task.linkedHomeDirectory, `task context ${index} linked home`),
    linkedMemoryIdentities,
    taskId: matching(task.taskId, TASK_ID, `task context ${index} id`),
  };
}

function parseModelPlan(value: unknown, label: string): ModelPlanV1 {
  const model = object(value, label);
  exactKeys(model, ['id', 'provider', 'reasoningEffort']);
  return {
    id: boundedText(model.id, 1, 128, `${label} id`),
    provider: boundedText(model.provider, 1, 128, `${label} provider`),
    reasoningEffort: boundedText(model.reasoningEffort, 1, 32, `${label} reasoning effort`),
  };
}

function manifestModel(model: ModelPlanV1) {
  const configured = modelConfiguration(model);
  return {model: configured.id, parametersHash: configured.parametersHash, provider: configured.provider};
}

function modelConfiguration(model: ModelPlanV1) {
  return {
    ...model,
    parametersHash: digest('matched-evaluation-codex-model-parameters-v1', {
      allowProviderModelFallback: false,
      approvalPolicy: 'untrusted',
      id: model.id,
      provider: model.provider,
      reasoningEffort: model.reasoningEffort,
      sandbox: 'workspace-write-no-network',
    }),
  };
}

async function assertRepositoryRemote(repository: string, expected: string): Promise<void> {
  const actual = singleLine(
    (await captureGit(repository, ['remote', 'get-url', 'origin'])).stdout,
    'repository origin',
  );
  if (normalizeRemote(actual) !== normalizeRemote(expected))
    throw new Error('Held-out repository origin differs from the plan.');
}

function normalizeRemote(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
  if (!url.hostname || !path) throw new Error('Repository origin is invalid.');
  return `${url.hostname.toLowerCase()}/${path}`;
}

async function captureGit(root: string, arguments_: readonly string[], allowFailure = false) {
  return await captureCodeMemoryLinkProcessGroup({
    allowFailure,
    arguments: ['-C', root, ...arguments_],
    command: 'git',
    cwd: root,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: '/usr/bin:/bin',
    },
    label: 'Matched evaluation preparation Git',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
}

function threadnoteEnvironment(home: string, safeExecutablePath: string): Readonly<Record<string, string>> {
  return {
    CI: '1',
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: safeExecutablePath,
    THREADNOTE_HOME: home,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
  };
}

async function writePreparedFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await chmod(root, 0o700);
  for (const [path, bytes] of files) {
    const destination = containedPath(root, path);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, bytes, {flag: 'wx', mode: 0o600});
  }
}

async function verifyPreparedFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [path, bytes] of files) {
    const actual = await readCanonicalFile(containedPath(root, path), false, `prepared ${path}`);
    if (sha256(actual) !== sha256(bytes)) throw new Error(`Prepared output changed while written: ${path}`);
  }
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error('Prepared Threadnote home contains a symbolic link.');
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile() && metadata.nlink === 1) files.push(path);
      else throw new Error('Prepared Threadnote home contains an unsupported filesystem entry.');
    }
  };
  await visit(root);
  return files;
}

async function assertPrivateAuthFile(path: string): Promise<void> {
  const canonical = await canonicalRegularFile(path, false, 'auth source');
  const metadata = await lstat(canonical);
  if (metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    throw new Error('Auth source must be one owner-only file.');
  }
}

async function hashCanonicalFile(path: string, executable: boolean, label: string): Promise<string> {
  return sha256(await readCanonicalFile(path, executable, label));
}

async function canonicalRegularFile(path: string, executable: boolean, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (canonical !== path || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be one canonical regular file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${label} must be executable.`);
  return canonical;
}

async function readCanonicalFile(path: string, executable: boolean, label: string): Promise<Buffer> {
  const canonical = await canonicalRegularFile(path, executable, label);
  const before = await stat(canonical);
  const bytes = await readFile(canonical);
  const after = await stat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`${label} changed while read.`);
  }
  return bytes;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (canonical !== path || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be one canonical directory.`);
  }
  return canonical;
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return;
    throw cause;
  }
  throw new Error(`${label} already exists.`);
}

function containedPath(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error('Prepared output path is invalid.');
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Prepared output path escaped its root.');
  }
  return absolute;
}

function firstObservation(
  observations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>,
): MatchedEvaluationRepositoryObservationV1 {
  return required(observations.values().next().value, 'first cluster observation');
}

function parseArguments(args: readonly string[]): {
  readonly corpusPath: string;
  readonly outputRoot: string;
  readonly planPath: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--corpus', '--output', '--plan'].includes(option) || values.has(option)) {
      throw ScriptError.make({message: `Unknown or repeated preparation option: ${option}`});
    }
    values.set(option, required(args[++index], option));
  }
  return {
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    outputRoot: absolutePath(required(values.get('--output'), '--output'), '--output'),
    planPath: absolutePath(required(values.get('--plan'), '--plan'), '--plan'),
  };
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAXIMUM_JSON_BYTES) {
    throw new Error(`${path} is not one bounded regular JSON file.`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`);
}

function digest(namespace: string, value: unknown): string {
  return sha256(Buffer.from(`${namespace}\n${JSON.stringify(value)}`));
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
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    invalid('preparation plan contains unsupported or missing fields');
}

function stringArray(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) => boundedText(entry, 0, 4_096, `${label} ${index}`));
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const parsed = boundedText(value, 1, 4_096, label);
  if (!pattern.test(parsed)) invalid(`${label} is invalid`);
  return parsed;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (!isAbsolute(path) || path.includes('\0')) invalid(`${label} must be absolute`);
  return path;
}

function singleLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new Error(`${label} must be one line.`);
  return trimmed;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}.`);
  return value;
}

function invalid(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
}
