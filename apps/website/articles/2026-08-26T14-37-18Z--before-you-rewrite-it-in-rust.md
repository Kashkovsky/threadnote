---
author: Denys Kashkovskyi
publishedAt: 2026-08-26T14:37:18Z
slug: before-you-rewrite-it-in-rust
socialImage: before-you-rewrite-it-in-rust-og.png
socialImageAlt: 'Before You Rewrite It in Rust — Threadnote improved a cold graph build from 164 minutes to 57 minutes.'
summary: 'How a 164-minute code-graph build became 57 minutes—and why the biggest wins came from deleting work, not changing languages.'
title: 'Before You Rewrite It in Rust: What Threadnote Learned From a 164-Minute Code-Graph Build'
---

At two hours and forty-four minutes, an indexer is no longer background infrastructure. It is a reason not to use the product.

That was Threadnote's starting point on IntelliJ Community: 164.3 minutes to build a code graph from scratch. Changing one file was not much better. The graph took another 184.4 seconds to become current.

The obvious explanation was sitting right there in the stack: Threadnote is written in TypeScript and runs on Bun. Surely this was the moment to rewrite the graph engine in Rust.

It was a compelling story. It was also mostly wrong.

Threadnote gives coding agents two different kinds of context. Memory explains why a project is the way it is: decisions, constraints, and handoffs from earlier work. The code graph explains what the source says now. It maps files, symbols, imports, calls, inheritance, and dependencies into a local SQLite store. An agent can use bounded queries to locate a declaration, follow a path, estimate a change's blast radius, or find larger structures such as communities, hubs, god nodes, and surprising links between subsystems.

That distinction matters in agentic development. Text search finds matching strings, but not necessarily the caller, re-export chain, or downstream contract that makes an edit safe. Memory preserves intent, but it ages. The graph is disposable evidence derived from the current commit, with uncommitted changes isolated per worktree. Repository files remain authoritative.

Threadnote can also add semantic retrieval using an installed local embedding model. The model still tokenizes text and consumes local compute; there is no magic removal of cost. But repository chunks do not pass through the coding agent's prompt, consume its context window, or incur hosted embedding charges. Structural graph queries continue to work without that model. [1]

All of this is useful only if “current” arrives on a developer's timescale. So we set two deliberately uncomfortable targets: under one hour for a cold graph of IntelliJ, and under 30 seconds for a one-file update. We also required the incremental graph to be identical to an independent rebuild of the same change. A fast, subtly incomplete graph would be worse than a slow one.

The eventual result was 57 minutes for the cold build and 10.7 seconds for the one-file update. The language did not change. The amount and shape of the work did.

## The profile changed the question

The baseline graph contained 2.34 million symbols and 6.96 million relationships from 225,852 files. Inventory and extraction took 37.6 minutes. Materialization—the mixed work of preparing and persisting graph surfaces—took 91.1 minutes. Resolving references took another 31.3 minutes.

The one-file profile was even more revealing. Parsing the changed file took 3.7 seconds. Registration, workspace scans, materialization, resolution, and activation consumed the other three minutes.

Rust might have made individual loops faster. It could not tell us that most of those loops should never have run for a one-file edit.

Even generous arithmetic pointed away from a direct port. Doubling the throughput of all three large cold phases still projected to roughly 84 minutes. Accelerating only materialization and resolution left the estimate above 100 minutes. The first job was not to execute the architecture faster. It was to stop asking the architecture to replay the repository.

The final exact-release observation looked like this:

| Governed wall time | Threadnote 4.3.1 | Threadnote 4.3.8 | Reduction |
| ------------------ | ---------------: | ---------------: | --------: |
| Cold graph         |     2h 44m 17.3s |       57m 6.563s |     65.2% |
| One-file update    |         184.400s |          10.748s |     94.2% |
| Registration       |          50.400s |           4.852s |     90.4% |
| Post-scan work     |          37.100s |             53ms |     99.9% |

These are exact governed observations, not universal estimates. Both releases ran on the same Apple M1 Max with 64 GiB of memory, internal APFS storage, and the same pinned public IntelliJ commit. A separately retained operator launcher set four parser workers; the public artifact does not serialize that field. The incremental same-overlay graph matched an independent rebuild of that same overlay, passed language controls for Java, Kotlin, TypeScript, and Bazel, and completed without sampler or publication failures. I am Threadnote's creator and maintainer and designed and operated these measurements; exact provenance, retained misses, correctness controls, and resource evidence are published so the claims do not depend on operator neutrality. [1] [2]

