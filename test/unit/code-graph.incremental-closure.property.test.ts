import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  assessProjectClosureSeeds,
  assessProjectFileSetClosureSeeds,
  declaredProjectResolutionClosureProjectIds,
  planProjectIncrementalClosure,
} from '../../src/code_graph/incremental_closure.js';
import {resolvePersistedReexportTerminals} from '../../src/code_graph/indexer.js';
import type {CodeGraphWorkspace, CodeGraphWorkspaceProject} from '../../src/code_graph/languages/types.js';
import type {CodeGraphReusableReexport} from '../../src/code_graph/store.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '../../src/code_graph/types.js';
import {mergeCodeGraphWorkspaces} from '../../src/code_graph/workspace.js';

describe('project incremental closure', () => {
  it('finds the exact reverse-transitive declared project closure and deterministically selects its files', () => {
    const projects = [project('app', ['barrel']), project('barrel', ['core']), project('core'), project('unrelated')];
    const files = projects.flatMap(value => [inventory(`${value.root}/index.ts`, 32)]);
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: new Map(files.map(file => [file.path, 64])),
      files: [...files].reverse(),
      modifiedPaths: ['packages/barrel/index.ts'],
      projects: [...projects].reverse(),
      seedProjectIds: ['barrel'],
      workspaceDiagnostics: [],
    });

    expect(plan).toEqual({
      affectedPaths: ['packages/app/index.ts', 'packages/barrel/index.ts'],
      cachedFactBytes: 128,
      mode: 'eligible',
      planningOperations: {dependencyEdges: 2, pathOwnershipChecks: 4},
      projectIds: ['app', 'barrel'],
      sourceBytes: 64,
    });
    expect(declaredProjectResolutionClosureProjectIds([...projects].reverse(), ['barrel'])).toEqual(['app', 'barrel']);
  });

  it('accepts distinct declared evidence for one structural dependency after workspace composition', () => {
    const canonicalProjects = [project('app', ['core']), project('core'), project('unrelated')];
    const appWithBuildEvidence = {
      ...project('app', ['core']),
      dependencyDetails: [
        {
          evidence: 'packages/app/tsconfig.json',
          provenance: 'declared' as const,
          targetId: 'core',
        },
      ],
    };
    const merged = mergeCodeGraphWorkspaces([workspace(canonicalProjects), workspace([appWithBuildEvidence])]);
    const files = canonicalProjects.map(value => inventory(`${value.root}/index.ts`, 1));
    const common = {
      cachedFactBytesByPath: new Map(files.map(file => [file.path, 1])),
      files,
      modifiedPaths: ['packages/core/index.ts'],
      seedProjectIds: ['core'],
      workspaceDiagnostics: [] as readonly string[],
    };

    expect(merged.projects.find(value => value.id === 'app')?.dependencyDetails).toEqual([
      {evidence: 'packages/app/package.json', provenance: 'declared', targetId: 'core'},
      {evidence: 'packages/app/tsconfig.json', provenance: 'declared', targetId: 'core'},
    ]);
    const canonical = planProjectIncrementalClosure({...common, projects: canonicalProjects});
    expect(canonical).toMatchObject({mode: 'eligible', projectIds: ['app', 'core']});
    expect(planProjectIncrementalClosure({...common, projects: merged.projects})).toEqual(canonical);
  });

  it('retains otherwise-compatible modified files outside the seeded closure without leaking their unchanged peers', () => {
    const projects = [project('app', ['barrel']), project('barrel'), project('other'), project('idle')];
    const files = projects.map(value => inventory(`${value.root}/index.ts`, 1));
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: new Map(files.map(file => [file.path, 1])),
      files,
      modifiedPaths: ['packages/barrel/index.ts', 'packages/other/index.ts'],
      projects,
      seedProjectIds: ['barrel'],
      workspaceDiagnostics: [],
    });

    expect(plan).toMatchObject({
      affectedPaths: ['packages/app/index.ts', 'packages/barrel/index.ts', 'packages/other/index.ts'],
      mode: 'eligible',
      projectIds: ['app', 'barrel'],
    });
  });

  it('allows only project-scoped arity and lookup changes and seeds static reexports', () => {
    const projects = [project('app', ['barrel']), project('barrel')];
    const left = facts('packages/barrel/index.ts', [symbol('barrel', 1, ['typescript:barrel:path:a:name:foo'])], true);
    const right = facts('packages/barrel/index.ts', [symbol('barrel', 2, ['typescript:barrel:path:b:name:foo'])], true);

    expect(assessProjectClosureSeeds({committedFacts: [left], effectiveFacts: [right], projects})).toEqual({
      mode: 'eligible',
      planningOperations: {ownershipChecks: 3, pathIndexProjects: 2},
      seedProjectIds: ['barrel'],
    });

    expect(
      assessProjectClosureSeeds({
        committedFacts: [left],
        effectiveFacts: [
          facts(
            'packages/barrel/index.ts',
            [symbol('barrel', 2, ['global:name:other', 'typescript:barrel:path:b:name:foo'])],
            true,
          ),
        ],
        projects,
      }),
    ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
  });

  it.prop(
    'admits only effective-only exports whose lookup keys belong to one declared project',
    {
      reverseKeys: FC.boolean(),
      suffix: FC.integer({max: 100_000, min: 0}),
    },
    ({reverseKeys, suffix}) => {
      const scopeId = `p${suffix}`;
      const name = `added${suffix}`;
      const path = `packages/${scopeId}/index.ts`;
      const encodedPath = encodeURIComponent(path);
      const ownedKeys = [
        `typescript:${scopeId}:path:${encodedPath}:name:${name}`,
        `typescript:${scopeId}:path:${encodedPath}:qualified:${name}`,
        `typescript:${scopeId}:path:${encodedPath}:name:${name}:arity:0`,
        `typescript:${scopeId}:path:${encodedPath}:name:${name}:implementation`,
      ];
      const keys = reverseKeys ? [...ownedKeys].reverse() : ownedKeys;
      const added: CodeGraphSymbol = {
        ...symbol(scopeId, 0, keys),
        id: `symbol-${suffix}`,
        name,
        path,
        qualifiedName: name,
      };
      const projects = [project(scopeId)];
      const committed = facts(path, [], false);
      const effective = facts(path, [added], false);

      expect(assessProjectClosureSeeds({committedFacts: [committed], effectiveFacts: [effective], projects})).toEqual({
        mode: 'eligible',
        planningOperations: {ownershipChecks: 1, pathIndexProjects: 1},
        seedProjectIds: [scopeId],
      });
      expect(assessProjectClosureSeeds({committedFacts: [effective], effectiveFacts: [committed], projects})).toEqual({
        mode: 'fallback',
        reason: 'resolution-surface-changed',
      });
      expect(
        assessProjectClosureSeeds({
          committedFacts: [effective],
          effectiveFacts: [
            facts(
              path,
              [
                {
                  ...added,
                  id: `renamed-symbol-${suffix}`,
                  lookupKeys: keys.map(key => key.replaceAll(name, `renamed${suffix}`)),
                  name: `renamed${suffix}`,
                  qualifiedName: `renamed${suffix}`,
                },
              ],
              false,
            ),
          ],
          projects,
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
      expect(
        assessProjectClosureSeeds({
          committedFacts: [facts(path, [{...added, exported: false}], false)],
          effectiveFacts: [effective],
          projects,
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
      expect(
        assessProjectClosureSeeds({
          committedFacts: [committed],
          effectiveFacts: [facts(path, [{...added, lookupKeys: [...keys, `global:name:${name}`]}], false)],
          projects,
        }),
      ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'selects file-set closure seeds deterministically from added, modified, and deleted project paths',
    {
      currentMask: FC.integer({max: 65_535, min: 0}),
      deletedMask: FC.integer({max: 65_535, min: 0}),
      projectCount: FC.integer({max: 16, min: 1}),
      reverse: FC.boolean(),
    },
    ({currentMask, deletedMask, projectCount, reverse}) => {
      const boundedMask = (1 << projectCount) - 1;
      const maskedCurrent = currentMask & boundedMask;
      const effectiveDeletedMask = deletedMask & boundedMask;
      const effectiveCurrentMask = (maskedCurrent | effectiveDeletedMask) === 0 ? 1 : maskedCurrent;
      const projects = Array.from({length: projectCount}, (_, index) => project(`p${index}`));
      const paths = (mask: number) =>
        projects.filter((_, index) => (mask & (1 << index)) !== 0).map(value => `${value.root}/index.ts`);
      const expected = projects
        .filter((_, index) => ((effectiveCurrentMask | effectiveDeletedMask) & (1 << index)) !== 0)
        .map(value => value.id)
        .sort();
      const input = {
        baseProjects: reverse ? [...projects].reverse() : projects,
        currentChangedPaths: reverse ? paths(effectiveCurrentMask).reverse() : paths(effectiveCurrentMask),
        currentProjects: reverse ? [...projects].reverse() : projects,
        deletedPaths: reverse ? paths(effectiveDeletedMask).reverse() : paths(effectiveDeletedMask),
      };
      const first = assessProjectFileSetClosureSeeds(input);
      const second = assessProjectFileSetClosureSeeds(input);

      expect(first).toEqual(second);
      expect(first).toMatchObject({mode: 'eligible', seedProjectIds: expected});
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'ignores ambiguous ownership in resolution domains outside the changed file and seeded closure',
    {
      reverse: FC.boolean(),
      unrelatedProjectCount: FC.integer({max: 8, min: 2}),
    },
    ({reverse, unrelatedProjectCount}) => {
      const runtime = project('runtime');
      const path = `${runtime.root}/added.ts`;
      const unrelated = Array.from({length: unrelatedProjectCount}, (_, index) => ({
        ...project(`config-${index}`),
        dependencies: [`missing-${index}`],
        dependencyDetails: [],
        resolutionDomain: 'typescript-config',
        root: '',
        sourceRoots: [runtime.root],
      }));
      const projects = [runtime, ...(reverse ? unrelated.reverse() : unrelated)];
      const currentResolutionDomainByPath = new Map([[path, 'typescript']]);
      const canonicalSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: [runtime],
        currentChangedPaths: [path],
        currentProjects: [runtime],
        currentResolutionDomainByPath,
        deletedPaths: [],
      });
      const mixedSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: projects,
        currentChangedPaths: [path],
        currentProjects: projects,
        currentResolutionDomainByPath,
        deletedPaths: [],
      });
      const file = inventory(path, 1);
      const common = {
        cachedFactBytesByPath: new Map([[path, 1]]),
        files: [file],
        modifiedPaths: [path],
        seedProjectIds: [runtime.id],
        workspaceDiagnostics: [] as readonly string[],
      };

      expect(canonicalSeeds).toMatchObject({mode: 'eligible', seedProjectIds: [runtime.id]});
      expect(mixedSeeds).toMatchObject({
        mode: 'eligible',
        planningOperations: {ownershipChecks: 1},
        seedProjectIds: [runtime.id],
      });
      expect(planProjectIncrementalClosure({...common, projects})).toEqual(
        planProjectIncrementalClosure({...common, projects: [runtime]}),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('fails closed when a file-set change lacks stable declared ownership in both workspace models', () => {
    const declared = project('a');
    const input = {
      baseProjects: [declared],
      currentChangedPaths: ['packages/a/added.ts'],
      currentProjects: [declared],
      deletedPaths: [] as readonly string[],
    };

    expect(assessProjectFileSetClosureSeeds({...input, currentChangedPaths: ['unowned.ts']})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      assessProjectFileSetClosureSeeds({
        ...input,
        currentProjects: [{...declared, provenance: 'inferred'}],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-incomplete'});
    expect(assessProjectFileSetClosureSeeds({...input, currentProjects: []})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(assessProjectFileSetClosureSeeds({...input, baseProjects: []})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(assessProjectFileSetClosureSeeds({...input, currentProjects: [declared, declared]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
  });

  it('fails closed for inferred, ambiguous, diagnostic, incomplete, missing-cache, and oversized closure evidence', () => {
    const base = project('a');
    const file = inventory('packages/a/index.ts', 1);
    const common = {
      cachedFactBytesByPath: new Map([[file.path, 1]]),
      files: [file],
      modifiedPaths: [file.path],
      seedProjectIds: ['a'],
      workspaceDiagnostics: [] as readonly string[],
    };

    expect(planProjectIncrementalClosure({...common, projects: [{...base, provenance: 'inferred'}]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(planProjectIncrementalClosure({...common, projects: [base], workspaceDiagnostics: ['ambiguous']})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        projects: [{...base, dependencies: ['missing'], dependencyDetails: []}],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-incomplete'});
    expect(planProjectIncrementalClosure({...common, cachedFactBytesByPath: new Map(), projects: [base]})).toEqual({
      mode: 'fallback',
      reason: 'cache-incomplete',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        cachedFactBytesByPath: new Map([[file.path, 8 * 1_048_576 + 1]]),
        projects: [base],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-unbounded'});
    expect(
      planProjectIncrementalClosure({
        ...common,
        files: [inventory(file.path, 16 * 1_048_576 + 1)],
        projects: [base],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-unbounded'});
    expect(
      planProjectIncrementalClosure({
        ...common,
        cachedFactBytesByPath: new Map(
          Array.from({length: 129}, (_, index) => [`packages/a/file-${index}.ts`, 1] as const),
        ),
        files: Array.from({length: 129}, (_, index) => inventory(`packages/a/file-${index}.ts`, 1)),
        modifiedPaths: ['packages/a/file-0.ts'],
        projects: [base],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-unbounded'});
    expect(planProjectIncrementalClosure({...common, projects: [{...base, diagnostics: ['unreconciled']}]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      planProjectIncrementalClosure({
        ...common,
        projects: [base, {...project('b'), root: base.root, sourceRoots: base.sourceRoots}],
      }),
    ).toEqual({mode: 'fallback', reason: 'project-closure-incomplete'});

    const left = facts(
      file.path,
      [{...symbol('a', 1, ['typescript:a:path:a:name:foo']), resolutionScopeId: undefined}],
      true,
    );
    const right = facts(
      file.path,
      [{...symbol('a', 2, ['typescript:a:path:b:name:foo']), resolutionScopeId: undefined}],
      true,
    );
    expect(assessProjectClosureSeeds({committedFacts: [left], effectiveFacts: [right], projects: [base]})).toEqual({
      mode: 'fallback',
      reason: 'project-closure-incomplete',
    });
    expect(
      assessProjectClosureSeeds({
        committedFacts: [left],
        effectiveFacts: [right, facts('packages/a/extra.ts', [], false)],
        projects: [base],
      }),
    ).toEqual({mode: 'fallback', reason: 'resolution-surface-changed'});
    const dynamic = {
      ...left,
      references: left.references?.map(reference => ({...reference, relation: 'calls' as const})),
    };
    expect(assessProjectClosureSeeds({committedFacts: [dynamic], effectiveFacts: [dynamic], projects: [base]})).toEqual(
      {
        mode: 'fallback',
        reason: 'dynamic-aliases',
      },
    );
  });

  it('still fails closed for malformed structural dependency evidence', () => {
    const target = project('b');
    const declared = {evidence: 'packages/a/package.json', provenance: 'declared' as const, targetId: 'b'};
    const malformedProjects = [
      [{...project('a', ['b']), dependencyDetails: []}, target],
      [{...project('a'), dependencyDetails: [declared]}, target],
      [{...project('a', ['b']), dependencyDetails: [{...declared, provenance: 'inferred' as const}]}, target],
      [project('a', ['missing']), target],
      [{...project('a', ['b']), dependencies: ['b', 'b']}, target],
    ];
    const files = [inventory('packages/a/index.ts', 1), inventory('packages/b/index.ts', 1)];
    const common = {
      cachedFactBytesByPath: new Map(files.map(file => [file.path, 1])),
      files,
      modifiedPaths: ['packages/a/index.ts'],
      seedProjectIds: ['a'],
      workspaceDiagnostics: [] as readonly string[],
    };

    for (const projects of malformedProjects) {
      expect(planProjectIncrementalClosure({...common, projects})).toEqual({
        mode: 'fallback',
        reason: 'project-closure-incomplete',
      });
    }
  });

  it.prop(
    'keeps file-set seeds and closure unchanged when declared evidence is added or reordered for existing targets',
    {
      evidenceCopies: FC.integer({max: 5, min: 1}),
      projectCount: FC.integer({max: 8, min: 2}),
      reverseEvidence: FC.boolean(),
      seed: FC.integer({max: 100_000, min: 0}),
    },
    ({evidenceCopies, projectCount, reverseEvidence, seed}) => {
      const projects = Array.from({length: projectCount}, (_, index) =>
        project(`p${index}`, index === 0 ? [] : [`p${index - 1}`]),
      );
      const enrichedProjects = projects.map(value => ({
        ...value,
        dependencyDetails: value.dependencyDetails.flatMap(dependency => {
          const evidence = [
            dependency,
            ...Array.from({length: evidenceCopies}, (_, index) => ({
              ...dependency,
              evidence: `packages/${value.id}/dependency-evidence-${index}.json`,
            })),
          ];
          return reverseEvidence ? evidence.reverse() : evidence;
        }),
      }));
      const seedProject = projects[seed % projectCount]!;
      const changedPath = `${seedProject.root}/index.ts`;
      const files = projects.map(value => inventory(`${value.root}/index.ts`, 1));
      const canonicalSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: projects,
        currentChangedPaths: [changedPath],
        currentProjects: projects,
        deletedPaths: [],
      });
      const enrichedSeeds = assessProjectFileSetClosureSeeds({
        baseProjects: projects,
        currentChangedPaths: [changedPath],
        currentProjects: enrichedProjects,
        deletedPaths: [],
      });
      const common = {
        cachedFactBytesByPath: new Map(files.map(file => [file.path, 1])),
        files,
        modifiedPaths: [changedPath],
        seedProjectIds: [seedProject.id],
        workspaceDiagnostics: [] as readonly string[],
      };
      const canonicalPlan = planProjectIncrementalClosure({...common, projects});

      expect(canonicalSeeds.mode).toBe('eligible');
      expect(enrichedSeeds).toEqual(canonicalSeeds);
      expect(canonicalPlan.mode).toBe('eligible');
      expect(planProjectIncrementalClosure({...common, projects: enrichedProjects})).toEqual(canonicalPlan);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'is deterministic, order-independent, idempotent, seed-containing, monotone, and equal to an independent reverse model',
    {
      adjacency: FC.array(FC.integer({max: 63, min: 0}), {maxLength: 6, minLength: 1}),
      dependencyPriorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      filePriorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      priorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      seedPriorities: FC.array(FC.integer(), {maxLength: 6, minLength: 6}),
      seedMask: FC.integer({max: 63, min: 1}),
    },
    ({adjacency, dependencyPriorities, filePriorities, priorities, seedMask, seedPriorities}) => {
      const count = adjacency.length;
      const ids = Array.from({length: count}, (_, index) => `p${index}`);
      const projects = ids.map((id, source) =>
        project(
          id,
          ids.filter((_, target) => target !== source && (adjacency[source]! & (1 << target)) !== 0),
        ),
      );
      const seeds = ids.filter((_, index) => (seedMask & (1 << index)) !== 0);
      const firstSeed = seeds[0] ?? ids[0]!;
      const expected = independentReverseClosure(projects, seeds.length > 0 ? seeds : [firstSeed]);
      const files = ids.map(id => inventory(`packages/${id}/index.ts`, 1));
      const bytes = new Map(files.map(file => [file.path, 1]));
      const shuffled = projects
        .map((value, index) => ({
          index,
          priority: priorities[index] ?? 0,
          value: {
            ...value,
            dependencies:
              (dependencyPriorities[index] ?? 0) < 0 ? [...value.dependencies].reverse() : value.dependencies,
            dependencyDetails:
              (dependencyPriorities[index] ?? 0) >= 0
                ? [...value.dependencyDetails].reverse()
                : value.dependencyDetails,
          },
        }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map(entry => entry.value);
      const shuffledFiles = files
        .map((value, index) => ({index, priority: filePriorities[index] ?? 0, value}))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map(entry => entry.value);
      const shuffledSeeds = (seeds.length > 0 ? seeds : [firstSeed])
        .map(value => ({priority: seedPriorities[ids.indexOf(value)] ?? 0, value}))
        .sort((left, right) => left.priority - right.priority || left.value.localeCompare(right.value))
        .map(entry => entry.value);
      const canonical = planProjectIncrementalClosure({
        cachedFactBytesByPath: bytes,
        files,
        modifiedPaths: [`packages/${firstSeed}/index.ts`],
        projects,
        seedProjectIds: seeds.length > 0 ? seeds : [firstSeed],
        workspaceDiagnostics: [],
      });
      const input = {
        cachedFactBytesByPath: bytes,
        files: shuffledFiles,
        modifiedPaths: [`packages/${firstSeed}/index.ts`],
        projects: shuffled,
        seedProjectIds: shuffledSeeds,
        workspaceDiagnostics: [] as readonly string[],
      };
      const once = planProjectIncrementalClosure(input);
      const twice = planProjectIncrementalClosure(input);

      expect(once).toEqual(twice);
      expect(once).toEqual(canonical);
      expect(once.mode).toBe('eligible');
      if (once.mode !== 'eligible') return;
      expect(planProjectIncrementalClosure({...input, seedProjectIds: once.projectIds})).toEqual(once);
      expect(once.projectIds).toEqual([...expected].sort());
      expect(seeds.every(seed => once.projectIds.includes(seed))).toBe(true);

      const expanded = planProjectIncrementalClosure({...input, seedProjectIds: ids});
      expect(expanded.mode).toBe('eligible');
      if (expanded.mode === 'eligible') {
        expect(once.projectIds.every(id => expanded.projectIds.includes(id))).toBe(true);
      }
      const missingEdge = projects
        .flatMap(source => ids.map(targetId => ({source, targetId})))
        .find(({source, targetId}) => source.id !== targetId && !source.dependencies.includes(targetId));
      if (missingEdge) {
        const edgeExpanded = planProjectIncrementalClosure({
          ...input,
          projects: projects.map(value =>
            value.id === missingEdge.source.id
              ? {
                  ...value,
                  dependencies: [...value.dependencies, missingEdge.targetId],
                  dependencyDetails: [
                    ...value.dependencyDetails,
                    {
                      evidence: `packages/${value.id}/package.json`,
                      provenance: 'declared' as const,
                      targetId: missingEdge.targetId,
                    },
                  ],
                }
              : value,
          ),
        });
        expect(edgeExpanded.mode).toBe('eligible');
        if (edgeExpanded.mode === 'eligible') {
          expect(once.projectIds.every(id => edgeExpanded.projectIds.includes(id))).toBe(true);
        }
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  it('plans 5,000 projects and 60,000 paths within the broad scaling ceiling', () => {
    const projectCount = 5_000;
    const projects = Array.from({length: projectCount}, (_, index) =>
      project(`p${index}`, index === 0 ? [] : [`p${index - 1}`]),
    );
    const files = Array.from({length: 60_000}, (_, index) =>
      inventory(`packages/p${index % projectCount}/file-${index}.ts`, 1),
    );
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: new Map(files.map(file => [file.path, 1])),
      files,
      maxCachedFactBytes: 100_000,
      maxFiles: 100_000,
      maxSourceBytes: 100_000,
      modifiedPaths: ['packages/p4999/file-4999.ts'],
      projects,
      seedProjectIds: ['p4999'],
      workspaceDiagnostics: [],
    });

    expect(plan.mode).toBe('eligible');
    if (plan.mode === 'eligible') {
      expect(plan.planningOperations).toEqual({dependencyEdges: 4_999, pathOwnershipChecks: 60_000});
    }
  });

  it('indexes seed ownership once across 5,000 projects and dense bounded facts', () => {
    const projects = Array.from({length: 5_000}, (_, index) => project(`p${index}`));
    const path = 'packages/p4999/index.ts';
    const template = {
      ...facts(path, [], true).references![0]!,
      aliasLookupKeys: ['typescript:p4999:path:packages%2Fp4999%2Findex.ts:name:foo'],
    };
    const denseFacts: CodeGraphFileFacts = {
      diagnostics: [],
      edges: [],
      path,
      references: Array.from({length: 2_048}, (_, index) => ({...template, edgeId: `edge-${index}`})),
      symbols: [],
    };
    const assessment = assessProjectClosureSeeds({
      committedFacts: [denseFacts],
      effectiveFacts: [denseFacts],
      projects,
    });

    expect(assessment).toEqual({
      mode: 'eligible',
      planningOperations: {ownershipChecks: 4_096, pathIndexProjects: 5_000},
      seedProjectIds: ['p4999'],
    });
  });

  it('resolves a 10,000-hop persisted reexport chain iteratively within a structural operation cap', () => {
    const reexports = Array.from({length: 10_000}, (_, index) => reexport(`p${index}`, 'foo', `p${index + 1}`, 'foo'));
    const result = resolvePersistedReexportTerminals({name: 'foo', path: 'p0'}, provenance(reexports), {
      maxOperations: 20_001,
    });

    expect(result).toEqual({
      mode: 'complete',
      operations: 20_001,
      targets: [{name: 'foo', path: 'p10000'}],
    });
  });

  it('deduplicates reconvergent reexport diamonds and preserves cycle-only seeds independent of row order', () => {
    const diamond = [
      reexport('a', 'foo', 'b', 'foo'),
      reexport('a', 'foo', 'c', 'foo'),
      reexport('b', 'foo', 'd', 'foo'),
      reexport('c', 'foo', 'd', 'foo'),
      reexport('d', 'foo', 'sink', 'value'),
    ];
    const cycle = [reexport('x', 'foo', 'y', 'foo'), reexport('y', 'foo', 'x', 'foo')];

    const forward = resolvePersistedReexportTerminals({name: 'foo', path: 'a'}, provenance(diamond));
    const reverse = resolvePersistedReexportTerminals({name: 'foo', path: 'a'}, provenance([...diamond].reverse()));
    expect(reverse).toEqual(forward);
    expect(forward).toMatchObject({mode: 'complete', targets: [{name: 'value', path: 'sink'}]});
    expect(resolvePersistedReexportTerminals({name: 'foo', path: 'x'}, provenance(cycle))).toMatchObject({
      mode: 'complete',
      targets: [{name: 'foo', path: 'x'}],
    });
    expect(
      resolvePersistedReexportTerminals({name: 'foo', path: 'a'}, provenance(diamond), {maxOperations: 3}),
    ).toEqual({mode: 'fallback', reason: 'reexport-closure-unbounded'});
  });
});

function project(id: string, dependencies: readonly string[] = []): CodeGraphWorkspaceProject {
  return {
    buildSystem: 'node',
    dependencies,
    dependencyDetails: dependencies.map(targetId => ({
      evidence: `packages/${id}/package.json`,
      provenance: 'declared',
      targetId,
    })),
    diagnostics: [],
    id,
    kind: 'package',
    languages: ['typescript'],
    name: id,
    provenance: 'declared',
    resolutionDomain: 'typescript',
    root: `packages/${id}`,
    sourceRoots: [`packages/${id}`],
    workspaceId: 'workspace',
    workspaceRoots: [''],
  };
}

function workspace(projects: readonly CodeGraphWorkspaceProject[]): CodeGraphWorkspace {
  return {diagnostics: [], fingerprint: 'test-workspace', projects, workspaces: []};
}

function inventory(path: string, size: number): CodeGraphInventoryFile {
  return {
    blobId: path,
    contentHash: path,
    language: 'typescript',
    mode: '100644',
    path,
    size,
    source: 'worktree',
  };
}

function symbol(scopeId: string, arity: number, lookupKeys: readonly string[]): CodeGraphSymbol {
  return {
    arity,
    contentHash: 'hash',
    exported: true,
    id: 'symbol',
    kind: 'function',
    language: 'typescript',
    lookupKeys,
    name: 'foo',
    packageName: scopeId,
    path: `packages/${scopeId}/index.ts`,
    qualifiedName: 'foo',
    resolutionDomain: 'typescript',
    resolutionScopeId: scopeId,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function facts(path: string, symbols: readonly CodeGraphSymbol[], reexport: boolean): CodeGraphFileFacts {
  return {
    diagnostics: [],
    edges: [],
    path,
    references: reexport
      ? [
          {
            aliasLookupKeys: ['typescript:barrel:path:packages%2Fbarrel%2Findex.ts:name:foo'],
            edgeId: 'edge',
            evidencePath: path,
            evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
            lookupTiers: [['typescript:barrel:path:packages%2Fcore%2Findex.ts:name:foo']],
            provenance: 'syntactic',
            relation: 'reexports',
            resolutionDomain: 'typescript',
            sourceName: 'barrel',
            targetName: './core.js',
          },
        ]
      : [],
    symbols,
  };
}

function independentReverseClosure(
  projects: readonly CodeGraphWorkspaceProject[],
  seeds: readonly string[],
): ReadonlySet<string> {
  const closure = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const project of projects) {
      if (closure.has(project.id)) continue;
      if (project.dependencies.some(dependency => closure.has(dependency))) {
        closure.add(project.id);
        changed = true;
      }
    }
  }
  return closure;
}

function reexport(
  sourcePath: string,
  localName: string,
  targetPath: string,
  importedName: string,
): CodeGraphReusableReexport {
  return {importedName, localName, sourcePath, targetPath};
}

function provenance(
  reexports: readonly CodeGraphReusableReexport[],
): ReadonlyMap<string, readonly CodeGraphReusableReexport[]> {
  const output = new Map<string, CodeGraphReusableReexport[]>();
  for (const value of reexports) {
    const key = `${value.sourcePath}\0${value.localName}`;
    const entries = output.get(key) ?? [];
    entries.push(value);
    output.set(key, entries);
  }
  return output;
}
