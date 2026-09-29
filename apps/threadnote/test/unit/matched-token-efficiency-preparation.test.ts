import {createHash} from '@threadnote/testing/node-crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {
  parseMatchedEvaluationManifestV1,
  parseMatchedEvaluationCorpusV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  matchedTokenEfficiencyCitationHashV1,
  parseMatchedTokenEfficiencyStudyV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {captureCodeMemoryLinkProcessGroup} from '../../../../scripts/code-memory-link-process-boundary.js';
import {parseMatchedEvaluationCodexAdapterConfigV1} from '../../../../scripts/matched-evaluation-codex-adapter.js';
import {observeMatchedEvaluationRepositoryV1} from '../../../../scripts/matched-evaluation-runtime-integrity.js';
import {
  MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION,
  assertMatchedTokenEfficiencyLinkedBriefV1,
  assertMatchedTokenEfficiencyThreadnoteVersionOutputV1,
  prepareMatchedTokenEfficiencyStudyV1,
} from '../../../../scripts/prepare-matched-token-efficiency-study.js';
import {parseMatchedEvaluationRuntimeV1} from '../../../../scripts/run-matched-evaluation.js';

describe('matched token-efficiency study preparation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('accepts only an exact commit-reporting 5.0.6 local build', () => {
    const commit = 'a'.repeat(40);

    expect(() => assertMatchedTokenEfficiencyThreadnoteVersionOutputV1('threadnote v5.0.6\n', commit)).toThrow(
      'exact commit-reporting',
    );
    expect(() =>
      assertMatchedTokenEfficiencyThreadnoteVersionOutputV1(`threadnote v5.0.6-local.g${'b'.repeat(40)}\n`, commit),
    ).toThrow('differs');
    expect(() =>
      assertMatchedTokenEfficiencyThreadnoteVersionOutputV1(`threadnote v5.0.6-local.g${commit}\n`, commit),
    ).not.toThrow();
  });

  it('requires the exact task prompt to surface the complete reviewed memory roster', () => {
    const brief = {
      activeHandoffs: [],
      durableDecisions: [
        {kind: 'durable', project: 'threadnote', topic: 'parser-contract'},
        {kind: 'durable', project: 'threadnote', topic: 'serializer-contract'},
      ],
      type: 'context-brief',
      version: 3,
    };

    expect(() =>
      assertMatchedTokenEfficiencyLinkedBriefV1(brief, 'threadnote', 'tsk_1234567890abcdef', [
        'parser-contract',
        'serializer-contract',
      ]),
    ).not.toThrow();
    expect(() =>
      assertMatchedTokenEfficiencyLinkedBriefV1(
        {...brief, durableDecisions: brief.durableDecisions.slice(0, 1)},
        'threadnote',
        'tsk_1234567890abcdef',
        ['parser-contract', 'serializer-contract'],
      ),
    ).toThrow('complete reviewed memory roster');
  });

  it('freezes a hash-closed no-provider bundle with distinct graph-only and linked homes', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot(roots);
    const contextRoot = join(root, '.context');
    await mkdir(contextRoot);
    const source = join(root, 'threadnote-source');
    const sourceCommit = await sourceRepository(source);
    const repositories = await Promise.all([
      heldOutRepository(join(root, 'repository-one'), 'https://github.com/example/preparation-one.git'),
      heldOutRepository(join(root, 'repository-two'), 'https://github.com/example/preparation-two.git'),
    ]);
    const fixtureInput = JSON.parse(
      await readFile(
        join(process.cwd(), 'apps/threadnote/test/evaluation/fixtures/matched-evaluation-v1/fixture.json'),
        'utf8',
      ),
    ) as {tasks: Array<Record<string, unknown>>; version: 1; corpusId: string};
    const corpusInput = {
      ...fixtureInput,
      tasks: fixtureInput.tasks.map((task, index) => ({
        ...task,
        memoryFixtures: (task.memoryFixtures as Array<Record<string, unknown>>).map(memory => ({
          ...memory,
          source:
            memory.source === null
              ? null
              : {...(memory.source as Record<string, unknown>), endLine: 1, path: 'service.ts', startLine: 1},
        })),
        repositoryFixtureHash: repositories[index % 2].fixtureHash,
        sourceGold: (task.sourceGold as Array<Record<string, unknown>>).map(sourceGold => ({
          ...sourceGold,
          endLine: 1,
          path: 'service.ts',
          startLine: 1,
        })),
      })),
    };
    const corpus = parseMatchedEvaluationCorpusV1(corpusInput);
    const corpusPath = join(root, 'corpus.json');
    await writeFile(corpusPath, `${JSON.stringify(corpus, undefined, 2)}\n`);
    const graphSnapshotId = `cgsn_${'1'.repeat(40)}`;
    const graphContentId = `cgc_${'2'.repeat(40)}`;
    const assessmentFile = join(root, 'assessment.json');
    await writeFile(assessmentFile, '{"review":"no manual context"}\n');
    const taskContexts = [];
    const expectedReceipts = new Map<string, Array<{citationHash: string; memoryId: string; status: 'exact'}>>();
    for (let index = 0; index < corpus.tasks.length; index += 1) {
      const task = corpus.tasks[index];
      const taskReceipts: Array<{citationHash: string; memoryId: string; status: 'exact'}> = [];
      const graphHome = join(root, `graph-home-${index}`);
      const linkedHome = join(root, `linked-home-${index}`);
      await Promise.all([mkdir(graphHome), mkdir(linkedHome)]);
      await writeFile(join(graphHome, 'graph-state'), 'ready\n');
      await writeFile(join(linkedHome, 'graph-state'), 'ready\n');
      const memoryDirectory = join(linkedHome, 'data', 'fixture', 'memories', 'durable', 'projects', 'threadnote');
      await mkdir(memoryDirectory, {recursive: true});
      const repository = repositories[index % 2];
      const linkedMemoryIdentities: Array<{fixtureMemoryId: string; managedMemoryId: string}> = [];
      for (let memoryIndex = 0; memoryIndex < task.memoryFixtures.length; memoryIndex += 1) {
        const fixture = task.memoryFixtures[memoryIndex];
        const managedMemoryId = `tn_${String(index + 1).repeat(8)}${String(memoryIndex + 1).repeat(8)}`;
        linkedMemoryIdentities.push({fixtureMemoryId: fixture.memoryId, managedMemoryId});
        const citations =
          fixture.source === null
            ? []
            : [
                createMemoryCodeCitation({
                  extractorSet: 'matched-preparation-test-v1',
                  fileContentHash: {algorithm: 'sha256', value: '3'.repeat(64)},
                  path: fixture.source.path,
                  repositoryId: '4'.repeat(64),
                  repositoryIdentityKind: 'remote',
                  sourceCommit: repository.revision,
                  sourceDirty: false,
                  sourceGraphContentId: graphContentId,
                  sourceSnapshotId: graphSnapshotId,
                  target: {kind: 'file'},
                  version: 1,
                }),
              ];
        const document = formatMemoryDocument(
          'MEMORY',
          {
            codeCitations: citations,
            kind: 'durable',
            memoryId: managedMemoryId,
            project: 'threadnote',
            schemaVersion: 5,
            sourceAgentClient: 'preparation-test',
            status: fixture.status,
            timestamp: '2026-09-29T00:00:00.000Z',
            topic: `task-${index}-memory-${memoryIndex}`,
          },
          fixture.text,
        );
        await writeFile(join(memoryDirectory, `memory-${memoryIndex}.md`), document);
        if (fixture.source !== null) {
          taskReceipts.push({
            citationHash: matchedTokenEfficiencyCitationHashV1({
              citationId: citations[0].id,
              fixtureMemoryId: fixture.memoryId,
              managedMemoryId,
            }),
            memoryId: fixture.memoryId,
            status: 'exact',
          });
        }
      }
      expectedReceipts.set(
        task.taskId,
        taskReceipts.sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
      );
      taskContexts.push({
        asIssuedContext: {assessmentFile, contentFile: null, sufficiency: 'none'},
        clusterId: `cluster_${String((index % 2) + 1).repeat(16)}`,
        graphHomeDirectory: graphHome,
        linkedHomeDirectory: linkedHome,
        linkedMemoryIdentities,
        taskId: task.taskId,
      });
    }
    const fakeThreadnote = join(root, 'threadnote');
    await writeFile(fakeThreadnote, fakeThreadnoteProgram(graphSnapshotId, graphContentId, sourceCommit));
    await chmod(fakeThreadnote, 0o700);
    const auth = join(root, 'auth.json');
    await writeFile(auth, '{}\n', {mode: 0o600});
    await chmod(auth, 0o600);
    const lockFile = join(root, 'install-lock.json');
    await writeFile(lockFile, '{"fixture":true}\n');
    const planPath = join(root, 'plan.json');
    await writeFile(
      planPath,
      `${JSON.stringify(
        {
          adapter: {
            appServer: {
              argumentsAfterSubcommand: [],
              argumentsBeforeSubcommand: [],
              executable: '/usr/bin/true',
              version: 'fixture-app-server-v1',
            },
            authSourcePath: auth,
            contextBudgetTokens: 1_200,
            executable: '/usr/bin/true',
            gitExecutable: '/usr/bin/git',
            judgeModel: {
              id: 'judge-model',
              provider: 'fixture',
              reasoningEffort: 'low',
            },
            model: {id: 'agent-model', provider: 'fixture', reasoningEffort: 'medium'},
            pricingMicrosPerMillionTokens: null,
            safeBinaries: [],
            safeExecutablePath: '/usr/bin:/bin',
            taskBudget: {steps: 100, tokens: 100_000},
            temporaryRoot: root,
          },
          bootstrap: {confidenceLevelBasisPoints: 9_500, iterations: 200, seed: '7'.repeat(64)},
          clusters: [
            {
              clusterId: `cluster_${'1'.repeat(16)}`,
              repositoryDirectory: repositories[0].directory,
              repositoryUrl: repositories[0].url,
            },
            {
              clusterId: `cluster_${'2'.repeat(16)}`,
              repositoryDirectory: repositories[1].directory,
              repositoryUrl: repositories[1].url,
            },
          ],
          gates: {
            completionNonInferiorityBasisPoints: 500,
            maximumAuthorizationLeaks: 0,
            maximumFalseCurrentOutcomes: 0,
            maximumHarmfulActions: 0,
            minimumCorrectnessScoreMilli: 800,
            minimumClusters: 2,
            minimumMemoryTokenReductionBasisPoints: 500,
            minimumTokenReductionBasisPoints: 500,
          },
          lifecycle: lifecycle(),
          project: 'threadnote',
          repetitions: 5,
          scheduleSeed: '8'.repeat(64),
          studyId: 'matched-preparation-test',
          taskContexts,
          threadnote: {
            executable: fakeThreadnote,
            lockFile,
            requiredReleaseCommit: sourceCommit,
            sourceDirectory: source,
          },
          timeoutMilliseconds: 60_000,
          version: 1,
        },
        undefined,
        2,
      )}\n`,
    );
    const outputRoot = join(contextRoot, 'prepared-study');

    const receipt = await prepareMatchedTokenEfficiencyStudyV1({corpusPath, outputRoot, planPath});
    const manifest = parseMatchedEvaluationManifestV1(
      JSON.parse(await readFile(join(outputRoot, 'manifest.json'), 'utf8')),
    );
    const study = parseMatchedTokenEfficiencyStudyV1(
      JSON.parse(await readFile(join(outputRoot, 'study.json'), 'utf8')),
    );
    const runtime = parseMatchedEvaluationRuntimeV1(
      JSON.parse(await readFile(join(outputRoot, 'runtime.json'), 'utf8')),
    );
    const configs = await Promise.all(
      manifest.arms.map(async definition => {
        const bytes = await readFile(join(outputRoot, 'adapter-config', `${definition.arm}.json`));
        return {
          config: parseMatchedEvaluationCodexAdapterConfigV1(JSON.parse(bytes.toString('utf8'))),
          definition,
          hash: sha256(bytes),
        };
      }),
    );

    expect(receipt).toMatchObject({
      manifestHash: manifest.manifestHash,
      referenceArm: 'unavailable',
      requiredProductVersion: MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION,
      studyHash: study.studyHash,
      threadnoteSourceCommit: sourceCommit,
    });
    expect(manifest.schedule).toHaveLength(150);
    expect(runtime.arms.map(arm => arm.arm)).toEqual([
      'files',
      'threadnote-graph',
      'threadnote-compact',
      'threadnote-source',
    ]);
    for (const [path, expectedHash] of Object.entries(receipt.outputHashes)) {
      expect(sha256(await readFile(join(outputRoot, path))), path).toBe(expectedHash);
    }
    for (const {definition, hash} of configs) {
      expect(hash, definition.arm).toBe(definition.adapterConfigurationHash);
      expect(hash, definition.arm).toBe(receipt.adapterConfigurationHashes[definition.arm]);
    }
    const graphConfig = configs.find(entry => entry.config.arm === 'threadnote-graph')?.config;
    const compactConfig = configs.find(entry => entry.config.arm === 'threadnote-compact')?.config;
    expect(graphConfig?.contextHomes).toHaveLength(corpus.tasks.length);
    expect(compactConfig?.contextHomes).toHaveLength(corpus.tasks.length);
    expect(new Set(graphConfig?.contextHomes.map(home => home.homeDirectory))).toHaveProperty(
      'size',
      corpus.tasks.length,
    );
    expect(new Set(compactConfig?.contextHomes.map(home => home.homeFixtureHash))).toHaveProperty(
      'size',
      corpus.tasks.length,
    );
    for (const graphHome of graphConfig?.contextHomes ?? []) {
      const linkedHome = compactConfig?.contextHomes.find(home => home.taskId === graphHome.taskId);
      expect(linkedHome).toBeDefined();
      expect(graphHome.homeDirectory).not.toBe(linkedHome?.homeDirectory);
      expect(graphHome.homeFixtureHash).not.toBe(linkedHome?.homeFixtureHash);
      expect(graphHome.expectedContext.memoryAccess).toBe('disabled');
      expect(linkedHome?.expectedContext.memoryAccess).toBe('linked');
    }
    expect(JSON.stringify(configs.map(entry => entry.config))).not.toContain('studyHash');
    expect(study.clusters).toHaveLength(2);
    expect(study.taskContexts.every(context => context.linkReceipts.length > 0)).toBe(true);
    for (const context of study.taskContexts) {
      const expected = taskContexts.find(candidate => candidate.taskId === context.taskId);
      expect(context.clusterId).toBe(expected?.clusterId);
      expect(context.repositoryFixtureHash).toBe(
        repositories[context.clusterId === `cluster_${'1'.repeat(16)}` ? 0 : 1].fixtureHash,
      );
      expect(context.linkReceipts).toEqual(expectedReceipts.get(context.taskId));
    }
    const referencePayload = await readFile(join(outputRoot, 'reference-scope-unavailable.json'));
    expect(JSON.parse(referencePayload.toString('utf8'))).toEqual({
      reason: 'reference-scope runtime is not configured by the production Codex preparer',
      version: 1,
    });
    const referenceDefinition = manifest.arms.find(arm => arm.arm === 'reference-scope');
    expect(referenceDefinition?.tool.artifactHash).toBe(sha256(referencePayload));
    expect(referenceDefinition?.tool.lockIdentityHash).toBe(sha256(referencePayload));
  }, 30_000);
});

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-preparation-')));
  roots.push(root);
  return root;
}