## Delete work before optimizing it

Three research ideas gave us a better vocabulary for the problem.

_Build Systems à la Carte_ separates the scheduler—which chooses when work runs—from the rebuilder—which decides whether the work is needed at all. [3] Research on demand-driven incremental computation and demanded static analysis asks a related question: can a system update only the results affected by a change while preserving equality with a full computation? [4] [5] DBSP treats rich computations as views maintained over deltas instead of repeatedly recomputed from the original input. [6]

Threadnote did not implement any of those systems wholesale. They supplied a standard to aim at: a one-file edit should flow through one changed file plus explicitly proven dependency fanout, not through a cleverly disguised full rebuild.

### Make a one-file change stay small

The old cache path unpacked repository-sized payloads merely to decide whether one file could reuse them. It parsed large fact records to recover paths, then repeatedly asked Git and the workspace to restate information it already had.

The replacement kept a small, trustworthy inventory beside the large parser facts. For an ordinary body edit, Threadnote could compare that file with the reusable committed base, load one cached fact, and update one file. If the change could alter imports, exports, or another file's meaning, it followed reverse dependencies up to a strict bound. Ambiguous, malformed, or unexpectedly broad evidence still fell back to the complete path.

That last qualification is important. Threadnote does not claim that every edit is universally `O(changed files)`. It claims something narrower and testable: an admitted body-only edit stays proportional to its changed set, while a resolution-surface edit adds only its bounded, proven dependency closure.

On the final IntelliJ run, the dirty-overlay path inspected one inventory entry, loaded one base fact, staged one file, and probed zero dependency paths. That is why a one-file update became a one-file update. [13]

### Feed the heavy tail instead of adding workers

Large and structurally complex files created a parser tail: three workers could finish while one expensive file kept the fourth busy. Scheduling research suggests starting the longest predicted jobs first. [7] Threadnote learned a deterministic cost estimate from language, file size, and prior request and output sizes, then committed results in stable order regardless of completion order. [13]

The surprise was what happened next. Four workers beat six. Six beat eight. On the governed fixture, the means were 2.835, 2.913, and 3.033 seconds respectively. More concurrency created more contention; it did not create more throughput.

“Use every core” would have been easy advice. The measured answer was to keep four workers and give them better work.

### Cooperate with SQLite's one writer

SQLite permits many readers but one writer. WAL mode improves coexistence; it does not remove that writer. [8] Threadnote's original materializer amplified the constraint with repeated sorting, transient structures, query indexes built too early, and transactions shaped around implementation convenience rather than resumable work.

The faster design streamed deterministic sorted pages through a bounded SQLite sidecar spool. Reconstructible query indexes were deferred until after bulk materialization. Reference transactions became adaptive. Parser queries were compiled once and reused. A validated private Git-status cache avoided repeated repository scans without mutating the real Git index or repository configuration. [13]

Changing new databases from 4 KiB to 8 KiB pages delivered one of the strongest isolated wins: 16.6% less cold time and a 34% smaller final database. It also raised peak RSS by 5.1% and WAL high-water by 43.8%. We kept both sides of that result. Existing stores were not migrated on the strength of a benchmark that had measured only new ones.

Several plausible ideas simply lost:

- three proposed resolution caches made matching 27–36% slower;
- lower-level parser-input tricks lost to the existing control;
- fixed reference-batch limits helped one graph shape and hurt another;
- extra parser workers reduced throughput;
- weaker default durability was rejected rather than counted as a speedup.

A Rust port could have made every one of those losing designs more expensive to discover. [13]

## The last 200 milliseconds were the most educational

The cold build crossed one hour before registration crossed five seconds. Five exact release-scale observations landed between 5.178 and 5.255 seconds. Each missed the hard gate by only a few hundred milliseconds. [14]

It would have been easy to rerun until noise produced a passing number. We retained every miss instead.

The first explanation looked convincing: a private Git accelerator tried to start the filesystem-monitor daemon, received a nonzero exit because the daemon was already healthy, and discarded a valid cache. Fixing that behavior produced a dramatic reduced-fixture win. The next IntelliJ run still missed.

Then physical Git-index churn looked guilty. Git can rewrite an index inode without changing the staged tree, so Threadnote learned to fingerprint semantic fields rather than treating timestamps and inode identity as repository meaning. The fallback became much faster. The next full run still missed, because the ordinary one-file path had never taken that fallback.

