# Effect architecture

Threadnote 4 has one supported application runtime: the Bun runtime embedded into each release executable. Each CLI,
stdio MCP, or foreground manager process owns one root Effect runtime and scope; no service creates a nested runtime,
daemon, or hidden localhost dependency. Effect services form the capability boundaries:

- `ResourceStore` owns canonical URI operations, containment, locking, atomic replacement, and compare-and-swap.
- Obsidian source synchronization commits sanitized external resources through `ResourceStore`; configuration,
  boundary-safe inventory, deterministic projection, navigation, and Inbox candidate persistence compose as Effects
  through the shared filesystem, path, crypto, clock, command, lock, and system services.
- `LocalModelStore` owns resumable downloads, free-space checks, verification, and atomic model promotion.
- `LocalModelRuntime` owns core embedding plus optional reranking and structured generation.
- `@effect/sql-sqlite-bun` owns scoped lexical-index connections over Bun's built-in SQLite runtime.
- `SystemInfo`, `HttpService`, `CommandExecutor`, and digest services isolate platform effects.

Domain code does not import `node-llama-cpp`. The single native adapter requests a prebuilt binary with downloads and
builds disabled, and its layer scopes disposal in dependency order. `LocalModelRuntime` lazily builds one engine per
application process, caches model sessions by role/model/hash/path, and serializes native inference.

Effect’s unstable `EmbeddingModel` service is the embedding harness. Threadnote-owned service ports cover reranking and
JSON-schema generation because those contracts are product-specific. Tests replace all three with pure Layers, so
normal unit and recall-quality tests never load a native module or model.

The canonical store remains independent of every derived index. The core embedding model is automatically provisioned
by install and repair; missing, corrupt, incompatible, or interrupted inference still fails open to deterministic
lexical recall and produces a failing doctor diagnostic. A complete vector generation is never replaced by a partial
one. Reranking and structured generation remain optional roles.

Architecture tests enforce that raw filesystem, process, HTTP, crypto, and native-addon access stays inside adapters.
Application modules and build scripts do not import `node:*` modules; Effect's Bun filesystem, path, command, HTTP,
socket, server, terminal, and SQLite adapters provide those capabilities.
See [architecture.md](architecture.md) for the complete storage and recall data flow.
Obsidian workflows do not create an internal runtime or shell through a second memory platform.
