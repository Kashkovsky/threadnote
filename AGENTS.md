# Threadnote development instructions

Threadnote must dogfood itself on every non-trivial task. Repository files and the nearest checked-in guidance remain
authoritative.

## Dogfood Threadnote

- Start with `recall_context` using `project: threadnote` and the absolute `callerCwd`; read relevant returned
  `threadnote://` records.
- Use `inspect_code_graph` for focused current-source relationships and `analyze_code_graph` for repository structure,
  then exact text/path search for literals and verification. Graph-first applies to unfamiliar source and relationship
  claims; explicitly state a bounded skip for an already-known exact path or symbol, a remote review without a local
  checkout, or visual/binary evidence. If the scope expands, use the graph.
- Workset graph queries use only each repository's existing ready snapshot. Treat results as bounded, per-repository
  evidence: they neither fan out cold builds nor prove repository-wide absence. When missing or fresher evidence is
  required, explicitly run `threadnote workset prepare <name>` before querying.
- Store reusable decisions and contracts as durable memory. Store status, checks, blockers, and next steps as a handoff
  before pausing or ending meaningful work. Use stable project/topic identities and `replaceUri` for updates.
- Never store secrets, credentials, customer data, or raw production logs. Prefer Threadnote MCP tools; use the
  `threadnote` CLI as fallback and report unexpected dogfood behavior instead of silently bypassing it.

## Test Effect code with Effect Vitest

- Tests whose primary program is an `Effect` must use `@effect/vitest`: `effectIt.effect`, `effectIt.scoped` for owned
  scopes, and `effectIt.effect.prop` for Effect properties. Do not bridge them through `Effect.runPromise`, `runEffect`,
  or another runtime inside a plain async test.
- Provide the narrowest useful test layer. Keep Effect setup, synchronization, assertions, and cleanup in the returned
  Effect; use scoped/interruption primitives rather than Promise cleanup around nested Effect execution.
- Use deterministic test time. Apply `TestClock.withLive` only for real processes, SQLite leases, wall-clock deadlines,
  or similar behavior that deliberately needs live time.
- Plain tests and Promise execution remain appropriate for Promise/Node callback APIs, OS processes, external CLI
  protocols, and non-Effect code. When touching a plain async test that mainly runs an Effect, convert it unless one of
  these boundary exceptions applies.

## Assess property-based tests

For every behavior change, assess useful properties such as round trips, idempotence, determinism, ordering,
monotonicity, state transitions, incremental-versus-clean equivalence, and non-mutation. Add a bounded Fast-check
property with a shrinking generator and an independent model/invariant when one adds coverage; keep concrete regression
examples. Do not force properties onto static copy or one-off wiring. At closeout, state what property was added or why
none was appropriate.

## Install runtime changes globally

After changing runtime or product logic (`src/`, runtime scripts, installer/updater, MCP, storage, indexing, plugin
lifecycle, or release payload behavior):

1. Run appropriate checks.
2. Commit the intended change and make the worktree clean; the development installer rejects dirty or non-HEAD source.
3. Run `bun run dev:install-global` from this checkout to build, activate, and doctor-verify exact HEAD.
4. Exercise the affected flow through the global `threadnote` command and record the smoke result in the handoff.

Do not bypass the active-worktree ownership guard. After confirming the owning task has finished, an intentional handoff
may use `bun run dev:install-global -- --take-over-global-runtime`. After installing exact HEAD, terminate superseded
processes with `bun run dev:install-global -- --terminate-superseded`; this does not relax ownership safety.

Documentation-only and test-only changes do not require global installation unless they change a packaged runtime
contract or expose a runtime defect.
