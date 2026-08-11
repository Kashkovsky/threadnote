# Contributing to Threadnote

Thank you for improving Threadnote. Contributions to the CLI, MCP server, web manager, documentation, tests, and agent
workflows are welcome.

For a small fix, opening a focused pull request is usually enough. For a broad feature, behavior change, or migration,
open an issue first so the intended contract can be agreed before substantial implementation work begins.

## Development setup

You need:

- Bun `1.3.14`.

Install dependencies and run the fast validation set:

```bash
bun install --frozen-lockfile
bun run lint
bun run prettier:check
bun run typecheck
bun run test
```

Run the source CLI or MCP server during development with:

```bash
bun run dev -- --help
bun run dev:mcp-server
```

Do not commit credentials, API keys, private memories, customer data, raw production logs, or a local Threadnote home.
Test fixtures must use synthetic data.

## Architecture expectations

Threadnote uses Effect 4 beta for infrastructure and orchestration. Preserve the capability, lifecycle, and runtime
boundaries below when changing the CLI, lifecycle, manager, MCP, command execution, HTTP, retry, or AI code.

Keep these invariants intact:

- The application constructs one Effect, provides the application layer once, and runs it once in `src/standalone.ts`.
  The signal-transparent diagnostics worker is a mutually exclusive root execution path, not a nested runtime.
- Independent build, benchmark, and evaluation scripts are separate executables and may run one top-level Effect. Their
  workflows still compose Effects internally and must not start a nested runtime.
- Library workflows return and compose Effects. Do not introduce internal `runSync`, `runPromise`, `runFork`,
  `runCallback`, `ManagedRuntime.make`, or repeated runtime boundaries.
- Expected failures belong in typed Effect error channels. Use defects for truly unexpected programmer errors.
- Use the shared `fromPromise`/`fromSync` adapters in `src/effect/errors.ts` for compatibility helpers; do not add
  module-local Promise-lifting helpers or a generic Promise bridge in the CLI.
- Use Effect's `Console` service for application output. Promise compatibility code must use the scoped adapter in
  `src/effect/console.ts`; raw `console.*` calls are rejected by the architecture tests.
- Use `Scope` or `acquireRelease` for servers, temporary directories, child processes, and other resources that require
  cleanup.
- MCP inputs use Effect Schema as the source for types, runtime validation, descriptions, and emitted JSON Schema.
- Pure transformations and React state may remain plain TypeScript when Effect would not improve composition or error
  handling.
- The release entrypoint is ESM and compiles to a bytecode-enabled standalone executable with the pinned Bun runtime.
- Use Effect's Bun platform services for filesystem, path, command, HTTP, terminal, server, socket, and SQLite access.
  Application and build-script code must not import `node:*` modules.
