# Recall evaluation and benchmarks

This directory is the release-quality contract for Threadnote retrieval. It is intentionally independent of a
developer home, network access, local canonical data, and model-generated relevance scores.

## Native code graph contract

`fixtures/code-graph-v1/` is the reviewed repository and query contract for native source navigation. It covers
definitions, authoritative calls and dependencies, paths, reverse impact, documentation, no-answer behavior, and
linked-worktree dirty-overlay isolation. The fixture identity is frozen; changing the repository or judgments requires
reviewing every baseline with the new hash.

`fixtures/code-graph-polyglot-v1/` is the complementary Java, Kotlin, Swift, and TypeScript contract. It executes the
bundled Java/Kotlin/Swift grammar packs and the unchanged compiler-backed TypeScript pack in one repository, including
declared Gradle JVM interoperability and SwiftPM target resolution. Its checked native quality and development
performance artifacts live under `baselines/code-graph-polyglot-v1/`.

```sh
bun run eval:code-graph
bun run eval:code-graph -- --fixture code-graph-polyglot-v1
bun run bench:code-graph -- --output artifacts/code-graph-local.json
bun run bench:code-graph -- --fixture code-graph-polyglot-v1 --fail-on-budget
bun run bench:code-graph -- --vectors --model-home ~/.threadnote --output artifacts/code-graph-vectors-local.json
bun run bench:code-graph -- --scale-symbols 10000 --fail-on-budget
bun run bench:code-graph -- --scale-symbols 100000 --fail-on-budget
bun run bench:code-graph -- --vectors --scale-symbols 10000 --model-home ~/.threadnote --fail-on-budget
bun run bench:code-graph:dirty-overlay -- --scale-symbols 10000 --samples 3 \
  --output artifacts/code-graph-dirty-overlay.json

# Opt-in/scheduled large-monorepo shape; expect substantial CPU, RAM, disk, and wall time.
bun run bench:code-graph -- --profile production-large --samples 1 --warmups 0 \
  --output artifacts/code-graph-production-large.json

# Opt-in/scheduled heavy-tail regression: pathological TS, 25 MiB low-signal JSON, 4,000 textless SVGs,
# interruption/resume, and deterministic workers=1 versus workers=4 graph output.
bun run bench:code-graph:heavy-tail -- \
  --output artifacts/code-graph-heavy-tail.json

# Fast harness smoke; exercises the same orchestration and assertions with a reduced generated fixture.
bun run bench:code-graph:heavy-tail -- --smoke \
  --output artifacts/code-graph-heavy-tail-smoke.json
```

The evaluator runs Threadnote's real Git inventory, extractor, SQLite store, and query service. It gates zero
authoritative false edges, zero worktree leakage, perfect no-answer precision/recall, perfect reviewed symbol/edge
recall, and MRR 1. The checked Graphify 0.9.29 result remains a frozen historical comparison, not the native release
floor. `threadnote-native.json` is the native baseline; `budgets.json` records quality and
development and scale performance limits. The default development and scale artifacts are explicitly lexical-only.
`performance-vectors-development.json` separately records activation and a lexically disjoint semantic query with the
pinned production embedding model. Reviewed local lexical 10k/100k results and a production-model 10k vector result
are stored as `performance-10000-development.json`, `performance-100000-development.json`, and
`performance-vectors-10000-development.json`. Scheduled 10k/100k production-vector jobs gate bounded decoding, exact
scans, RSS, and disk. Code-graph embeddings use paged SQLite generations so candidate construction, reuse, and search
do not materialize a repository-sized sidecar. The platform workflow retains full artifacts rather than pretending
shared-runner latency is machine-independent.

The reviewed `production-large` profile is shaped after the beta.27 field investigation: approximately 48,000
eligible files, 800,000 symbols, 2.7 million edges, 12 million lexical term rows, and 24 integrated and nested
workspaces. It runs weekly or through the explicit `include_production_large` workflow input on the pinned
`ubuntu-24.04` runner class; pull requests retain the existing reviewed
development, 10k-symbol, and 100k-symbol suites. `--profile-files` and `--profile-symbols` may shrink the same generator
for harness development, but only the default shape is the reviewed profile. There is intentionally no portable
latency budget or fabricated checked result for this profile: retain the JSON artifact from each measured run and
review it only when `sameRunnerComparisonKey` matches. The cold and incremental builds and their phases are explicitly
labelled n=1; the artifact never presents them as a latency distribution.

