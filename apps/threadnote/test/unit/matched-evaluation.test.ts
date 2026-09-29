import {readFile} from '@threadnote/testing/node-fs-promises';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createMatchedEvaluationManifestV1,
  matchedEvaluationReferenceEnvironmentPolicyHashV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
  type MatchedEvaluationArmDefinitionV1,
  type MatchedEvaluationCorpusV1,
  type MatchedEvaluationManifestV1,
  MATCHED_EVALUATION_ARMS,
  MATCHED_EVALUATION_BLIND_LABELS,
  MATCHED_EVALUATION_TASK_CATEGORIES,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  assertMatchedEvaluationOutcomePrefixV1,
  parseMatchedEvaluationObservationV1,
  runMatchedEvaluationV1,
  summarizeMatchedEvaluationV1,
  type MatchedEvaluationMetricsV1,
  type MatchedEvaluationObservationV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';

describe('matched Threadnote, reference, and files evaluation', () => {
  it('builds a content-addressed corpus and balanced blinded repeated schedule', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);

    expect(manifest.tasks).toHaveLength(6);
    expect(new Set(manifest.tasks.map(task => task.category))).toEqual(new Set(MATCHED_EVALUATION_TASK_CATEGORIES));
    expect(manifest.schedule).toHaveLength(6 * 5 * 5);
    expect(parseMatchedEvaluationManifestV1(manifest)).toEqual(manifest);

    for (const task of manifest.tasks) {
      const entries = manifest.schedule.filter(entry => entry.taskId === task.taskId);
      for (const label of MATCHED_EVALUATION_BLIND_LABELS) {
        expect(entries.filter(entry => entry.blindLabel === label)).toHaveLength(5);
        expect(
          entries
            .filter(entry => entry.blindLabel === label)
            .map(entry => entry.position)
            .sort(),
        ).toEqual([1, 2, 3, 4, 5]);
      }
    }
  });

  it('admits an unmixed historical as-issued corpus without inventing synthetic task conditions', async () => {
    const corpus = await fixture();
    const historical = {
      ...corpus,
      tasks: corpus.tasks.map(task => ({...task, pairId: null, variant: 'historical-as-issued' as const})),
    };

    expect(parseMatchedEvaluationCorpusV1(historical).tasks).toHaveLength(6);
    expect(() =>
      parseMatchedEvaluationCorpusV1({
        ...historical,
        tasks: historical.tasks.map((task, index) => (index === 0 ? {...task, variant: 'exact-name' as const} : task)),
      }),
    ).toThrow('cannot mix with synthetic variants');
  });

  it('admits the reviewed historical external corpus with unedited prompt and context provenance', async () => {
    const root = new URL('../evaluation/corpora/token-efficiency-historical-v1/', import.meta.url);
    const corpus = parseMatchedEvaluationCorpusV1(JSON.parse(await readFile(new URL('corpus.json', root), 'utf8')));
    const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8')) as {
      readonly repositories: readonly {
        readonly clusterId: string;
        readonly repository: string;
        readonly repositoryFixtureHash: string;
      }[];
      readonly tasks: readonly {
        readonly contextAssessment: {
          readonly assessmentFile: string;
          readonly contentFile: string | null;
          readonly sufficiency: string;
        };
        readonly promptSource: {readonly lastEditedAt: string | null};
        readonly targetRepository: string;
        readonly taskId: string;
      }[];
    };

    expect(corpus.tasks).toHaveLength(6);
    expect(new Set(corpus.tasks.map(task => task.variant))).toEqual(new Set(['historical-as-issued']));
    expect(new Set(provenance.repositories.map(repository => repository.repository)).size).toBe(6);
    expect(new Set(provenance.repositories.map(repository => repository.clusterId)).size).toBe(6);
    expect(new Set(provenance.tasks.map(task => task.contextAssessment.sufficiency))).toEqual(
      new Set(['none', 'lacking', 'sufficient', 'excessive']),
    );

    for (const taskProvenance of provenance.tasks) {
      const task = corpus.tasks.find(candidate => candidate.taskId === taskProvenance.taskId);
      if (!task) throw new Error(`missing corpus task ${taskProvenance.taskId}`);
      expect(taskProvenance.promptSource.lastEditedAt).toBeNull();
      const repository = provenance.repositories.find(
        candidate => candidate.repository === taskProvenance.targetRepository,
      );
      expect(repository?.repositoryFixtureHash).toBe(task.repositoryFixtureHash);
      const assessment = JSON.parse(
        await readFile(new URL(taskProvenance.contextAssessment.assessmentFile, root), 'utf8'),
      ) as {readonly sufficiency: string; readonly taskId: string};
      expect(assessment).toMatchObject({
        sufficiency: taskProvenance.contextAssessment.sufficiency,
        taskId: taskProvenance.taskId,
      });
      if (taskProvenance.contextAssessment.contentFile === null) {
        expect(taskProvenance.contextAssessment.sufficiency).toBe('none');
      } else {
        const promptBody = task.prompt.slice(task.prompt.indexOf('\n\n') + 2);
        expect(await readFile(new URL(taskProvenance.contextAssessment.contentFile, root), 'utf8')).toBe(
          `${promptBody}\n`,
        );
      }
    }
  });

  it('is deterministic and position-balanced for arbitrary seeds and input permutations', async () => {
    const corpus = await fixture();
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64})
          .map(characters => characters.join('')),
        fc.boolean(),
        fc.integer({min: 0, max: corpus.tasks.length - 1}),
        (seed, reverseArms, rotation) => {
          const rotatedTasks = [...corpus.tasks.slice(rotation), ...corpus.tasks.slice(0, rotation)];
          const permutedCorpus = {...corpus, tasks: rotatedTasks.reverse()};
          const arms = reverseArms ? [...armDefinitions()].reverse() : armDefinitions();
          const first = createManifest(permutedCorpus, seed, arms);
          const second = createManifest(corpus, seed, armDefinitions());

          expect(first).toEqual(second);
          for (const task of first.tasks) {
            const entries = first.schedule.filter(entry => entry.taskId === task.taskId);
            for (const label of MATCHED_EVALUATION_BLIND_LABELS) {
              expect(
                entries
                  .filter(entry => entry.blindLabel === label)
                  .map(entry => entry.position)
                  .sort(),
              ).toEqual([1, 2, 3, 4, 5]);
            }
          }
        },
      ),
      {numRuns: 40},
    );
  });

  it('binds task, model, repository, tool, and telemetry policy identities into the manifest hash', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const changedModel = createMatchedEvaluationManifestV1({
      arms: manifest.arms,
      corpus,
      model: {...manifest.model, parametersHash: 'f'.repeat(64)},
      repetitions: manifest.repetitions,
      repository: manifest.repository,
      scheduleSeed: manifest.scheduleSeed,
    });
    const changedCorpus = {
      ...corpus,
      tasks: corpus.tasks.map((task, index) => (index === 0 ? {...task, prompt: `${task.prompt} Changed.`} : task)),
    };
    const changedTask = createManifest(changedCorpus);
    const changedAdapterConfig = createMatchedEvaluationManifestV1({
      arms: manifest.arms.map((arm, index) => (index === 0 ? {...arm, adapterConfigurationHash: '0'.repeat(64)} : arm)),
      corpus,
      model: manifest.model,
      repetitions: manifest.repetitions,
      repository: manifest.repository,
      scheduleSeed: manifest.scheduleSeed,
    });

    expect(changedModel.manifestHash).not.toBe(manifest.manifestHash);
    expect(changedTask.manifestHash).not.toBe(manifest.manifestHash);
    expect(changedAdapterConfig.manifestHash).not.toBe(manifest.manifestHash);
    expect(manifest.arms.find(arm => arm.arm === 'reference-scope')).toMatchObject({
      environmentPolicyHash: matchedEvaluationReferenceEnvironmentPolicyHashV1(),
      tool: {name: 'reference-context-tool', version: 'pinned-v1'},
    });
    expect(() =>
      createMatchedEvaluationManifestV1({
        arms: manifest.arms.map(arm =>
          arm.arm === 'reference-scope' ? {...arm, environmentPolicyHash: '0'.repeat(64)} : arm,
        ),
        corpus,
        model: manifest.model,
        repetitions: manifest.repetitions,
        repository: manifest.repository,
        scheduleSeed: manifest.scheduleSeed,
      }),
    ).toThrow('isolated no-tracking environment policy');
  });

  it('records a missing optional reference arm without corrupting the balanced run', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const outcomes = await runMatchedEvaluationV1({
      availability: async arm =>
        arm === 'reference-scope'
          ? {
              available: false as const,
              detail: 'reference tool executable is not configured',
              reason: 'runtime-not-configured',
            }
          : {available: true as const},
      corpus,
      execute: async request => observation(request.schedule.runOrder),
      manifest,
    });
    const summary = summarizeMatchedEvaluationV1(manifest, outcomes);

    expect(outcomes).toHaveLength(manifest.schedule.length);
    expect(assertMatchedEvaluationOutcomePrefixV1(manifest, outcomes)).toEqual(outcomes);
    expect(summary.arms.find(arm => arm.arm === 'reference-scope')).toMatchObject({completed: 0, unavailable: 30});
    expect(summary.arms.find(arm => arm.arm === 'threadnote-source')).toMatchObject({
      completed: 30,
      unavailable: 0,
    });
    expect(summary.comparativeClaimsEligible).toBe(false);
    expect(JSON.stringify(outcomes)).not.toContain('reference-scope');
    expect(JSON.stringify(outcomes)).not.toContain('transcript content');
  });

  it('resumes only an exact hash-chained prefix and refuses changed identities', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const first = await runMatchedEvaluationV1({
      availability: async () => ({available: true as const}),
      corpus,
      execute: async request => observation(request.schedule.runOrder),
      manifest,
    });
    let executions = 0;
    const resumed = await runMatchedEvaluationV1({
      availability: async () => ({available: true as const}),
      corpus,
      execute: async request => {
        executions += 1;
        return observation(request.schedule.runOrder);
      },
      manifest,
      outcomes: first.slice(0, 17),
    });

    expect(resumed).toEqual(first);
    expect(executions).toBe(first.length - 17);

    const changed = createMatchedEvaluationManifestV1({
      arms: manifest.arms,
      corpus,
      model: {...manifest.model, model: 'changed-model'},
      repetitions: manifest.repetitions,
      repository: manifest.repository,
      scheduleSeed: manifest.scheduleSeed,
    });
    await expect(
      runMatchedEvaluationV1({
        availability: async () => ({available: true as const}),
        corpus,
        execute: async request => observation(request.schedule.runOrder),
        manifest: changed,
        outcomes: first.slice(0, 1),
      }),
    ).rejects.toThrow('immutable manifest schedule');
  });

  it('accepts only bounded metrics and excludes raw transcript or response fields', () => {
    expect(parseMatchedEvaluationObservationV1(observation(0))).toEqual(observation(0));
    expect(() => parseMatchedEvaluationObservationV1({...observation(0), transcript: 'raw local transcript'})).toThrow(
      'unsupported or missing fields',
    );
    expect(() =>
      parseMatchedEvaluationObservationV1({
        ...observation(0),
        metrics: {...metrics(), retrieval: {recalledEvidence: 3, requiredEvidence: 2}},
      }),
    ).toThrow('subset exceeds total');
    expect(() =>
      parseMatchedEvaluationObservationV1({
        ...observation(0),
        metrics: {
          ...metrics(),
          timing: {endToEndMilliseconds: 5, firstSufficientEvidenceMilliseconds: 6},
        },
      }),
    ).toThrow('exceeds end-to-end');
    expect(() =>
      parseMatchedEvaluationObservationV1({
        ...observation(0),
        metrics: {
          ...metrics(),
          usage: {
            ...metrics().usage,
            providerTokens: {
              cachedInputTokens: 10,
              inputTokens: 200,
              outputTokens: 50,
              reasoningOutputTokens: 20,
              totalTokens: 251,
            },
          },
        },
      }),
    ).toThrow('provider token components are inconsistent');
  });
});