Profiling the path that actually ran found the real payload: a reusable receipt decoded 3,417 resolution-context files, about 10.1 MB encoded, when repository attribution needed only 81 `package.json` files and six `tsconfig.json` files—about 251 KB. Narrowing the receipt cut median decode time from 272.4 milliseconds to 6.7 milliseconds. The next exact-release registration took 4.852 seconds. [13] [14]

The lesson was not that 200 milliseconds require heroic optimization. It was that component evidence does not automatically transfer to the product path. A benchmark can prove that a mechanism became faster while the user never exercises that mechanism at all.

## Performance work needs a truth machine

Every candidate moved through four different kinds of evidence:

1. Focused regression tests and bounded property tests checked semantics.
2. The exact clean commit was installed globally and exercised through the real CLI.
3. A production-shaped fixture measured governed latency, resource, graph-shape, and failure metrics.
4. A manual exact-release run checked that the result transferred to the pinned IntelliJ repository and machine.

The permanent CI ratchet deliberately does not rebuild IntelliJ. That would make routine development intolerable. It uses 3,000 generated source files, roughly 110,000 symbols, and 529 independently governed metrics. Exact fields cover correctness, graph shape, proportional work, and failure counts. Noisy hosted measurements use reviewed absolute and relative headroom. The full IntelliJ artifact is the separate release gate behind public performance claims. [2]

Properties covered three rules that one happy example could not: incremental output must equal a clean rebuild across different schedules, interrupted work must resume safely, and malformed cache evidence must fail closed without mutating the real Git index.

Examples remained essential for temporal failures. One test forced the exact race in which a worktree could publish a snapshot after another writer had deferred a required query index. We did not wait for that schedule to happen by chance. [13]

The rule was simple: an optimization could improve a governed metric, but it could not silently degrade another one. Faster with a larger WAL, higher RSS, a longer writer lock, incomplete graph parity, or a rare full fallback was not an unqualified win.

## Why Effect mattered

Threadnote's application model is Effect. Effect did not make SQLite atomic and it did not invent incremental computation. It made cancellation, failure, concurrency, and resource lifetimes explicit enough that the optimized paths could be trusted. [9]

Scopes and finalizers bound parser workers, subprocesses, temporary directories, leases, spool files, and writer ownership to a lifetime that ended on success, typed failure, or interruption. Fibers made cancellation cooperative. Effect's Vitest integration provided scoped tests and a deterministic test clock, while the few boundaries that genuinely depended on OS processes, SQLite leases, or wall time opted into live time explicitly.

That structure made ugly tests possible: interrupt a spool replay and prove cleanup is idempotent; fail a later transaction and prove a durable prefix survives; control the exact writer-gate interleaving that once produced a missing-index error.

SQLite transactions and ready-snapshot state supplied durable atomicity. Effect made it much harder for a failed or cancelled workflow to skip the cleanup that preserved that atomicity. Reliability was not a tax paid after optimization. It was what made cached and incremental work safe to reuse.

## A fair comparison with Graphify

Graphify is the obvious comparison because the feature overlap is real. Graphify v0.9.49 and Threadnote both extract local code structure, expose bounded queries to agents, and surface architecture such as communities, god nodes, and surprising connections. Both model higher-order relationships—structural n-ary groups in Threadnote and hyperedges in Graphify—and expose confidence or provenance review, reports, and portable exports. The schemas and emphasis differ, but those capabilities are not Graphify-exclusive. Graphify also offers broader language and configuration coverage, document and media ingestion, and specialized graph destinations and workflows; Threadnote combines its graph with persistent agent memory, local semantic retrieval, and isolated worktree overlays. [10]

The products make different operational choices. Threadnote keeps its disposable operational graph in SQLite, publishes immutable ready snapshots, and layers each worktree's uncommitted changes independently. Graphify normally publishes a monolithic `graph.json`. It supports separate or shared destinations through `GRAPHIFY_OUT`, advisory rebuild locking, and atomic replacement, but its installed hooks deliberately avoid rebuilding from linked worktrees. Its supported query and MCP loaders apply a 512 MiB graph-file guard by default, then read the complete JSON, parse it, and hydrate a NetworkX graph; the guard can be raised explicitly. [11]

For the controlled structural comparison, we disabled semantic model work and clustering. Threadnote ran lexical-only; Graphify ran `--code-only --no-cluster`. Graphify recorded its four-worker cap in the public summary; Threadnote's matching setting came from the separately retained launcher disclosed above. Both ran on the same M1 Max, internal storage, and pinned IntelliJ checkout. Their native inventories differed—225,852 indexed files for Threadnote and 191,249 code files reported by Graphify—so a direct per-file throughput ratio would not be honest.

