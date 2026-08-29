#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '../src/crypto/sha256.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1,
  evaluateCodeMemoryLinkAgentAb,
  parseCodeMemoryLinkAgentAbManifestV1,
  parseCodeMemoryLinkAgentAbTrialsJsonl,
} from '../src/evaluation/code-memory-link-agent-ab.js';
import {parseCodeMemoryLinkAgentAttemptsJsonl} from '../src/evaluation/code-memory-link-agent-attempts.js';
import {parseCodeMemoryLinkAgentEvidenceJsonl} from '../src/evaluation/code-memory-link-agent-evidence.js';
import {parseCodeMemoryLinkSealedSuiteV1} from '../src/evaluation/code-memory-link-agent-protocol.js';
import {
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientProjectionHash,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
} from '../src/evaluation/code-memory-link-client-descriptor.js';
import {evaluateCodeMemoryLinkDogfood} from '../src/evaluation/code-memory-link-dogfood.js';
import {
  codeMemoryLinkRetentionBlockers,
  createCodeMemoryLinkRetainedResultV1,
} from '../src/evaluation/code-memory-link-retained-result.js';
import {
  CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT,
  createCodeMemoryLinkRetainedBundleV1,
  type CodeMemoryLinkRetainedArtifactRole,
} from '../src/evaluation/code-memory-link-retained-bundle.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceRoot = yield* path.fromFileUrl(new URL('../', import.meta.url));
  const outputRoot = path.join(sourceRoot, CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT);
  const preparedRoot = path.resolve(options.preparedRoot);
  const [assignment, attempts, dogfood, evidence, manifestSource, sealedLayout, sealedSuite, trials] =
    yield* Effect.all(
      [
        fs.readFileString(path.join(preparedRoot, 'assignment.json')),
        fs.readFileString(path.resolve(options.attemptsPath)),
        fs.readFileString(path.resolve(options.dogfoodPath)),
        fs.readFileString(path.resolve(options.evidencePath)),
        fs.readFileString(path.join(preparedRoot, 'manifest.json')),
        fs.readFileString(path.join(preparedRoot, 'adapter.json')),
        fs.readFileString(path.join(preparedRoot, 'suite.json')),
        fs.readFileString(path.resolve(options.trialsPath)),
      ],
      {concurrency: 8},
    );
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(json(manifestSource, 'manifest'));
  if (manifest.candidate.commit !== options.candidateCommit) {
    return yield* Effect.fail(new ScriptError('Retained manifest candidate differs from --candidate-commit.'));
  }
  const parsedAssignment = json(assignment, 'assignment');
  const parsedAttempts = parseCodeMemoryLinkAgentAttemptsJsonl(attempts);
  const parsedEvidence = parseCodeMemoryLinkAgentEvidenceJsonl(evidence);
  const parsedTrials = parseCodeMemoryLinkAgentAbTrialsJsonl(trials);
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({
    assignment: parsedAssignment,
    manifest,
    trials: parsedTrials,
  });
  const agentAb = evaluateCodeMemoryLinkAgentAb({
    assignment: parsedAssignment,
    attempts: parsedAttempts,
    evidence: parsedEvidence,
    manifest,
    trials: parsedTrials,
  });
  const dogfoodResult = evaluateCodeMemoryLinkDogfood(json(dogfood, 'dogfood'));
  const retentionBlockers = codeMemoryLinkRetentionBlockers({agentAb, dogfood: dogfoodResult});
  if (retentionBlockers.length > 0) {
    return yield* Effect.fail(new ScriptError(`Evidence is not ready for retention:\n${retentionBlockers.join('\n')}`));
  }
  if (
    agentAb.candidate.commit !== options.candidateCommit ||
    dogfoodResult.candidate.commit !== options.candidateCommit ||
    JSON.stringify(agentAb.candidate) !== JSON.stringify(dogfoodResult.candidate)
  ) {
    return yield* Effect.fail(new ScriptError('Retained agent and dogfood artifacts do not identify one candidate.'));
  }
  const suite = parseCodeMemoryLinkSealedSuiteV1(json(sealedSuite, 'sealed suite'));
  if (manifest.suiteHash !== suite.suiteHash || manifest.adjudicationArtifactHash !== suite.judge.judgeHash) {
    return yield* Effect.fail(new ScriptError('Retained sealed suite differs from the manifest bindings.'));
  }
  const layoutHash = sha256HexSync(sealedLayout);
  if (!suite.judge.artifacts.some(artifact => artifact.sha256 === layoutHash)) {
    return yield* Effect.fail(new ScriptError('Retained sealed layout is not one of the suite judge artifacts.'));
  }
  const clients = yield* Effect.forEach(
    manifest.clients,
    client =>
      Effect.gen(function* () {
        const descriptor = yield* fs.readFileString(
          path.join(preparedRoot, `clients/${client.clientId}.descriptor.json`),
        );
        const configProjection = yield* fs.readFileString(
          path.join(preparedRoot, `clients/${client.clientId}.config-projection.json`),
        );
        const descriptorInput = json(descriptor, `${client.clientId} descriptor`);
        const parsedDescriptor = parseCodeMemoryLinkClientImplementationDescriptorV1(descriptorInput);
        const configurationProjectionHash = sha256HexSync(configProjection);
        const clientEvidence = parsedEvidence.filter(
          receipt => receipt.rawEvidence.bindings.clientId === client.clientId,
        );
        const expectedProjectionHashes = new Set(
          clientEvidence.map(receipt => {
            const protocol = receipt.rawEvidence.clientProtocol;
            if (JSON.stringify(protocol.expectedClient) !== JSON.stringify(client.expectedClient)) {
              throw new ScriptError(
                `Retained app-server identity for ${client.clientId} differs from the manifest expected client.`,
              );
            }
            const expectedProjectionHash = codeMemoryLinkClientProjectionHash('expected-client', {
              ...protocol.expectedClient,
              proxyTool: protocol.proxyTool,
            });
            if (
              protocol.configurationProjectionHash !== client.configurationProjectionHash ||
              protocol.environmentPolicyHash !== client.environmentPolicyHash ||
              protocol.executionBundleHash !== client.executionBundleHash ||
              protocol.expectedClientProjectionHash !== expectedProjectionHash
            ) {
              throw new ScriptError(
                `Retained client protocol for ${client.clientId} differs from the manifest/descriptor identity projection.`,
              );
            }
            return expectedProjectionHash;
          }),
        );
        if (
          clientEvidence.length === 0 ||
          codeMemoryLinkClientImplementationDescriptorHash(descriptorInput) !== client.implementationDescriptorHash ||
          configurationProjectionHash !== client.configurationProjectionHash ||
          parsedDescriptor.configurationProjectionHash !== configurationProjectionHash ||
          parsedDescriptor.environmentPolicyHash !== client.environmentPolicyHash ||
          parsedDescriptor.executionBundleHash !== client.executionBundleHash ||
          expectedProjectionHashes.size !== 1 ||
          !expectedProjectionHashes.has(parsedDescriptor.expectedClientProjectionHash)
        ) {
          return yield* Effect.fail(
            new ScriptError(
              `Retained descriptor/config projection for ${client.clientId} differs from the manifest or app-server identity binding.`,
            ),
          );
        }
        return {clientId: client.clientId, configProjection, descriptor};
      }),
    {concurrency: 4},
  );
  assertRetainedResponseBindings(manifest, parsedEvidence);
  const sealedFiles = yield* collectPreparedSealedFiles(preparedRoot);
  const result = `${JSON.stringify(createCodeMemoryLinkRetainedResultV1({agentAb, dogfood: dogfoodResult}), undefined, 2)}\n`;
  const artifacts = {
    assignment,
    attempts,
    dogfood,
    evidence,
    manifest: manifestSource,
    result,
    sealedLayout,
    sealedSuite,
    trials,
  } satisfies Readonly<Record<CodeMemoryLinkRetainedArtifactRole, string>>;
  const bundle = yield* Effect.try({
    try: () =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts,
        candidateCommit: options.candidateCommit,
        clients,
        sealedFiles,
      }),
    catch: cause => new ScriptError('Could not construct the privacy-safe retained evidence bundle.', {cause}),
  });
  const destination = path.join(outputRoot, bundle.bundleHash);
  if (yield* fs.exists(destination)) {
    return yield* Effect.fail(new ScriptError(`Retained evidence destination already exists: ${destination}`));
  }
  yield* fs.makeDirectory(outputRoot, {recursive: true});
  const staging = path.join(outputRoot, `.staging-${bundle.bundleHash}`);
  if (yield* fs.exists(staging)) {
    return yield* Effect.fail(new ScriptError(`Retained evidence staging directory already exists: ${staging}`));
  }
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(staging, 'blobs'), {recursive: true, mode: 0o700});
    yield* Effect.forEach(
      bundle.blobs,
      ([hash, content]) => fs.writeFileString(path.join(staging, 'blobs', hash), content, {flag: 'wx', mode: 0o600}),
      {concurrency: 8},
    );
    yield* fs.writeFileString(path.join(staging, 'bundle.json'), bundle.indexContent, {flag: 'wx', mode: 0o600});
    yield* fs.rename(staging, destination);
  }).pipe(Effect.ensuring(fs.remove(staging, {force: true, recursive: true}).pipe(Effect.catch(() => Effect.void))));
  yield* Console.log(
    JSON.stringify({
      bundleHash: bundle.bundleHash,
      path: `${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/${bundle.bundleHash}/bundle.json`,
    }),
  );
});

