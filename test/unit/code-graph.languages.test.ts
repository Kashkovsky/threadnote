import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Option} from 'effect';
import {describe, expect, it} from 'vitest';
import {createRepositoryFactResolver, extractFileFacts} from '../../src/code_graph/extractor.js';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  createCodeGraphLanguagePackRegistry,
} from '../../src/code_graph/languages/registry.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../../src/code_graph/languages/types.js';
import {TreeSitterRuntime} from '../../src/code_graph/tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {createWorkspaceAttributor, discoverManifestWorkspace} from '../../src/code_graph/workspace.js';
import {SystemInfo} from '../../src/effect/system.js';

describe('polyglot code graph language packs', () => {
  it('preserves the TypeScript compiler extractor behind the registry', async () => {
    const file = inventoryFile(
      'src/service.ts',
      `
        export interface Store { read(): string }
        export class Service implements Store {
          read(): string { return helper() }
        }
        export function helper(): string { return 'ok' }
      `,
    );

    const viaRegistry = await runExtraction(file);
    const direct = extractFileFacts(file);

    expect(viaRegistry).toEqual(direct);
    expect(viaRegistry.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['interface', 'Store'],
        ['class', 'Service'],
        ['method', 'Service.read'],
        ['function', 'helper'],
      ]),
    );
  });

  it('extracts Java, Kotlin, and Swift declarations with bounded file-local recovery', async () => {
    const [java, kotlin, swift, recovering] = await Promise.all([
      runExtraction(
        inventoryFile(
          'java/src/main/java/com/acme/Greeter.java',
          `
            package com.acme;
            public class Greeter extends BaseGreeter {
              public String greet(String name) { return normalize(name); }
            }
          `,
        ),
      ),
      runExtraction(
        inventoryFile(
          'kotlin/src/main/kotlin/com/acme/Greeter.kt',
          `
            package com.acme
            class Greeter : BaseGreeter() {
              fun greet(name: String): String = normalize(name)
            }
          `,
        ),
      ),
      runExtraction(
        inventoryFile(
          'swift/Sources/Core/Greeter.swift',
          `
            public protocol Greeting { func greet(_ name: String) -> String }
            public struct Greeter: Greeting {
              public func greet(_ name: String) -> String { normalize(name) }
            }
          `,
        ),
      ),
      runExtraction(inventoryFile('swift/Sources/Broken/Broken.swift', 'public struct Broken { func value(')),
    ]);

    expect(java.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['class', 'com.acme.Greeter'],
        ['method', 'com.acme.Greeter.greet'],
      ]),
    );
    expect(java.edges.map(edge => edge.relation)).toEqual(expect.arrayContaining(['calls', 'contains', 'extends']));
    expect(kotlin.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['class', 'com.acme.Greeter'],
        ['function', 'com.acme.Greeter.greet'],
      ]),
    );
    expect(kotlin.edges.map(edge => edge.relation)).toEqual(expect.arrayContaining(['calls', 'contains', 'extends']));
    expect(swift.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['protocol', 'Greeting'],
        ['struct', 'Greeter'],
        ['method', 'Greeter.greet'],
      ]),
    );
    expect(swift.edges.map(edge => edge.relation)).toEqual(expect.arrayContaining(['calls', 'contains', 'extends']));
    expect(recovering.diagnostics).toEqual([
      'swift/Sources/Broken/Broken.swift: swift parser recovered from one or more syntax errors',
    ]);
  });

  it('covers module, JVM type variants, companions, constructors, and Swift member declarations', async () => {
    const [java, kotlin, swift] = await Promise.all([
      runExtraction(
        inventoryFile(
          'java/src/main/java/module-info.java',
          'module com.acme.app { requires com.acme.core; exports com.acme.api; }',
        ),
      ),
      runExtraction(
        inventoryFile(
          'kotlin/src/main/kotlin/acme/Types.kt',
          `
            package acme
            interface Contract
            enum class State { READY }
            annotation class Marker
            class Host() {
              companion object Factory { fun make() = Host() }
              constructor(value: Int) : this()
              val property: String = "ready"
            }
            typealias HostAlias = Host
            fun String.slug(value: Int): String = this
          `,
        ),
      ),
      runExtraction(
        inventoryFile(
          'swift/Sources/Core/Types.swift',
          `
            public protocol Contract { func run() }
            public actor Worker {
              public var name: String = "worker"
              public init() {}
              public subscript(index: Int) -> String { name }
              public func run() {}
            }
            public extension Worker { func extra() {} }
            public typealias WorkerName = String
          `,
        ),
      ),
    ]);

    expect(java.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([['module', 'com.acme.app']]),
    );
    expect(java.edges.find(edge => edge.relation === 'imports' && edge.targetName === 'com.acme.core')).toBeDefined();
    expect(kotlin.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['interface', 'acme.Contract'],
        ['enum', 'acme.State'],
        ['annotation', 'acme.Marker'],
        ['object', 'acme.Host.Factory'],
        ['constructor', 'acme.Host.Host'],
        ['property', 'acme.Host.property'],
        ['type', 'acme.HostAlias'],
        ['function', 'acme.slug'],
      ]),
    );
    expect(kotlin.symbols.filter(symbol => symbol.kind === 'constructor')).toHaveLength(2);
    expect(swift.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['protocol', 'Contract'],
        ['method', 'Contract.run'],
        ['actor', 'Worker'],
        ['property', 'Worker.name'],
        ['initializer', 'Worker.init'],
        ['subscript', 'Worker.subscript'],
        ['method', 'Worker.run'],
        ['extension', 'Worker'],
        ['type', 'WorkerName'],
      ]),
    );
  });

  it('resolves Java and Kotlin only through a declared Gradle project dependency', async () => {
    const files = [
      inventoryFile(
        'settings.gradle.kts',
        `
          rootProject.name = "mixed"
          include(":libs:shared", ":apps:app", ":apps:isolated")
        `,
      ),
      inventoryFile('libs/shared/build.gradle.kts', ''),
      inventoryFile('apps/app/build.gradle.kts', 'dependencies { implementation(project(":libs:shared")) }'),
      inventoryFile('apps/isolated/build.gradle.kts', ''),
      inventoryFile(
        'libs/shared/src/main/java/com/acme/shared/Greeter.java',
        `
          package com.acme.shared;
          public class Greeter { public Greeter() {} }
        `,
      ),
      inventoryFile(
        'apps/app/src/main/kotlin/com/acme/app/App.kt',
        `
          package com.acme.app
          import com.acme.shared.Greeter
          fun boot() = Greeter()
        `,
      ),
      inventoryFile(
        'apps/isolated/src/main/kotlin/com/acme/isolated/App.kt',
        `
          package com.acme.isolated
          import com.acme.shared.Greeter
          fun boot() = Greeter()
        `,
      ),
    ];
    const workspace = discoverManifestWorkspace(files);
    const attribute = createWorkspaceAttributor(workspace);
    const extracted = attribute(await Promise.all(files.map(file => runExtraction(file))));
    const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
    const connected = resolved.find(file => file.path.includes('apps/app/src'))!;
    const isolated = resolved.find(file => file.path.includes('apps/isolated/src'))!;

    expect(connected.edges.find(edge => edge.relation === 'constructs' && edge.targetName === 'Greeter')).toMatchObject(
      {provenance: 'resolved', targetId: expect.stringMatching(/^cgs_/)},
    );
    const isolatedConstruction = isolated.edges.find(
      edge => edge.relation === 'constructs' && edge.targetName === 'Greeter',
    );
    expect(isolatedConstruction).toMatchObject({provenance: 'syntactic'});
    expect(isolatedConstruction?.targetId).toBeUndefined();
    expect(workspace.projects.find(project => project.name === 'app')?.dependencies).toHaveLength(1);
  });

  it('keeps a nested Gradle workspace distinct while honoring its integration into the outer monorepo', async () => {
    const files = [
      inventoryFile(
        'settings.gradle.kts',
        `
          rootProject.name = "outer"
          include(":libs:shared", ":apps:app")
        `,
      ),
      inventoryFile('libs/shared/build.gradle.kts', ''),
      inventoryFile(
        'apps/app/settings.gradle.kts',
        `
          rootProject.name = "nested-app"
          include(":feature")
        `,
      ),
      inventoryFile(
        'apps/app/build.gradle.kts',
        `
          dependencies {
            implementation(project(":libs:shared"))
            implementation(project(":feature"))
          }
        `,
      ),
      inventoryFile('apps/app/feature/build.gradle.kts', ''),
      inventoryFile(
        'libs/shared/src/main/java/com/acme/shared/Greeter.java',
        'package com.acme.shared; public class Greeter { public Greeter() {} }',
      ),
      inventoryFile(
        'apps/app/feature/src/main/java/com/acme/feature/FeatureApi.java',
        'package com.acme.feature; public class FeatureApi { public FeatureApi() {} }',
      ),
      inventoryFile(
        'apps/app/src/main/kotlin/com/acme/app/App.kt',
        `
          package com.acme.app
          import com.acme.shared.Greeter
          import com.acme.feature.FeatureApi
          fun boot() {
            Greeter()
            FeatureApi()
          }
        `,
      ),
    ];
    const workspace = discoverManifestWorkspace(files);
    const app = workspace.projects.find(project => project.root === 'apps/app')!;
    const feature = workspace.projects.find(project => project.root === 'apps/app/feature')!;
    const shared = workspace.projects.find(project => project.root === 'libs/shared')!;
    const attribute = createWorkspaceAttributor(workspace);
    const extracted = attribute(await Promise.all(files.map(file => runExtraction(file))));
    const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
    const appFacts = resolved.find(file => file.path.endsWith('/App.kt'))!;
    const constructions = appFacts.edges.filter(edge => edge.relation === 'constructs');

    expect(app.workspaceRoots).toEqual(['', 'apps/app']);
    expect(app.dependencies).toEqual(expect.arrayContaining([feature.id, shared.id]));
    expect(app.dependencies).toHaveLength(2);
    expect(constructions.find(edge => edge.targetName === 'Greeter')).toMatchObject({
      provenance: 'resolved',
      targetId: expect.stringMatching(/^cgs_/),
    });
    expect(constructions.find(edge => edge.targetName === 'FeatureApi')).toMatchObject({
      provenance: 'resolved',
      targetId: expect.stringMatching(/^cgs_/),
    });
  });

  it('resolves Swift calls across declared SwiftPM target dependencies', async () => {
    const files = [
      inventoryFile(
        'Package.swift',
        `
          import PackageDescription
          let package = Package(
            name: "Workspace",
            targets: [
              .target(name: "Core"),
              .target(name: "App", dependencies: ["Core"])
            ]
          )
        `,
      ),
      inventoryFile('Sources/Core/Factory.swift', 'public func makeService() -> String { "ready" }'),
      inventoryFile('Sources/App/Main.swift', 'import Core\npublic func boot() -> String { makeService() }'),
    ];
    const workspace = discoverManifestWorkspace(files);
    const attribute = createWorkspaceAttributor(workspace);
    const extracted = attribute(await Promise.all(files.map(file => runExtraction(file))));
    const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
    const app = resolved.find(file => file.path === 'Sources/App/Main.swift')!;

    expect(app.edges.find(edge => edge.relation === 'calls' && edge.targetName === 'makeService')).toMatchObject({
      provenance: 'resolved',
      targetId: expect.stringMatching(/^cgs_/),
    });
  });

  it('promotes proven Swift protocol conformance but never resolves an override to itself', async () => {
    const files = [
      inventoryFile(
        'Package.swift',
        'import PackageDescription\nlet package = Package(name: "Core", targets: [.target(name: "Core")])',
      ),
      inventoryFile(
        'Sources/Core/Types.swift',
        `
          public protocol Contract { func run() }
          public struct Service: Contract { public func run() {} }
          public class Base { public func refresh() {} }
          public class Child: Base { public override func refresh() {} }
        `,
      ),
    ];
    const workspace = discoverManifestWorkspace(files);
    const attribute = createWorkspaceAttributor(workspace);
    const extracted = attribute(await Promise.all(files.map(file => runExtraction(file))));
    const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
    const facts = resolved.find(file => file.path.endsWith('Types.swift'))!;
    const conformance = facts.edges.find(edge => edge.sourceName === 'Service' && edge.targetName === 'Contract');
    const override = facts.edges.find(edge => edge.relation === 'overrides' && edge.sourceName === 'refresh');

    expect(conformance).toMatchObject({
      provenance: 'resolved',
      relation: 'implements',
      targetId: expect.stringMatching(/^cgs_/),
    });
    expect(override).toMatchObject({provenance: 'syntactic'});
    expect(override?.targetId).toBeUndefined();
  });

  it('fails closed when the applicable lookup tier is ambiguous', async () => {
    const files = [
      inventoryFile('settings.gradle.kts', 'include(":one", ":two", ":app")'),
      inventoryFile('one/build.gradle.kts', ''),
      inventoryFile('two/build.gradle.kts', ''),
      inventoryFile(
        'app/build.gradle.kts',
        'dependencies { implementation(project(":one")); implementation(project(":two")) }',
      ),
      inventoryFile('one/src/main/java/acme/Greeter.java', 'package acme; public class Greeter {}'),
      inventoryFile('two/src/main/kotlin/acme/Greeter.kt', 'package acme\nclass Greeter'),
      inventoryFile('app/src/main/kotlin/acme/App.kt', 'package acme\nimport acme.Greeter\nfun boot() = Greeter()'),
    ];
    const workspace = discoverManifestWorkspace(files);
    const attribute = createWorkspaceAttributor(workspace);
    const extracted = attribute(await Promise.all(files.map(file => runExtraction(file))));
    const resolved = createRepositoryFactResolver(extracted, files).resolve(extracted);
    const edge = resolved
      .find(file => file.path === 'app/src/main/kotlin/acme/App.kt')!
      .edges.find(candidate => candidate.relation === 'constructs' && candidate.targetName === 'Greeter');

    expect(edge).toMatchObject({provenance: 'syntactic'});
    expect(edge?.targetId).toBeUndefined();
  });

  it('accepts a synthetic future pack without changing registry or indexing code', async () => {
    const futurePack: CodeGraphLanguagePack = {
      assets: [],
      capabilities: new Set(['declarations']),
      extractor: {
        extract: file =>
          Effect.succeed({
            diagnostics: [],
            edges: [],
            path: file.path,
            symbols: [],
          }),
        version: 'future-extractor-v1',
      },
      files: [{kind: 'extension', language: 'future', role: 'source', value: '.future'}],
      id: 'future',
      resolutionStrategy: {domain: 'future', version: 'future-resolution-v1'},
      version: '1.0.0',
      workspaceDetector: Option.none(),
    };
    const registry = createCodeGraphLanguagePackRegistry([futurePack]);
    const file = inventoryFile('src/example.future', 'entity Example', 'future');

    expect(registry.match(file.path)).toMatchObject({
      _tag: 'Some',
      value: {language: 'future', role: 'source'},
    });
    await expect(
      Effect.runPromise(
        registry
          .extractFile(file)
          .pipe(
            Effect.provide(TreeSitterRuntime.layer),
            Effect.provide(SystemInfo.layer),
            Effect.provide(BunServices.layer),
          ),
      ),
    ).resolves.toEqual({
      diagnostics: [],
      edges: [],
      path: file.path,
      symbols: [],
    });
  });

  it('changes only the updated language cache identity', () => {
    const changedRegistry = createCodeGraphLanguagePackRegistry(
      BUILTIN_LANGUAGE_PACK_REGISTRY.packs.map(pack =>
        pack.id === 'swift' ? {...pack, version: `${pack.version}-next`} : pack,
      ),
    );
    const originalTypeScript = Option.getOrThrow(BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('src/service.ts'));
    const changedTypeScript = Option.getOrThrow(changedRegistry.cacheIdentityForPath('src/service.ts'));
    const originalSwift = Option.getOrThrow(
      BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('Sources/App/Main.swift'),
    );
    const changedSwift = Option.getOrThrow(changedRegistry.cacheIdentityForPath('Sources/App/Main.swift'));

    expect(changedTypeScript).toBe(originalTypeScript);
    expect(changedSwift).not.toBe(originalSwift);
    expect(changedRegistry.activeCacheIdentities(['src/service.ts'])).toEqual([originalTypeScript]);
  });
});

function runExtraction(file: CodeGraphInventoryFile): Promise<CodeGraphFileFacts> {
  return Effect.runPromise(
    BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file).pipe(
      Effect.provide(TreeSitterRuntime.layer),
      Effect.provide(SystemInfo.layer),
      Effect.provide(BunServices.layer),
    ),
  );
}

function inventoryFile(path: string, content: string, language?: string): CodeGraphInventoryFile {
  const match = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  if (Option.isNone(match) && language === undefined) {
    throw new CodeGraphLanguagePackError(`Test file is not accepted by a language pack: ${path}.`);
  }
  return {
    blobId: `blob-${path}`,
    content,
    contentHash: Bun.hash(content).toString(16),
    language: language ?? (Option.isSome(match) ? match.value.language : 'unknown'),
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}
