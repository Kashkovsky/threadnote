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
bun run bench:code-graph:dirty-overlay -- --scenario unchanged-static-reexport \
  --scale-symbols 10000 --samples 3 \
  --output artifacts/code-graph-dirty-overlay-static-reexport.json
bun run bench:worktree-readiness -- --candidate-ref v4.0.1 --samples 5 --warmups 1 \
  --output artifacts/code-graph-worktree-readiness-v4.0.1.json

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

### Cross-repository workset contract

The workset fixture scales one deterministic set of repository archetypes into prefix worksets. Sizes 1, 8, 32, 64,
and 128 are the required correctness matrix: together they cover single-repository parity and progressively larger
published catalog generations without an eight-repository admission cap. Size 50 is benchmark-only. It exists to
measure the 50-ready-repository latency target and must not replace any required correctness size or be included when
claiming that the correctness matrix passed. The directory remains `code-graph-workset-v1` because it names the frozen
fixture and evaluator schema; the implementation and performance suite are Workset Search 2.0 / `code-graph-workset-v2`.

Ordinary CI runs the truthful bounded smoke against sizes 1 and 8. The scheduled/manual platform workflow runs the
complete correctness matrix, then measures sizes 32, 50, 64, and 128 with 25 recorded samples after five warmups. That
sample count supports a p95 distribution claim; a single observation remains `n=1` evidence even when an artifact
schema contains p50, p95, or p99 fields.

```sh
# Fast correctness smoke used by ordinary quality CI.
bun run eval:code-graph-workset -- --sizes 1,8

# Complete required correctness matrix.
bun run eval:code-graph-workset -- \
  --sizes 1,8,32,64,128 \
  --output artifacts/code-graph-workset-quality.json

# Full scheduled/manual performance distribution, including benchmark-only size 50.
bun run bench:code-graph-workset -- \
  --sizes 32,50,64,128 \
  --samples 25 \
  --warmups 5 \
  --output artifacts/code-graph-workset-benchmark.json

# Enforce the Workset Search 2.0 latency and response-budget targets.
bun run bench:code-graph-workset -- \
  --sizes 50,128 \
  --samples 25 \
  --warmups 5 \
  --fail-on-budget
```

Workset MCP responses are currently buffered: the client receives no partial card while repositories are still being
queried. Therefore `delivered-time-to-first-evidence-buffered` is the elapsed time until the first evidence is actually
available to the client, which is also completion time for the buffered response. An internal first-candidate timer
may help diagnose the pipeline, but it is not user-visible time to first evidence and must retain a distinct name.

Workset Search 2.0 first reads the complete indexed routing catalog, globally ranks candidates, then opens repository
graphs in bounded 4/4/16 waves. One four-repository validation wave may resolve ambiguous non-empty evidence; the
16-repository wave is reserved for zero-evidence exhaustion. The logical result sequence defaults to 40 evidence cards
with a separate internal maximum of 512. Its compact projection defaults to 1,250 estimated tokens and has a hard
1,500-token public ceiling. Continuations resolve an opaque persisted `cgwc_` sequence; repository-qualified `cgr_`
handles bind drill-down to the published generation and exact snapshot.

Agent-response cost counts the UTF-8 bytes of both MCP channels: structured content plus the duplicated terse text
rendering. It intentionally does not deduplicate equivalent facts across those channels because both are transmitted
to the agent. Estimated tokens use the conservative ceiling `ceil(total UTF-8 bytes / 3)`, not the recall evaluator's
older four-characters-per-token estimate. Artifacts retain each channel's bytes, their sum, and the estimate so future
response compaction remains comparable without claiming tokenizer-specific precision.

The clean native baseline records perfect coverage accuracy, repository recall@5, symbol recall, no-answer
precision/recall, and worktree isolation at every required size. Size 1 records full edge recall. Larger sizes record
0.25 edge recall because this frozen V1 evaluator still marks its `path` and `impact` cells unsupported and its package
expectation is not a query-card endpoint contract. The real
`test/integration/code-graph.workset-cross-repository-traversal.test.ts` lifecycle separately proves npm and Protobuf
extraction, generation-bound publication, V2 query evidence, forward path, and reverse impact through public runtime
surfaces. Do not describe the evaluator's unsupported cells as missing Phase 2 runtime support.

