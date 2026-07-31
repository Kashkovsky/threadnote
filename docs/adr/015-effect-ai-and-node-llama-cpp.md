# ADR 015: Effect AI harness and node-llama-cpp

Status: accepted for 4.0
Date: 2026-07-27

## Decision

Local inference uses the N-API-compatible `node-llama-cpp` 3.19.1 package in a supervised worker launched from the
same standalone Threadnote executable. The CLI, MCP, or manager parent process never loads the native addon. The worker
is lazy and stays warm for a five-minute idle window, after which it unloads; the next request lazily respawns exactly
one worker. The timeout is configurable through `THREADNOTE_LOCAL_MODEL_WORKER_IDLE_TIMEOUT_MS`, with `0` disabling
eviction, without turning inference into a daemon or separately installed service. Core embedding is required
Threadnote functionality; reranking and structured generation are optional roles. Release archives include exactly
one target-compatible prebuilt native payload; runtime builds and binary downloads remain disabled. No domain module
imports the addon directly.

Effect’s unstable `EmbeddingModel` is the embedding harness. Threadnote owns small typed services for reranking and
JSON-schema generation, composed behind `LocalModelRuntime`. The parent Layer serializes requests over a versioned
JSON-lines protocol. The worker Layer lazily creates one llama engine, caches model contexts by role/model/hash/path,
serializes inference, and disposes child contexts before models and the engine.

A worker transport fault—crash, unexpected exit, protocol failure, closed input, or request deadline—discards the
worker and retries the operation once in a fresh process. A second transport fault becomes a typed, bounded failure;
stderr retention, protocol response buffering, and request duration are bounded as well. This contains a native crash
without hiding a repeatable failure or extending a foreground command indefinitely.

The pinned 36.7 MB BGE Small embedding model is downloaded, verified, selected, and preserved automatically by install
and repair. Additional embedding candidates, rerankers, and generation models remain explicit choices. Immutable
manifests pin revision, SHA-256, byte size, role, dimensions or context, prompt prefixes, normalization, quantization,
runtime, license, and minimum memory. Partial or unverified files are never loaded.

The built-in BGE Small manifest requests `gpuLayers: 0` on Darwin arm64. This keeps its transformer layers on CPU on
the constrained `macos-15` release runner and reduces exposure to the observed Metal embedding fault. The packaged
arm64 addon is still the Metal build and still initializes the Metal backend, so this policy is mitigation, not proof
that Metal or any specific upstream component is the root cause. Other models do not inherit this override.

## Consequences

- Tests replace inference with fake Layers and never need a model or native module.
- Transport tests replace the worker spawner and exercise crash, timeout, restart, and retry behavior without loading
  native code.
- Unstable Effect APIs are isolated and can be migrated behind the Threadnote port.
- Lexical recall remains the deterministic fail-open path when core native inference is temporarily unavailable;
  doctor reports that degraded state as a core-capability failure.
- Embedding is not implemented as bespoke inference math inside Threadnote; Threadnote implements orchestration,
  lifecycle, storage, and evaluation around a maintained llama.cpp binding.
