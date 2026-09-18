import {fcProp} from '../helpers/fast-check-property.js';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  ciScopeKeys,
  classifyCiScopes,
  selectCiTestPlan,
  selectCiTestPlanForClassification,
  type CiScopeKey,
} from '../ci/ci-scopes.js';

const pathSegment = FC.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/u);
const websitePath = FC.array(pathSegment, {maxLength: 5, minLength: 1}).map(parts => `website/${parts.join('/')}.tsx`);
const documentationPath = FC.oneof(
  FC.array(pathSegment, {maxLength: 5, minLength: 1}).map(parts => `docs/${parts.join('/')}.md`),
  pathSegment.map(segment => `${segment}.md`),
);
const guidancePath = FC.oneof(
  FC.constantFrom('config/agent-instructions.md', 'docs/agent-instructions.md', 'test/unit/agent-instructions.test.ts'),
  FC.constantFrom('threadnote-context', 'threadnote-code-graph', 'threadnote-memory').map(
    skill => `config/agent-skills/${skill}/SKILL.md`,
  ),
  FC.constantFrom('cursor-cloud-personal').map(profile => `config/agent-profiles/${profile}/agent-instructions.md`),
);
const runtimePath = pathSegment.map(segment => `src/${segment}.ts`);
const knownPath = FC.oneof(
  websitePath,
  documentationPath,
  guidancePath,
  runtimePath,
  pathSegment.map(segment => `test/unit/${segment}.test.ts`),
  pathSegment.map(segment => `scripts/${segment}.ts`),
  FC.constantFrom('README.md', 'package.json', '.github/workflows/pages.yml', '.github/workflows/ci.yml'),
);

const fixedLongGroupNames = [
  'lifecycle-alpha',
  'lifecycle-beta',
  'lifecycle-gamma',
  'lifecycle-delta',
  'project-closure',
  'incremental-property',
  'load-evidence',
  'os-contention',
  'heavy-integration',
  'heavy-state',
] as const;
type FixedLongGroupName = (typeof fixedLongGroupNames)[number];

const fixedRequiredLongGroupNames = fixedLongGroupNames.filter(group => group !== 'load-evidence');

const fixedLongGroupModel: Readonly<Record<FixedLongGroupName, readonly string[]>> = {
  'lifecycle-alpha': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-beta': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-gamma': ['test/integration/code-graph.lifecycle.test.ts'],
  'lifecycle-delta': ['test/integration/code-graph.lifecycle.test.ts'],
  'project-closure': ['test/integration/code-graph.project-closure.test.ts'],
  'incremental-property': [
    'test/integration/code-graph.barrel-incremental.property.test.ts',
    'test/integration/code-graph.incremental.property.test.ts',
    'test/unit/code-graph.analysis-summary.property.test.ts',
    'test/unit/code-graph.resolution-summary.property.test.ts',
    'test/unit/code-graph.store-query.property.test.ts',
  ],
  'load-evidence': [
    'test/integration/code-graph.removed-view-cleanup-load.test.ts',
    'test/integration/code-graph.vector-retirement-load.test.ts',
    'test/integration/code-graph.cache-capacity-load.test.ts',
  ],
  'os-contention': [
    'test/integration/code-graph.repair-signal.test.ts',
    'test/integration/code-graph.read-bootstrap.test.ts',
    'test/integration/code-graph.view-attach-lock.test.ts',
    'test/integration/code-graph.vector-retirement-os.test.ts',
    'test/integration/code-graph.removed-view-cleanup-os.test.ts',
    'test/integration/code-graph.cache-capacity-os.test.ts',
    'test/integration/code-graph.disk-reservation.test.ts',
    'test/unit/code-graph.maintenance-residual-live.test.ts',
  ],
  'heavy-integration': [
    'test/integration/cli.effect.test.ts',
    'test/integration/mcp.native-tools.test.ts',
    'test/integration/code-graph.performance-evidence.test.ts',
    'test/integration/code-graph.snapshot-repair.property.test.ts',
    'test/integration/code-graph.cross-session-incremental.test.ts',
    'test/integration/code-graph.session.test.ts',
    'test/integration/code-graph.benchmark-preflight.test.ts',
    'test/unit/code-graph.tree-sitter-identity.property.test.ts',
    'test/unit/code-graph.languages.property.test.ts',
    'test/unit/code-graph.languages.test.ts',
  ],
  'heavy-state': [
    'test/unit/code-graph.workset-catalog-projection.test.ts',
    'test/unit/code-graph.removed-view-cleanup.property.test.ts',
    'test/unit/code-graph.view-removal.property.test.ts',
    'test/unit/code-graph.worktree-reconciliation.test.ts',
    'test/unit/code-graph.vector-retirement-schema.test.ts',
    'test/unit/code-graph.vector-retirement-ordinary.test.ts',
    'test/unit/code-graph.vector-maintenance.test.ts',
    'test/unit/code-graph.materialization-store.test.ts',
    'test/unit/evaluation.recall-v2.test.ts',
    'test/unit/code-graph.project-closure-store.test.ts',
    'test/unit/code-graph.snapshot-retention.test.ts',
    'test/integration/share.sync.test.ts',
    'test/unit/code-graph.cache-coalescer.test.ts',
  ],
};