`heavy-tail-profile.json` is the complementary beta.29 regression shape. It checks the file classes that a uniform
symbol-count generator cannot represent: call-heavy and multi-megabyte generated TypeScript, one 25 MiB test snapshot
JSON, and 4,000 textless SVG assets. The harness builds clean graphs with one and four parser workers, interrupts a
third build only after parser facts are durable, then resumes it from the same home. All three completed graphs must
have the same normalized digest. The resumed run must reuse the interrupted cache; low-signal JSON must remain one
small metadata fact; TypeScript imports/exports/tail declarations and one metadata symbol per SVG must survive. The
checked profile is a reviewed workload contract, not a fabricated latency result. Compare wall time, aggregate
per-language parse/persist timing, RSS, and cache bytes only within the same artifact and runner class.
`heavy-tail-development.json` retains the first reviewed full-shape observation on the documented local hardware. It
is evidence that the harness and contracts passed, not an absolute release threshold for other machines.

`bench:code-graph:dirty-overlay` isolates the first dirty build where Threadnote must materialize a clean commit and a
one-file worktree overlay in the same SQLite session. It alternates the safe staging-reuse path with an explicitly
disabled full-materialization control, requires identical graph shape, and records both total and materialization
time. The reviewed local 10k-symbol result is stored as `dirty-overlay-development.json`; it is comparative evidence
on one hardware class, not a portable latency gate.

The general `bench:code-graph` suite separately labels its post-cold one-file edit as `one-file-reindex`. That path
measures the normal cross-session cache reuse and records the observed materialization mode, staged-file count, and
fallback reason. An eligible edit now reuses the persisted clean base through a versioned receipt containing normalized
symbol, alias, and named-re-export provenance, and writes a direct changed-file delta without hydrating the clean graph
into temporary staging tables. Eligibility requires compatible extractor, workspace, and file-set fingerprints; a
complete fact cache and receipt; an unchanged declaration/lookup surface; and no changed dynamic aliases. File-set,
workspace, resolution-surface, cache, receipt, or staging-identity changes conservatively fall back to full
materialization and remain explicit in the recorded reason.

The reusable receipt and named-barrel resolution contract ships as extractor generation `native-code-graph-9`.
Upgrading from generation 8 therefore performs one intentional clean rebuild before persisted-base deltas become
eligible. SQLite records a monotonic minimum extractor generation so an older process that overlaps an update cannot
publish a generation-8 snapshot after generation 9 has initialized the checkout store.

The bounded parser-worker pool, generated-root correction, and metadata-only low-signal structured-data policy advance
the current extractor generation to `native-code-graph-10`. That transition performs one clean rebuild and extends the
same monotonic publication guard to overlapping generation-9 processes.

Code-graph benchmark artifacts now separate registration/lock/database setup, committed inventory/extraction, the dirty
overlay and workspace-discovery gap, materialization, reference resolution, validation, SQLite write/checkpoint,
promotion, and vector work using first progress transitions and explicit subphase completion events. They also record
operation CPU deltas; boundary and cumulative peak RSS; final main SQLite, WAL, SHM, vector, sidecar, and unclassified
derived bytes; observed SQLite/WAL/SHM peaks sampled at progress boundaries; lexical/vector row counts;
repository-status latency; and cross-process build sidecar latency. Every measurement includes `samples`. With one cold
or incremental run, `p50`, `p95`, and `p99` are schema-compatible copies of that one observation, not percentile
estimates; cite it as “one observation (n=1),” never as p95. Distribution labels are valid only for measurements with
multiple samples.

