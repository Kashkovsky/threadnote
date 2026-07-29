# Recall evaluation and benchmarks

This directory is the release-quality contract for Threadnote retrieval. It is intentionally independent of a
developer home, network access, local canonical data, and model-generated relevance scores.

## Native code graph contract

`fixtures/code-graph-v1/` is the reviewed repository and query contract for native source navigation. It covers
definitions, authoritative calls and dependencies, paths, reverse impact, documentation, no-answer behavior, and
linked-worktree dirty-overlay isolation. The fixture identity is frozen; changing the repository or judgments requires
reviewing every baseline with the new hash.

```sh
bun run eval:code-graph
bun run bench:code-graph -- --output artifacts/code-graph-local.json
bun run bench:code-graph -- --vectors --model-home ~/.threadnote --output artifacts/code-graph-vectors-local.json
bun run bench:code-graph -- --scale-symbols 10000 --fail-on-budget
bun run bench:code-graph -- --scale-symbols 100000 --fail-on-budget
bun run bench:code-graph -- --vectors --scale-symbols 10000 --model-home ~/.threadnote --fail-on-budget
```

The evaluator runs Threadnote's real Git inventory, extractor, SQLite store, and query service. It gates zero
authoritative false edges, zero worktree leakage, perfect no-answer precision/recall, perfect reviewed symbol/edge
recall, and MRR 1. The checked Graphify 0.9.29 result remains a frozen historical comparison, not the native release
floor. `threadnote-native.json` is the native baseline; `budgets.json` records quality and
development and scale performance limits. The default development and scale artifacts are explicitly lexical-only.
`performance-vectors-development.json` separately records activation and a lexically disjoint semantic query with the
pinned production embedding model. Reviewed local lexical 10k/100k results and a production-model 10k vector result
are stored as `performance-10000-development.json`, `performance-100000-development.json`, and
`performance-vectors-10000-development.json`. Scheduled 10k/100k production-vector jobs gate bounded sidecar decoding,
exact scans, RSS, and disk. The platform workflow retains full artifacts rather than pretending shared-runner latency
is machine-independent.

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
