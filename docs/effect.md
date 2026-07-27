# Effect architecture

Threadnote 4 uses Effect services as capability boundaries:

- `ResourceStore` owns canonical URI operations, containment, locking, atomic replacement, and compare-and-swap.
- `LocalModelStore` owns resumable downloads, free-space checks, verification, and atomic model promotion.
- `LocalModelRuntime` owns optional embedding, reranking, and structured generation.
- `SystemInfo`, `HttpService`, `CommandExecutor`, and digest services isolate platform effects.

Domain code does not import `node-llama-cpp`. The single native adapter requests a prebuilt binary with downloads and
builds disabled, and its layer scopes disposal in dependency order. `LocalModelRuntime` lazily builds one engine per
application process, caches model sessions by role/model/hash/path, and serializes native inference.

Effect’s unstable `EmbeddingModel` service is the embedding harness. Threadnote-owned service ports cover reranking and
JSON-schema generation because those contracts are product-specific. Tests replace all three with pure Layers, so
normal unit and recall-quality tests never load a native module or model.

The canonical store and lexical recall work without inference services. Missing, corrupt, incompatible, or interrupted
optional inference fails open to deterministic recall and produces diagnostics. A complete vector generation is never
replaced by a partial one.

Architecture tests enforce that raw filesystem, process, HTTP, crypto, and native-addon access stays inside adapters.