async function sourceRepository(directory: string): Promise<string> {
  await mkdir(directory);
  await git(directory, ['init', '-q']);
  await git(directory, ['config', 'user.email', 'evaluation@example.invalid']);
  await git(directory, ['config', 'user.name', 'Evaluation Fixture']);
  await writeFile(join(directory, 'package.json'), JSON.stringify({name: 'threadnote-source', version: '5.0.6'}));
  await git(directory, ['add', 'package.json']);
  await git(directory, ['commit', '-qm', 'fixture 5.0.6 source']);
  return await gitOutput(directory, ['rev-parse', 'HEAD']);
}

async function heldOutRepository(directory: string, url: string) {
  await mkdir(directory);
  await git(directory, ['init', '-q']);
  await git(directory, ['config', 'user.email', 'evaluation@example.invalid']);
  await git(directory, ['config', 'user.name', 'Evaluation Fixture']);
  await git(directory, ['remote', 'add', 'origin', url]);
  await writeFile(join(directory, 'service.ts'), 'export const value = 1;\n');
  await git(directory, ['add', 'service.ts']);
  await git(directory, ['commit', '-qm', 'held-out fixture']);
  return {directory, url, ...(await observeMatchedEvaluationRepositoryV1(directory))};
}

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', cwd, ...arguments_],
    command: 'git',
    cwd,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Matched preparation Git fixture',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
}

