# Effect architecture

Threadnote 4 uses Effect services as capability boundaries:

- `ResourceStore` owns canonical URI operations, containment, locking, atomic replacement, and compare-and-swap.
- `LocalModelStore` owns resumable downloads, free-space checks, verification, and atomic model promotion.
- `LocalModelRuntime` owns core embedding plus optional reranking and structured generation.
- `@effect/sql-sqlite-node` owns scoped lexical-index connections over Node's built-in SQLite runtime.
- `SystemInfo`, `HttpService`, `CommandExecutor`, and digest services isolate platform effects.

Domain code does not import `node-llama-cpp`. The single native adapter requests a prebuilt binary with downloads and
builds disabled, and its layer scopes disposal in dependency order. `LocalModelRuntime` lazily builds one engine per
application process, caches model sessions by role/model/hash/path, and serializes native inference.

Effect’s unstable `EmbeddingModel` service is the embedding harness. Threadnote-owned service ports cover reranking and
JSON-schema generation because those contracts are product-specific. Tests replace all three with pure Layers, so
normal unit and recall-quality tests never load a native module or model.

The canonical store remains independent of every derived index. The core embedding model is provisioned by install and
repair; missing, corrupt, incompatible, or interrupted inference still fails open to deterministic lexical recall and
produces a failing doctor diagnostic. A complete vector generation is never replaced by a partial one.

Architecture tests enforce that raw filesystem, process, HTTP, crypto, and native-addon access stays inside adapters.
