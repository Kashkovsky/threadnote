import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {Effect, Path} from 'effect';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {compareCodeUnits} from '../../src/code_graph/ordering.js';
import {CodeGraphStore, type CodeGraphVisualizationCatalog, type StoredCodeGraph} from '../../src/code_graph/store.js';
import {runEffect} from '../helpers/effect-runtime.js';

interface DifferentialScenario {
  readonly baseTargets: readonly number[];
  readonly dirty: ReadonlySet<number>;
  readonly dirtyTargets: readonly number[];
  readonly fileCount: number;
  readonly salt: number;
}

interface BarrelScenario {
  readonly barrelDepth: number;
  readonly cleanArities: readonly number[];
  readonly dirtyArities: readonly number[];
  readonly revision: number;
}

const scenarioArbitrary = FC.record({
  baseTargets: FC.array(FC.integer({max: 31, min: 0}), {maxLength: 7, minLength: 7}),
  dirtyMask: FC.array(FC.boolean(), {maxLength: 7, minLength: 7}),
  dirtyTargets: FC.array(FC.integer({max: 31, min: 0}), {maxLength: 7, minLength: 7}),
  fileCount: FC.integer({max: 7, min: 3}),
  salt: FC.integer({max: 10_000, min: 0}),
}).map(({baseTargets, dirtyMask, dirtyTargets, fileCount, salt}) => {
  const dirty = new Set(dirtyMask.slice(3, fileCount).flatMap((enabled, index) => (enabled ? [index + 3] : [])));
  dirty.add(0);
  dirty.add(2);
  const anchoredBaseTargets = baseTargets.slice(0, fileCount);
  const anchoredDirtyTargets = dirtyTargets.slice(0, fileCount);
  anchoredBaseTargets[0] = 1;
  anchoredDirtyTargets[0] = 2;
  anchoredBaseTargets[1] = 0;
  anchoredDirtyTargets[1] = 0;
  anchoredBaseTargets[2] = 1;
  anchoredDirtyTargets[2] = 1;
  return {
    baseTargets: anchoredBaseTargets,
    dirty,
    dirtyTargets: anchoredDirtyTargets,
    fileCount,
    salt,
  } satisfies DifferentialScenario;
});

const barrelScenarioArbitrary = FC.record({
  barrelDepth: FC.integer({max: 4, min: 1}),
  cleanZero: FC.boolean(),
  cleanTwo: FC.boolean(),
  dirtyZero: FC.boolean(),
  dirtyTwo: FC.boolean(),
  revision: FC.integer({max: 10_000, min: 1}),
}).map(({barrelDepth, cleanTwo, cleanZero, dirtyTwo, dirtyZero, revision}) => ({
  barrelDepth,
  cleanArities: [cleanZero ? 0 : -1, cleanTwo ? 2 : -1].filter(arity => arity >= 0),
  dirtyArities: [dirtyZero ? 0 : -1, dirtyTwo ? 2 : -1].filter(arity => arity >= 0),
  revision,
}));

