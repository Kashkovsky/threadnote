# Third-party software

Threadnote 4 is a self-contained application with an embedded Bun runtime. It does not install or invoke Node.js,
Python, OpenViking, or a separate memory server.

## Runtime and bundled software

Direct runtime software and packages bundled into the published JavaScript retain their own licenses:

- `node-llama-cpp` (MIT), used in a supervised local worker with prebuilt `llama.cpp` binaries for GGUF inference
- Bun (MIT), embedded into each compiled executable
- `effect`, `@effect/platform-bun`, `@effect/ai-openai-compat`, `@effect/sql-sqlite-bun`, and `@effect/vitest` (MIT)
- `@modelcontextprotocol/sdk` (MIT)
- `react`, `react-dom`, and `react-markdown` (MIT)
- `remark-gfm` (MIT)
- `three` (MIT), used for GPU-accelerated manager graph rendering
- `js-yaml` (MIT)
- TypeScript compiler 5.9 (`typescript-compiler`, Apache-2.0), bundled for native TypeScript/JavaScript graph extraction
- `web-tree-sitter` 0.26.11 (MIT), bundled as the portable structural parser runtime
- `tree-sitter-java` 0.23.5 (MIT), bundled as a verified WASM grammar
- `tree-sitter-kotlin` 0.3.8 plus pinned upstream revision `c8ac3d2` (MIT), bundled as a verified WASM grammar
- `tree-sitter-swift` 0.7.3 (MIT), bundled as a verified WASM grammar

Grammar and parser license copies, source revisions, ABIs, and SHA-256 checksums are included under
`assets/code-graph/`. Consult those files and each installed package's metadata for the authoritative terms. The
pinned MIT-licensed BGE Small embedding model is installed automatically by `threadnote install`; other model files
require an explicit `threadnote models install` action. Catalog entries identify every model source and license.

## Public website

The separately deployed GitHub Pages website is not part of the standalone release. Its build uses Vite and
`@vitejs/plugin-react` (MIT), and it self-hosts Spline Sans and JetBrains Mono through Fontsource packages. The font
packages and font files are distributed under the SIL Open Font License 1.1. A copy is included with the website
assets.

## Historical migration compatibility

Threadnote 4 can read a legacy `~/.openviking` directory during the explicit, non-destructive home migration. That
compatibility path copies user-owned data into `~/.threadnote`, excludes old runtime artifacts, and never executes or
bundles OpenViking code. OpenViking is not a Threadnote 4 runtime dependency.