The result was still operationally meaningful. Graphify reported all 191,249 per-file AST steps, then continued in a downstream phase without a bounded remaining-work estimate. We stopped it after 5 hours 32 minutes, after it exceeded a five-hour developer-utility threshold. At interruption, parent RSS was 12.1 GB, process-tree peak RSS was 14.8 GB, and a 3.7 GB per-file AST cache existed. There was no `graph.json` and no atomic write-temp artifact. [12]

That is a right-censored result. It does not tell us when Graphify would eventually finish, and it does not prove that a larger machine or longer wait could not complete it. It does prove that the tested configuration produced no queryable graph inside the operator's working window.

The persisted AST cache could avoid repeating every parse on a restart. Source review indicates that cross-file resolution and in-memory graph construction would restart, and the terminal JSON is published only at the end. In other words, the multi-hour downstream work had no durable continuation checkpoint. Because no graph artifact arrived, we could not run the default loader, a safely raised-cap hydration probe, warm queries, or an incremental-update control. Queryability did not fail; it never became available.

There is a second comparison axis that a code-only stopwatch misses. Threadnote's optional local embeddings improve semantic seed retrieval without consuming the coding agent's context or hosted-provider tokens. Graphify's code-only graph is deliberately non-vector. Graphify can use a fully local Ollama backend for its broader document and media ingestion path, so “local” is not exclusive to Threadnote either. These are different product capabilities, not a reason to smuggle model work into the structural benchmark.

## When Rust becomes the right answer

This work does not prove that TypeScript is as fast as Rust. It proves that the original implementation paid for the wrong things.

Metadata authority was hidden in large payloads. Small edits reconstructed repository state. Expensive parser work arrived late. Persistence amplified sorting and writes. Resolution rebuilt transient structures. Indexes existed during the phase in which they were costly and unnecessary. A line-for-line port would have preserved most of that waste.

Before rewriting a working system, ask three questions:

1. Is the amount of work proportional to the logical change?
2. Are I/O, transactions, scheduling, and data layout shaped for the storage engine and runtime you already have?
3. Does profiling still reveal a stable hot leaf whose cost is intrinsic to the language boundary?

If all three answers are yes, Rust may be the right next tool. It could provide a tighter codec, a predictable immutable segment, a lower-overhead parsing kernel, or safer native concurrency. By then, however, the target is small, measured, and protected by parity tests. You are replacing a bottleneck instead of rediscovering years of semantics in another language.

There is a surprising amount of performance available before the first line of Rust. More importantly, finding it tells you where Rust could actually matter.

## References and implementation record

