# Third-party software

Threadnote 4 is a self-contained Node.js application. It does not install or invoke a Python runtime, OpenViking, or a
separate memory server.

## Runtime and bundled npm software

Direct runtime software and packages bundled into the published JavaScript retain their own licenses:

- `node-llama-cpp` (MIT), used in-process with prebuilt `llama.cpp` binaries for local GGUF inference
- `effect`, `@effect/platform-node`, `@effect/ai-openai-compat`, `@effect/sql-sqlite-node`, and `@effect/vitest` (MIT)
- `@modelcontextprotocol/sdk` (MIT)
- `react`, `react-dom`, and `react-markdown` (MIT)
- `remark-gfm` (MIT)
- `js-yaml` (MIT)

Consult each installed package's metadata and license files for the authoritative terms. The pinned MIT-licensed BGE
Small embedding model is installed automatically by `threadnote install`; other model files require an explicit
`threadnote models install` action. Catalog entries identify every model source and license.

## Historical migration compatibility

Threadnote 4 can read a legacy `~/.openviking` directory during the explicit, non-destructive home migration. That
compatibility path copies user-owned data into `~/.threadnote`, excludes old runtime artifacts, and never executes or
bundles OpenViking code. OpenViking is not a Threadnote 4 runtime dependency.
