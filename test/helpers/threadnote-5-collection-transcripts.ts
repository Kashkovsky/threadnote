import {
  collectionTrialIdentity,
  parseThreadnote5CollectionPlan,
  THREADNOTE_5_COLLECTION_MATRIX,
  type NativeProjection,
} from '../../src/evaluation/threadnote-5-release-collection.js';
import {deriveThreadnote5PrivateCollection} from '../../src/evaluation/threadnote-5-release-collection-envelope.js';
import {PRODUCTION_CAPTURE_CANDIDATE, productionCaptureFixture} from './threadnote-5-production-capture-fixture.js';

/** Test-only native transcript doubles; no production adapter imports this helper. */
export function collectionTranscriptFixture() {
  const source = productionCaptureFixture();
  const runId = 'test_collection';
  const transcripts: unknown[] = [];
  const recipes = THREADNOTE_5_COLLECTION_MATRIX.map(([scenario, kinds]) => {
    const count = kinds.some(item => item[1] > 1) ? 10 : 1;
    const outputs: Record<string, unknown>[] = Array.from({length: count}, () => ({}));
    const exports: Record<string, NativeProjection> = {};
    for (const [kind, required] of kinds) {
      const artifact = source.records.find(record => record.scenario === scenario && record.kind === kind)!
        .artifact as Record<string, unknown>;
      if (required === 1) {
        outputs[0][kind] = artifact;
        exports[kind] = {select: 'native', pointer: `/json/${kind}`, trial: 0};
        continue;
      }
      const fields: Record<string, NativeProjection> = {};
      for (let index = 0; index < count; index += 1) outputs[index][kind] = {};
      for (const [field, value] of Object.entries(artifact)) {
        if (Array.isArray(value) && value.length === count) {
          fields[field] = {collect: 'native', pointer: `/json/${kind}/${field}`, flatten: true};
          for (let index = 0; index < count; index += 1)
            (outputs[index][kind] as Record<string, unknown>)[field] = [value[index]];
        } else {
          fields[field] = {select: 'native', pointer: `/json/${kind}/${field}`, trial: 0};
          (outputs[0][kind] as Record<string, unknown>)[field] = value;
        }
      }
      exports[kind] = {object: fields};
    }
    const steps = [{id: 'native', type: 'cli', surface: 'primary', argv: ['test-only-source-double'], expectedExit: 0}];
    for (let index = 0; index < count; index += 1) {
      const identity = collectionTrialIdentity(runId, scenario, index);
      transcripts.push({
        identity,
        scenario,
        mcpStderr: {},
        steps: [
          {
            step: steps[0],
            bindings: {
              ...identity,
              home: '/private/synthetic/home',
              userHome: '/private/synthetic/user',
              repo: '/private/synthetic/repo',
              primaryRepo: '/private/synthetic/repo',
              secondaryRepo: '/private/synthetic/worktree',
              remote: '/private/synthetic/team.git',
            },
            output: {
              stdout: JSON.stringify(outputs[index]),
              stderr: '',
              exitCode: 0,
              elapsedMilliseconds: 1,
              json: outputs[index],
            },
          },
        ],
      });
    }
    return {scenario, steps, exports};
  });
  const plan = parseThreadnote5CollectionPlan({
    version: 1,
    runId,
    candidate: PRODUCTION_CAPTURE_CANDIDATE,
    measuredTrials: 10,
    retentionHours: 1,
    recipes,
  });
  const runtime = {sourceCommit: plan.candidate.commit, executableSha256: plan.candidate.executableSha256};
  const boundaries = recipes.map(({scenario}) => ({scenario, preRuntime: runtime, postRuntime: runtime}));
  return {...source, plan, transcripts, collection: deriveThreadnote5PrivateCollection(plan, transcripts, boundaries)};
}