function assertRetainedResponseBindings(
  manifest: ReturnType<typeof parseCodeMemoryLinkAgentAbManifestV1>,
  evidence: ReturnType<typeof parseCodeMemoryLinkAgentEvidenceJsonl>,
): void {
  for (const receipt of evidence) {
    const raw = receipt.rawEvidence;
    const task = manifest.tasks.find(candidate => candidate.taskId === raw.bindings.taskId)!;
    const observedResponseHashes = raw.appServer.checkpoints.flatMap(checkpoint => {
      if (
        checkpoint.method !== 'item/completed' ||
        checkpoint.itemType !== 'mcpToolCall' ||
        checkpoint.succeeded !== true ||
        checkpoint.proxyReceipt === null
      ) {
        return [];
      }
      return [checkpoint.proxyReceipt.responseHash];
    });
    const expectedResponseHash =
      raw.bindings.arm === 'anchored'
        ? task.expectedResponseHashes.anchored
        : raw.bindings.arm === 'no-memory'
          ? task.expectedResponseHashes.noMemory
          : task.expectedResponseHashes.taskOnly;
    if (observedResponseHashes.length !== 1 || observedResponseHashes[0] !== expectedResponseHash) {
      throw new ScriptError(
        `Retained Context Brief response for ${raw.bindings.taskId}/${raw.bindings.arm} differs from the manifest preregistration.`,
      );
    }
  }
}