async function gitOutput(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: ['-C', cwd, ...arguments_],
    command: 'git',
    cwd,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    },
    label: 'Matched preparation Git fixture read',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  });
  return result.stdout.trim();
}

function fakeThreadnoteProgram(snapshotId: string, graphContentId: string, sourceCommit: string): string {
  const repositoryId = '4'.repeat(64);
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "threadnote v5.0.6-local.g${sourceCommit}"
  exit 0
fi
if [ "$1" = "context" ] && [ "$2" = "check" ]; then
  echo '{}'
  exit 0
fi
if [ "$1" = "context" ] && [ "$2" = "brief" ]; then
  home=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--home" ]; then
      shift
      home="$1"
    fi
    shift
  done
  printf '{"type":"context-brief","version":3,"durableDecisions":['
  separator=""
  for memory in "$home"/data/fixture/memories/durable/projects/threadnote/*.md; do
    if [ ! -f "$memory" ]; then
      continue
    fi
    topic=$(/usr/bin/awk '/^topic: / { sub(/^topic: /, ""); print; exit }' "$memory")
    printf '%s{"kind":"durable","project":"threadnote","topic":"%s"}' "$separator" "$topic"
    separator=","
  done
  echo '],"activeHandoffs":[]}'
  exit 0
fi
cwd=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--cwd" ]; then
    shift
    cwd="$1"
  fi
  shift
done
commit=$(/usr/bin/git -C "$cwd" rev-parse HEAD)
origin=$(/usr/bin/git -C "$cwd" remote get-url origin)
remote=\${origin#https://}
remote=\${remote%.git}
printf '{"type":"code-graph-status","version":5,"stale":false,"identity":{"headCommit":"%s","repoRoot":"%s","remoteIdentity":"%s","repositoryId":"${repositoryId}"},"readySnapshot":{"id":"${snapshotId}","graphContentId":"${graphContentId}","commit":"%s","dirty":false,"state":"ready","repositoryId":"${repositoryId}"}}\n' "$commit" "$cwd" "$remote" "$commit"
`;
}

function lifecycle() {
  const zero = {cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0};
  return ['files', 'threadnote-graph', 'threadnote-compact', 'threadnote-source', 'reference-scope'].map(arm => ({
    arm,
    setupMilliseconds: 0,
    setupUsage: {graphPreparation: zero, memoryAuthoring: zero, memoryReview: zero},
  }));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
