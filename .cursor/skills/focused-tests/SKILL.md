---
name: focused-tests
description: Run only the Vitest files that cover changed behavior and leave the full suite to pull-request CI. Use when tempted to run bun test, the complete suite, or when AGENTS.md says not to run the full suite locally.
---

# Focused tests, not the full suite

Do not run `bun test` / `bun run test` locally. PR CI is the authoritative full-suite run.

## What to run

- The specific `test/unit/...` or `test/integration/...` files for the behavior you changed.
- `bun run lint` and `bun run typecheck` when the change is TypeScript or script logic.
- Effect tests use `@effect/vitest` (`effectIt.effect` / `effectIt.scoped` / `effectIt.effect.prop`). Convert a touched `runEffect(Effect...)` async test unless it is a Promise/OS/CLI boundary.

## After the PR opens

Investigate and fix CI failures on that PR. Do not compensate by running the complete local suite unless CI is unreachable and the user asked.
---