const ordinaryCiTestCorpus = [
  ...new Set([
    'test/unit/utils.test.ts',
    'test/integration/remote-memory-postgres.test.ts',
    ...Object.values(fixedLongGroupModel).flat(),
  ]),
].sort((left, right) => left.localeCompare(right));
const dedicatedOnlyTestCorpus = ['test/unit/agent-instructions.test.ts', 'test/unit/website-content.test.ts'];
const nonOrdinaryCodeCorpus = [
  'test/unit/helper.ts',
  'config/agent-instructions.md',
  'src/runtime.ts',
  'unclassified/payload.bin',
  '',
];
const ciPlanCorpus = [...ordinaryCiTestCorpus, ...dedicatedOnlyTestCorpus, ...nonOrdinaryCodeCorpus];
const ordinaryCiTests = FC.array(FC.constantFrom(...ordinaryCiTestCorpus), {maxLength: 30, minLength: 1});

function expectedContainingGroups(paths: readonly string[]): readonly FixedLongGroupName[] {
  const changed = new Set(paths);
  return fixedLongGroupNames.filter(group => fixedLongGroupModel[group].some(path => changed.has(path)));
}

function enabledScopes(paths: readonly string[]): readonly CiScopeKey[] {
  const classification = classifyCiScopes(paths);
  return ciScopeKeys.filter(key => classification.scopes[key]);
}

