import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM} from '../../src/code_graph/fact_budget.js';
import type {ProjectResolutionLookupKey} from '../../src/code_graph/incremental_closure.js';
import {
  assessResolutionCandidateReexportSafety,
  boundedReusableReexportsFromKeys,
  enrichPersistedTypeScriptReexports,
} from '../../src/code_graph/indexer_resolution_candidate_closure.js';
import type {CodeGraphReusableReexport} from '../../src/code_graph/store.js';
import {
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS,
  PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES,
  PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES,
  planProjectResolutionCandidateScan,
  resolutionCandidateLookupKeyClosure,
  scanProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateClosure,
  type ProjectResolutionCandidateFactPage,
  type ProjectResolutionCandidateScanPlan,
  type ProjectResolutionReexportKeys,
} from '../../src/code_graph/store_resolution_candidate_closure.js';
import {CODE_GRAPH_RESOLUTION_PASS_MAXIMUM} from '../../src/code_graph/store_resolution.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphReference} from '../../src/code_graph/types.js';

describe('resolution-candidate closure', () => {
  effectIt.prop(
    'partitions every file exactly once independent of inventory order',
    {
      ids: FC.uniqueArray(FC.integer({max: 10_000, min: 0}), {maxLength: 80}),
      pageMaximumFactBytes: FC.integer({max: 64, min: 1}),
      pageMaximumFiles: FC.integer({max: 16, min: 1}),
      reverse: FC.boolean(),
    },
    ({ids, pageMaximumFactBytes, pageMaximumFiles, reverse}) => {
      const files = ids.map(id => inventory(`src/file-${id}.ts`, 1));
      const bytesByPath = new Map(files.map(file => [file.path, factBytesForPath(file.path)]));
      const inputFiles = reverse ? [...files].reverse() : files;
      const plan = planProjectResolutionCandidateScan({
        bytesByPath,
        files: inputFiles,
        maximumFactBytes: Number.MAX_SAFE_INTEGER,
        maximumFiles: 80,
        pageMaximumFactBytes,
        pageMaximumFiles,
      });

      expect(plan.mode).toBe('eligible');
      if (plan.mode !== 'eligible') return;
      const flattened = plan.pages.flatMap(page => page.files.map(file => file.path));
      const expectedPaths = files.map(file => file.path).sort();
      expect(flattened).toEqual(expectedPaths);
      expect(new Set(flattened).size).toBe(flattened.length);
      expect(plan.files).toBe(files.length);
      expect(plan.factBytes).toBe([...bytesByPath.values()].reduce((total, bytes) => total + bytes, 0));
      for (const page of plan.pages) {
        expect(page.files.length).toBeLessThanOrEqual(pageMaximumFiles);
        expect(page.factBytes).toBe(page.files.reduce((total, file) => total + bytesByPath.get(file.path)!, 0));
        if (page.factBytes > pageMaximumFactBytes) {
          expect(page.files).toHaveLength(1);
          expect(bytesByPath.get(page.files[0]!.path)).toBeGreaterThan(pageMaximumFactBytes);
        }
      }

      const reordered = planProjectResolutionCandidateScan({
        bytesByPath,
        files: [...inputFiles].reverse(),
        maximumFactBytes: Number.MAX_SAFE_INTEGER,
        maximumFiles: 80,
        pageMaximumFactBytes,
        pageMaximumFiles,
      });
      expect(reordered).toEqual(plan);
    },
    {fastCheck: {numRuns: 150}},
  );

  effectIt.effect.prop(
    'returns the same complete closure for every bounded page partition',
    {
      ids: FC.uniqueArray(FC.integer({max: 1_000, min: 0}), {maxLength: 40, minLength: 1}),
      leftPageFiles: FC.integer({max: 12, min: 1}),
      rightPageFiles: FC.integer({max: 12, min: 1}),
    },
    ({ids, leftPageFiles, rightPageFiles}) =>
      Effect.gen(function* () {
        const files = ids.map(id => inventory(`src/file-${id}.ts`, 1));
        const factsByPath = new Map(
          ids.map(id => {
            const path = `src/file-${id}.ts`;
            const group = id % 4;
            return [
              path,
              id % 4 === 0
                ? facts(path, [reexportReference(path, `alias-${group}`, 'seed')])
                : facts(path, [reference(path, [[`alias-${group}`]])]),
            ] as const;
          }),
        );
        const leftPlan = eligiblePlan(files, leftPageFiles);
        const rightPlan = eligiblePlan([...files].reverse(), rightPageFiles);
        const left = yield* scan(leftPlan, factsByPath, [lookup('typescript', 'seed')], 40);
        const right = yield* scan(rightPlan, factsByPath, [lookup('typescript', 'seed')], 40);

        expect(canonicalClosure(left)).toEqual(canonicalClosure(right));
      }),
    {fastCheck: {numRuns: 80}},
  );

  effectIt.prop(
    'computes a deterministic reverse fixed point independent of edge permutation and is idempotent',
    {
      edgeCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 80}),
      nodeCount: FC.integer({max: 20, min: 1}),
      permutationCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 80}),
      seedCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 20, minLength: 1}),
    },
    ({edgeCodes, nodeCount, permutationCodes, seedCodes}) => {
      const reexports = edgeCodes.map((code, index) => {
        const alias = code % nodeCount;
        const candidate = Math.floor(code / nodeCount) % nodeCount;
        return reexportKeys(
          `barrel-${index}.ts`,
          lookup('typescript', `k${alias}`),
          lookup('typescript', `k${candidate}`),
        );
      });
      const seeds = seedCodes.map(code => lookup('typescript', `k${code % nodeCount}`));
      const expected = independentLookupClosure(seeds, reexports);
      const permuted = [...reexports]
        .map((value, index) => ({priority: permutationCodes[index] ?? 0, value}))
        .sort((left, right) => left.priority - right.priority)
        .map(entry => entry.value);

      const canonical = resolutionCandidateLookupKeyClosure(seeds, reexports, nodeCount + 1);
      const reordered = resolutionCandidateLookupKeyClosure([...seeds].reverse(), permuted, nodeCount + 1);
      expect(canonical.mode).toBe('eligible');
      expect(reordered.mode).toBe('eligible');
      if (canonical.mode !== 'eligible' || reordered.mode !== 'eligible') return;
      expect([...canonical.identities].sort()).toEqual([...expected].sort());
      expect([...reordered.identities].sort()).toEqual([...expected].sort());

      const fixedPointSeeds = [...canonical.identities].map(parseLookupIdentity);
      const repeated = resolutionCandidateLookupKeyClosure(fixedPointSeeds, permuted, nodeCount + 1);
      expect(repeated.mode).toBe('eligible');
      if (repeated.mode === 'eligible') {
        expect([...repeated.identities].sort()).toEqual([...canonical.identities].sort());
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  effectIt.prop(
    'matches an independent fixed-point model for multi-alias multi-candidate hyperedges',
    {
      hyperedges: FC.array(
        FC.record({
          aliasCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 8, minLength: 1}),
          candidateCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 8, minLength: 1}),
        }),
        {maxLength: 30},
      ),
      nodeCount: FC.integer({max: 20, min: 1}),
      seedCodes: FC.array(FC.integer({max: 10_000, min: 0}), {maxLength: 10, minLength: 1}),
    },
    ({hyperedges, nodeCount, seedCodes}) => {
      const reexports = hyperedges.map(({aliasCodes, candidateCodes}, index) => ({
        aliases: aliasCodes.map(code => lookup('typescript', `k${code % nodeCount}`)),
        candidates: candidateCodes.map(code => lookup('typescript', `k${code % nodeCount}`)),
        sourcePath: `barrel-${index}.ts`,
      }));
      const seeds = seedCodes.map(code => lookup('typescript', `k${code % nodeCount}`));
      const expected = independentLookupClosure(seeds, reexports);
      const actual = resolutionCandidateLookupKeyClosure(seeds, reexports, nodeCount);

      expect(actual.mode).toBe('eligible');
      if (actual.mode === 'eligible') {
        expect([...actual.identities].sort()).toEqual([...expected].sort());
      }
    },
    {fastCheck: {numRuns: 150}},
  );

  effectIt.prop(
    'bounds parsed provenance by the unique alias-target product independent of duplicate order',
    {
      aliasIds: FC.uniqueArray(FC.integer({max: 31, min: 0}), {maxLength: 8, minLength: 1}),
      candidateIds: FC.uniqueArray(FC.integer({max: 31, min: 0}), {maxLength: 8, minLength: 1}),
      duplicate: FC.boolean(),
      maximumRows: FC.integer({max: 64, min: 0}),
    },
    ({aliasIds, candidateIds, duplicate, maximumRows}) => {
      const copies = duplicate ? 2 : 1;
      const aliases = aliasIds.flatMap(id =>
        Array.from({length: copies}, () =>
          lookup('typescript', canonicalTypeScriptKey(`alias-${id}.ts`, `alias${id}`)),
        ),
      );
      const candidates = candidateIds.flatMap(id =>
        Array.from({length: copies}, () =>
          lookup('typescript', canonicalTypeScriptKey(`target-${id}.ts`, `target${id}`)),
        ),
      );
      const reexport = {aliases, candidates, sourcePath: 'barrel.ts'};
      const result = boundedReusableReexportsFromKeys([reexport], maximumRows);
      const reordered = boundedReusableReexportsFromKeys(
        [{aliases: [...aliases].reverse(), candidates: [...candidates].reverse(), sourcePath: 'barrel.ts'}],
        maximumRows,
      );
      const expectedRows = aliasIds.length * candidateIds.length;

      if (expectedRows > maximumRows) {
        expect(result).toBeUndefined();
        expect(reordered).toBeUndefined();
        return;
      }
      expect(result).toHaveLength(expectedRows);
      expect(reordered).toHaveLength(expectedRows);
      expect(canonicalReexports(result ?? [])).toEqual(canonicalReexports(reordered ?? []));
    },
    {fastCheck: {numRuns: 150}},
  );

  effectIt.effect('isolates identical lookup-key text by resolution domain through aliases and consumers', () =>
    Effect.gen(function* () {
      const files = [
        inventory('src/barrel.ts', 1),
        inventory('src/typescript-direct.ts', 1),
        inventory('src/typescript-alias.ts', 1),
        inventory('src/Jvm.java', 1),
      ];
      const factsByPath = new Map<string, CodeGraphFileFacts>([
        ['src/barrel.ts', facts('src/barrel.ts', [reexportReference('src/barrel.ts', 'alias', 'shared')])],
        [
          'src/typescript-direct.ts',
          facts('src/typescript-direct.ts', [reference('src/typescript-direct.ts', [['shared']])]),
        ],
        [
          'src/typescript-alias.ts',
          facts('src/typescript-alias.ts', [reference('src/typescript-alias.ts', [['alias']])]),
        ],
        ['src/Jvm.java', facts('src/Jvm.java', [reference('src/Jvm.java', [['shared', 'alias']], 'jvm')])],
      ]);

      const closure = yield* scan(eligiblePlan(files, 2), factsByPath, [lookup('typescript', 'shared')], 4);

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') {
        expect(closure.paths).toEqual(['src/barrel.ts', 'src/typescript-alias.ts', 'src/typescript-direct.ts']);
        expect([...closure.affectedAliasLookupIdentities]).toEqual(['typescript\0alias']);
        const jvmClosure = resolutionCandidateLookupKeyClosure([lookup('jvm', 'shared')], closure.reexports);
        expect(jvmClosure.mode).toBe('eligible');
        if (jvmClosure.mode === 'eligible') {
          expect([...jvmClosure.identities]).not.toContain('typescript\0alias');
        }
      }
    }),
  );

  effectIt.effect.prop(
    'selects a file exactly when any candidate tier contains an affected key',
    {
      seed: FC.integer({max: 16, min: 0}),
      tiers: FC.array(FC.uniqueArray(FC.integer({max: 16, min: 0}), {maxLength: 5}), {
        maxLength: 6,
      }),
    },
    ({seed, tiers}) =>
      Effect.gen(function* () {
        const path = 'src/consumer.ts';
        const lookupTiers = tiers.map(tier => tier.map(id => `k${id}`));
        const factsByPath = new Map([[path, facts(path, [reference(path, lookupTiers)])]]);
        const closure = yield* scan(
          eligiblePlan([inventory(path, 1)], 1),
          factsByPath,
          [lookup('typescript', `k${seed}`)],
          1,
        );
        const expected = tiers.some(tier => tier.includes(seed));

        expect(closure.mode).toBe('eligible');
        if (closure.mode === 'eligible') expect(closure.paths).toEqual(expected ? [path] : []);
      }),
    {fastCheck: {numRuns: 120}},
  );

  effectIt.effect('retains earlier-empty, same-tier ambiguity, and later-tier negative dependencies', () =>
    Effect.gen(function* () {
      const files = [
        inventory('src/earlier-empty.ts', 1),
        inventory('src/same-tier.ts', 1),
        inventory('src/later-tier.ts', 1),
      ];
      const factsByPath = new Map<string, CodeGraphFileFacts>([
        [
          'src/earlier-empty.ts',
          facts('src/earlier-empty.ts', [reference('src/earlier-empty.ts', [['seed'], ['fallback']])]),
        ],
        ['src/same-tier.ts', facts('src/same-tier.ts', [reference('src/same-tier.ts', [['other', 'seed']])])],
        ['src/later-tier.ts', facts('src/later-tier.ts', [reference('src/later-tier.ts', [['stable'], ['seed']])])],
      ]);

      const closure = yield* scan(eligiblePlan(files, 2), factsByPath, [lookup('typescript', 'seed')], 3);

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') {
        expect(closure.paths).toEqual(['src/earlier-empty.ts', 'src/later-tier.ts', 'src/same-tier.ts']);
      }
    }),
  );

  effectIt('reports exact planning, lookup, selection, and reexport cap boundaries', () => {
    const files = [inventory('a.ts', 1), inventory('b.ts', 1), inventory('c.ts', 1)];
    expect(
      planProjectResolutionCandidateScan({
        bytesByPath: new Map(files.map(file => [file.path, 1])),
        files,
        maximumFiles: 2,
      }),
    ).toEqual({
      detail: 'candidate-scan-files',
      limit: 2,
      mode: 'fallback',
      observed: 3,
      reason: 'project-closure-unbounded',
    });
    expect(
      planProjectResolutionCandidateScan({
        bytesByPath: new Map(files.map(file => [file.path, 1])),
        files,
        maximumFactBytes: 2,
      }),
    ).toEqual({
      detail: 'candidate-scan-fact-bytes',
      limit: 2,
      mode: 'fallback',
      observed: 3,
      reason: 'project-closure-unbounded',
    });
    expect(
      resolutionCandidateLookupKeyClosure(
        [lookup('typescript', 'one'), lookup('typescript', 'two'), lookup('typescript', 'three')],
        [],
        2,
      ),
    ).toEqual({
      detail: 'candidate-lookup-keys',
      limit: 2,
      mode: 'fallback',
      observed: 3,
      reason: 'project-closure-unbounded',
    });
  });

  effectIt('keeps a production-sized cached-fact surface within the default bounded scan', () => {
    const files = Array.from({length: 48}, (_, index) => inventory(`file-${index}.ts`, 1));
    const productionSurfaceBytes = 192 * 1_048_576;
    const bytesPerFile = productionSurfaceBytes / files.length;
    const plan = planProjectResolutionCandidateScan({
      bytesByPath: new Map(files.map(file => [file.path, bytesPerFile])),
      files,
    });

    expect(PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES).toBe(256 * 1_048_576);
    expect(PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES).toBe(CODE_GRAPH_CACHED_FACT_BYTES_MAXIMUM);
    expect(plan).toMatchObject({factBytes: productionSurfaceBytes, files: 48, mode: 'eligible'});
    if (plan.mode === 'eligible') {
      expect(plan.pages).toHaveLength(24);
      expect(plan.pages.every(page => page.factBytes <= PROJECT_RESOLUTION_CANDIDATE_SCAN_PAGE_MAX_FACT_BYTES)).toBe(
        true,
      );
    }
    const overflowFiles = [inventory('overflow-a.ts', 1), inventory('overflow-b.ts', 1)];
    expect(
      planProjectResolutionCandidateScan({
        bytesByPath: new Map([
          [overflowFiles[0]!.path, PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES],
          [overflowFiles[1]!.path, 1],
        ]),
        files: overflowFiles,
      }),
    ).toEqual({
      detail: 'candidate-scan-fact-bytes',
      limit: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES,
      mode: 'fallback',
      observed: PROJECT_RESOLUTION_CANDIDATE_SCAN_MAX_FACT_BYTES + 1,
      reason: 'project-closure-unbounded',
    });
  });

  effectIt.effect('fails closed on incomplete pages and reports exact selected/reexport overflows', () =>
    Effect.gen(function* () {
      const files = [inventory('a.ts', 1), inventory('b.ts', 1)];
      const plan = eligiblePlan(files, 1);
      const missing = yield* scanProjectResolutionCandidateClosure({
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: () => Effect.succeed({bytesByPath: new Map(), facts: new Map()}),
        maximumSelectedFiles: 2,
        plan,
      });
      expect(missing).toEqual({mode: 'fallback', reason: 'cache-incomplete'});

      const matchingFacts = new Map(
        files.map(file => [file.path, facts(file.path, [reference(file.path, [['seed']])])]),
      );
      const selectedOverflow = yield* scan(plan, matchingFacts, [lookup('typescript', 'seed')], 1);
      expect(selectedOverflow).toEqual({
        detail: 'candidate-selected-files',
        limit: 1,
        mode: 'fallback',
        observed: 2,
        reason: 'project-closure-unbounded',
      });

      const emptyPlan = eligiblePlan([], 1);
      const repeatedReexport = reexportKeys('barrel.ts', lookup('typescript', 'alias'), lookup('typescript', 'seed'));
      const reexportOverflow = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: Array.from(
          {length: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS + 1},
          () => repeatedReexport,
        ),
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: () => Effect.die('empty plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: emptyPlan,
      });
      expect(reexportOverflow).toEqual({
        detail: 'candidate-reexports',
        limit: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS,
        mode: 'fallback',
        observed: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORTS + 1,
        reason: 'project-closure-unbounded',
      });

      const halfByteLimitKey = 'x'.repeat(PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES / 2);
      const keyByteOverflow = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: [
          reexportKeys(
            'large-barrel.ts',
            lookup('typescript', halfByteLimitKey),
            lookup('typescript', halfByteLimitKey),
          ),
        ],
        initialLookupKeys: [lookup('typescript', 'seed')],
        loadPage: () => Effect.die('empty plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: emptyPlan,
      });
      expect(keyByteOverflow).toEqual({
        detail: 'candidate-reexport-key-bytes',
        limit: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES,
        mode: 'fallback',
        observed: PROJECT_RESOLUTION_CANDIDATE_MAX_REEXPORT_KEY_BYTES + 'typescript'.length * 2,
        reason: 'project-closure-unbounded',
      });
    }),
  );

  effectIt('accepts functional aliases and rejects ambiguity, cycles, conflicts, and malformed aliases', () => {
    const alias = canonicalTypeScriptKey('barrel.ts', 'value');
    const firstTarget = canonicalTypeScriptKey('first.ts', 'value');
    const secondTarget = canonicalTypeScriptKey('second.ts', 'value');
    const safety = new Set([lookupIdentity(lookup('typescript', alias))]);
    const staged = new Set(safety);
    const functional = [
      reexportKeys('barrel.ts', lookup('typescript', alias), lookup('typescript', firstTarget)),
      reexportKeys('duplicate.ts', lookup('typescript', alias), lookup('typescript', firstTarget)),
    ];

    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: functional,
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'eligible', stagedDepthMaximum: 1});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: [
          ...functional,
          reexportKeys('ambiguous.ts', lookup('typescript', alias), lookup('typescript', secondTarget)),
        ],
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'fallback', reason: 'non-functional-alias'});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: [reexportKeys('barrel.ts', lookup('typescript', alias), lookup('typescript', alias))],
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'fallback', reason: 'alias-cycle'});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: safety,
        reexports: functional,
        safetyAliasLookupIdentities: safety,
        stagedAliasLookupIdentities: staged,
      }),
    ).toEqual({mode: 'fallback', reason: 'direct-symbol-conflict'});
    expect(
      assessResolutionCandidateReexportSafety({
        directAliasSymbolConflictIdentities: new Set(),
        reexports: [
          reexportKeys('barrel.ts', lookup('typescript', 'not-canonical'), lookup('typescript', firstTarget)),
        ],
        safetyAliasLookupIdentities: new Set(['typescript\0not-canonical']),
        stagedAliasLookupIdentities: new Set(['typescript\0not-canonical']),
      }),
    ).toEqual({mode: 'fallback', reason: 'unparseable-alias'});
  });

  effectIt('counts only staged aliases and admits exactly 32 persisted-delta passes', () => {
    const thirtyTwo = reexportChain(CODE_GRAPH_RESOLUTION_PASS_MAXIMUM);
    const thirtyThree = reexportChain(CODE_GRAPH_RESOLUTION_PASS_MAXIMUM + 1);
    expect(
      reexportSafety(
        thirtyTwo,
        thirtyTwo.map(value => value.alias),
      ),
    ).toEqual({
      mode: 'eligible',
      stagedDepthMaximum: CODE_GRAPH_RESOLUTION_PASS_MAXIMUM,
    });
    expect(
      reexportSafety(
        thirtyThree,
        thirtyThree.map(value => value.alias),
      ),
    ).toEqual({
      mode: 'fallback',
      reason: 'staged-depth-unbounded',
    });

    const retainedTail = reexportChain(96);
    expect(
      reexportSafety(
        retainedTail,
        retainedTail.slice(0, 1).map(value => value.alias),
      ),
    ).toEqual({
      mode: 'eligible',
      stagedDepthMaximum: 1,
    });
    expect(
      reexportSafety(
        retainedTail,
        retainedTail.slice(0, CODE_GRAPH_RESOLUTION_PASS_MAXIMUM).map(value => value.alias),
      ),
    ).toEqual({mode: 'eligible', stagedDepthMaximum: CODE_GRAPH_RESOLUTION_PASS_MAXIMUM});
  });

  effectIt('walks a 10,000-alias retained chain without recursive ancestor copies', () => {
    const chain = reexportChain(10_000);

    expect(reexportSafety(chain, [])).toEqual({mode: 'eligible', stagedDepthMaximum: 0});
  });

  effectIt.effect('processes broad reexport hyperedges without materializing their Cartesian product', () =>
    Effect.gen(function* () {
      const count = 4_000;
      const aliases = Array.from({length: count}, (_, index) => lookup('typescript', `alias-${index}`));
      const candidates = Array.from({length: count}, (_, index) => lookup('typescript', `candidate-${index}`));
      const reexport = {aliases, candidates, sourcePath: 'broad-barrel.ts'};
      const closure = resolutionCandidateLookupKeyClosure([candidates[0]!], [reexport], count + 1);

      expect(closure.mode).toBe('eligible');
      if (closure.mode === 'eligible') expect(closure.identities.size).toBe(count + 1);

      const scanned = yield* scanProjectResolutionCandidateClosure({
        additionalReexports: [reexport],
        initialLookupKeys: [candidates[0]!],
        loadPage: () => Effect.die('empty scan plan must not load a page'),
        maximumSelectedFiles: 0,
        plan: eligiblePlan([], 1),
      });
      expect(scanned.mode).toBe('eligible');
      if (scanned.mode === 'eligible') expect(scanned.lookupKeys).toBe(count + 1);

      const parsedAliases = aliases.map(({resolutionDomain}, index) =>
        lookup(resolutionDomain, canonicalTypeScriptKey(`alias-${index}.ts`, `alias${index}`)),
      );
      const parsedCandidates = candidates.map(({resolutionDomain}, index) =>
        lookup(resolutionDomain, canonicalTypeScriptKey(`candidate-${index}.ts`, `candidate${index}`)),
      );
      expect(
        assessResolutionCandidateReexportSafety({
          directAliasSymbolConflictIdentities: new Set(),
          reexports: [{aliases: parsedAliases, candidates: parsedCandidates, sourcePath: 'broad-barrel.ts'}],
          safetyAliasLookupIdentities: new Set([lookupIdentity(parsedAliases[0]!)]),
          stagedAliasLookupIdentities: new Set(),
        }),
      ).toEqual({mode: 'fallback', reason: 'non-functional-alias'});
    }),
  );

  effectIt('rewrites a selected consumer to the terminal so it consumes no additional delta pass', () => {
    const chain = reexportChain(CODE_GRAPH_RESOLUTION_PASS_MAXIMUM);
    const consumerPath = 'consumer.ts';
    const consumer = facts(consumerPath, [reference(consumerPath, [[chain[0]!.alias]])]);
    const provenance: CodeGraphReusableReexport[] = chain.map(value => ({
      importedName: value.targetName,
      localName: value.aliasName,
      sourcePath: value.aliasPath,
      targetPath: value.targetPath,
    }));

    const enriched = enrichPersistedTypeScriptReexports([consumer], provenance);

    expect(enriched?.[0]?.references?.[0]?.lookupTiers).toEqual([[chain.at(-1)!.target]]);
  });
});