- Keep `effect`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`, `@effect/vitest`, and
  `@effect/ai-openai-compat` pinned to the same exact beta.
- Effectful tests use `it.effect`, `it.scoped`, or their property variants from `@effect/vitest`. Do not convert an
  Effect to a Promise or run it synchronously inside a Vitest callback.

Threadnote intentionally uses `effect/unstable/*`. API instability is acceptable, but an upgrade must update its
adapters and compatibility tests together.

## Tests and validation

Add or update the narrowest test that protects the behavior you changed. Unit tests cover pure logic and Effect
services; integration tests cover CLI, MCP, manager, lifecycle, and protocol boundaries.

Before opening a pull request, run:

```bash
bun run lint
bun run prettier:check
bun run typecheck
bun run test:coverage
bun run build
bun run check:self-contained
bun run test:smoke:self-contained
```

`typecheck` intentionally uses TypeScript 7 for both source and test code.

Lint adopts new Effect and platform boundaries incrementally: existing files report the new rules as warnings, while
files changed in the working tree are checked as errors. Pull-request CI applies the error policy to the complete PR
diff using the base commit supplied by GitHub. The initial rollout is anchored to the pre-policy source commit, so code
that was already on this development line is not misclassified as new during the adoption PR.

### CI changed-path routing

Pull-request CI classifies the complete merge-base diff and enables checks by dependency scope. Scopes are monotonic:
adding a changed path can only add checks, and an empty, invalid, or unrecognized path inventory enables every scope.

| Change surface                                   | Required CI work                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Documentation only                               | Formatting                                                                                    |
| `website/**` only                                | Formatting, website contracts, and website build                                              |
| Unit or integration tests only                   | Lint, typecheck, and coverage                                                                 |
| Runtime and release inputs                       | General checks, standalone build, bytecode targets, platform release smoke, and Windows smoke |
| Recall, vector, evaluation, or code-graph inputs | General checks plus recall/graph quality and the separately path-filtered benchmarks          |
| Workflow files                                   | Actionlint plus the scopes owned by that workflow                                             |

The classifier lives in `test/ci/ci-scopes.ts`, and its routing contract is covered by property and workflow tests.
Website deployment has a separate path filter limited to site output inputs, so unrelated merges do not rebuild Pages.
Documentation-only and website-only merges also avoid repeating pull-request CI on the resulting `main` push.

### Local distribution end-to-end tests

Run the local-bin suite when a change affects any of the following:

- installation, CLI arguments, URI semantics, or datastore behavior;
- Threadnote CLI launchers or argument parsing;
- MCP schemas, forwarding, or native parity;
- manager APIs, shutdown, or Effect AI consolidation;
- sharing, memory lifecycle, pack import/export, packaging, or generated distribution bundles;
- Effect runtime, resource, interruption, or error-boundary behavior.

```bash
bun run test:e2e:local-bins
```

The suite uses a temporary Threadnote home, exercises the built standalone launchers, native SQLite and vector
indexes, the local model runtime, MCP stdio, and sharing, then removes the home. It must never use or mutate a
contributor's normal `~/.threadnote` state.

### Exact-HEAD global developer runtime

Before a long local benchmark or testing a host integration that launches the global `threadnote` command, install the
clean checked-out commit into the managed standalone location:

```bash
bun run dev:install-global -- --terminate-superseded --json
```

The installer refuses a dirty worktree, embeds the full source commit in a local-only version, validates the staged
executable and provenance receipt before atomic activation, and only terminates superseded processes whose start
identity still matches their lease. Long local benchmarks require this exact-HEAD receipt; do not rely on whichever
beta a launcher or editor process happened to start earlier. The exported fail-closed
`verifyManagedDevelopmentRuntimeForSource` verifier is the preflight for long benchmark harnesses; it returns the
sanitized version, source commit, executable digest, target, and runtime evidence without recording local paths.

The installer also records an opaque SHA-256 identity for the source checkout that owns the active global development
runtime. A different worktree must not silently replace it. After confirming its task has finished, transfer ownership
explicitly with `bun run dev:install-global -- --take-over-global-runtime`; the stored record never contains the local
checkout path.

## Changing MCP tools

Keep tool names and the default core toolset compact and backward-compatible. When adding or changing an input:

- define it with Effect Schema through the MCP adapter;
- preserve documented aliases when removing them would break existing agents;
- test emitted JSON Schema and runtime rejection;
- test the built native MCP server over stdio when the parameter affects runtime behavior;
- consider the context cost before adding a tool to the focused core surface.

## Documentation and generated output

Update documentation in the same pull request as behavior. Keep `README.md` concise and put architectural or
operational detail under `docs/`.

`dist/` and `manager/app.js` are generated by `bun run build`; do not hand-edit them. Always run the build and release
checks when changing entrypoints, dependencies, manager UI code, or build scripts.

The public React website is developed separately with `bun run site:dev` and validated with
`bun run site:check && bun run site:build`. Its source lives under `website/`, its ignored output is `site-dist/`, and
neither is part of a standalone release. See [`docs/website.md`](./docs/website.md).

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
