# Polyglot code graph implementation plan

Status: implemented and release-gated on the Threadnote 4 development branch (updated 2026-07-31).

## Implementation result

All architectural phases in this plan are implemented:

- the generated built-in catalog currently registers documentation, manifests, corpus, structured-schema,
  TypeScript/JavaScript, Java, Kotlin, Swift, Bash, C, C++, C#, Dart, Elixir, Go, HCL/Terraform, Julia, Lua,
  Objective-C, PHP, PowerShell, Python, Ruby, Rust, Scala, Solidity, Svelte, SystemVerilog/Verilog, Vue, Zig, Apex,
  Fortran, and Razor packs;
- TypeScript/JavaScript remains compiler-backed, and its frozen evaluation fixture still produces the exact reviewed
  1.0 recall/MRR, 1.0 no-answer precision/recall, and zero authoritative false-edge baseline;
- Java, Kotlin, Swift, and the other portable structural source packs use bundled, checksum-verified Tree-sitter WASM
  assets with pinned source revisions, ABIs, versions, and licenses;
- Apex, Fortran, and Razor use bounded deterministic text-structural extraction and make no AST coverage claim;
- language-neutral workspace attribution and typed references cover nested and integrated Maven/Gradle, SwiftPM, and
  conservative Xcode scopes without executing repository build logic;
- repository resolution and graph-vector construction operate through bounded SQLite pages, with transactional
  snapshot/generation activation and no repository coverage caps;
- CLI and MCP `query`, `explain`, `path`, and `impact` operations pass the compiled standalone polyglot smoke with no
  Node, Python, external Bun, compiler, JVM, Swift, or build tool available. Separate whole-graph analysis adds
  statistics, structural communities, hubs, and surprising links without changing the language-pack contract;
- the frozen polyglot fixture also produces 1.0 recall/MRR and no-answer metrics with zero authoritative false edges;
- the 10,000-symbol production-vector gate passes with 10,103 stored symbols and 20,000 stored edges. More detailed
  dynamic build-file semantics can be added inside workspace detectors without changing the pack, index, storage,
  query, CLI, or MCP contracts.

## Objective

Extend the native code graph to Java, Kotlin, and Swift while establishing a language-extension contract that allows
future languages to be added without changing inventory, indexing, storage, querying, CLI, or MCP architecture.

The implementation must remain:

- self-contained and offline at runtime;
- free of Python, JVM, Swift, Maven, Gradle, and Xcode runtime requirements;
- honest about `declared`, `resolved`, `syntactic`, `heuristic`, and `model` provenance;
- bounded in transient memory without truncating repository graph facts;
- safe for large, nested, and partially integrated monorepos;
- compatible with the existing `query`, `explain`, `path`, and `impact` interfaces.

## Existing constraints

The current implementation is not an acceptable foundation for adding languages directly:

- inventory extensions and language detection are hard-coded in `src/code_graph/inventory.ts`;
- parsing, manifests, package attribution, TypeScript resolution, and fact helpers share
  `src/code_graph/extractor.ts`;
- the indexer uses one global parser cache identity, so changing one extractor can invalidate every cached file;
- unresolved reference intent is encoded into `targetName` strings;
- repository resolution retains global symbol and re-export collections in JavaScript;
- vector selection receives the complete resolved symbol collection.

The first implementation milestone therefore establishes the extension architecture without changing existing
TypeScript graph behavior.

## Target pipeline

```text
Git inventory
    |
    v
LanguagePackRegistry.match(path)
    |
    +--> workspace detectors --> projects, modules, source roots, dependencies
    |
    v
extractor backend
    +--> TypeScript compiler
    +--> Tree-sitter WASM
    +--> manifest/document parser
    |
    v
normalized symbols + references + declared/resolved edges
    |
    v
bounded SQLite staging and resolution
    |
    v
atomic snapshot + paged vector indexing
    |
    v
unchanged CLI and MCP graph operations
```

## Language-pack contract

Each pack owns language-specific classification, extraction, workspace discovery, resolution-key generation,
capabilities, versions, and verified runtime assets.

