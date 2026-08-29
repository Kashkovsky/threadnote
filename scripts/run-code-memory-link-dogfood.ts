#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, FileSystem, Path} from 'effect';
import {runCommandEffect} from '../src/effect/command.js';
import {measureAgentToolResponse} from '../src/evaluation/agent-response.js';
import {
  codeMemoryLinkDogfoodArtifactHash,
  createCodeMemoryLinkDogfoodObservationV1,
  evaluateCodeMemoryLinkDogfood,
  type CodeMemoryLinkDogfoodCaseId,
  type CodeMemoryLinkDogfoodGraphStatusV1,
  type CodeMemoryLinkDogfoodObservationSummaryV1,
} from '../src/evaluation/code-memory-link-dogfood.js';
import {parseContextBriefV1, renderContextBriefText} from '../src/context_brief/projector.js';
import {
  resolveManagedDevelopmentExecutableForSource,
  verifyManagedDevelopmentRuntimeForSource,
} from './development-runtime.js';
import {ApplicationLayer} from '../src/effect/runtime.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, scriptArguments} from './effect/script.js';
import {candidateEnvironment} from './code-memory-link-codex-preflight.js';
import {verifyApprovalCheckout} from './verify-code-memory-link-release.js';

const BUDGET_TOKENS = 1_250;
const CITED_FILE = 'src/recall/code_links.ts';
const UNRELATED_FILE = 'src/version.ts';
const REVIEWED_POSIX_EXECUTABLE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseArguments(yield* scriptArguments());
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const executingSourceRoot = yield* path.fromFileUrl(new URL('../', import.meta.url));
    const sourceRoot = yield* verifyDogfoodRunnerCheckout({
      approvalCommit: options.approvalCommit,
      candidateCommit: options.candidateCommit,
      executingSourceRoot,
      requestedSourceRoot: path.resolve(options.repository),
    });
    const resolved = yield* resolveManagedDevelopmentExecutableForSource(options.candidateCommit);
    const candidate = {
      buildIdentityHash: resolved.evidence.executableSha256,
      commit: resolved.evidence.sourceCommit,
      dirty: false as const,
    };
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-dogfood-'});
    const repository = path.join(root, 'repository');
    const home = path.join(root, 'home');
    const processHome = path.join(root, 'process-home');
    const temporaryDirectory = path.join(root, 'tmp');
    yield* Effect.all(
      [
        fs.makeDirectory(processHome, {recursive: true, mode: 0o700}),
        fs.makeDirectory(temporaryDirectory, {recursive: true, mode: 0o700}),
      ],
      {concurrency: 2, discard: true},
    );
    yield* runCommandEffect('git', ['clone', '--no-hardlinks', '--no-local', '--quiet', sourceRoot, repository], {
      maxOutputBytes: 64 * 1024,
      timeoutMs: 120_000,
    });
    const cloneHead = yield* git(repository, ['rev-parse', 'HEAD']);
    if (cloneHead.stdout.trim() !== options.approvalCommit) {
      return yield* Effect.fail(new ScriptError('The isolated dogfood clone did not resolve the reviewed harness.'));
    }
    const dogfoodEnvironment = codeMemoryLinkDogfoodEnvironment({
      home: processHome,
      temporaryDirectory,
      threadnoteHome: home,
    });
    const runExact = (args: readonly string[], timeoutMs = 120_000) =>
      runCommandEffect(resolved.executable, args, {
        cwd: repository,
        env: dogfoodEnvironment,
        maxOutputBytes: 2 * 1024 * 1024,
        timeoutMs,
      });
    yield* runExact(['graph', 'index', '--home', home, '--cwd', repository, '--no-vectors', '--json'], 300_000);
    const graphQuery = yield* runExact([
      'graph',
      'query',
      '--home',
      home,
      '--cwd',
      repository,
      '--query',
      'selectRecallCodeLinks',
      '--freshness',
      'current',
      '--json',
    ]);
    const symbol = findSymbolId(JSON.parse(graphQuery.stdout) as unknown, 'selectRecallCodeLinks');
    if (symbol === null) return yield* Effect.fail(new ScriptError('Dogfood could not resolve the cited symbol id.'));
    const runId = randomOpaqueId('run');
    const lexicalMarker = randomOpaqueId('marker');
    yield* runExact([
      'remember',
      '--home',
      home,
      '--kind',
      'handoff',
      '--project',
      'threadnote',
      '--topic',
      `code-memory-dogfood-${runId.slice(4, 20)}`,
      '--text',
      `${lexicalMarker} exact-installed practical backlink evidence for the recall selector contract.`,
      '--code-ref',
      CITED_FILE,
      '--code-ref',
      symbol,
    ]);

    const rawRuns: RawRun[] = [];
    const runBrief = Effect.fn('codeMemoryLinkDogfood.runBrief')(function* (
      id: CodeMemoryLinkDogfoodCaseId,
      task: string,
      codeRefs: readonly string[],
      graphStatus: CodeMemoryLinkDogfoodGraphStatusV1 | null,
    ) {
      const invocationNonce = randomOpaqueId('inv');
      const args = [
        'context',
        'brief',
        '--home',
        home,
        '--cwd',
        repository,
        '--project',
        'threadnote',
        '--task',
        task,
        '--budget-tokens',
        String(BUDGET_TOKENS),
        '--json',
        ...codeRefs.flatMap(ref => ['--code-ref', ref]),
      ];
      const result = yield* runExact(args);
      const brief = parseContextBriefV1(JSON.parse(result.stdout) as unknown);
      rawRuns.push({
        invocationNonce,
        summary: summarizeBrief(id, brief, graphStatus),
      });
    });

    yield* runBrief('task-only-memory', lexicalMarker, [], null);
    const anchorTask = 'Assess the implementation contract for this exact code anchor.';
    yield* runBrief('file-backlink', anchorTask, [CITED_FILE], null);
    yield* runBrief('symbol-backlink', anchorTask, [symbol], null);
    yield* runBrief('multi-anchor', anchorTask, [CITED_FILE, symbol], null);
    yield* runBrief('no-backlink', anchorTask, [UNRELATED_FILE], null);
    const citedSource = path.join(repository, CITED_FILE);
    yield* fs.writeFileString(citedSource, `${yield* fs.readFileString(citedSource)}\n`);
    const graphStatusResult = yield* runExact(['graph', 'status', '--home', home, '--cwd', repository, '--json']);
    const graphStatus = projectCodeMemoryLinkDogfoodGraphStatusV1(JSON.parse(graphStatusResult.stdout) as unknown);
    yield* runBrief('stale-graph-abstention', anchorTask, [CITED_FILE], graphStatus);

    const [after, governanceAfter] = yield* Effect.all([
      verifyManagedDevelopmentRuntimeForSource(options.candidateCommit),
      verifyApprovalCheckout(sourceRoot, options.candidateCommit),
    ]);
    if (governanceAfter.commit !== options.approvalCommit) {
      return yield* Effect.fail(new ScriptError('The reviewed harness checkout changed during dogfood.'));
    }
    const observations = rawRuns.map(run =>
      createCodeMemoryLinkDogfoodObservationV1({
        candidate,
        harnessCommit: options.approvalCommit,
        invocationNonce: run.invocationNonce,
        observation: run.summary,
        postRuntime: after,
        preRuntime: resolved.evidence,
        runId,
      }),
    );
    const evidence = {
      candidate,
      harnessCommit: options.approvalCommit,
      observations,
      runId,
      version: 1 as const,
    };
    const artifact = {...evidence, artifactHash: codeMemoryLinkDogfoodArtifactHash(evidence)};
    const result = evaluateCodeMemoryLinkDogfood(artifact);
    if (result.gate.qualityFailures.length > 0) {
      return yield* Effect.fail(new ScriptError(result.gate.qualityFailures.join('\n')));
    }
    yield* atomicWrite(options.output, `${JSON.stringify(artifact, undefined, 2)}\n`);
    yield* Console.log(
      JSON.stringify({artifactHash: artifact.artifactHash, gate: result.gate, output: options.output}),
    );
  }),
);