`performance-development.json` is a clean exact-commit, same-machine distribution with five samples after one warmup
at sizes 1, 8, 32, 50, 64, and 128. Its values are development evidence rather than portable latency promises; the
numeric targets remain versioned in `baselines/code-graph-workset-v1/budgets.json`. `catalogBytesRead: 0` currently
means catalog byte reads are not instrumented by this harness. It must not be interpreted as proof that the V2 query
did not use the routing catalog.

The checked 4.1.1 development artifact was captured from clean implementation commit
`8bfcc63c164f23456cb83fd1e090293ab020a18b` on the documented M1 Max runner. Because this bounded development run has
five samples, its p95 is the maximum observed sample; scheduled 25-sample runs remain the release-quality
distribution. All checked response estimates remain under the 1,500-token ceiling.

| Workset size | Buffered completion p95 | Estimated agent tokens |
| -----------: | ----------------------: | ---------------------: |
|            1 |              148.893 ms |                  1,306 |
|            8 |              445.221 ms |                    930 |
|           32 |              622.110 ms |                    931 |
|           50 |              758.645 ms |                    931 |
|           64 |              874.532 ms |                    931 |
|          128 |            1,423.727 ms |                    933 |

The evaluator runs Threadnote's real Git inventory, extractor, SQLite store, and query service. Its active Phase 0
safety gates require zero authoritative false edges, zero worktree leakage, and perfect no-answer precision/recall.
Repository, symbol, and edge recall plus MRR remain measured Phase 1 gaps rather than waived or falsely passing gates.
The checked Graphify 0.9.29 result remains a frozen historical comparison, not the native release floor.
`threadnote-native.json` is the native baseline; `performance-development.json` is the clean five-sample local
distribution; `budgets.json` records quality and
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
workspaces. One reusable workflow runs weekly, through the explicit `include_production_large` input, and from a
separate bounded workflow for every `v4.0.0-beta.*`, `v4.0.0-rc.*`, and final `v4.0.0` tag on the pinned
`ubuntu-24.04` runner class. Publication never waits for this observation; the latest exact-commit checkpoint and upload
digest are retained for 90 days. Ordinary pull requests retain the bounded development, 10k-symbol, and 100k-symbol
suites. `--profile-files` and `--profile-symbols` may shrink the same generator for harness development, but only the
default shape is the reviewed profile. Completed release evidence must attain at least 90% of each
reviewed file, symbol, edge, and lexical-term target; merely carrying those measurement names cannot qualify an
undersized run. There is intentionally no portable latency budget or fabricated checked result for this profile:
retain the JSON artifact from each measured run and review it only when `sameRunnerComparisonKey` matches. The cold and
incremental builds and their phases are explicitly labelled n=1; the artifact never presents them as a latency
distribution.

`beta30-staging-development.json` preserves the reviewed same-runner staging experiments, including the first 10k
direct-persistent observation and its source-artifact SHA-256. Every source run was dirty and local, so this compact
record is development evidence only. A release artifact is accepted only when it carries the Threadnote 4 release tag,
the exact matching commit, and a clean checkout; missing provenance is a hard failure rather than an implicit pass.
The compact direct record retains the reviewed top-level cold and one-file wall-time measurements under their exact raw
artifact phase names. The split snapshot phases are:

- `cold-snapshot-write-and-checkpoint`: 556.407 ms
- `cold-snapshot-promotion`: 62.470 ms
- `one-file-reindex-snapshot-write-and-checkpoint`: 131.654 ms
- `one-file-reindex-snapshot-promotion`: 156.894 ms

Snapshot write-and-checkpoint ends at promotion start; promotion is a separate phase. The record also retains the exact
privacy-safe structural and query digests, zero observed TEMP database pages, zero cold activation-copy stages, query
parity across all three builds, and structural parity between the incremental overlay and its independent full rebuild.
Its cold graph intentionally differs because the parity build includes the benchmark's one-file mutation.