function inventory(path: string, size: number): CodeGraphInventoryFile {
  return {
    blobId: path,
    contentHash: path,
    language: path.endsWith('.java') ? 'java' : 'typescript',
    mode: '100644',
    path,
    size,
    source: 'worktree',
  };
}

function facts(path: string, references: readonly CodeGraphReference[] = []): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, references, symbols: []};
}

function reference(
  path: string,
  lookupTiers: readonly (readonly string[])[],
  resolutionDomain = 'typescript',
): CodeGraphReference {
  return {
    edgeId: `edge-${path}`,
    evidencePath: path,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    lookupTiers,
    provenance: 'syntactic',
    relation: 'references',
    resolutionDomain,
    sourceName: path,
    targetName: lookupTiers.flat().join(','),
  };
}

function reexportReference(path: string, alias: string, candidate: string): CodeGraphReference {
  return {
    ...reference(path, [[candidate]]),
    aliasLookupKeys: [alias],
    relation: 'reexports',
  };
}

function lookup(resolutionDomain: string, key: string): ProjectResolutionLookupKey {
  return {key, resolutionDomain};
}

function lookupIdentity(value: ProjectResolutionLookupKey): string {
  return `${value.resolutionDomain}\0${value.key}`;
}

function parseLookupIdentity(identity: string): ProjectResolutionLookupKey {
  const separator = identity.indexOf('\0');
  return {key: identity.slice(separator + 1), resolutionDomain: identity.slice(0, separator)};
}