async function fixture(): Promise<MatchedEvaluationCorpusV1> {
  const path = new URL('../evaluation/fixtures/matched-evaluation-v1/fixture.json', import.meta.url);
  return parseMatchedEvaluationCorpusV1(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function createManifest(
  corpus: MatchedEvaluationCorpusV1 | unknown,
  scheduleSeed = 'a'.repeat(64),
  arms = armDefinitions(),
): MatchedEvaluationManifestV1 {
  return createMatchedEvaluationManifestV1({
    arms,
    corpus,
    model: {model: 'test-model', parametersHash: 'b'.repeat(64), provider: 'provider-neutral'},
    repetitions: 5,
    repository: {
      dirty: true,
      fixtureHash: 'c'.repeat(64),
      identityHash: 'd'.repeat(64),
      revision: 'fixture-revision-v1',
    },
    scheduleSeed,
  });
}

function armDefinitions(): readonly MatchedEvaluationArmDefinitionV1[] {
  return MATCHED_EVALUATION_ARMS.map((arm, index) => ({
    adapterArtifactHash: String(index + 1).repeat(64),
    adapterConfigurationHash: (index + 6).toString(16).repeat(64),
    adapterProtocol: 'matched-evaluation-adapter-v4',
    arm,
    environmentPolicyHash:
      arm === 'reference-scope' ? matchedEvaluationReferenceEnvironmentPolicyHashV1() : 'e'.repeat(64),
    tool:
      arm === 'files'
        ? {artifactHash: null, lockIdentityHash: null, name: 'repository-files', version: 'builtin-v1'}
        : arm === 'reference-scope'
          ? {
              artifactHash: '9'.repeat(64),
              lockIdentityHash: '8'.repeat(64),
              name: 'reference-context-tool',
              version: 'pinned-v1',
            }
          : {
              artifactHash: '7'.repeat(64),
              lockIdentityHash: '6'.repeat(64),
              name: 'threadnote',
              version: '5.0.4',
            },
  }));
}

function observation(runOrder: number): MatchedEvaluationObservationV1 {
  return {
    artifactHash: runOrder.toString(16).padStart(64, '0'),
    metrics: metrics(),
    transcriptHash: (runOrder + 1).toString(16).padStart(64, '0'),
    version: 3,
  };
}

function metrics(): MatchedEvaluationMetricsV1 {
  return {
    auditability: {citations: 2, resolvableCitations: 2},
    completion: {completed: true},
    context: null,
    correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
    drift: {falseCurrentOutcomes: 0},
    providerCostMicros: null,
    retrieval: {recalledEvidence: 2, requiredEvidence: 2},
    safety: {authorizationLeaks: 0, harmfulActions: 0},
    sourceSupport: {requiredClaims: 2, supportedClaims: 2},
    timing: {endToEndMilliseconds: 20, firstSufficientEvidenceMilliseconds: 10},
    usage: {
      modelVisibleBytes: 1_000,
      modelVisibleTokens: 250,
      providerTokens: {
        cachedInputTokens: 10,
        inputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 20,
        totalTokens: 250,
      },
      redundantFileReads: 0,
      toolTurns: 2,
    },
    validity: {failureCount: 0, valid: true},
    verification: null,
  };
}