The production-large workflow additionally starts a 25 ms external sampler before it constructs the fixture, then
hands continuous coverage across bootstrap, cold-index, and incremental-index samplers. Each sampler must publish a
parseable readiness marker before the parent enters the measured phase. It records per-phase process CPU/RSS and
DB/WAL/SHM peaks plus SQLite temporary-file peaks from an isolated temp root, including
`activating/writing-and-checkpointing`. This is observed sampling, not an assertion that an interval cannot miss a
shorter transient. Linux validates the sampled parent using `/proc` start time so PID reuse cannot be mistaken for the
original benchmark. Other platforms mark external CPU/RSS telemetry unavailable instead of emitting fabricated zero
measurements; storage sampling remains available.

Each sampler atomically checkpoints its evidence into the workflow's artifact directory once per second and on parent
exit. A separate run-lifecycle checkpoint records the current benchmark phase and ends as `complete` or `failed` when
the process can finalize normally. If the process is killed, the last `running` phase and the sampler's
`parent-exited` checkpoint remain. Sampler shutdown is bounded and escalates to process termination if the stop signal
cannot be written or honored. The production step reserves at least 30 minutes before the job deadline, and artifact
upload runs with `if: always()`, so failure and timeout evidence is retained whenever the runner itself remains alive.

Graph code search is intentionally separate from memory recall. `recall_context` evaluates durable memories and
resources; `inspect_code_graph` evaluates current source evidence. Agents may call both, but one subsystem failing or
returning no answer cannot silently change the other's answer contract.

## Fixture contract

`createRecallEvaluationFixtureV2()` in `src/evaluation/recall-fixture.ts` creates the reviewed base corpus:

- 200 canonical-shaped documents and 250 queries;
- relevance grades from 0 through 3;
- explicit no-answer queries, forbidden URIs, authority pairs, expected stages, and required explanation codes;
- reviewed provenance and language on every document and query;
- every required category represented, including separately reported Polish, Ukrainian, and Spanish queries;
- no semantic scores embedded in the fixture.

`expandRecallEvaluationFixtureV2()` deterministically grows the same corpus to 1,000, 10,000, or 100,000 documents.
The seed and generated-document count are part of the fixture identity. Generated records are marked `reviewed:
false`; they must never be added to relevance judgments.

Fixture identity normalizes the 4.0 `threadnote://` namespace rename back to the frozen 3.0.3 representation before
hashing. This keeps stored baselines and measured model candidates comparable when only the URI scheme changed; corpus,
query, or judgment changes still produce a different hash.

To add a scenario, add one hand-reviewed entry to `SCENARIOS`. Each entry creates eight documents and ten query
contracts. If a new behavior does not fit that shape, add an explicit document/query builder and preserve the minimum
counts. Validate that:

1. the desired document has a relevance grade;
2. unsafe or out-of-scope results are in `forbiddenUris`;
3. `expectedStages` describes the pipeline behavior being tested;
4. required reason codes are stable domain contracts, not model prose;
5. provenance is synthetic or public project material, never copied memory/customer data.

Any intentional fixture change requires regenerating both checked-in baselines and reviewing the metric deltas:

```sh
bun run eval:recall:baseline -- --output test/evaluation/baselines/threadnote-3.0.3/recall-v1.json
bun run eval:recall:baseline:v2 -- --output test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json
```

The default timestamp is fixed. `SOURCE_DATE_EPOCH` or `--created-at` may record a reviewed replacement baseline.

## Metrics

All metrics are emitted globally and per category.

| Metric                             | Definition                                                                                         | Direction                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| Recall@k                           | Fraction of all relevant URIs present in the first k results, averaged over answerable queries     | Higher                           |
| MRR                                | Reciprocal rank of the first relevant result, averaged over answerable queries                     | Higher                           |
| nDCG@k                             | Graded discounted gain divided by the ideal ranking at k                                           | Higher                           |
| No-answer precision/recall/F1      | Classification metrics for expected and predicted no-answer outcomes                               | Higher                           |
| Forbidden-hit rate                 | Forbidden hits divided by all returned hits                                                        | Lower; no regression             |
| Stale-hit rate                     | Archived or superseded hits divided by all returned hits                                           | Lower; no regression             |
| Authority-inversion rate           | Inferior documents ranked above or instead of preferred authority pairs                            | Lower; no regression             |
| Explanation coverage               | Queries whose first result contains every required reason code                                     | Higher                           |
| Average candidates read            | Candidate records inspected per query                                                              | Informational/performance budget |
| Average context characters/tokens  | Returned context size; tokens use an explicit four-character estimate until a model tokenizer runs | Informational                    |
| Expansion invocation/fallback rate | Fraction invoking expansion and fraction of those invocations that fail open                       | Informational/lower fallback     |

