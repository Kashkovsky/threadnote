# ADR 015: Effect AI harness and node-llama-cpp

Status: accepted for 4.0
Date: 2026-07-27

## Decision

Local inference runs inside the supported Node.js process through `node-llama-cpp` 3.19.1. Core embedding is required
Threadnote functionality; reranking and structured generation are optional roles. The adapter requests prebuilt
binaries with runtime builds and binary downloads disabled. No domain module imports the addon directly.

Effect’s unstable `EmbeddingModel` is the embedding harness. Threadnote owns small typed services for reranking and
JSON-schema generation, composed behind `LocalModelRuntime`. The application Layer lazily creates one llama engine,
caches model contexts by role/model/hash/path, serializes inference, and disposes child contexts before models and the
engine.

The pinned 36.7 MB BGE Small embedding model is downloaded, verified, selected, and preserved automatically by install
and repair. Additional embedding candidates, rerankers, and generation models remain explicit choices. Immutable
manifests pin revision, SHA-256, byte size, role, dimensions or context, prompt prefixes, normalization, quantization,
runtime, license, and minimum memory. Partial or unverified files are never loaded.

## Consequences

- Tests replace inference with fake Layers and never need a model or native module.
- Unstable Effect APIs are isolated and can be migrated behind the Threadnote port.
- Lexical recall remains the deterministic fail-open path when core native inference is temporarily unavailable;
  doctor reports that degraded state as a core-capability failure.
- Embedding is not implemented as bespoke inference math inside Threadnote; Threadnote implements orchestration,
  lifecycle, storage, and evaluation around a maintained llama.cpp binding.
