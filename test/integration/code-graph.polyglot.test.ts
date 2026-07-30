import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Effect, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeGraphIndexer} from '../../src/code_graph/indexer.js';
import {codeGraphLayout} from '../../src/code_graph/layout.js';
import {CodeGraphQueryService} from '../../src/code_graph/query.js';
import {CodeGraphStore} from '../../src/code_graph/store.js';
import {runEffect} from '../helpers/effect-runtime.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('polyglot code graph lifecycle', () => {
  it('indexes and queries TypeScript, Java, Kotlin, and Swift through one native graph', async () => {
    const root = createPolyglotRepository();
    const home = join(root, '.threadnote-test-home');
    const result = await runEffect(
      Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        const query = yield* CodeGraphQueryService;
        const store = yield* CodeGraphStore;
        const path = yield* Path.Path;
        const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
        const layout = codeGraphLayout(path, home, indexed.identity.checkoutId, indexed.identity.worktreeId);
        const graph = yield* store.loadGraph(layout.databasePath, indexed.snapshot.id);
        const operations = yield* Effect.all(
          [
            query.inspect({
              cwd: root,
              operation: 'query',
              query: 'Greeter',
              refresh: false,
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              operation: 'explain',
              refresh: false,
              symbol: 'KotlinApp',
              threadnoteHome: home,
            }),
            query.inspect({
              cwd: root,
              from: 'typescriptBoot',
              operation: 'path',
              refresh: false,
              threadnoteHome: home,
              to: 'typescriptHelper',
            }),
            query.inspect({
              cwd: root,
              operation: 'impact',
              query: 'makeService',
              refresh: false,
              threadnoteHome: home,
            }),
          ],
          {concurrency: 1},
        );
        return {graph, indexed, operations};
      }),
    );

    expect(result.graph.symbols.map(symbol => symbol.language)).toEqual(
      expect.arrayContaining(['java', 'kotlin', 'swift', 'typescript']),
    );
    expect(
      result.graph.edges.find(
        edge => edge.sourceName === 'start' && edge.relation === 'constructs' && edge.targetName === 'Greeter',
      ),
    ).toMatchObject({provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)});
    expect(
      result.graph.edges.find(
        edge => edge.sourceName === 'swiftBoot' && edge.relation === 'calls' && edge.targetName === 'makeService',
      ),
    ).toMatchObject({provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)});
    expect(
      result.graph.edges.find(
        edge =>
          edge.sourceName === 'typescriptBoot' && edge.relation === 'calls' && edge.targetName === 'typescriptHelper',
      ),
    ).toMatchObject({provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)});
    expect(result.operations.every(operation => operation.snapshot.id === result.indexed.snapshot.id)).toBe(true);
    expect(result.operations[0]!.nodes.some(node => node.language === 'java')).toBe(true);
    expect(result.operations[1]!.nodes.some(node => node.name === 'KotlinApp')).toBe(true);
    expect(result.operations[2]!.edges.some(edge => edge.targetName === 'typescriptHelper')).toBe(true);
    expect(result.operations[3]!.nodes.some(node => node.name === 'swiftBoot')).toBe(true);
  });
});

function createPolyglotRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-polyglot-'));
  temporaryRoots.push(root);
  write(root, 'settings.gradle.kts', 'include(":shared", ":app")\n');
  write(root, 'shared/build.gradle.kts', '');
  write(root, 'app/build.gradle.kts', 'dependencies { implementation(project(":shared")) }\n');
  write(
    root,
    'shared/src/main/java/com/acme/Greeter.java',
    'package com.acme; public class Greeter { public Greeter() {} }\n',
  );
  write(
    root,
    'app/src/main/kotlin/com/acme/KotlinApp.kt',
    'package com.acme\nimport com.acme.Greeter\nclass KotlinApp { fun start() = Greeter() }\n',
  );
  write(
    root,
    'Package.swift',
    [
      'import PackageDescription',
      'let package = Package(name: "SwiftWorkspace", targets: [',
      '  .target(name: "SwiftCore"),',
      '  .target(name: "SwiftApp", dependencies: ["SwiftCore"])',
      '])',
    ].join('\n'),
  );
  write(root, 'Sources/SwiftCore/Service.swift', 'public func makeService() -> String { "ready" }\n');
  write(root, 'Sources/SwiftApp/Main.swift', 'import SwiftCore\npublic func swiftBoot() -> String { makeService() }\n');
  write(root, 'src/helper.ts', 'export function typescriptHelper(): string { return "ready"; }\n');
  write(
    root,
    'src/main.ts',
    'import {typescriptHelper} from "./helper.js";\nexport function typescriptBoot() { return typescriptHelper(); }\n',
  );
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'polyglot fixture',
  ]);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, content);
}
