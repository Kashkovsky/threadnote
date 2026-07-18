# Contributing to Threadnote

Thank you for improving Threadnote. Contributions to the CLI, MCP server, web manager, documentation, tests, and agent
workflows are welcome.

For a small fix, opening a focused pull request is usually enough. For a broad feature, behavior change, or migration,
open an issue first so the intended contract can be agreed before substantial implementation work begins.

## Development setup

You need:

- Node.js 20 or newer;
- npm;
- uv and Python 3.12 only when running the live OpenViking end-to-end suite.

Install dependencies and run the fast validation set:

```bash
npm ci
npm run lint
npm run prettier:check
npm run typecheck
npm test
```

Run the source CLI or MCP server during development with:

```bash
npm run dev -- --help
npm run dev:mcp-server
```

Do not commit credentials, API keys, private memories, customer data, raw production logs, or a local OpenViking
datastore. Test fixtures must use synthetic data.

## Architecture expectations

Threadnote uses Effect 4 beta for infrastructure and orchestration. See [`docs/effect.md`](./docs/effect.md) before
changing the CLI, lifecycle, manager, MCP, command execution, HTTP, retry, or AI code.

Keep these invariants intact:

- Each executable constructs one Effect, provides the application layer once, and runs it once at `main`.
- Library workflows return and compose Effects. Do not introduce internal `runPromise`, `runFork`, or repeated runtime
  boundaries.
- Expected failures belong in typed Effect error channels. Use defects for truly unexpected programmer errors.
- Use `Scope` or `acquireRelease` for servers, temporary directories, child processes, and other resources that require
  cleanup.
- MCP inputs use Effect Schema as the source for types, runtime validation, descriptions, and emitted JSON Schema.
- Pure transformations and React state may remain plain TypeScript when Effect would not improve composition or error
  handling.
- The npm package is ESM. The checked-in `.cjs` files under `bin/` must remain tiny dynamic-import launchers rather than
  bundling CommonJS copies of the application.
- Keep `effect`, `@effect/platform-node`, `@effect/vitest`, and `@effect/ai-openai-compat` pinned to the same exact beta.

Threadnote intentionally uses `effect/unstable/*`. API instability is acceptable, but an upgrade must update its
adapters and compatibility tests together.

## Tests and validation

Add or update the narrowest test that protects the behavior you changed. Unit tests cover pure logic and Effect
services; integration tests cover CLI, MCP, manager, lifecycle, and protocol boundaries.

Before opening a pull request, run:

```bash
npm run lint
npm run prettier:check
npm run typecheck
npm run test:coverage
npm run build
npm run check:bundle-size
npm run pack:dry-run
```

`typecheck` intentionally checks the supported TypeScript compiler and the TypeScript 7 release candidate. Do not fix
one by weakening the other. Bundle-size failures should trigger a dependency or bundling review rather than an
unexplained limit increase.

### Live OpenViking end-to-end tests

Run the live suite when a change affects any of the following:

- the OpenViking version, configuration, installer, CLI arguments, URI semantics, or datastore behavior;
- Threadnote CLI launchers or argument parsing;
- MCP schemas, forwarding, or native parity;
- manager APIs, shutdown, or Effect AI consolidation;
- sharing, memory lifecycle, OVPack import/export, packaging, or generated distribution bundles;
- Effect runtime, resource, interruption, or error-boundary behavior.

```bash
npm run test:e2e:install-openviking
npm run test:e2e:local-bins
```

The installer selects the exact version pinned in `src/constants.ts`. If uv rejects a malformed prebuilt
`llama-cpp-python` wheel, it retries with a bounded local source build, which can take several minutes.

The suite starts a real OpenViking server on a random local port, uses a suite-scoped temporary datastore, exercises the
built and npm-packed binaries, and removes the datastore after the run. It must never use or mutate the contributor's
normal OpenViking store. Do not replace the live server with a mock merely to make an upgrade pass.

## Updating OpenViking

The OpenViking pin is a compatibility contract. For an upgrade:

1. Read every official OpenViking release note between the current pin and the target version.
2. Identify changes to URI rules, identity and tenancy, CLI output, MCP schemas, import/export, storage, and retrieval.
3. Update `DEFAULT_OPENVIKING_VERSION` in `src/constants.ts` and any user-facing version examples.
4. Install the new version with `npm run test:e2e:install-openviking`.
5. Run the complete live suite and address behavioral incompatibilities in code and tests.
6. Run all normal validation and packaging gates.

Do not loosen version assertions or skip failing live scenarios without documenting a deliberate compatibility change.

## Changing MCP tools

Keep tool names and the default core toolset compact and backward-compatible. When adding or changing an input:

- define it with Effect Schema through the MCP adapter;
- preserve documented aliases when removing them would break existing agents;
- test emitted JSON Schema and runtime rejection;
- test forwarding to a real OpenViking MCP server when the parameter is native;
- consider the context cost before adding a tool to the six-tool core surface.

## Documentation and generated output

Update documentation in the same pull request as behavior. Keep `README.md` concise and put architectural or
operational detail under `docs/`.

`dist/` and `manager/app.js` are generated by `npm run build`; do not hand-edit them. Always run the build and package
checks when changing entrypoints, dependencies, manager UI code, or build scripts.

## Pull requests

A pull request should explain:

- the problem and intended behavior;
- important design choices or compatibility constraints;
- tests and manual checks performed;
- migration, security, packaging, or documentation impact;
- any known limitation or follow-up work.

Keep unrelated refactors out of a focused fix. Preserve user changes already present in the worktree, and do not commit
generated local state or secrets.

By submitting a contribution, you agree that it is licensed under the repository's
[AGPL-3.0-or-later license](./LICENSE).
