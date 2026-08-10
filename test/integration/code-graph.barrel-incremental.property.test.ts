import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'effect/testing/FastCheck';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {compareCodeUnits} from '../../src/code_graph/ordering.js';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {CodeGraphStore, type StoredCodeGraph} from '../../src/code_graph/store.js';
import {CommandExecutor} from '../../src/effect/command.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';

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

describe('code graph incremental barrel differential properties', () => {
  it.effect.prop(
    'matches a full rebuild through randomized transitive and cyclic named barrels',
    {scenario: barrelScenarioArbitrary},
    ({scenario}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const command = yield* CommandExecutor;
          const indexer = yield* CodeGraphIndexer;
          const store = yield* CodeGraphStore;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-barrel-property-'});
          const sourceRoot = path.join(root, 'src');
          const incrementalHome = path.join(root, '.threadnote-barrel-incremental-home');
          const fullHome = path.join(root, '.threadnote-barrel-full-home');
          const writeConsumer = (arities: readonly number[], revision: number) => {
            const calls = arities.map(arity => (arity === 0 ? 'decode()' : 'decode("a", "b")'));
            return fs.writeFileString(
              path.join(sourceRoot, 'use.ts'),
              [
                `import {decode} from './barrel-${scenario.barrelDepth - 1}.js';`,
                'export function useDecode(): string {',
                `  const revision = ${revision};`,
                `  return [String(revision)${calls.map(call => `, ${call}`).join('')}].join(":");`,
                '}',
                '',
              ].join('\n'),
            );
          };

          yield* fs.makeDirectory(sourceRoot, {recursive: true});
          yield* fs.writeFileString(
            path.join(sourceRoot, 'declarations.ts'),
            [
              'export declare function decode(): string;',
              'export declare function decode(a: string, b: string): string;',
              '',
            ].join('\n'),
          );
          yield* fs.writeFileString(path.join(sourceRoot, 'cycle-a.ts'), 'export {decode} from "./cycle-b.js";\n');
          yield* fs.writeFileString(
            path.join(sourceRoot, 'cycle-b.ts'),
            ['export {decode} from "./cycle-a.js";', 'export {decode} from "./declarations.js";', ''].join('\n'),
          );
          for (let index = 0; index < scenario.barrelDepth; index += 1) {
            const target = index === 0 ? 'cycle-a' : `barrel-${index - 1}`;
            yield* fs.writeFileString(
              path.join(sourceRoot, `barrel-${index}.ts`),
              `export {decode} from "./${target}.js";\n`,
            );
          }
          yield* writeConsumer(scenario.cleanArities, 0);
          yield* command.execute('git', ['init', '-q'], {cwd: root});
          yield* command.execute('git', ['add', '.'], {cwd: root});
          yield* command.execute(
            'git',
            [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '-qm',
              'barrel property fixture',
            ],
            {cwd: root},
          );

          yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          yield* writeConsumer(scenario.dirtyArities, scenario.revision);
          const incremental = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
          const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
          const incrementalLayout = codeGraphLayout(
            path,
            incrementalHome,
            incremental.identity.checkoutId,
            incremental.identity.worktreeId,
          );
          const fullLayout = codeGraphLayout(path, fullHome, full.identity.checkoutId, full.identity.worktreeId);
          const incrementalGraph = yield* store.loadGraph(incrementalLayout.databasePath, incremental.snapshot.id);
          const fullGraph = yield* store.loadGraph(fullLayout.databasePath, full.snapshot.id);

          expect(incremental.materialization).toEqual({
            mode: 'incremental-overlay',
            stagedFiles: 1,
            totalFiles: scenario.barrelDepth + 4,
          });
          expect(normalizeGraph(incrementalGraph)).toEqual(normalizeGraph(fullGraph));
          const resolvedArities = new Set(
            incrementalGraph.edges
              .filter(edge => edge.relation === 'calls' && edge.targetName === 'decode' && edge.targetId !== undefined)
              .flatMap(edge => {
                const target = incrementalGraph.symbols.find(symbol => symbol.id === edge.targetId);
                return target?.arity === undefined ? [] : [target.arity];
              }),
          );
          expect(resolvedArities).toEqual(new Set(scenario.dirtyArities));
        }),
      ).pipe(Effect.provide(ApplicationLayer)),
    {
      fastCheck: {interruptAfterTimeLimit: 180_000, markInterruptAsFailure: true, numRuns: 6},
      timeout: 190_000,
    },
  );
});

function normalizeGraph(graph: StoredCodeGraph): Pick<StoredCodeGraph, 'edges' | 'symbols'> {
  return {
    edges: [...graph.edges].sort((left, right) => compareCodeUnits(left.id, right.id)),
    symbols: [...graph.symbols].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}