Semantic uplift is the metric delta from a lexical run to a semantic run. Reranker uplift is the delta from hybrid to
reranked output. Use `compareRecallEvaluationResults` so both are reported globally and per category.

The default non-inferiority policy allows at most a 0.01 aggregate and 0.05 per-category drop for higher-is-better
quality metrics. Forbidden, stale, authority-inversion, and expansion-fallback rates may not increase. Contract
failure count may not increase. Tight platform latency gates are not applied on shared CI runners.

## Running quality gates

```sh
# Existing v1 quality and 10k production-shaped checks
bun run eval:recall

# v2 current-pipeline non-inferiority check
bun run eval:recall:v2 -- \
  --baseline test/evaluation/baselines/threadnote-3.0.3/recall-v2-lexical.json \
  --fail-on-regression

# Keep the full query run as an untracked CI artifact
bun run eval:recall:v2 -- --documents 10000 --full --output artifacts/recall-v2-10k.json
```

The frozen 3.0.3 lexical baseline has known failures. These are evidence of behavior to improve, not waived release
criteria. A candidate passes only when it does not add failures or regress safety/quality metrics.

## Performance suites

`bench:recall:micro` uses Mitata against a minified built artifact, outside Vitest's module runner. Its compact JSON
mode omits raw sample arrays:

```sh
bun run bench:recall:micro
bun run bench:recall:micro -- --json
THREADNOTE_BENCHMARK_100K=1 bun run bench:recall:micro -- --json
```

`bench:recall` is the explicit end-to-end orchestrator. It records p50/p95/p99, throughput, CPU time, RSS, heap,
external memory, and event-loop delay together with commit/dirty state, fixture hash, Node/npm, OS, architecture, CPU,
RAM, warmups, and samples:

```sh
bun run bench:recall -- --documents 10000 --samples 25 --warmups 5 \
  --output artifacts/recall-10k.json
```

To add a benchmark scenario, expose a stable operation from `scripts/benchmark-target.ts`, register it in
`scripts/benchmark-recall-micro.mjs`, and add a named measurement to the end-to-end runner when process-level
telemetry matters. Never assert tight latency limits from a shared-host result.

Model candidates must have immutable revision, SHA-256, role, dimensions/context, prompt prefixes, normalization,
quantization, license, and hardware class metadata. Each candidate runs through the same query fixture and emits a
normal v2 run artifact; model downloads and raw benchmark output remain CI artifacts rather than checked-in files.
Reviewed compact gate summaries live under `candidates/<release>/` so failed candidates and their reasons are not
rediscovered or accidentally promoted later.

```sh
bun run eval:recall:models -- \
  --embedding bge-small-en-v1.5-q8 \
  --install \
  --output .artifacts/bge-small-full.json \
  --summary-output test/evaluation/candidates/threadnote-4.0.0/bge-small-en-v1.5-q8.json
```

## Artifact schemas

- Recall fixture: version 2 (`RecallEvaluationFixtureSchemaV2`)
- Pipeline run: version 1 (`RecallEvaluationRunSchemaV1`)
- Compact baseline: version 1 (`RecallEvaluationBaselineSchemaV1`)
- Non-inferiority gate: version 1 (`RecallNonInferiorityGateV1`)
- Benchmark artifact: version 1 (`BenchmarkArtifactSchemaV1`)

Schema versions change only for incompatible contract changes. Add a migration before deleting a decoder for any
artifact format used by a released Threadnote version.
