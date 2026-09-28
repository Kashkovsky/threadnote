import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';

describe('TypeScript overload indexing', () => {
  effectIt.effect(
    'keeps overload symbols while resolving calls to implementations or unique arities',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository();
        const home = join(root, '.threadnote-test-home');
        const indexer = yield* CodeGraphIndexer;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const layout = codeGraphLayout(path, home, indexed.identity.checkoutId, indexed.identity.worktreeId);
        const graph = yield* store.loadGraph(layout.databasePath, indexed.snapshot.id);
        const parseSymbols = graph.symbols.filter(symbol => symbol.name === 'parse');
        const decodeSymbols = graph.symbols.filter(symbol => symbol.name === 'decode');
        const implementation = parseSymbols.find(symbol => symbol.signature?.includes('...values'));
        const nullaryDeclaration = decodeSymbols.find(symbol => symbol.arity === 0);
        const binaryDeclaration = decodeSymbols.find(symbol => symbol.arity === 2);
        const call = (sourceName: string, targetName: string) =>
          graph.edges.find(
            edge => edge.sourceName === sourceName && edge.relation === 'calls' && edge.targetName === targetName,
          );

        expect(new Set(parseSymbols.map(symbol => symbol.id)).size).toBe(3);
        expect(new Set(decodeSymbols.map(symbol => symbol.id)).size).toBe(2);
        expect(call('useImported', 'parse')).toMatchObject({
          provenance: 'resolved',
          targetId: implementation?.id,
        });
        const declaredCalls = graph.edges.filter(
          edge => edge.sourceName === 'useDeclared' && edge.relation === 'calls' && edge.targetName === 'decode',
        );
        expect(declaredCalls).toHaveLength(2);
        expect(new Set(declaredCalls.map(edge => edge.id)).size).toBe(2);
        expect(new Set(declaredCalls.map(edge => edge.targetId))).toEqual(
          new Set([nullaryDeclaration?.id, binaryDeclaration?.id]),
        );
        expect(call('useShadowed', 'parse')).toMatchObject({provenance: 'syntactic', targetId: undefined});
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );
});

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-overloads-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(
    join(root, 'src', 'overloads.ts'),
    [
      'export function parse(value: string): string;',
      'export function parse(value: number): string;',
      'export function parse(...values: readonly (number | string)[]): string { return values.join(","); }',
      'export declare function decode(): string;',
      'export declare function decode(left: string, right: string): string;',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'src', 'index.ts'), 'export {decode, parse} from "./overloads.js";\n');
  writeFileSync(
    join(root, 'src', 'use.ts'),
    [
      'import {decode, parse} from "./index.js";',
      'export function useImported(): string { return parse(1); }',
      'export function useDeclared(): string { return decode() + decode("a", "b"); }',
      'export function useShadowed(parse: (value: number) => string): string { return parse(1); }',
      '',
    ].join('\n'),
  );
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'overload fixture',
  ]);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