interface RawRun {
  readonly invocationNonce: string;
  readonly summary: CodeMemoryLinkDogfoodObservationSummaryV1;
}

function summarizeBrief(
  id: CodeMemoryLinkDogfoodCaseId,
  brief: ReturnType<typeof parseContextBriefV1>,
  graphStatus: CodeMemoryLinkDogfoodGraphStatusV1 | null,
): CodeMemoryLinkDogfoodObservationSummaryV1 {
  const memories = [...brief.activeHandoffs, ...brief.durableDecisions];
  const uniqueUris = new Set(memories.map(memory => memory.uri));
  const direct = memories.filter(memory => memory.selectionBasis === 'code-citation');
  const coverage = brief.coverage.memory.codeAnchors;
  const measurement = measureAgentToolResponse({structuredContent: brief, text: renderContextBriefText(brief)});
  return {
    budgetTokens: BUDGET_TOKENS,
    codeAnchorCoverageComplete: coverage?.complete ?? null,
    directCodeCitationMatches: direct.length,
    duplicateMemoryCount: memories.length - uniqueUris.size,
    estimatedTokens: measurement.estimatedTokens,
    falseCurrentCount: direct.filter(memory => memory.codeRelations?.some(relation => relation.status !== 'exact'))
      .length,
    graphStatus,
    id,
    memoryMatches: memories.length,
    outputVersion: brief.version,
    requestedAnchors: coverage?.requested ?? 0,
    resolvedAnchors: coverage?.resolved ?? 0,
    responseBytes: measurement.totalBytes,
  };
}