function reexportKeys(
  sourcePath: string,
  alias: ProjectResolutionLookupKey,
  candidate: ProjectResolutionLookupKey,
): ProjectResolutionReexportKeys {
  return {aliases: [alias], candidates: [candidate], sourcePath};
}

function independentLookupClosure(
  initial: readonly ProjectResolutionLookupKey[],
  reexports: readonly ProjectResolutionReexportKeys[],
): ReadonlySet<string> {
  const closure = new Set(initial.map(lookupIdentity));
  let changed = true;
  while (changed) {
    changed = false;
    for (const reexport of reexports) {
      if (!reexport.candidates.some(candidate => closure.has(lookupIdentity(candidate)))) continue;
      for (const alias of reexport.aliases) {
        const identity = lookupIdentity(alias);
        if (closure.has(identity)) continue;
        closure.add(identity);
        changed = true;
      }
    }
  }
  return closure;
}

function factBytesForPath(path: string): number {
  return (path.length % 71) + 1;
}

function eligiblePlan(
  files: readonly CodeGraphInventoryFile[],
  pageMaximumFiles: number,
): Extract<ProjectResolutionCandidateScanPlan, {readonly mode: 'eligible'}> {
  const plan = planProjectResolutionCandidateScan({
    bytesByPath: new Map(files.map(file => [file.path, 1])),
    files,
    maximumFactBytes: Number.MAX_SAFE_INTEGER,
    maximumFiles: Math.max(files.length, 1),
    pageMaximumFactBytes: Number.MAX_SAFE_INTEGER,
    pageMaximumFiles,
  });
  if (plan.mode !== 'eligible') throw new Error(`Expected eligible scan plan, received ${plan.mode}`);
  return plan;
}