```ts
interface CodeGraphLanguagePack {
  readonly id: string;
  readonly version: string;
  readonly files: ReadonlyArray<FileMatcher>;
  readonly extractor: CodeGraphExtractor;
  readonly workspaceDetector: Option.Option<WorkspaceDetector>;
  readonly resolutionStrategy: ResolutionStrategy;
  readonly assets: ReadonlyArray<VerifiedLanguageAsset>;
  readonly capabilities: ReadonlySet<GraphCapability>;
}
```

Optional contract fields use Effect `Option`, not nullable unions.

Adding a first-party language after this work should require only:

- `src/code_graph/languages/<language>/`;
- grammar and query assets when applicable;
- fixtures and benchmark expectations;
- source revision, checksum, ABI, and license metadata.

A build-time catalog generator discovers pack directories and emits static imports for standalone compilation.
Repository files can never provide executable pack code. Initial packs are bundled and trusted; the manifest remains
data-oriented so signed, data-only external packs can be introduced later without redesigning the graph.

## Parser runtime

The preferred portable structural backend is exact-pinned `web-tree-sitter` with bundled grammar WASM files and
Threadnote-owned query bundles.

Requirements:

- prove WASM initialization and asset loading in every standalone release target before adoption;
- pin the runtime, grammar source commit, ABI, query bundle, and checksum together;
- perform no runtime downloads;
- initialize the runtime once and maintain a bounded parser pool;
- bound source bytes in flight and process extracted facts incrementally;
- release each syntax tree immediately after extraction;
- isolate parse errors to one file and record bounded diagnostics;
- keep the pack contract independent of the parser backend.

If WASM misses the Phase 0 performance budget, a Threadnote-controlled native parser runtime may replace it without
changing packs or indexing architecture.

## Normalized intermediate representation

Extraction emits declarations and unresolved reference intent separately. It does not encode resolver instructions
inside edge display names.

Declarations include:

- stable language and resolution domains;
- project/module/source-root scope;
- namespace, qualified name, kind, and overload discriminator;
- lookup keys used by the generic resolver;
- signature, documentation, span, and visibility.

References include:

- source declaration and evidence span;
- relation and provenance;
- name, qualifier, import/module context, and optional arity;
- ordered candidate lookup keys;
- language-specific resolution domain.

Java and Kotlin share the `jvm` resolution domain. Swift uses its module domain. TypeScript preserves its existing
module and workspace rules behind the same contract.

The generic resolver resolves only unique, grounded candidates at the applicable precedence. Ambiguous or incomplete
references remain syntactic.

## Workspace model

Language-neutral workspace tables represent:

- repository projects and nested modules;
- source roots and source-set roles;
- module dependencies;
- file-to-project attribution;
- language and resolution domains.

Workspace detectors are static and containment-safe. Threadnote does not execute repository build scripts.

Initial detectors:

- existing npm and TypeScript projects;
- Maven aggregators and modules;
- Gradle settings, projects, dependencies, and conventional or declared source sets;
- Kotlin Multiplatform and Android source sets;
- SwiftPM packages, products, and targets;
- Xcode projects, targets, build phases, and source membership.

Dynamic build logic that cannot be proven statically produces diagnostics and conservative fallback scopes.

## Cache and snapshot identity

Each file fact cache key includes only its applicable:

- pack ID and version;
- parser runtime and grammar checksum;
- query and extraction-policy checksum;
- relevant workspace/context fingerprint.

Updating one pack must not invalidate unrelated languages. Snapshot extractor identity hashes only packs active in the
repository and relevant workspace context. One-file edits reuse all unaffected cached facts.

## Scalable resolution and embedding

SQLite staging tables hold declarations, lookup keys, unresolved references, and candidate keys. Resolution operates in
bounded pages and indexed joins. No repository-wide symbol, edge, or reference collection is retained in JavaScript.

High-value embedding candidates are read from SQLite in deterministic pages. Existing vector reuse and snapshot
activation remain atomic.

Transient batch and parser-pool bounds are safety controls, not repository coverage limits. All eligible facts are
eventually persisted.

## Language scope

### Java