export function projectCodeMemoryLinkDogfoodGraphStatusV1(value: unknown): CodeMemoryLinkDogfoodGraphStatusV1 {
  const status = plainRecord(value, 'Code graph status');
  if (status.type !== 'code-graph-status' || status.version !== 2 || typeof status.stale !== 'boolean') {
    throw new ScriptError('Dogfood graph status did not use the expected v2 status contract.');
  }
  const snapshot = plainRecord(status.readySnapshot, 'Code graph ready snapshot');
  if (
    typeof snapshot.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(snapshot.commit) ||
    typeof snapshot.dirty !== 'boolean' ||
    typeof snapshot.id !== 'string' ||
    !/^cgsn_[0-9a-f]{32,64}$/u.test(snapshot.id)
  ) {
    throw new ScriptError('Dogfood graph status did not identify a valid ready snapshot.');
  }
  return {
    readySnapshotCommit: snapshot.commit,
    readySnapshotDirty: snapshot.dirty,
    readySnapshotId: snapshot.id,
    stale: status.stale,
  };
}

/** Candidate dogfood receives only deterministic runtime inputs, never ambient host credentials or configuration. */
export function codeMemoryLinkDogfoodEnvironment(input: {
  readonly home: string;
  readonly temporaryDirectory: string;
  readonly threadnoteHome: string;
}): Readonly<Record<string, string>> {
  return {
    ...candidateEnvironment(input.threadnoteHome, REVIEWED_POSIX_EXECUTABLE_PATH),
    HOME: input.home,
    TMPDIR: input.temporaryDirectory,
  };
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScriptError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function findSymbolId(value: unknown, name: string): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSymbolId(entry, name);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const object = value as Record<string, unknown>;
  if (object.name === name && typeof object.id === 'string' && /^cgs_[0-9a-f]{32,64}$/u.test(object.id)) {
    return object.id;
  }
  return findSymbolId(Object.values(object), name);
}

function parseArguments(args: readonly string[]): {
  readonly approvalCommit: string;
  readonly candidateCommit: string;
  readonly output: string;
  readonly repository: string;
} {
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!['--approval-commit', '--candidate-commit', '--output', '--repository'].includes(argument)) {
      throw new ScriptError(`Unknown Code Memory Link dogfood option: ${argument}`);
    }
    values[argument] = required(args[++index], argument);
  }
  return {
    approvalCommit: required(values['--approval-commit'], '--approval-commit'),
    candidateCommit: required(values['--candidate-commit'], '--candidate-commit'),
    output: required(values['--output'], '--output'),
    repository: required(values['--repository'], '--repository'),
  };
}

function randomOpaqueId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ScriptError(`${option} requires a value.`);
  return value;
}

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 1024 * 1024, timeoutMs: 30_000});
}

export const verifyDogfoodRunnerCheckout = Effect.fn('codeMemoryLinkDogfood.verifyRunnerCheckout')(function* (input: {
  readonly approvalCommit: string;
  readonly candidateCommit: string;
  readonly executingSourceRoot: string;
  readonly requestedSourceRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const [executingSourceRoot, requestedSourceRoot] = yield* Effect.all(
    [fs.realPath(input.executingSourceRoot), fs.realPath(input.requestedSourceRoot)],
    {concurrency: 2},
  );
  if (executingSourceRoot !== requestedSourceRoot) {
    return yield* Effect.fail(
      new ScriptError('--repository must be the canonical checkout that supplied and is executing the dogfood runner.'),
    );
  }
  const governance = yield* verifyApprovalCheckout(executingSourceRoot, input.candidateCommit);
  if (governance.commit !== input.approvalCommit) {
    return yield* Effect.fail(
      new ScriptError('Dogfood requires the executing checkout to be the exact clean reviewed --approval-commit.'),
    );
  }
  return executingSourceRoot;
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