function scan(
  plan: Extract<ProjectResolutionCandidateScanPlan, {readonly mode: 'eligible'}>,
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
  initialLookupKeys: readonly ProjectResolutionLookupKey[],
  maximumSelectedFiles: number,
): Effect.Effect<ProjectResolutionCandidateClosure> {
  return scanProjectResolutionCandidateClosure({
    initialLookupKeys,
    loadPage: files => Effect.succeed(loadedPage(files, factsByPath)),
    maximumSelectedFiles,
    plan,
  });
}

function loadedPage(
  files: readonly CodeGraphInventoryFile[],
  factsByPath: ReadonlyMap<string, CodeGraphFileFacts>,
): ProjectResolutionCandidateFactPage {
  return {
    bytesByPath: new Map(files.map(file => [file.path, 1])),
    facts: new Map(
      files.flatMap(file => (factsByPath.has(file.path) ? [[file.path, factsByPath.get(file.path)!]] : [])),
    ),
  };
}

function canonicalClosure(closure: ProjectResolutionCandidateClosure): unknown {
  if (closure.mode !== 'eligible') return closure;
  return {
    ...closure,
    affectedAliasLookupIdentities: [...closure.affectedAliasLookupIdentities].sort(),
    directAliasSymbolConflictIdentities: [...closure.directAliasSymbolConflictIdentities].sort(),
  };
}

