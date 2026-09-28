import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Effect, Layer} from 'effect';
import {JAVA_GRAMMAR} from '@threadnote/graph/languages/tree_sitter_assets';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';

const RuntimeTestLayer = TreeSitterRuntime.layer.pipe(
  Layer.provide(TestSystemInfoLayer),
  Layer.provide(BunServices.layer),
);

describe('Tree-sitter query cache', () => {
  it.layer(RuntimeTestLayer)(layerIt => {
    layerIt.effect('compiles one query per language and source across parsed files', () =>
      Effect.gen(function* () {
        const runtime = yield* TreeSitterRuntime;
        const querySource = '(class_declaration name: (identifier) @name)';
        const first = yield* runtime.withParsedSource(JAVA_GRAMMAR, 'class First {}', parsed => {
          const query = parsed.query(querySource);
          return {matches: query.matches(parsed.root).length, query};
        });
        const second = yield* runtime.withParsedSource(JAVA_GRAMMAR, 'class Second {}', parsed => {
          const query = parsed.query(querySource);
          return {matches: query.matches(parsed.root).length, query};
        });

        expect(first.matches).toBe(1);
        expect(second.matches).toBe(1);
        expect(second.query).toBe(first.query);
      }),
    );
  });
});