`heavy-tail-profile.json` is the complementary beta.29 parser/cache regression shape. It checks the file classes that a uniform
symbol-count generator cannot represent: call-heavy and multi-megabyte generated TypeScript, one 25 MiB test snapshot
JSON, and 4,000 textless SVG assets. The harness builds clean graphs with one and four parser workers, interrupts a
third build only after parser facts are durable, then resumes it from the same home. All three completed graphs must
have the same normalized digest. The resumed run must reuse the interrupted cache; low-signal JSON must remain one
small metadata fact; TypeScript imports/exports/tail declarations and one metadata symbol per SVG must survive. The
checked profile is a reviewed workload contract, not a fabricated latency result. Compare wall time, aggregate
per-language parse/persist timing, RSS, and cache bytes only within the same artifact and runner class.
`heavy-tail-development.json` retains the first reviewed full-shape observation on the documented local hardware. It
is evidence that the harness and contracts passed, not an absolute release threshold for other machines or evidence
that production-scale materialization was exercised.

`bench:code-graph:dirty-overlay` isolates the first dirty build where Threadnote must materialize a clean commit and a
one-file worktree overlay in the same SQLite session. It alternates the safe staging-reuse path with an explicitly
disabled full-materialization control, requires identical graph shape, and records both total and materialization
time. The reviewed local 10k-symbol result is stored as `dirty-overlay-development.json`; it is comparative evidence
on one hardware class, not a portable latency gate.

The opt-in `unchanged-static-reexport` scenario shifts only the evidence span above a byte-identical named TypeScript
re-export. It retains staged/total files plus exact integer rewrite and cached-fact replay amplification for both the
incremental path and forced-full control; those structural observations are not wall-clock assertions. The generated
10k-symbol fixture contains 102 indexed files, so this is not evidence for a 10k-file repository or production-large.
The existing body-only scenario and checked baseline remain unchanged.

`bench:worktree-readiness` compares an exact candidate ref with its immediate parent on one machine and one pinned
public checkout. Each runtime gets an independent frozen dependency installation, Threadnote home, and fixture clone.
After both runtimes build the same warm anchor, the harness alternates linked-worktree runs for graph-equivalent commits
and committed one-file edits. It records raw wall times, requires the predecessor to use full materialization, requires
v4.0.1 to use `reused-snapshot` or `incremental-clean` with zero or one staged file respectively, and checks graph-count
and controlled-query parity after every pair. Cold anchor construction, dependency installation, and optional vector
enrichment are outside the timing scope. Treat its median speedup as same-machine engineering evidence, not a portable
latency promise.

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

The bounded development, polyglot, 10k, and 100k budget contracts gate cold and one-file materialization independently
from total indexing. Production-large and external-soak artifacts additionally retain privacy-safe aggregate file,
symbol, edge, lexical-term, staged-file, phase CPU, and phase boundary-RSS measurements. Completed activation-stage
duration and row counts cover validation, graph-table copying, commit, checkpoint, and completion for both cold and
one-file builds. SQLite TEMP allocated-page high-water is separate from the external sampler. The external value
unions linked files in the isolated temporary root with open regular scratch files held by the recursive benchmark
process tree and deduplicates them by device and inode. That includes immediately unlinked SQLite `etilqs_*`
databases, journals, and subjournals without retaining their paths. Linux reads `/proc` file descriptors; macOS uses a
bounded numeric-FD `lsof` projection at the process-sampling interval. Both values are sampled high-water, not exact
live totals. For a
production repository that is already cloned locally, run the explicit soak mode without adding a network clone to CI:

```sh
bun run bench:code-graph -- \
  --repository /path/to/clean/public-github-checkout \
  --incremental-path path/to/TrackedSource.java \
  --control '{"query":"PublicJavaSymbol","expectedPath":"path/to/TrackedSource.java","expectedLanguage":"java"}' \
  --control '{"query":"PublicKotlinSymbol","expectedPath":"path/to/TrackedSource.kt","expectedLanguage":"kotlin"}' \
  --control '{"query":"PublicTypeScriptSymbol","expectedPath":"path/to/tracked-source.ts","expectedLanguage":"typescript"}' \
  --control '{"query":"PublicBazelSymbol","expectedPath":"path/to/rule.bzl","expectedLanguage":"bazel-build"}' \
  --home /large-volume/threadnote-primary \
  --reference-home /large-volume/threadnote-reference \
  --retain-homes \
  --samples 25 --warmups 5 \
  --output /path/outside/checkout/code-graph-external.json
```