function canonicalReexports(reexports: readonly CodeGraphReusableReexport[]): readonly string[] {
  return reexports
    .map(value => [value.sourcePath, value.localName, value.targetPath, value.importedName].join('\0'))
    .sort();
}

function canonicalTypeScriptKey(path: string, name: string): string {
  return `typescript:test:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
}

interface ReexportChainEntry {
  readonly alias: string;
  readonly aliasName: string;
  readonly aliasPath: string;
  readonly keys: ProjectResolutionReexportKeys;
  readonly target: string;
  readonly targetName: string;
  readonly targetPath: string;
}

function reexportChain(length: number): readonly ReexportChainEntry[] {
  return Array.from({length}, (_, index) => {
    const aliasPath = `barrel-${index}.ts`;
    const targetPath = index + 1 === length ? 'terminal.ts' : `barrel-${index + 1}.ts`;
    const aliasName = `value${index}`;
    const targetName = index + 1 === length ? 'terminal' : `value${index + 1}`;
    const alias = canonicalTypeScriptKey(aliasPath, aliasName);
    const target = canonicalTypeScriptKey(targetPath, targetName);
    return {
      alias,
      aliasName,
      aliasPath,
      keys: reexportKeys(aliasPath, lookup('typescript', alias), lookup('typescript', target)),
      target,
      targetName,
      targetPath,
    };
  });
}

function reexportSafety(chain: readonly ReexportChainEntry[], stagedAliases: readonly string[]) {
  const safetyAliasLookupIdentities = new Set([lookupIdentity(lookup('typescript', chain[0]!.alias))]);
  return assessResolutionCandidateReexportSafety({
    directAliasSymbolConflictIdentities: new Set(),
    reexports: chain.map(value => value.keys),
    safetyAliasLookupIdentities,
    stagedAliasLookupIdentities: new Set(stagedAliases.map(alias => lookupIdentity(lookup('typescript', alias)))),
  });
}