describe('CI changed-path scope properties', () => {
  it('selects only changed ordinary tests and their long groups', () => {
    const plan = selectCiTestPlan([
      'test/unit/utils.test.ts',
      'test/integration/code-graph.cache-capacity-load.test.ts',
      'test/integration/remote-memory-postgres.test.ts',
      'test/unit/utils.test.ts',
    ]);

    expect(plan.standard).toEqual({
      mode: 'selected',
      paths: ['test/integration/remote-memory-postgres.test.ts', 'test/unit/utils.test.ts'],
    });
    expect(plan.long).toEqual({mode: 'selected', groups: ['load-evidence']});
    expect(plan.postgres).toEqual({mode: 'selected', paths: ['test/integration/remote-memory-postgres.test.ts']});
  });

  it('keeps lifecycle and scheduled load groups explicit in the test model', () => {
    expect(expectedContainingGroups(['test/integration/code-graph.lifecycle.test.ts'])).toEqual([
      'lifecycle-alpha',
      'lifecycle-beta',
      'lifecycle-gamma',
      'lifecycle-delta',
    ]);
    expect(expectedContainingGroups(['test/integration/code-graph.cache-capacity-load.test.ts'])).toEqual([
      'load-evidence',
    ]);
  });

  it('plans a classified invalid path as a full suite', () => {
    expect(
      selectCiTestPlanForClassification({
        changedCount: 1,
        invalidPath: true,
        paths: ['test/unit/utils.test.ts'],
        scopes: {
          actions: true,
          code: true,
          guidance: true,
          quality: true,
          release: true,
          site_build: true,
          site_check: true,
          windows: true,
        },
      }),
    ).toEqual({
      standard: {mode: 'full', paths: []},
      long: {mode: 'full', groups: fixedRequiredLongGroupNames},
      postgres: {mode: 'full', paths: []},
    });
  });

  it('keeps special test paths out of the ordinary plan', () => {
    expect(selectCiTestPlan(['test/unit/website-content.test.ts'])).toMatchObject({
      standard: {mode: 'none'},
      long: {mode: 'none'},
      postgres: {mode: 'none'},
    });
  });

  fcProp(
    it,
    'keeps the independent ordinary-test model deterministic and selects exact containing long groups',
    {
      paths: ordinaryCiTests,
    },
    ({paths}) => {
      const expectedPaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
      const expectedGroups = expectedContainingGroups(expectedPaths);
      const longPaths = new Set<string>(expectedGroups.flatMap(group => fixedLongGroupModel[group]));
      const plan = selectCiTestPlan(paths);

      expect(selectCiTestPlan([...paths, ...paths].reverse())).toEqual(plan);
      expect(plan.long.groups).toEqual(expectedGroups);
      expect(plan.standard.paths).toEqual(expectedPaths.filter(path => !longPaths.has(path)));
      expect(plan.postgres.paths).toEqual(
        expectedPaths.filter(path => /^test\/integration\/remote-memory-[A-Za-z0-9._-]+\.test\.ts$/u.test(path)),
      );
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'keeps every selected lane monotonic when ordinary tests are added',
    {paths: ordinaryCiTests, extra: FC.constantFrom(...ordinaryCiTestCorpus)},
    ({paths, extra}) => {
      const before = selectCiTestPlan(paths);
      const after = selectCiTestPlan([...paths, extra]);
      for (const path of before.standard.paths) expect(after.standard.paths).toContain(path);
      const selectedGroups = new Set<string>(after.long.groups);
      for (const path of before.long.groups) expect(selectedGroups.has(path)).toBe(true);
      for (const path of before.postgres.paths) expect(after.postgres.paths).toContain(path);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'falls back to full suites for every inventory that mixes an ordinary test with a non-ordinary path',
    {
      ordinary: FC.constantFrom(...ordinaryCiTestCorpus),
      nonOrdinary: FC.constantFrom(...dedicatedOnlyTestCorpus, ...nonOrdinaryCodeCorpus),
      rest: FC.array(FC.constantFrom(...ciPlanCorpus), {maxLength: 12}),
    },
    ({ordinary, nonOrdinary, rest}) => {
      const plan = selectCiTestPlan([ordinary, nonOrdinary, ...rest]);
      expect(plan).toEqual({
        standard: {mode: 'full', paths: []},
        long: {mode: 'full', groups: fixedRequiredLongGroupNames},
        postgres: {mode: 'full', paths: []},
      });
    },
    {fastCheck: {numRuns: 200}},
  );

  it('fails safe to full suites for mixed, invalid, and unknown changes', () => {
    for (const paths of [
      ['test/unit/utils.test.ts', 'src/utils.ts'],
      ['test/unit/utils.test.ts', 'test/unit/helper.ts'],
      ['test/unit/utils.test.ts', 'test/unit/agent-instructions.test.ts'],
      ['test/unit/utils.test.ts', 'test/unit/website-content.test.ts'],
      ['', 'test/unit/utils.test.ts'],
      [''],
      ['unclassified/payload.bin'],
    ]) {
      expect(selectCiTestPlan(paths)).toMatchObject({
        standard: {mode: 'full'},
        long: {mode: 'full', groups: fixedRequiredLongGroupNames},
        postgres: {mode: 'full'},
      });
    }
  });
  fcProp(
    it,
    'is invariant to path order and duplicates',
    {paths: FC.array(knownPath, {maxLength: 40, minLength: 1})},
    ({paths}) => {
      const expected = classifyCiScopes(paths);
      const reordered = classifyCiScopes([...paths].reverse());
      const duplicated = classifyCiScopes([...paths, ...paths]);

      expect(reordered).toEqual(expected);
      expect(duplicated).toEqual(expected);
    },
    {fastCheck: {numRuns: 300}},
  );

  fcProp(
    it,
    'isolates pure guidance changes from runtime, release, Windows, and quality work',
    {paths: FC.array(guidancePath, {maxLength: 30, minLength: 1})},
    ({paths}) => {
      expect(enabledScopes(paths)).toEqual(['guidance']);
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'keeps coverage monotonic when a runtime or cross-cutting path is added',
    {paths: FC.array(knownPath, {maxLength: 30, minLength: 1}), extra: knownPath},
    ({paths, extra}) => {
      const before = classifyCiScopes(paths).scopes;
      const after = classifyCiScopes([...paths, extra]).scopes;

      for (const key of ciScopeKeys) {
        if (before[key]) expect(after[key]).toBe(true);
      }
    },
    {fastCheck: {numRuns: 300}},
  );

  fcProp(
    it,
    'escalates guidance-only changes when a runtime path is added',
    {guidance: FC.array(guidancePath, {maxLength: 30, minLength: 1}), runtime: runtimePath},
    ({guidance, runtime}) => {
      const before = classifyCiScopes(guidance).scopes;
      const after = classifyCiScopes([...guidance, runtime]).scopes;

      expect(before.guidance).toBe(true);
      expect(after).toMatchObject({code: true, guidance: true, release: true, windows: true});
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'isolates pure website changes from runtime, release, Windows, and quality work',
    {paths: FC.array(websitePath, {maxLength: 30, minLength: 1})},
    ({paths}) => {
      expect(enabledScopes(paths)).toEqual(['site_check', 'site_build']);
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'keeps pure documentation changes on the formatting-only lane',
    {paths: FC.array(documentationPath, {maxLength: 30, minLength: 1})},
    ({paths}) => {
      expect(enabledScopes(paths)).toEqual([]);
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'fails safe for paths outside the classified repository surface',
    {segment: pathSegment},
    ({segment}) => {
      expect(enabledScopes([`unclassified-${segment}/payload.bin`])).toEqual(ciScopeKeys);
    },
    {fastCheck: {numRuns: 200}},
  );

  it('fails safe for empty, invalid, and parent-traversing path inventories', () => {
    for (const paths of [[], [''], ['../website/index.html'], ['/website/index.html']]) {
      expect(enabledScopes(paths)).toEqual(ciScopeKeys);
    }
  });

  it('maps representative repository paths to the expected expensive scopes', () => {
    expect(enabledScopes(['config/agent-skills/threadnote-context/SKILL.md'])).toEqual(['guidance']);
    expect(enabledScopes(['test/unit/agent-instructions.test.ts'])).toEqual(['guidance']);
    expect(enabledScopes(['test/unit/cursor-plugin.test.ts'])).toEqual(['code']);
    expect(
      enabledScopes(['config/agent-skills/threadnote-context/SKILL.md', 'test/unit/agent-instructions.test.ts']),
    ).toEqual(['guidance']);
    expect(enabledScopes(['test/unit/utils.test.ts'])).toEqual(['code']);
    expect(enabledScopes(['test/unit/command-shim.test.ts'])).toEqual(['code', 'release', 'windows']);
    expect(enabledScopes(['src/installations.ts'])).toEqual(['code', 'release', 'windows']);
    expect(enabledScopes(['src/recall/index.ts'])).toEqual(['code', 'quality', 'release', 'windows']);
    expect(enabledScopes(['src/context_brief/citation_validation.ts'])).toEqual([
      'code',
      'quality',
      'release',
      'windows',
    ]);
    expect(enabledScopes(['src/memory/code_citation_capture.ts'])).toEqual(['code', 'quality', 'release', 'windows']);
    expect(enabledScopes(['.github/workflows/pages.yml'])).toEqual(['actions', 'site_check', 'site_build']);
    expect(enabledScopes(['test/unit/website-content.test.ts'])).toEqual(['site_check', 'site_build']);
    expect(enabledScopes(['test/unit/website-site-meta.test.ts'])).toEqual(['site_check', 'site_build']);
    expect(enabledScopes(['README.md'])).toEqual(['site_check']);
    expect(enabledScopes(['test/ci/ci-scopes.ts'])).toEqual(ciScopeKeys);
    expect(enabledScopes(['scripts/benchmark-worktree-readiness.ts'])).toEqual(['code', 'quality']);
    expect(enabledScopes(['scripts/evaluate-context-brief-citations-runtime.ts'])).toEqual(['code', 'quality']);
    expect(enabledScopes(['scripts/lint-file-length.ts'])).toEqual(['code', 'site_check']);
    expect(enabledScopes(['.oxlintrc.max-lines.json'])).toEqual(['code', 'site_check']);
    expect(enabledScopes(['.oxlintrc.strict.json'])).toEqual(['code', 'site_check']);
    expect(enabledScopes(['scripts/release-targets.ts'])).toEqual(['code', 'release', 'windows']);
    expect(enabledScopes(['scripts/effect/script.ts'])).toEqual(['code', 'quality', 'release', 'windows']);
  });
});
