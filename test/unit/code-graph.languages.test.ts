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

  it('extracts declarations and relationships across the bundled portable language matrix', async () => {
    const samples = [
      [
        'src/service.py',
        'from core.base import Base\nclass Greeter(Base):\n  def greet(self, name):\n    return normalize(name)\n',
      ],
      [
        'src/service.go',
        'package service\nimport "fmt"\ntype Greeter struct{}\nfunc (g *Greeter) Greet(name string) string { return fmt.Sprint(name) }\n',
      ],
      [
        'src/service.rs',
        'use crate::core::Base;\npub struct Greeter;\npub trait Runner { fn run(&self); }\nimpl Runner for Greeter { fn run(&self) { normalize(); } }\n',
      ],
      [
        'src/service.c',
        '#include "core.h"\ntypedef struct Greeter { int value; } Greeter;\nint greet(void) { return normalize(); }\n',
      ],
      [
        'src/service.cpp',
        '#include "core.hpp"\nnamespace acme { class Greeter : public Base { public: int greet() { return normalize(); } }; }\n',
      ],
      [
        'src/Service.cs',
        'using Core;\nnamespace Acme;\npublic interface IRunner { void Run(); }\npublic class Greeter : Base, IRunner { public void Run() { Normalize(); } }\n',
      ],
      [
        'lib/service.rb',
        'require "core"\nmodule Acme\n class Greeter < Base\n  def greet(name)\n   normalize(name)\n  end\n end\nend\n',
      ],
      [
        'src/service.php',
        '<?php\nnamespace Acme;\nuse Core\\Base;\nclass Greeter extends Base { public function greet() { return normalize(); } }\nfunction normalize() {}\n',
      ],
      ['scripts/service.sh', '#!/usr/bin/env bash\nsource ./core.sh\ngreet() { normalize "$1"; }\ngreet world\n'],
      [
        'infra/main.tf',
        'variable "region" { type = string }\nresource "aws_s3_bucket" "logs" { bucket = var.region }\nmodule "network" { source = "./network" }\n',
      ],
    ] as const;
    const facts = await Promise.all(samples.map(([path, content]) => runExtraction(inventoryFile(path, content))));
    const byLanguage = new Map(facts.map((value, index) => [inventoryFile(samples[index]![0], '').language, value]));

    expect(byLanguage.get('python')?.symbols.map(symbol => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ['class', 'Greeter'],
        ['function', 'Greeter.greet'],
      ]),
    );
    expect(byLanguage.get('go')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['struct', 'method']),
    );
    expect(byLanguage.get('rust')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['struct', 'trait', 'impl', 'function']),
    );
    expect(byLanguage.get('c')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['struct', 'function']),
    );
    expect(byLanguage.get('cpp')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['namespace', 'class', 'function']),
    );
    expect(byLanguage.get('csharp')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['interface', 'class', 'method']),
    );
    expect(byLanguage.get('ruby')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['module', 'class', 'method']),
    );
    expect(byLanguage.get('php')?.symbols.map(symbol => symbol.kind)).toEqual(
      expect.arrayContaining(['class', 'method', 'function']),
    );
    expect(byLanguage.get('bash')?.symbols.map(symbol => symbol.kind)).toContain('function');
    expect(byLanguage.get('terraform')?.symbols.map(symbol => [symbol.kind, symbol.name])).toEqual(
      expect.arrayContaining([
        ['variable', 'region'],
        ['resource', 'aws_s3_bucket.logs'],
        ['module', 'network'],
      ]),
    );
    for (const value of facts) {
      expect(value.symbols[0]?.kind).toBe('module');
      expect(value.edges.length).toBeGreaterThan(0);
    }
  });

  it('detects the complete portable source and Terraform extension matrix', () => {
    const expected = new Map([
      ['src/app.py', 'python'],
      ['src/types.pyi', 'python'],
      ['src/main.go', 'go'],
      ['src/lib.rs', 'rust'],
      ['src/native.c', 'c'],
      ['include/native.h', 'c'],
      ['src/native.cpp', 'cpp'],
      ['include/native.hpp', 'cpp'],
      ['src/App.cs', 'csharp'],
      ['lib/app.rb', 'ruby'],
      ['src/app.php', 'php'],
      ['scripts/release.sh', 'bash'],
      ['infra/main.hcl', 'hcl'],
      ['infra/main.tf', 'terraform'],
      ['infra/prod.tfvars', 'terraform-vars'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({_tag: 'Some', value: {language}});
    }
  });

  it('extracts additional structural languages from verified bundled grammars', async () => {
    const samples = [
      [
        'scripts/Widget.psm1',
        'Import-Module Core.Tools\nfunction Get-Widget { Invoke-Helper }\nclass Widget : BaseWidget { [string] Run() { Invoke-Helper } }',
        ['class', 'function', 'method'],
        ['calls', 'extends', 'imports'],
      ],
      [
        'lib/widget.dart',
        'import "package:core/base.dart"; class Widget extends Base implements Runnable { void run() { helper(); } }',
        ['class', 'function'],
        ['calls', 'extends', 'implements', 'imports'],
      ],
      [
        'contracts/Vault.sol',
        'import "./Base.sol"; contract Vault is Base { event Deposited(address who); function deposit() public { helper(); } }',
        ['contract', 'event', 'function'],
        ['calls', 'extends', 'imports'],
      ],
      [
        'lib/widget.lua',
        'local util = require("util")\nfunction run(x) return util.help(x) end\nlocal function hidden() end',
        ['function'],
        ['calls', 'imports'],
      ],
      [
        'src/Widget.scala',
        'package demo\nimport core.Base\ntrait Runner { def run(): Unit }\nclass Widget extends Base with Runner { def run() = helper() }',
        ['class', 'function', 'trait'],
        ['calls', 'extends', 'imports'],
      ],
      [
        'lib/widget.ex',
        'defmodule Demo.Widget do\n alias Core.Base\n def run(x), do: helper(x)\n defp hidden(), do: :ok\nend',
        ['function', 'module'],
        ['calls', 'imports'],
      ],
      [
        'src/widget.zig',
        'const std = @import("std");\npub const Widget = struct { pub fn run(self: *Widget) void { helper(); } };',
        ['function', 'struct'],
        ['calls', 'imports'],
      ],
      [
        'src/Widget.jl',
        'module Demo\nusing Core\nstruct Widget <: Base\n value::Int\nend\nfunction run(x)\n helper(x)\nend\nend',
        ['function', 'module', 'struct'],
        ['calls', 'imports'],
      ],
      [
        'src/Widget.m',
        '#import <Foundation/Foundation.h>\n@interface Widget : Base <Runnable>\n- (void)run;\n@end\n@implementation Widget\n- (void)run { helper(); }\n@end',
        ['class', 'method'],
        ['calls', 'extends', 'implements', 'imports'],
      ],
      [
        'rtl/widget.sv',
        'package core_pkg; function int helper(); endfunction endpackage\nimport core_pkg::*; module widget; child u_child(); function int run(); return helper(); endfunction endmodule\nclass Driver extends BaseDriver; function void start(); helper(); endfunction endclass',
        ['class', 'function', 'module', 'package'],
        ['calls', 'constructs', 'extends', 'imports'],
      ],
    ] as const;

    for (const [path, content, expectedKinds, expectedRelations] of samples) {
      const facts = await runExtraction(inventoryFile(path, content));
      expect(
        facts.symbols.map(symbol => symbol.kind),
        path,
      ).toEqual(expect.arrayContaining([...expectedKinds]));
      expect(
        facts.edges.map(edge => edge.relation),
        path,
      ).toEqual(expect.arrayContaining([...expectedRelations]));
    }

    const [vue, svelte] = await Promise.all([
      runExtraction(inventoryFile('src/App.vue', '<template><Widget/><div></div></template>')),
      runExtraction(inventoryFile('src/App.svelte', '<Widget/><section></section>')),
    ]);
    for (const facts of [vue, svelte]) {
      expect(facts.edges.find(edge => edge.relation === 'constructs' && edge.targetName === 'Widget')).toBeDefined();
      expect(facts.edges.some(edge => edge.targetName === 'div' || edge.targetName === 'section')).toBe(false);
    }
  });

  it('detects every extended structural language without ambiguous matchers', () => {
    const expected = new Map([
      ['scripts/build.ps1', 'powershell'],
      ['modules/App.psm1', 'powershell'],
      ['modules/App.psd1', 'powershell-data'],
      ['lib/app.dart', 'dart'],
      ['contracts/App.sol', 'solidity'],
      ['lib/app.lua', 'lua'],
      ['src/App.scala', 'scala'],
      ['scripts/App.sc', 'scala'],
      ['lib/app.ex', 'elixir'],
      ['test/app.exs', 'elixir'],
      ['src/app.zig', 'zig'],
      ['src/App.jl', 'julia'],
      ['src/App.m', 'objective-c'],
      ['src/App.mm', 'objective-cpp'],
      ['src/App.vue', 'vue'],
      ['src/App.svelte', 'svelte'],
      ['rtl/App.v', 'verilog'],
      ['rtl/App.vh', 'verilog'],
      ['rtl/App.sv', 'systemverilog'],
      ['rtl/App.svh', 'systemverilog'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({_tag: 'Some', value: {language}});
    }
  });

  it('provides bounded deterministic structure for Fortran, Apex, and Razor without claiming AST coverage', async () => {
    const [fortran, apex, trigger, razor] = await Promise.all([
      runExtraction(
        inventoryFile(
          'src/solver.f90',
          'module solver\n  use iso_fortran_env\ncontains\n  subroutine run()\n    call helper()\n  end subroutine run\n  function helper() result(value)\n  end function helper\nend module solver\n',
        ),
      ),
      runExtraction(
        inventoryFile(
          'force-app/classes/Widget.cls',
          'public class Widget extends BaseWidget implements Runnable {\n  public void run() {\n    List<Account> rows = [SELECT Id FROM Account];\n  }\n}\n',
        ),
      ),
      runExtraction(
        inventoryFile(
          'force-app/triggers/AccountSync.trigger',
          'trigger AccountSync on Account (before insert) {\n}\n',
        ),
      ),
      runExtraction(
        inventoryFile(
          'Pages/Widget.razor',
          '@page "/widget"\n@using App.Core\n@inject IService Service\n@inherits WidgetBase\n<ChildWidget />\n<div></div>\n@code {\n  private void Refresh() { Service.Run(); }\n}\n',
        ),
      ),
    ]);

    expect(fortran.symbols.map(symbol => [symbol.kind, symbol.name])).toEqual(
      expect.arrayContaining([
        ['module', 'solver'],
        ['subroutine', 'run'],
        ['function', 'helper'],
      ]),
    );
    expect(fortran.edges.map(edge => [edge.relation, edge.targetName])).toEqual(
      expect.arrayContaining([
        ['imports', 'iso_fortran_env'],
        ['calls', 'helper'],
      ]),
    );
    expect(apex.symbols.map(symbol => symbol.kind)).toEqual(expect.arrayContaining(['class', 'method']));
    expect(apex.edges.map(edge => [edge.relation, edge.targetName])).toEqual(
      expect.arrayContaining([
        ['extends', 'BaseWidget'],
        ['implements', 'Runnable'],
        ['references', 'Account'],
      ]),
    );
    expect(trigger.symbols.map(symbol => symbol.kind)).toContain('trigger');
    expect(trigger.edges.map(edge => [edge.relation, edge.targetName])).toContainEqual(['references', 'Account']);
    expect(razor.symbols.map(symbol => [symbol.kind, symbol.name])).toEqual(
      expect.arrayContaining([
        ['route', '/widget'],
        ['method', 'Refresh'],
      ]),
    );
    expect(razor.edges.map(edge => [edge.relation, edge.targetName])).toEqual(
      expect.arrayContaining([
        ['imports', 'App.Core'],
        ['imports', 'IService'],
        ['extends', 'WidgetBase'],
        ['constructs', 'ChildWidget'],
      ]),
    );
    for (const facts of [fortran, apex, trigger, razor]) expect(facts.diagnostics).toEqual([]);
  });

  it('detects the bounded text-structural specialist formats', () => {
    const expected = new Map([
      ['src/legacy.f', 'fortran'],
      ['src/legacy.F90', 'fortran'],
      ['src/legacy.for', 'fortran'],
      ['src/legacy.f77', 'fortran'],
      ['src/legacy.f95', 'fortran'],
      ['src/legacy.f03', 'fortran'],
      ['src/legacy.f08', 'fortran'],
      ['force-app/classes/App.cls', 'apex'],
      ['force-app/triggers/App.trigger', 'apex-trigger'],
      ['Pages/App.razor', 'razor'],
      ['Views/App.cshtml', 'razor'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({_tag: 'Some', value: {language}});
    }
  });

  it('extracts SQL, config, schema, build, and container declarations without external runtimes', async () => {
    const samples = [
      [
        'db/schema.sql',
        'CREATE TABLE users (id int); CREATE VIEW active_users AS SELECT * FROM users;',
        ['table', 'view'],
        ['references'],
      ],
      ['config/app.json', '{"server":{"port":8080},"features":{"graph":true}}', ['property'], []],
      ['config/app.yaml', 'server:\n  port: 8080\nfeatures:\n  graph: true\n', ['property'], []],
      ['config/app.toml', '[server]\nport = 8080\n', ['property', 'table'], []],
      ['config/app.ini', '[server]\nport=8080\n', ['property', 'section'], []],
      [
        'schema/api.graphql',
        'interface Node { id: ID! }\ntype User implements Node { id: ID! }',
        ['interface', 'type'],
        [],
      ],
      [
        'schema/api.proto',
        'package acme;\nimport "common.proto";\nmessage User {}\nservice Users { rpc Get(User) returns (User); }',
        ['message', 'rpc', 'service'],
        ['imports'],
      ],
      [
        'build/App.csproj',
        '<Project><ItemGroup><PackageReference Include="Effect" /></ItemGroup><Target Name="Build" /></Project>',
        ['packagereference', 'target'],
        ['depends_on'],
      ],
      ['build/App.sln', 'Project("{A}") = "App", "App.csproj", "{B}"\nEndProject\n', ['project'], ['depends_on']],
      [
        'Dockerfile',
        'FROM oven/bun:1 AS build\nFROM scratch\nCOPY --from=build /app /app\n',
        ['stage'],
        ['depends_on'],
      ],
    ] as const;
    for (const [path, content, kinds, relations] of samples) {
      const facts = await runExtraction(inventoryFile(path, content));
      expect(
        facts.symbols.map(symbol => symbol.kind),
        path,
      ).toEqual(expect.arrayContaining([...kinds]));
      expect(
        facts.edges.map(edge => edge.relation),
        path,
      ).toEqual(expect.arrayContaining([...relations, 'contains']));
      expect(facts.diagnostics, path).toEqual([]);
    }
  });

  it('detects the complete structured schema and configuration matrix', () => {
    const expected = new Map([
      ['db/schema.sql', 'sql'],
      ['config/app.json', 'json'],
      ['config/app.jsonc', 'jsonc'],
      ['config/app.yaml', 'yaml'],
      ['config/app.yml', 'yaml'],
      ['config/app.toml', 'toml'],
      ['config/app.ini', 'ini'],
      ['config/app.properties', 'properties'],
      ['schema/api.graphql', 'graphql'],
      ['schema/api.graphqls', 'graphql'],
      ['schema/api.gql', 'graphql'],
      ['schema/api.proto', 'protobuf'],
      ['build/App.csproj', 'msbuild'],
      ['build/App.fsproj', 'msbuild'],
      ['build/App.vbproj', 'msbuild'],
      ['build/Directory.Build.props', 'msbuild'],
      ['build/Directory.Build.targets', 'msbuild'],
      ['ui/App.xaml', 'xaml'],
      ['build/App.sln', 'solution'],
      ['Dockerfile', 'dockerfile'],
      ['containers/Containerfile', 'dockerfile'],
    ]);
    for (const [path, language] of expected) {
      expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match(path), path).toMatchObject({_tag: 'Some', value: {language}});
    }
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

  it('separates parser cache identities from derived graph policy identities', () => {
    const policyChangedRegistry = createCodeGraphLanguagePackRegistry(
      BUILTIN_LANGUAGE_PACK_REGISTRY.packs.map(pack =>
        pack.id === 'swift' ? {...pack, version: `${pack.version}-next`} : pack,
      ),
    );
    const parserChangedRegistry = createCodeGraphLanguagePackRegistry(
      BUILTIN_LANGUAGE_PACK_REGISTRY.packs.map(pack =>
        pack.id === 'swift'
          ? {...pack, extractor: {...pack.extractor, version: `${pack.extractor.version}-next`}}
          : pack,
      ),
    );
    const originalTypeScript = Option.getOrThrow(BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('src/service.ts'));
    const changedTypeScript = Option.getOrThrow(parserChangedRegistry.cacheIdentityForPath('src/service.ts'));
    const originalSwift = Option.getOrThrow(
      BUILTIN_LANGUAGE_PACK_REGISTRY.cacheIdentityForPath('Sources/App/Main.swift'),
    );
    const policyChangedSwift = Option.getOrThrow(policyChangedRegistry.cacheIdentityForPath('Sources/App/Main.swift'));
    const parserChangedSwift = Option.getOrThrow(parserChangedRegistry.cacheIdentityForPath('Sources/App/Main.swift'));

    expect(changedTypeScript).toBe(originalTypeScript);
    expect(policyChangedSwift).toBe(originalSwift);
    expect(parserChangedSwift).not.toBe(originalSwift);
    expect(parserChangedRegistry.activeCacheIdentities(['src/service.ts'])).toEqual([originalTypeScript]);
    expect(policyChangedRegistry.activeDerivationIdentities(['Sources/App/Main.swift'])).not.toEqual(
      BUILTIN_LANGUAGE_PACK_REGISTRY.activeDerivationIdentities(['Sources/App/Main.swift']),
    );
  });

  it('keeps rationale derivation out of cached parser facts', async () => {
    const file = inventoryFile('src/rationale.ts', '// WHY: preserve parser facts\nexport function run(): void {}\n');
    const provideRuntime = <A, E>(effect: Effect.Effect<A, E, TreeSitterRuntime>) =>
      effect.pipe(
        Effect.provide(TreeSitterRuntime.layer),
        Effect.provide(SystemInfo.layer),
        Effect.provide(BunServices.layer),
      );
    const raw = await Effect.runPromise(provideRuntime(BUILTIN_LANGUAGE_PACK_REGISTRY.extractRawFile(file)));
    const derived = BUILTIN_LANGUAGE_PACK_REGISTRY.postprocessFile(file, raw);

    expect(raw.symbols.some(symbol => symbol.kind === 'rationale')).toBe(false);
    expect(derived.symbols.some(symbol => symbol.kind === 'rationale')).toBe(true);
    expect(derived).toEqual(await Effect.runPromise(provideRuntime(BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file))));
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
