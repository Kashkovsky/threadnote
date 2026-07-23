# Effect architecture

Threadnote uses Effect 4 for infrastructure, orchestration, lifecycle, and protocol boundaries. Pure memory algorithms,
formatting, and React state remain plain TypeScript where an Effect service or typed error channel would not add value.

The package currently pins `effect`, `@effect/platform-node`, `@effect/vitest`, and
`@effect/ai-openai-compat` to the same exact Effect 4 beta. Threadnote intentionally uses `effect/unstable/*`; beta
upgrades are explicit and must pass the protocol and bundle gates below.

## Runtime boundaries

- `src/effect/command.ts` owns interruptible child processes, typed command failures, timeouts, output limits, and git
  environment isolation.
- `src/effect/http.ts` owns HTTP status/text/JSON requests and typed transport/status failures.
- `src/effect/time.ts` owns polling and retry schedules. Tests use `TestClock`, so they do not wait in real time.
- `src/effect/openviking.ts` applies typed transient failures and scheduled retries to OpenViking resource removal.
- `src/effect/file_lock.ts` provides Effect-native, token-owned local critical sections for bounded candidate and
  feedback stores, including retry and stale-lock recovery.
- `src/effect/runtime.ts` only assembles the application layer. It does not own a `ManagedRuntime` or expose execution
  helpers.
- Each executable builds one Effect, provides the application layer once, and calls `NodeRuntime.runMain` once. Library
  code never calls `runPromise` or folds an Effect into a Promise; Effect-native workflows compose upward to that entry
  boundary.
- Promise-based filesystem and compatibility helpers are lifted with `Effect.tryPromise` at composition points. The
  manager's Node HTTP callback submits request Effects to a scoped `FiberSet` runtime created by its entry Effect, so
  in-flight requests are interrupted when the manager scope closes.
- Application Promise lifting is centralized in `src/effect/errors.ts`; production modules use its `fromPromise` and
  `fromSync` adapters with an operation label rather than declaring local copies. The CLI has no generic legacy-Promise
  command bridge: every command composes an Effect-returning workflow.
- Application output uses Effect's `Console` service. `src/effect/console.ts` carries the current service across the
  remaining Promise compatibility boundary and captures scoped output without mutating process-global handlers.
- Graph manifest reads, seeding, MCP installation, hook installation, lifecycle commands, recall, memory migration,
  pack I/O, and command execution compose through the application layer. Pure graph parsing, edge resolution, and
  Markdown rendering remain plain TypeScript.
- Recall feedback, candidate-review persistence, audit writes, session-closeout orchestration, and MCP candidate
  application compose as Effects using the shared filesystem and clock services. Deterministic BM25/ranking,
  confidence, explanation, candidate comparison, and memory document transforms remain pure TypeScript.
- `src/effect/share.ts` is the Effect-facing adapter for the transaction-oriented sharing implementation. This keeps
  the CLI error channel and runtime boundary uniform while the lower-level rollback callbacks remain Promise-based.
- Long-lived servers and Effect-owned temporary directories use `Scope`/`acquireRelease`, so interruption closes
  servers and removes staged files.

Threadnote is an ESM package. The checked-in `.cjs` bin files are deliberately tiny CommonJS launchers that dynamically
import the ESM bundles. This avoids TypeScript's CommonJS-to-ESM `require()` mismatch while retaining npm bin
compatibility.

The CLI entry normalizes dash-prefixed string values and strings containing multiple `=` characters before invoking the
Effect CLI parser. This preserves Commander-era argument behavior while Effect 4 is in beta; the integration suite
protects the compatibility shim so it can be reevaluated on an upgrade.

## MCP schemas and parity

MCP tool inputs use Effect Schema as the single source for handler types, runtime decoding, constraints, descriptions,
and emitted JSON Schema. Empty input structs are normalized to an explicit JSON Schema object because Effect 4 beta
currently represents an empty struct as an object-or-array union.

The stdio integration tests connect with the official MCP client and protect:

- tool names and core/full toolsets;
- server instructions and context-byte budget;
- JSON Schema fields and numeric constraints;
- runtime rejection of invalid inputs;
- OpenViking forwarding and share behavior.

## Optional Effect AI consolidation

The manager can use `@effect/ai-openai-compat` for structured consolidation drafts. It is intentionally opt-in and keeps
the same preview-before-apply safety model as Codex and Claude consolidation.

```bash
export THREADNOTE_EFFECT_AI=1
export THREADNOTE_EFFECT_AI_MODEL=<openai-compatible-model>
export THREADNOTE_EFFECT_AI_API_KEY=<key>       # optional when the endpoint does not require one
export THREADNOTE_EFFECT_AI_API_URL=<base-url>  # optional for the default OpenAI endpoint
threadnote manage
```

The model returns an Effect Schema-validated `{ "draft": string }` object. Generating a draft never deletes source
memories; cleanup remains a separate user-approved operation.

## Upgrading Effect

Keep every Effect package on the same exact beta, then run:

```bash
npm run lint
npm run prettier:check
npm run typecheck
npm run build
npm run check:bundle-size
npm test
npm run pack:dry-run
```

Treat a change to unstable MCP/AI behavior as a compatibility migration: update the adapter and parity tests together.
Do not bypass schema, tool-list, instruction, lifecycle, or bundle-size failures merely to accept a beta upgrade.

## Local-bin end-to-end validation

The dedicated distribution suite uses the built CommonJS launchers, a real pinned OpenViking CLI/server, a random local
port, and a suite-scoped temporary datastore. It exercises CLI memory and share writes, manager APIs and shutdown,
native OpenViking MCP plus Threadnote stdio MCP, optional Effect AI consolidation, and an installed npm tarball. Global
teardown stops the server and recursively removes the temporary datastore.

```bash
npm run test:e2e:install-openviking # explicit opt-in; installs the version pinned in src/constants.ts with uv
npm run test:e2e:local-bins
```

The E2E command refuses an OpenViking CLI/server version that differs from the Threadnote pin. CI runs the installer and
suite in a dedicated job, so updating the pin automatically validates the new OpenViking version across the shipped
entrypoints. If uv rejects a malformed prebuilt `llama-cpp-python` wheel, the installer retries from source with the same
bounded-parallelism and macOS Metal settings as Threadnote's production installer.