describe('code graph incremental-overlay differential properties', () => {
  it.effect.prop(
    'matches a full rebuild after randomized body-only edits change multi-file references',
    {scenario: scenarioArbitrary},
    ({scenario}) =>
      Effect.promise(async () => {
        const root = createRepository(scenario);
        const incrementalHome = join(root, '.threadnote-incremental-home');
        const fullHome = join(root, '.threadnote-full-home');
        try {
          await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            }),
          );
          applyDirtyScenario(root, scenario);
          const result = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const store = yield* CodeGraphStore;
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
                threadnoteHome: fullHome,
              });
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
              const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
              const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);
              return {
                full,
                fullCatalog: yield* store.loadVisualizationCatalog(fullLayout.databasePath),
                fullGraph,
                fullHealth: yield* store.diagnose(fullLayout.databasePath),
                incremental,
                incrementalCatalog: yield* store.loadVisualizationCatalog(incrementalLayout.databasePath),
                incrementalGraph,
                incrementalHealth: yield* store.diagnose(incrementalLayout.databasePath),
              };
            }),
          );

          expect(result.incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            stagedFiles: scenario.dirty.size,
            totalFiles: scenario.fileCount,
          });
          expect(result.full.materialization).toEqual({
            fallbackReason: 'disabled',
            mode: 'full',
            stagedFiles: scenario.fileCount,
            totalFiles: scenario.fileCount,
          });
          expect(normalizeGraph(result.incrementalGraph)).toEqual(normalizeGraph(result.fullGraph));
          expect(normalizeCatalog(result.incrementalCatalog)).toEqual(normalizeCatalog(result.fullCatalog));
          expect(result.incrementalHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
          expect(result.fullHealth).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});

          const expectedCalls = new Set(
            Array.from({length: scenario.fileCount}, (_, source) => {
              const rawTarget = scenario.dirty.has(source)
                ? scenario.dirtyTargets[source]!
                : scenario.baseTargets[source]!;
              return `symbol${source}->symbol${differentFile(rawTarget, source, scenario.fileCount)}`;
            }),
          );
          const resolvedCalls = new Set(
            result.incrementalGraph.edges
              .filter(edge => edge.relation === 'calls' && edge.sourceId !== undefined && edge.targetId !== undefined)
              .map(edge => `${edge.sourceName}->${edge.targetName}`),
          );
          expect(resolvedCalls).toEqual(expectedCalls);
        } finally {
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      fastCheck: {interruptAfterTimeLimit: 90_000, markInterruptAsFailure: true, numRuns: 10},
      timeout: 100_000,
    },
  );

  it.effect.prop(
    'matches a full rebuild through randomized transitive and cyclic named barrels',
    {scenario: barrelScenarioArbitrary},
    ({scenario}) =>
      Effect.promise(async () => {
        const root = createBarrelRepository(scenario);
        const incrementalHome = join(root, '.threadnote-barrel-incremental-home');
        const fullHome = join(root, '.threadnote-barrel-full-home');
        try {
          await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
            }),
          );
          writeBarrelConsumer(root, scenario.barrelDepth, scenario.dirtyArities, scenario.revision);
          const result = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const store = yield* CodeGraphStore;
              const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
              const full = yield* indexer.index({
                cwd: root,
                incrementalOverlay: false,
                threadnoteHome: fullHome,
              });
              const incrementalLayout = codeGraphLayout(
                path,
                incrementalHome,
                incremental.identity.checkoutId,
                incremental.identity.worktreeId,
              );
              const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
              return {
                fullGraph: yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id),
                incremental,
                incrementalGraph: yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id),
              };
            }),
          );

          expect(result.incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            stagedFiles: 1,
            totalFiles: scenario.barrelDepth + 4,
          });
          expect(normalizeGraph(result.incrementalGraph)).toEqual(normalizeGraph(result.fullGraph));
          const resolvedArities = new Set(
            result.incrementalGraph.edges
              .filter(edge => edge.relation === 'calls' && edge.targetName === 'decode' && edge.targetId !== undefined)
              .flatMap(edge => {
                const target = result.incrementalGraph.symbols.find(symbol => symbol.id === edge.targetId);
                return target?.arity === undefined ? [] : [target.arity];
              }),
          );
          expect(resolvedArities).toEqual(new Set(scenario.dirtyArities));
        } finally {
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      fastCheck: {interruptAfterTimeLimit: 60_000, markInterruptAsFailure: true, numRuns: 6},
      timeout: 70_000,
    },
  );
});

function createRepository(scenario: DifferentialScenario): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-overlay-property-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  git(root, ['init', '-q']);
  for (let source = 0; source < scenario.fileCount; source += 1) {
    writeSource(root, source, scenario.baseTargets[source]!, scenario.fileCount, 0);
  }
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'property fixture',
  ]);
  return root;
}

function applyDirtyScenario(root: string, scenario: DifferentialScenario): void {
  for (const source of scenario.dirty) {
    writeSource(root, source, scenario.dirtyTargets[source]!, scenario.fileCount, scenario.salt + source + 1);
  }
}

function createBarrelRepository(scenario: BarrelScenario): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-barrel-property-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(
    join(root, 'src', 'declarations.ts'),
    [
      'export declare function decode(): string;',
      'export declare function decode(a: string, b: string): string;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'src', 'cycle-a.ts'), 'export {decode} from "./cycle-b.js";\n');
  writeFileSync(
    join(root, 'src', 'cycle-b.ts'),
    ['export {decode} from "./cycle-a.js";', 'export {decode} from "./declarations.js";', ''].join('\n'),
  );
  for (let index = 0; index < scenario.barrelDepth; index += 1) {
    const target = index === 0 ? 'cycle-a' : `barrel-${index - 1}`;
    writeFileSync(join(root, 'src', `barrel-${index}.ts`), `export {decode} from "./${target}.js";\n`);
  }
  writeBarrelConsumer(root, scenario.barrelDepth, scenario.cleanArities, 0);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'barrel property fixture',
  ]);
  return root;
}

function writeBarrelConsumer(root: string, barrelDepth: number, arities: readonly number[], revision: number): void {
  const calls = arities.map(arity => (arity === 0 ? 'decode()' : 'decode("a", "b")'));
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      `import {decode} from './barrel-${barrelDepth - 1}.js';`,
      'export function useDecode(): string {',
      `  const revision = ${revision};`,
      `  return [String(revision)${calls.map(call => `, ${call}`).join('')}].join(":");`,
      '}',
      '',
    ].join('\n'),
  );
}

function writeSource(root: string, source: number, rawTarget: number, fileCount: number, revision: number): void {
  const target = differentFile(rawTarget, source, fileCount);
  writeFileSync(
    join(root, 'src', `file-${source}.ts`),
    [
      `import {symbol${target}} from './file-${target}.js';`,
      `export function symbol${source}(): number {`,
      `  // body revision ${revision}`,
      `  return symbol${target}() + ${revision};`,
      '}',
      '',
    ].join('\n'),
  );
}

function differentFile(rawTarget: number, source: number, fileCount: number): number {
  const candidate = rawTarget % fileCount;
  return candidate === source ? (candidate + 1) % fileCount : candidate;
}

function normalizeGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    symbols: [...graph.symbols].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {completedAt: _completedAt, ...stableSnapshot} = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
