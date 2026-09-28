# Private workspace development

Threadnote is one product with one release version and one Bun lockfile. Internal packages are private source packages with explicit exports. Run `bun install --frozen-lockfile` at the repository root; Bun resolves `workspace:*` dependencies without publishing packages.

## Start here

Place a change with the code that owns it, colocate its tests, regenerate the
Bazel declarations, and run the repository contracts plus the narrowest affected
test:

```bash
bun run bazel:generate
bun run check:repo
bun run bazel -- test //packages/<owner>:test
```

Use `apps/threadnote` for product entrypoints and cross-domain composition,
`apps/website` for the public site, an existing `packages/*` workspace for a
reusable domain or infrastructure capability, `tools` for repository automation,
`infra` for deployed operations sources, and `training` for offline model work.
Avoid creating a new package until it has a clear owner and dependency direction.

| Workspace                | Ownership                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `apps/threadnote`        | CLI, MCP server, runtime composition, provider adapters, telemetry, and release entrypoint |
| `apps/website`           | Website, public assets, content generators, prepared metadata, and website tests           |
| `packages/platform`      | Filesystem, processes, operating system access, locks, hashing, and sanitization           |
| `packages/store`         | Resource identities, persistence, mutation generations, and invalidation contract          |
| `packages/workspace`     | Configuration, manifests, installation paths, and runtime version                          |
| `packages/memory`        | Memory documents, lifecycle contracts, hygiene, relocation, and read projection            |
| `packages/recall`        | Ranking, eligibility, lexical and vector indexes, and memory connections                   |
| `packages/inference`     | Model catalog, selection, local inference engines, and vector search                       |
| `packages/graph`         | Graph parsing, indexing, querying, schema, workers, and maintenance                        |
| `packages/context`       | Context Brief compiler, evidence projection, citation validation, and procedure contracts  |
| `packages/manager`       | Manager UI, presentation, HTTP protocol, static files, and response contracts              |
| `packages/remote-memory` | Remote memory storage, transactions, migrations, and service contracts                     |
| `packages/protocol`      | Shared response, authorization, and diagnostic contracts                                   |
| `packages/integrations`  | Agent catalog and agent identities                                                         |
| `packages/evidence`      | Benchmark and public performance evidence contracts                                        |
| `packages/testing`       | Reusable test helpers                                                                      |

The repository has no root `src/` or `test/` tree. Production code belongs to an app or package. Tests are colocated under the same owner: `packages/graph/test` tests graph code, `packages/manager/test` tests Manager code, and cross-domain application tests live under `apps/threadnote/test`.

### Adding or changing a workspace

1. Keep the package private and expose explicit source entrypoints from its
   `package.json`; wildcard exports are rejected.
2. Declare internal dependencies with `workspace:*` and update the allowed
   direction in `tools/workspace/boundaries.ts` only when the architecture calls
   for that edge.
3. Put package tests under its `test/` directory. Tests that exercise application
   composition belong under `apps/threadnote/test`.
4. Add non-imported runtime inputs such as fixtures, assets, migrations, or
   executable entrypoints to `tools/bazel/target-specs.mjs`. Static imports and
   package exports are followed automatically.
5. Add the manifest to `MODULE.bazel`, run `bun install`, then run
   `bun run bazel:generate` and `bun run check:repo`.

Generated `BUILD.bazel` files and `tools/bazel/targets.json` are reviewable build
artifacts, not editing surfaces. Resource and infrastructure BUILD files are
hand-written because those trees have non-TypeScript ownership and native rules.

## Dependency boundaries

Run `bun run check:workspaces` after changing imports or manifests. The check rejects public internal packages, undeclared dependencies, unexported imports, package cycles, and relative imports across workspace boundaries. Production source cannot consume development dependencies. Shared testing helpers are development dependencies only.

Import another package through a declared entrypoint, such as `@threadnote/memory/document`. Keep graph storage schemas in the graph package. Memory core does not depend on recall; recall consumes memory contracts. Context composes memory and graph. The application supplies runtime adapters and owns only cross-domain composition.

## Repository resources

Some top-level directories remain stable because their paths are release or operator contracts:

- `assets/` contains the runtime grammar/model payload and canonical brand sources copied into releases.
- `config/` contains shipped agent guidance and migration configuration; `config/lint` is the repository lint plugin.
- `training/recall-reranker/` is a standalone Python training toolchain, separate from the shipped runtime.
- `infra/` owns the telemetry gateway and dashboard deployment sources.
- `apps/website/public/` is owned by the website app.

Each is a Bazel package or an explicit input to an app target. Moving release resources beneath an app would change installer and update metadata without improving dependency ownership, so their stable artifact paths remain intentional.

## Bazel CI

See [the Bazel development guide](../tools/bazel/README.md) for pinned toolchain commands and target generation. Bazel hosts the Bun/Vitest runner, Go telemetry targets, website build, runtime build, formatting, lint, workspace checks, and typechecks. The dependency repository consumes `bun.lock`; no pnpm lockfile, paid Aspect service, or remote cache is required.

`tools/bazel/target-specs.mjs` discovers every colocated test suite and declares its source and data closure. Generation emits checked-in BUILD files and `targets.json`. The package export helper uses package-local globs for visibility while test and action targets retain exact generated inputs for `bazel-diff`.

Pull-request CI compares base and head target hashes with pinned open-source `bazel-diff` and executes the selected targets. Platform and quality jobs that require a particular GitHub runner are selected from the same Bazel inventory. Unknown inputs, absent baselines, or failed analysis fail safe by selecting the complete inventory. The previous path classifier and shadow workflow are removed.

Website builds consume prepared metadata produced before the sandbox. Cached actions do not discover Git history or call release APIs. Article, release, performance, public, and prepared metadata are explicit website inputs. A website-only change selects website checks without selecting graph package tests; shared dependency changes select every dependent target.

Run focused tests locally. Pull-request CI owns the complete selected suite and platform matrix.

Preview selection with `bun run bazel:affected`. The command writes the exact
selection, changed paths, fallback reason, and base/head graph evidence under
`.context/bazel-selection/`, which is ignored by Git and suitable for attaching to
a debugging handoff. Use `bun run bazel -- test <label>` for focused execution;
`bun run bazel:check` validates generated declarations and target analysis without
running every product test.