The soak currently supports Linux and macOS, where both recursive process and SQLite temporary-file telemetry are
audited; other platforms are rejected before indexing. The checkout must be clean and remain at the recorded exact
commit. Git cleanliness checks explicitly include all untracked files, disable repository-configured filesystem
monitor and untracked-cache shortcuts, include submodule dirt, and run again immediately before publication. The
Threadnote source checkout is independently required to remain clean at its exact commit. The selected file must be
tracked and regular, and the artifact and both benchmark homes must be outside the checkout.

Explicit home paths are reserved with an exclusive directory creation rather than an existence-check race.
`--retain-homes` requires two explicit fresh paths and arms retention only after the real run's preflight succeeds;
otherwise scoped cleanup releases both reservations. Before an expensive run, repeat the command with `--preflight
--minimum-free-gib 140`. A validation-only run always releases the requested paths—even when `--retain-homes` is
present—so those same fresh paths remain available for the real run. Preflight validates the commit, tree, controls,
semantic-overlay language, effective parser-worker capacity, privacy-safe allowlisted environment metadata, and free
space without indexing. Path-valued environment metadata is recorded only as a redacted configured marker. The real
run repeats the same validation and enforces the capacity threshold even when the operator omits `--preflight`; 120
GiB is the default minimum and 140 GiB is recommended for the public soak. The validation-only command writes a
separate `<output>.preflight.json` rather than impersonating benchmark evidence.

The incremental edit is a harmless language-aware import/dependency, not a comment-only byte change or a new
declaration. It changes graph evidence while preserving the symbol lookup surface, and release evidence requires the
observed mode to be `incremental-overlay`; a conservative full fallback does not count as an incremental benchmark.
The overlay source must be valid UTF-8. The harness compares bytes before applying and restoring it, restores the
exact original bytes (including BOM and line endings), and leaves a newer concurrent edit untouched rather than
overwriting it. Normal success and cooperative failure therefore restore safely. A process `SIGKILL`, power loss, or
machine crash can still leave the benchmark overlay in place, so run destructive-scale evidence in a disposable clean
clone and verify Git status after interruption.

The run must prove that the overlay changes the cold effective-state digest and that its incremental state exactly
matches an independent fresh-home full rebuild. The digest covers effective inventory files, symbols, lexical terms,
lookup keys, edges, workspace attribution, re-export provenance, and structural-analysis aggregates—not only symbol
and edge counts. Cold, incremental, and reference builds each have their own non-overlapping progress timeline,
SQLite temporary root, required external sampler, and crash checkpoint. The artifact also times `query`, `node`,
`neighbors`, `explain`, `impact`, and `path` through the MCP compaction path, enforcing the 25-second tool envelope and
24 KiB limits for both structured and text parts. Only latency, row counts, truncation state, and byte counts are
retained—never graph content. All gates and final source/checkout checks run before the canonical artifact is written.

The artifact omits local repository paths, credentials, and source content. It retains the canonical public GitHub
repository name and HTTPS URL plus the reviewed public control queries, repository-relative paths, expected languages,
and stable node IDs. These fields make the public result reproducible while aggregate counts prove that every cold,
post-incremental, and reference control returned at least one node from its expected tracked path and language. Compare
it only with the same external commit and runner class.

Release-bound external evidence additionally measures cold/warm Manager catalog and overview operations, project and
node detail, bounded Manager query latency and payload, and a deterministic client render proxy. Exact snapshot binding,
stale/aborted request rejection, node/edge budgets, logical CPU count, filesystem, disk-medium category, and eligible and
excluded inventory counts are mandatory binder metadata. Concurrent-worktree evidence reuses the measured primary
Threadnote home: a bounded synthetic Git repository and one real linked worktree receive distinct dirty sentinels, are
indexed concurrently, and are queried concurrently with positive and cross-negative controls to prove repository
identity sharing without worktree leakage. The control reports its own duration and two indexed files; it does not
repeat the public repository cold build.