- classes, interfaces, enums, records, annotations, methods, constructors, fields, packages, and modules;
- imports, calls, construction, inheritance, implementation, overrides, annotations, and declared dependencies;
- Maven multi-module projects, Gradle modules, configured/conventional source sets, and `module-info.java`.

### Kotlin

- classes, interfaces, objects, companions, enums, data/value classes, functions, properties, constructors, type
  aliases, and extension functions;
- import aliases, calls, construction, inheritance, overrides, and declared dependencies;
- JVM, Android, and Kotlin Multiplatform source sets;
- grounded Java-to-Kotlin and Kotlin-to-Java relationships through shared JVM lookup keys.

### Swift

- classes, structs, enums, protocols, actors, extensions, functions, properties, initializers, subscripts, and type
  aliases;
- imports, calls, construction, inheritance, protocol conformance, overrides, and declared dependencies;
- SwiftPM packages, products, targets, and source roots;
- Xcode targets, build phases, and source membership.

Structural extraction is not presented as type-checker output. Calls or members that require unavailable type
information remain syntactic. Optional SCIP or compiler-index imports may later promote independently verified facts.

## Delivery phases

### Phase 0: baselines and runtime qualification

- store current TypeScript correctness and performance baselines;
- add versioned polyglot evaluation fixtures and a generated large mixed-monorepo benchmark;
- prove grammar WASM loading and disposal from compiled standalone artifacts;
- compare Kotlin grammar candidates against pinned compiler fixtures;
- benchmark cold, incremental, and hot graph behavior;
- add a synthetic test language pack that exercises the complete extension contract.

No feature phase merges until correctness, memory, latency, cache-reuse, and package-size budgets are committed.

### Phase 1: language-pack boundary

- add `LanguagePackRegistry` and generated built-in catalog;
- make inventory classification registry-driven;
- move TypeScript/JavaScript, manifests, and Markdown behind packs;
- add pack versions and coverage to status and diagnostics;
- introduce pack-scoped file cache identities;
- preserve existing TypeScript graph output and evaluation results.

### Phase 2: language-neutral workspace and resolution

- introduce normalized declarations and references;
- add project, source-root, lookup-key, and reference staging tables;
- replace resolver sentinel strings with typed reference records;
- move resolution to paged SQLite operations;
- page embedding candidates from SQLite;
- automatically rebuild disposable derived graph data for the schema change.

### Phase 3: JVM foundation and Java

- implement Maven and Gradle workspace detectors;
- implement the Java grammar/query pack;
- add package, module, import, inheritance, and unique-reference resolution;
- cover nested/integrated monorepos and CLI/MCP operations.

### Phase 4: Kotlin and JVM interoperability

- qualify and pin the Kotlin grammar;
- implement Kotlin declarations and references;
- add Gradle, Android, and KMP source-set attribution;
- add shared JVM lookup keys and Java/Kotlin interop fixtures;
- fail closed for overload, extension, and receiver ambiguity.

### Phase 5: Swift

- pin and bundle the Swift grammar;
- implement Swift declarations, references, module rules, and protocol conformance;
- add SwiftPM and Xcode workspace detectors;
- cover multi-target packages and projects.

### Phase 6: hardening and release

- run large polyglot correctness and performance gates;
- verify install/update preservation and graph rebuild progress;
- verify every standalone archive contains matching grammar assets, checksums, and licenses;
- add full CLI/MCP E2E coverage;
- update architecture, ADR, troubleshooting, manager, and release documentation.

## Required gates

- A synthetic fourth language is added without editing core graph files.
- Existing TypeScript/JavaScript metrics do not regress.
- Authoritative false-edge rate remains zero.
- Ambiguity remains syntactic and never receives a target ID.
- Updating one pack preserves caches for all unrelated languages.
- Incremental edits reuse every unaffected file fact.
- Indexing retains no repository-sized JavaScript symbol/reference collection.
- Parser failures remain file-local.
- Nested and integrated monorepo modules remain distinct but connect through declared dependencies.
- All four graph operations work through both CLI and MCP for every supported language.
- No Python, external compiler/build tool, daemon, or runtime network access is required.
- Standalone checks verify grammar source, version, ABI, checksum, and license metadata.