[1] Threadnote, [native code-graph contract](https://github.com/Kashkovsky/threadnote/blob/v4.3.8/README.md), [v4.3.8 release](https://github.com/Kashkovsky/threadnote/releases/tag/v4.3.8) at commit `f1e4102a78e4df2127fca0c4d59da39ffb5f70a6`, and [content-addressed exact-release evidence](https://threadnote.io/performance-evidence.b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39.json). The artifact records 3,426,563.136875 milliseconds cold, 10,748.486666 milliseconds for the one-file update, 4,851.893916 milliseconds for registration, and 53.179375 milliseconds post-scan. A read-only `git status --porcelain` overlapped only the later independent-reference phase, after all four headline timings; it made no mutation but may have perturbed downstream timing or resource observations.

[2] Threadnote issue [#203: Make code-graph indexing proportional at IntelliJ scale](https://github.com/Kashkovsky/threadnote/issues/203), including the baseline, goals, research record, retained misses, and delivery evidence; plus the [529-metric production ratchet](https://github.com/Kashkovsky/threadnote/blob/v4.3.8/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json) and [permanent workflow](https://github.com/Kashkovsky/threadnote/blob/v4.3.8/.github/workflows/code-graph-production-ratchet.yml).

[3] Andrey Mokhov, Neil Mitchell, and Simon Peyton Jones, [_Build Systems à la Carte_](https://www.microsoft.com/en-us/research/wp-content/uploads/2018/03/build-systems.pdf), PACMPL/ICFP 2018.

[4] Matthew A. Hammer et al., [_Adapton: Composable, Demand-Driven Incremental Computation_](https://doi.org/10.1145/2594291.2594324), PLDI 2014.

[5] Benno Stein, Bor-Yuh Evan Chang, and Manu Sridharan, [_Demanded Abstract Interpretation_](https://plv.colorado.edu/papers/dai-pldi21.pdf), PLDI 2021.

[6] Mihai Budiu et al., [_DBSP: Automatic Incremental View Maintenance for Rich Query Languages_](https://www.vldb.org/pvldb/vol16/p1601-budiu.pdf), PVLDB 2023.

[7] R. L. Graham, [_Bounds on Multiprocessing Timing Anomalies_](https://epubs.siam.org/doi/10.1137/0117039), SIAM Journal on Applied Mathematics 1969.

[8] SQLite, [transactions](https://sqlite.org/lang_transaction.html), [write-ahead logging](https://www.sqlite.org/wal.html), [transaction speed](https://www.sqlite.org/faq.html#q19), and [atomic commit](https://sqlite.org/atomiccommit.html).

[9] Effect upstream [`Scope`](https://github.com/Effect-TS/effect/blob/de2a9a69099993087e57c64df58537c765ac0224/packages/effect/src/Scope.ts), [`Fiber`](https://github.com/Effect-TS/effect/blob/de2a9a69099993087e57c64df58537c765ac0224/packages/effect/src/Fiber.ts), and [`@effect/vitest`](https://github.com/Effect-TS/effect/tree/de2a9a69099993087e57c64df58537c765ac0224/packages/vitest) contracts at the source version used by Threadnote v4.3.8.

[10] Graphify [v0.9.49 release](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.49) and [product contract](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/README.md), including code-only extraction, Ollama, queries, MCP, reports, architecture analysis, update/watch, and exports.

[11] Graphify v0.9.49 source contracts for the [graph-file load guard](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/security.py), [JSON-to-NetworkX query loading](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/serve.py), [`GRAPHIFY_OUT` and atomic publication](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/paths.py), [rebuild locking](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/watch.py), and the [linked-worktree hook guard](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/hooks.py).

[12] Threadnote, [controlled Graphify v0.9.49 IntelliJ evidence](https://threadnote.io/graphify-intellij-evidence.bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1.json), including command, provenance, resource samples, terminal-artifact boundary, source-reviewed restart semantics, and retained artifact hashes.

[13] Threadnote implementation record: admission, authority, and incremental closure ([#200](https://github.com/Kashkovsky/threadnote/pull/200), [#201](https://github.com/Kashkovsky/threadnote/pull/201), [#205](https://github.com/Kashkovsky/threadnote/pull/205)); extraction scheduling ([#202](https://github.com/Kashkovsky/threadnote/pull/202)); materialization, resolution, storage experiments, and the ratchet ([#204](https://github.com/Kashkovsky/threadnote/pull/204), [#206](https://github.com/Kashkovsky/threadnote/pull/206), [#208](https://github.com/Kashkovsky/threadnote/pull/208)); Git admission, maintenance, and compact receipts ([#217](https://github.com/Kashkovsky/threadnote/pull/217), [#221](https://github.com/Kashkovsky/threadnote/pull/221), [#224](https://github.com/Kashkovsky/threadnote/pull/224), [#227](https://github.com/Kashkovsky/threadnote/pull/227), [#230](https://github.com/Kashkovsky/threadnote/pull/230)); deterministic race, sampler, and provenance controls ([#213](https://github.com/Kashkovsky/threadnote/pull/213), [#214](https://github.com/Kashkovsky/threadnote/pull/214), [#215](https://github.com/Kashkovsky/threadnote/pull/215)).

[14] Threadnote retained exact IntelliJ observations: v4.3.4 at commit `4f53313c8a605ff12d8ab9e494a3bf3cbe83958f` (artifact SHA-256 `c25e1dc8cdbc96e5aa0e4803f37bc949e9b4220e109ecf0245171471d5f8bc9d` and `0f3ba956f491d4de39d81101ddfaae029eb097146cea29ce3f848f69bbf79fad`), v4.3.5 at `f3e1bd46640a1c41488dfef89de712323ac4911a` (`cc337e8778eb8e2d0590b995f43985f21f6da3ec50ec2bdb53d201cbce1110f7`), v4.3.6 at `91cc2eb21beeccd3fe2b181201539709f184041e` (`731f8694ac4e4617601ba814dacba7d95729ad32a7537c7dea1bfd2d7efcd569`), and v4.3.7 at `ed2a7a8654149b1fb97fd4319bea95403557928b` (`899faf6380b2fb6a69078b5cd79837451453be02541df4956854da1df6414a97`). The raw artifacts were retained locally. The compact-receipt profiling and focused evidence are documented in [#230](https://github.com/Kashkovsky/threadnote/pull/230).