The production-large workflow additionally starts a 25 ms external sampler before it constructs the fixture, then
uses distinct, non-overlapping bootstrap, cold-index, incremental-index, and same-overlay reference samplers. A prior
sampler is stopped before the next measured sampler starts, so CPU, RSS, I/O, and temporary-file totals cannot leak
between measurements. Each sampler must publish a parseable readiness marker before the parent enters the measured
phase. Index wall-time and process boundaries begin immediately before `indexer.index()` only after sampler readiness
and overlay application, then end immediately after that call and before overlay restoration or post-index work. It
records per-phase process CPU/RSS and
DB/WAL/SHM peaks plus deduplicated linked-and-open SQLite temporary-file peaks, including
`activating/writing-and-checkpointing`. This is observed sampling, not an assertion that an interval cannot miss a
shorter transient. Linux validates the sampled parent using `/proc` start time so PID reuse cannot be mistaken for the
original benchmark. macOS samples process trees every 250 ms and open numeric file descriptors every second to bound
`ps`/`lsof` overhead. Open-file inspection is capped at 4,096 processes and 65,536 descriptors, and the macOS projection
at 8 MiB. The artifact records aggregate scheduled attempts, successful samples, and failures; a cap or transient
inspection loss after startup therefore fails production/external release evidence instead of silently retaining a
partial high-water. The sampled-high-water caveat still applies between successful observations. The sampler excludes its own
observer subtree from process and open-file totals. Production/external release evidence is accepted only on Linux or
macOS; unsupported platforms fail the preflight instead of emitting partial or fabricated measurements.

Each sampler atomically checkpoints its evidence into the workflow's artifact directory once per second and on parent
exit. A separate run-lifecycle checkpoint records the current benchmark phase and ends as `complete` or `failed` when
the process can finalize normally. If the process is killed, the last `running` phase and the sampler's
`parent-exited` checkpoint remain. Sampler shutdown is bounded and escalates to process termination if the stop signal
cannot be written or honored. The production job has a hard 30-minute ceiling: capture is limited to 20 minutes and
artifact upload to 5 minutes, leaving the rest for checkout, setup, and summary. Upload runs with `if: always()`, so the
latest failure or timeout checkpoint is retained whenever the runner itself remains alive.

Graph code search is intentionally separate from memory recall. `recall_context` evaluates durable memories and
resources; `inspect_code_graph` evaluates current source evidence. Agents may call both, but one subsystem failing or
returning no answer cannot silently change the other's answer contract.

## Fixture contract

`createRecallEvaluationFixtureV2()` in `src/evaluation/recall-fixture.ts` creates the reviewed base corpus:

- 200 canonical-shaped documents and 250 queries;
- relevance grades from 0 through 3;
- explicit no-answer queries, forbidden URIs, authority pairs, expected stages, and required explanation codes;
- reviewed provenance and language on every document and query;
- every required category represented; the frozen v2 multilingual rotation currently yields Spanish only, so Polish
  and Ukrainian coverage requires a versioned replacement fixture rather than a silent baseline mutation;
- no semantic scores embedded in the fixture.

`expandRecallEvaluationFixtureV2()` deterministically grows the same corpus to 1,000, 10,000, or 100,000 documents.
The seed and generated-document count are part of the fixture identity. Generated records are marked `reviewed:
false`; they must never be added to relevance judgments.

Fixture identity normalizes the 4.0 `threadnote://` namespace rename back to the frozen 3.0.3 representation before
hashing. This keeps stored baselines and measured model candidates comparable when only the URI scheme changed; corpus,
query, or judgment changes still produce a different hash.

## Training boundary

The recall-v2 fixture, its expansions, and all checked baselines are evaluation-only. They are intentionally imbalanced
and do not constitute model-training data. The development-only harness under `training/recall-reranker/` uses a
separate versioned query-group contract, records immutable source/license/privacy provenance, partitions before rows,
and rejects exact overlap with this fixture. Its checked smoke generator is only a wiring test; it cannot support model
quality or release claims.

Candidate GGUF files are evaluated through this same frozen contract by passing `--reranker-manifest` and
`--reranker-path` to `bun run eval:recall:models`. The evaluator verifies the local file's size and SHA-256, parses the
normal production model manifest, invokes `LocalModelRuntime.rerank`, and applies the existing non-inferiority gate.

To add a scenario, add one hand-reviewed entry to `SCENARIOS`. Each entry creates eight documents and ten query
contracts. If a new behavior does not fit that shape, add an explicit document/query builder and preserve the minimum
counts. Validate that:

1. the desired document has a relevance grade;
2. unsafe or out-of-scope results are in `forbiddenUris`;
3. `expectedStages` describes the pipeline behavior being tested;
4. required reason codes are stable domain contracts, not model prose;
5. provenance is synthetic or public project material, never copied memory/customer data.