const collectPreparedSealedFiles = Effect.fn('codeMemoryLinkRetain.collectSealedFiles')(function* (
  preparedRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending = ['artifacts', 'tasks'];
  const files: {content: string; path: string}[] = [];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directory = path.join(preparedRoot, relativeDirectory);
    const entries = (yield* fs.readDirectory(directory)).sort();
    for (const name of entries) {
      const relativePath = `${relativeDirectory}/${name}`;
      const absolutePath = path.join(preparedRoot, relativePath);
      if (Option.isSome(yield* fs.readLink(absolutePath).pipe(Effect.option))) {
        return yield* Effect.fail(new ScriptError(`Prepared sealed file must not be a symlink: ${relativePath}`));
      }
      const info = yield* fs.stat(absolutePath);
      if (info.type === 'Directory') pending.push(relativePath);
      else if (info.type === 'File') files.push({content: yield* fs.readFileString(absolutePath), path: relativePath});
      else return yield* Effect.fail(new ScriptError(`Prepared sealed path has unsupported type: ${relativePath}`));
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
});

function parseArguments(args: readonly string[]): {
  readonly attemptsPath: string;
  readonly candidateCommit: string;
  readonly dogfoodPath: string;
  readonly evidencePath: string;
  readonly preparedRoot: string;
  readonly trialsPath: string;
} {
  const values = new Map<string, string>();
  const supported = new Set([
    '--attempts',
    '--candidate-commit',
    '--dogfood',
    '--evidence',
    '--prepared-root',
    '--trials',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!supported.has(option)) throw new ScriptError(`Unknown Code Memory Link retain option: ${option}`);
    if (values.has(option)) throw new ScriptError(`${option} must be provided exactly once`);
    values.set(option, required(args[++index], option));
  }
  const candidateCommit = required(values.get('--candidate-commit'), '--candidate-commit');
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw new ScriptError('--candidate-commit requires an exact 40-character lowercase Git SHA.');
  }
  return {
    attemptsPath: required(values.get('--attempts'), '--attempts'),
    candidateCommit,
    dogfoodPath: required(values.get('--dogfood'), '--dogfood'),
    evidencePath: required(values.get('--evidence'), '--evidence'),
    preparedRoot: required(values.get('--prepared-root'), '--prepared-root'),
    trialsPath: required(values.get('--trials'), '--trials'),
  };
}

function json(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    throw new ScriptError(`Retained ${label} must be valid JSON.`, {cause});
  }
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value`);
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