The Threadnote 3.0.3 baselines are frozen historical artifacts and must never be overwritten. An intentional fixture or
ranker change requires capturing a new reviewed current baseline from a clean commit and reviewing every metric delta:

```sh
git status --short
bun run eval:recall:baseline:v2
```

The v2 capture refuses a dirty checkout and defaults to
`baselines/threadnote-<package-version>/recall-v2-lexical.json`. It derives the package version, pipeline name, commit,
clean state, and commit timestamp from the checkout. `SOURCE_DATE_EPOCH`, `--created-at`, or `--output` may override the
reproducible timestamp or destination, but must not be used to relabel historical behavior. The legacy v1 capture
remains only for its frozen contract.

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
  --fail-on-contract \
  --fail-on-regression

# Keep the full query run as an untracked CI artifact
bun run eval:recall:v2 -- --no-baseline --documents 10000 --full --output artifacts/recall-v2-10k.json
```

The evaluator and model bake-off default to the reviewed Threadnote 4.2.7 lexical baseline. Its 193 exact contract
failure identities remain visible work, not silent waivers: with a baseline, `--fail-on-contract` allows fixes but
rejects any new identity or count increase; with `--no-baseline`, it remains zero-tolerance. A candidate must also pass
the independent non-inferiority gate for global, category, and safety metrics. Pass `--baseline` explicitly only to
reproduce a historical comparison.

## Performance suites

`bench:recall:micro` uses Mitata against a minified built artifact, outside Vitest's module runner. Its compact JSON
mode omits raw sample arrays:

```sh
bun run bench:recall:micro
bun run bench:recall:micro -- --json
THREADNOTE_BENCHMARK_100K=1 bun run bench:recall:micro -- --json
```

`bench:recall` is the explicit end-to-end orchestrator. It records p50/p95/p99 rank latency, throughput, RSS, heap,
and external memory together with commit/dirty state, fixture hash, Bun runtime, OS, architecture, CPU, RAM, warmups,
and samples. Use `--require-clean` for checked-in evidence; exploratory dirty runs remain available and identify
themselves as dirty:

```sh
bun run bench:recall -- --documents 10000 --samples 25 --warmups 5 --require-clean \
  --output .artifacts/recall-10k.json
```

`bench:recall:monorepo-shares` is a separate deterministic stress diagnostic for package-local work in a monorepo
where each logical memory has a personal copy and several team-share aliases. It does not mutate the frozen recall-v2
fixture or any checked baseline. The runner compares the full physical corpus with the same corpus admitted by the
current workspace-scope predicate, then exercises the production logical-memory deduper and ranker in both modes. It
reports physical and logical candidate counts, alias compression, duplicate-result rate, target-package recall@k, and
latency distributions:

```sh
# Bounded default: 64 packages × 24 logical memories × (1 personal + 3 shared copies).
bun run bench:recall:monorepo-shares -- --output .artifacts/recall-monorepo-shares.json

# Fast harness smoke while iterating.
bun run bench:recall:monorepo-shares -- \
  --packages 8 --logical-per-package 8 --share-aliases 2 --samples 2 --warmups 1
```

This in-memory diagnostic isolates workspace admission, ranking, and alias deduplication; it does not claim SQLite
index-build or filesystem-scan performance. Compare latency only for matching fixture hashes and runner classes. The
runner intentionally records observations without universal pass/fail latency thresholds.

The current Apple M1 Max/64 GiB `hybrid-v3` reference covers 200, 1k, 10k, and 100k documents under
`baselines/threadnote-4.2.7/benchmarks/darwin-arm64-m1-max/`. Every artifact has clean commit provenance and derives
`sourceVersion` from the package. The 3.0.3 and 4.0 performance files remain immutable historical observations. Compare
candidate latency only on like hardware/runtime and matching fixture hashes; do not turn one host's timings into
universal CI thresholds.

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
- Compact baseline: version 1 (`RecallEvaluationBaselineSchemaV1`); current artifacts add optional commit and dirty
  provenance while released artifacts without those fields remain valid
- Non-inferiority gate: version 1 (`RecallNonInferiorityGateV1`)
- Benchmark artifact: version 1 (`BenchmarkArtifactSchemaV1`)

Schema versions change only for incompatible contract changes. Add a migration before deleting a decoder for any
artifact format used by a released Threadnote version.
