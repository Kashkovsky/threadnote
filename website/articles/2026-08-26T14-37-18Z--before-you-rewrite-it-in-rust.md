---
author: Denys Kashkovskyi
publishedAt: 2026-08-26T14:37:18Z
slug: before-you-rewrite-it-in-rust
summary: 'How Threadnote cut a 164-minute code-graph build below one hour—and made one-file updates proportional—without rewriting the engine in Rust.'
title: 'Before You Rewrite It in Rust: What Threadnote Learned From a 164-Minute Code-Graph Build'
---

Threadnote is a local context and memory system for coding agents. It lets an agent recall decisions and handoffs from earlier work, but it also gives the agent something memory cannot: a current, source-derived map of the code it is about to change. That map is a searchable SQLite code graph of files, symbols, imports, calls, inheritance, dependencies, and higher-order relationships. Agents can use it to find a declaration, follow neighbors and paths, estimate change impact, or inspect repository-wide topology such as communities, hubs, god nodes, and surprising cross-community links. A god node is a symbol or module with unusually broad connectivity: useful to identify, but also a warning that a change may have a wide blast radius. The graph follows the current Git commit and keeps each worktree’s dirty overlay—the uncommitted changes layered over that commit—isolated. [1]

In practical terms, the graph helps answer the questions that arrive before a safe edit: Where is this behavior actually defined? Which callers and re-export chains reach it? What else depends on this schema or interface? Is a familiar-looking symbol from this package, a sibling package, or generated code? A bounded graph answer does not replace reading source. It gives the agent a structurally informed place to start and a way to check the likely blast radius after the change.

That distinction matters because coding agents have two recurring failure modes. Searching text finds matching strings but not necessarily the declaration, caller, re-export chain, or downstream impact that makes a change safe. Remembered context explains why a design exists, but it can become stale as soon as the source changes. Threadnote therefore keeps historical memory and current-code evidence separate: recall is for prior decisions; graph inspection is for what the repository says now.

The graph is deliberately derived and disposable. Repository files and Git objects remain authoritative. A damaged or obsolete graph can be deleted and rebuilt without changing source or canonical memory. Exact and lexical graph retrieval works without a model. Optional semantic embeddings, produced by an installed local model, complement the abstract-syntax-tree (AST) structure when wording differs from source identifiers. The local model still tokenizes text internally, and it consumes local CPU, memory, storage, and runtime. The distinction is where that work happens: Threadnote does not ask the coding agent to ingest repository chunks through prompts, spend its context window, or buy hosted embedding tokens. [1] [18]

This architecture makes performance part of correctness. If building current evidence takes hours, an agent will fall back to grep or stale memory. If an incremental update secretly rebuilds the repository, worktree-aware freshness becomes unusable. And if a “fast” index can publish partial rows after interruption, a quick answer is worse than no answer.

That was the setting for Threadnote 4.3.1. On a pinned public IntelliJ Community checkout, a cold lexical build took 164.3 minutes. The first impulse could easily have been: TypeScript is too slow; rewrite the graph engine in Rust. We chose to ask a harder question first: how much time came from the language, and how much came from doing the wrong work?

### How to read the measurements

A **cold build** starts without a reusable graph. A **one-file update** starts from a ready committed graph with exactly one tracked file changed. **Registration** is the admission work before that update can reuse prior evidence; **post-scan** is the bounded workspace work after the source scan. **Structural parity** means the incremental result has the same normalized graph digest as an independent rebuild of the same dirty overlay. A **ratchet** is a permanent regression gate: later changes may improve a governed metric but may not silently make it worse. RSS means resident-set memory, and WAL is SQLite’s write-ahead log.

The exact-release comparison used the same Apple M1 Max with 64 GiB of memory, internal APFS solid-state storage, and IntelliJ Community commit `3cbdad9ee6c8a5135fc0f01cc90114fc25c0655c`. The separately retained Threadnote operator launcher set four parser workers (launcher SHA-256 `3d8edfd86376f6aaaa9efbf3989cbcea5a02f414e82a653637c9b2eea061c9cd`); the public Threadnote benchmark artifact does not serialize that field. The v4.3.8 run used Bun 1.3.14 and began with at least 120 GiB free. Release-scale timings below are single governed observations, not population estimates or confidence intervals. Unless stated otherwise, MB and GB are decimal units; MiB and GiB are binary units. Percentages compare observed wall times.

**Disclosure:** Denys Kashkovskyi is Threadnote’s creator and maintainer and designed or operated these measurements. The method therefore binds exact source and fixture identities, retains misses, validates independent correctness and failure controls, and publishes caveats instead of relying on operator neutrality.

## The run that challenged the architecture

The retained 4.3.1 evidence indexed 225,852 files into 2,339,372 symbols and 6,963,512 edges. Cold inventory and extraction took 37.6 minutes, materialization 91.1 minutes, and reference resolution 31.3 minutes. A one-file dirty-overlay rebuild took 184.4 seconds: 50.4 seconds of registration, 37.1 seconds of post-commit scan and workspace work, 35.6 seconds of materialization, 29.0 seconds of resolution, 28.7 seconds of activation, and only 3.7 seconds of extraction. Cold materialization replayed 7,518,745,725 bytes of cached facts. [2]

These were measurements from one exact Threadnote commit, one repository commit, and one governed machine—not a universal promise. They nevertheless exposed a structural problem. The one-file path spent almost all its time outside parsing the changed file. The cold path spent most of its time turning already-extracted facts into durable graph surfaces.

An Amdahl-style estimate made the implications concrete. Doubling the throughput of all three large cold stages still projected to roughly 84 minutes. Doubling the throughput of only materialization and resolution left about 103 minutes. Even tripling materialization and resolution throughput while doubling extraction throughput projected to about 64 minutes. The rounded named stages account for about 160 of the 164.3 minutes; orchestration and smaller phases account for the remainder. A localized loop optimization, more workers, or a single SQLite pragma would not meet the one-hour target. The system needed to eliminate repository-sized work from incremental cases and change the cold data flow.

The engineering gates were therefore explicit: cold indexing below one hour; one-file indexing below 30 seconds; registration and post-scan below five seconds each; work proportional to the changed set plus bounded required dependency fanout; exact graph and primary-query parity against an independent rebuild; and independent controls for CPU, RSS, disk, transactions, graph shape, and failure evidence so an aggregate win could not hide a regression. [2]

The retained full-scale sequence is easier to understand as a table. Each cell is one exact observation except for the explicitly paired v4.3.4 row; a miss was kept rather than rerun unchanged.

| Release observation       |                Cold build |  One-file update |    Registration |   Post-scan | Hard latency gates               |
| ------------------------- | ------------------------: | ---------------: | --------------: | ----------: | -------------------------------- |
| v4.3.1 baseline           |            2h 44m 17.300s |         184.400s |         50.400s |     37.100s | 0/4                              |
| v4.3.3                    |               58m 23.849s |          24.016s |          9.366s |       177ms | 3/4; registration missed         |
| v4.3.4, two retained runs | 58m 47.730s / 57m 38.761s | 11.618s / 9.876s | 5.212s / 5.191s | 57ms / 55ms | 3/4 in both; registration missed |
| v4.3.5                    |               58m 33.894s |          11.791s |          5.234s |    56.821ms | 3/4; registration missed         |
| v4.3.6                    |               58m 46.774s |          11.818s |          5.178s |    57.225ms | 3/4; registration missed         |
| v4.3.7                    |               59m 43.019s |          12.169s |          5.255s |    58.254ms | 3/4; registration missed         |
| v4.3.8                    |                57m 6.563s |          10.748s |          4.852s |    53.179ms | **4/4 passed**                   |

A later exact clean candidate on the same IntelliJ commit completed cold indexing in 75 minutes 53.657 seconds. Its one-file path took 21.851 seconds, registration 8.293 seconds, and post-scan 105 milliseconds, with exact incremental-versus-independent parity and zero sampler failures. Relative to 4.3.1, that candidate cut cold wall time by about 54% and the one-file operation by about 88%. It met the one-file goal but still missed the cold and registration goals. It is candidate evidence, not a release result. [9]

The exact v4.3.3 release run at commit `52a013157c757abb1b49cb02c6eae098c6af3345` crossed the largest threshold. Cold indexing completed in 58 minutes 23.849 seconds—64.5% below the 4.3.1 baseline, or 2.81 times as fast. The one-file path completed in 24.016 seconds, 87.0% lower than 4.3.1, and post-scan took 177 milliseconds, 99.5% lower. Registration fell from 50.4 seconds to 9.366 seconds but still missed its five-second gate. Incremental and independent-rebuild structural digests matched; Java, Kotlin, TypeScript, and Bazel controls passed; and the body-only overlay inspected one inventory file, loaded one base fact, staged one file, and probed zero dependency paths. The release evidence therefore met the cold, one-file, post-scan, parity, and proportionality goals while reporting registration as the one remaining miss. [2] [14]

That miss led to one more narrow investigation. The private Git accelerator copied a large index, then unconditionally started Git’s filesystem-monitor daemon. On the measured Git version, “start” exited nonzero when the daemon was already healthy; Threadnote treated the cache as unavailable and fell back to repeated full status scans. The retained fix checks daemon status first, treats a nonzero start only provisionally, and enables the cache only after a healthy final status. On the governed reduced fixture, cold indexing took 71.601 seconds, the one-file path 1.220 seconds, registration 293.650 milliseconds, and post-scan 33.850 milliseconds with exact parity and proportional work. These figures come from retained local evidence, not a publicly hosted raw artifact. [36]

The exact merged-HEAD development run at commit `26a5f96ef35dd3c371163972e8f82071cd9a91b0` then produced the first all-green full-scale development observation. It indexed the same 225,852 files into 2,339,372 symbols, 6,963,512 edges, and 42,872,270 lexical postings. Cold indexing took 58 minutes 41.220 seconds—0.5% slower than the single v4.3.3 observation but still 64.3% below the 4.3.1 baseline and under one hour. The one-file path took 6.411 seconds, registration 2.451 seconds, and post-scan 55 milliseconds; versus v4.3.3 those incremental measurements improved 73.3%, 73.8%, and 68.9% respectively. The longest reference transaction was 8.859 seconds and the longest activation transaction 127 milliseconds, both below their 15-second limits. [37]

The incremental graph and its independent same-overlay rebuild had the same SHA-256 structural digest, the primary query and all four language controls matched, one inventory file and one base fact were read, one file was staged, zero dependency paths were probed, and every required failure control was zero. Cold peak RSS was 8.60 GiB; the independent rebuild peaked at 12.14 GiB; the database was 16.63 GiB; and each full build peaked at 2.39 GiB of temporary storage. The artifact SHA-256 is `3f516784f0a37ef943ecee77a180b83057d4e13efcf17734830dc37f8c037b1c`. The repository’s authoritative evidence validator passed. A temporary outer launcher reported failure only because it incorrectly required the clean graph and the intentionally changed dirty-overlay query to be identical; both the retained v4.3.3 artifact and this run correctly record that deliberate structural change while requiring parity against the independent same-overlay rebuild. [37]

The exact v4.3.4 release observations kept us honest about single-run selection. Two clean runs recorded cold times of 58 minutes 47.730 seconds and 57 minutes 38.761 seconds, one-file times of 11.618 and 9.876 seconds, and post-scan times of 57 and 55 milliseconds. Both preserved graph/query parity, proportional one-file work, transaction bounds, and every required failure control. But registration took 5.212 and 5.191 seconds—misses of 212 and 191 milliseconds against the hard five-second gate. We retained both failures and declined to run unchanged trials until one happened to pass. [43]

The discrepancy exposed a subtle cache-identity mistake. Harmless Git status bookkeeping can atomically rewrite the real index, changing inode and timestamps without changing the staged tree. Threadnote’s receipt treated those physical metadata changes as semantic invalidation and discarded a warmed 49 MB private filesystem-monitor index. The correction keeps the cheap metadata fast path, but on metadata churn compares a bounded digest of staged paths, modes, object IDs, stages, and skip/assume flags. Matching semantics permit reuse; changed, missing, malformed, oversized, or racy evidence fails closed to reinitialization. A real IntelliJ probe fell from 5.27 seconds initially to 1.48 seconds after a content-neutral index rewrite and 272 milliseconds on the next warm observation. The focused regression suite also proves that metadata-only churn avoids reinitialization while a real staged change does not. [44]

The exact v4.3.5 release observation showed why a component win is not a product gate. Cold indexing completed in 58 minutes 33.894 seconds, the one-file path in 11.791 seconds, and post-scan in 56.821 milliseconds. Registration was 5.234 seconds: a 233.720-millisecond miss. Parity, proportional work, transaction limits, polyglot controls, and every required failure control still passed. We preserved the artifact instead of rerunning it away. The result narrowed the remaining cost again: registration also performed bounded reclamation of unreachable completed-build rows left by the cold publication. Those rows are maintenance, not admission input. The next correction keeps schema validation before foreground work but moves the same bounded reclamation to session finalization, where it remains inside end-to-end indexing time without delaying the start of useful work. [45]

The exact v4.3.6 observation falsified that hypothesis at product scale. Cold indexing still passed at 58 minutes 46.774 seconds, the one-file path passed at 11.818 seconds, and post-scan passed at 57.225 milliseconds. Registration reached 5.178 seconds, missing by 178.427 milliseconds. Every correctness, proportionality, transaction, polyglot-query, and failure control passed, but the maintenance deferral had not moved the measured gate enough. We preserved this release miss too. The useful lesson was not that the change had no value; it was that a plausible causal story backed by a smaller benchmark was still not enough to declare the user-visible bottleneck solved. [46]

The remaining admission work was then reduced at its source. Threadnote had been asking Git to emit every staged entry and then hashing that full semantic listing in JavaScript whenever physical index metadata changed. The replacement reads Git index v2, v3, and v4 directly under a 128 MiB bound, verifies its trailer checksum, and fingerprints only semantic fields: path bytes, mode, object ID, stage, and relevant flags. Mutable stat-cache fields and optional cache extensions do not invalidate reuse; split, sparse, malformed, unknown-required, oversized, or racy evidence fails closed to the canonical Git path. On IntelliJ’s 45.9 MiB, 278,115-entry index, the direct fingerprint took 154 milliseconds. Under the same warmed metadata-churn control, admission fell from 1.430 seconds to 440 milliseconds. A governed reduced repository then recorded a 2.283-second one-file operation, 457-millisecond registration, 194-millisecond post-scan, exact structural parity, and one changed, inspected, and staged file. Those were strong component and ratchet results—but the exact-release IntelliJ run still remained the product gate. [47]

The exact v4.3.7 run showed why transfer evidence matters. Cold indexing passed at 59 minutes 43.019 seconds, the one-file operation passed at 12.169 seconds, and post-scan passed at 58.254 milliseconds. Registration measured 5.255 seconds, missing the hard gate by 255 milliseconds. Every other retained correctness, proportionality, transaction, polyglot-query, and required failure control passed. The direct Git-index parser had improved the metadata-churn fallback, but the ordinary one-file run reused an unchanged physical index identity and therefore did not exercise that fallback. We preserved the release failure and did not rerun unchanged code. [48]

That miss redirected profiling from the fallback to the data actually decoded on an ordinary admission. The retained IntelliJ receipt carried 3,417 resolution-context files: 8.49 MB of source evidence and 10.12 MB once encoded. Repository attribution needed only 81 `package.json` files and six `tsconfig.json` files, totaling about 251 KB encoded. Median receipt decoding fell from 272.4 milliseconds to 6.7 milliseconds when measured against the compact form. The next candidate persisted that narrow attribution subset while retaining the complete derived workspace elsewhere and reused the decoded context across discovery, attribution, and closure fallback. On the governed reduced fixture it recorded a 1.281-second one-file operation, 300-millisecond registration, 60-millisecond post-scan, exact parity, and one changed, inspected, and staged file. At that point, it was causal component and ratchet evidence rather than an IntelliJ release result. [49]

The exact v4.3.8 release run at commit `f1e4102a78e4df2127fca0c4d59da39ffb5f70a6` finally passed all four hard latency gates on the pinned IntelliJ fixture. Cold indexing took 3,426,563.136875 milliseconds (57 minutes 6.563 seconds), the one-file update 10,748.486666 milliseconds, registration 4,851.893916 milliseconds, and post-scan 53.179375 milliseconds. Against the retained v4.3.1 observation, those wall times were lower by 65.2%, 94.2%, 90.4%, and 99.9%, respectively. The run admitted 225,867 eligible files and indexed 225,852 of them into 2,339,372 symbols and 6,963,512 relationships. [50]

The dirty-overlay path recorded one changed file, zero deleted files, one inventory entry inspected, one base fact loaded, one file staged, zero dependency probes, and 78 attribution contexts. Its structural digest matched the independent same-overlay rebuild, and the Java, Kotlin, TypeScript, and Bazel query controls matched. All six governed reference and activation transactions completed below 15 seconds, every required failure control was zero, and the release-bound evidence validator passed. Cold peak RSS was 8.39 GiB, the final database was 16.64 GiB, and peak temporary storage was 2.39 GiB. The artifact SHA-256 is `b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39`. [50]

There is one disclosed interference event. After the headline cold, one-file, registration, and post-scan target phases had completed, a separate read-only audit ran `git status --porcelain` for 4.6 seconds during the independent same-overlay reference phase. It reported only the expected modified file and made no mutation. It could still have perturbed read caches or competed for I/O in that downstream phase, so the independent-reference and downstream resource observations carry that limitation. We retained the artifact and did not rerun it; the already-completed headline timings were not exposed to the audit command. [50]

## Measure first, because phase names can lie

The original phase labels hid important distinctions. “Attributing” included attribution, final-fact serialization, compression, hashing, and materialized-shard writes. “Materialization” mixed computation with persistence. Several incremental phases consumed little process CPU relative to wall time, suggesting waiting or I/O, but the evidence could not identify which operation.

The first retained change was therefore observability, not speed. Materialization was split into parser-fact serialization, attribution compute, fact-batch preparation, shard serialization, shard persistence, and association. The benchmark artifact grew to include phase and subphase wall time, process and recursive CPU, process-tree RSS, SQLite main/TEMP/WAL high-water marks, transaction duration, source and fact bytes, changed/fanout counters, graph and query digests, progress gaps, and sampler failures. [6]

That instrumentation immediately rejected two plausible optimizations. Serialize-once and memoization candidates did not prove an independent win under exact comparison, so their implementation was removed while the telemetry stayed. The rule became: observability is a valid product improvement; a plausible optimization is not evidence.

The harness also became part of the trust boundary. Every artifact bound the source commit, installed runtime identity, fixture commit, filesystem, worker count, Bun version, free-space admission, and sampler health. A candidate that shifts wall time into memory, WAL growth, a longer writer lock, or a rare full fallback is not a clean win. Without those counters, it can look like one.

The surrounding agent tooling was dogfooded under the same discipline. Broker-child cleanup, cross-process context-page continuation, bounded Workset query paging, and portable memory fixtures were corrected when they failed in real use. They were not counted as graph-speed improvements, but trustworthy observation and reporting depend on the paths that deliver evidence to an agent. [10] [11] [12] [13]

## Research gave us hypotheses, not patches

Several research traditions shaped the experiments. None supplied code that could simply be pasted into Threadnote.

_Build Systems à la Carte_ separates two decisions that build systems often entangle: the scheduler, which chooses what runs and in what order, and the rebuilder, which decides whether work must run at all. [22] That became a useful lens for graph indexing. Parser scheduling and incremental cache admission were different problems. Making parsers faster could not excuse rebuilding facts whose dependencies had not changed.

Adapton’s demand-driven incremental computation suggested tracking change through a computation graph and recomputing only results still demanded by an observer. [23] _Demanded Abstract Interpretation_ brought the combination of demand and incrementality into interactive static analysis while preserving equality with batch analysis. [24] Threadnote did not implement either system, but they sharpened an invariant: reused current-source evidence must equal the independent full computation.

DBSP framed rich computation as incrementally maintained views over deltas. [25] The practical translation was modest but powerful: a one-file edit should flow through changed rows plus explicit dependency fanout, not through a disguised full repository replay.

For parser scheduling, longest-processing-time-first research suggested starting predicted expensive work early so a few large files would not become a tail after other workers went idle. [26] But real parsers share CPU and memory bandwidth, and duration is learned rather than known. The scheduling result was therefore a hypothesis to test—not proof that more workers would help.

SQLite imposed equally concrete constraints. It permits multiple readers but only one simultaneous writer; WAL improves reader/writer coexistence but still has one writer. [27] [28] Transaction batching can transform write throughput, while unsafe durability settings merely avoid work required for crash-safe commit. [29] Cache, mmap, page size, WAL, TEMP, checkpoint, and synchronous settings all had to be experiments with resource and publication evidence, not folklore.

## Hypothesis 1: make the small case actually small

The first source-confirmed bottleneck was cache admission. The old path exported every cache generation into JavaScript sets, scanned stored fact blobs by extractor generation, and parsed `facts_json` just to recover path authority. Metadata authority was buried inside the largest payload in the row.

A narrow trigger-maintained SQLite authority table made cache keys directly queryable by extractor generation. At 225,852 rows, a focused internal-SSD microbenchmark fell from 902.1 to 67.2 milliseconds for 4 KiB facts, and from 6,119.6 to 66.9 milliseconds for 32 KiB facts in a 7.57 GB database. [3] Those are component measurements, not release latency claims. Their value is causal: indexed metadata beat reconstructing metadata from every payload.

The larger change persisted a versioned clean-inventory receipt, retained one exact post-lock overlay observation, loaded base facts only for requested changed paths, and introduced a bounded reverse-dependency/project closure for exports, re-exports, and other resolution-surface changes. Additions, deletions, malformed evidence, ambiguous attribution, unsafe roots, and closure overflow still fail closed to a complete path. [4]

The wording matters. Threadnote does not claim universal `O(changed-set)` indexing. Legacy paths and correctness fallbacks can still load complete snapshot metadata. The proven contract is narrower: an admitted body-only edit is proportional to its changed set; an admitted resolution-surface edit is proportional to the change plus a bounded, proven dependency closure.

On a generated 3,006-file dependency-surface fixture with 303,008 final symbols, the admitted closure path took 1.593 seconds versus 275.452 seconds when incremental materialization was explicitly disabled. It staged four files instead of 3,006, replayed zero cached-fact bytes instead of 792,060,997, and produced the same 303,008 symbols and 600,006 edges. [19] This is not an IntelliJ latency substitute. It is evidence for the proportional-work invariant.

One exact `--no-optional-locks` porcelain status observation then replaced separate status, diff, and `ls-files` scans while preserving content hashes, renames, copies, deletions, and conflict states. A forced full-heap collection before the already-bounded sparse path was also removed. On the pinned checkout, the command-level observation median fell from roughly 6.47 to 3.28 seconds. [7]

## Hypothesis 2: schedule the heavy tail, then accept the measured worker count

The parser pool capped at four, yet some structured or large groups created global single-concurrency barriers. The easy recommendation was “use more cores.” The experiment asked a different question: could deterministic learned ordering keep the existing workers busy?

A longest-predicted-work-first prior used language and size, then updated estimates from observed request and fact bytes. Windows remained bounded by CPU, memory, and global parser-pool admission. Results were committed deterministically rather than in completion order. [5]

Across three controlled runs per arm, four-worker wall time fell from 3,487.42 to 2,869.23 milliseconds while average extraction concurrency rose from 2.171 to 3.314. Process CPU was nearly flat and peak RSS rose 0.86%. More workers lost: governed means were 2,834.97 milliseconds for four workers, 2,913.19 for six, and 3,032.69 for eight. [20]

“Use all the cores” was not the answer. Four remained the default because the workload, contention, and runtime said four—not because four was aesthetically conservative.

## Hypothesis 3: cooperate with SQLite’s writer

Reference resolution rehydrated millions of compact JSON candidates page by page, parsed and sorted them in JavaScript, reconstructed a TEMP B-tree, built page-local lookup summaries, and joined millions of lookup rows. Three proposed summary caches made matching 27–36% worse and cold resolution 11–16% worse. They were reverted. Bounded direct matching over primary-key probes cut matching by roughly 29% cold and 32% on the independent same-overlay rebuild in the reduced experiment. [4]

Transaction shape still mattered. Capacity reservation was separated from transaction width: the resolver could reserve room for eight compact pages while committing sequential four-page prefixes. A failure in the second transaction retained the first durable prefix, and a heartbeat after the first writer-lock release preserved liveness. Two bracket controls and two final candidates showed a 1.32% resolution improvement and a 9.12% reduction in reservation-side residual overhead. A pre-heartbeat candidate had doubled the progress gap to roughly six seconds; the measurement caught it before merge. [8]

The largest cold-path change routed persistent materialization through a bounded, resumable SQLite sidecar spool. Every graph surface was applied in deterministic sorted page order. Reconstructible cold-only query indexes were deferred and bulk-built after materialization. Compiled Tree-sitter queries were reused. Parser windows widened without increasing the four-worker cap. A private validated Git-status cache accelerated large repositories without mutating the real Git index or repository configuration. Reference transaction width became adaptive rather than globally “bigger.” [9]

Page layout produced one of the strongest isolated wins. Moving new stores from 4 KiB to 8 KiB pages improved cold time 16.61%, one-file time 11.23%, registration 13.31%, and post-scan 5.27%, while reducing final database size by 34.01%. The record also kept the costs: RSS rose 5.13% and WAL high-water 43.8%, although final database plus WAL size was lower. Existing stores retained their page size rather than paying for an unproven migration. [9]

Several lower-level ideas lost. Direct `Node.text` slicing and a bounded parser-input callback were slower than the JVM sample control. A 40,000-reference ceiling was rejected. A 20,000-reference ceiling helped a 196,113-reference fixture but hurt a roughly 104,000-reference fixture, producing an adaptive threshold. Default `NORMAL` build durability was rejected. [9] These results are central to the story: a language rewrite would not automatically discover which work, batch size, or durability boundary was correct.

## Evidence-led iteration and regression gates

Each semantic candidate passed through the same evidence layers: focused examples and bounded properties; an exact clean commit and global installation of that HEAD; installed-CLI smoke; governed reduced measurement; and pull-request CI as the authoritative full suite. Their chronology could overlap, but no layer substituted for another. Controls and candidates alternated on the same internal SSD with exact provenance and a free-space guard. Noise required a bracket control, not a persuasive explanation.

The layers answered different questions. A regression example asked whether a known failure stayed fixed. A property test asked whether the invariant survived many schedules, orderings, deltas, and malformed inputs. The permanent ratchet asked whether any governed correctness, proportionality, resource, or latency metric degraded on a production-shaped fixture. The exact-release run asked whether the improvement transferred to the repository and machine behind the public claim. Passing one layer never substituted for the next.

The permanent regression gate is intentionally not IntelliJ. Rebuilding that repository on every graph change would make normal development impractical. The recurring path-scoped gate uses a deterministic production-shaped fixture of 3,000 generated source files and roughly 110,000 symbols, four workers, a 20 GiB free-space floor, and 529 independently governed metrics. Correctness, graph shape, proportional work, and zero-failure fields are exact; hosted timing and storage use reviewed absolute-plus-relative headroom. [9] [21]

The pinned IntelliJ run has a different job: one manual exact-release artifact for release and website claims. It uses the pinned public commit, internal storage, at least 120 GiB free, exact source, and the reviewed worker count. A miss blocks the claim, not every later pull request.

Property-based tests protected invariants that example tests underspecified: incremental-versus-clean equivalence, permutation and worker-schedule determinism, cache authority, malformed-receipt rejection, dependency closure, ordered spool replay, interruption and cleanup, storage high-water monotonicity, transaction grouping, real Git-index non-mutation, and ratchet completeness. [3] [4] [5] [8] [9]

Examples remained essential where the bug was a specific temporal event. A cold-index race once let one worktree defer global query indexes after another claim’s initial schema check but before its snapshot publication, leading to `no such index: edges_source`. A deterministic test forced that exact writer-gate interleaving. The fix revalidated schema state in the same critical section that published the claim. [16] A benchmark sampler test replaced a 50-millisecond child-lifetime assumption with explicit ready/stop synchronization, and runner provenance became fixture-owned rather than ambient. [15] [17]

## What Effect contributed to reliability

Threadnote’s application model is Effect. Effect did not make SQLite atomic or invent incremental computation. It made failure, cancellation, concurrency, and resource lifetimes explicit enough to compose and test. [30]

Scopes and finalizers bound parser workers, subprocesses, temporary homes, leases, spool files, and writer ownership to a lifetime that ended on success, typed failure, or interruption. Fibers made cancellation and supervision cooperative. `@effect/vitest` supplied a fresh scope and deterministic `TestClock`; true OS-process, SQLite-lease, and wall-clock boundaries opted into live time explicitly. [30] [31]

That model enabled tests which injected failure into a second resolution transaction and proved the first prefix stayed durable and resumable; interrupted spool builds proved replay and cleanup idempotence; and the claim-race test controlled a concurrency schedule instead of waiting for chance. [8] [9] [16]

Atomic publication came from a combination: SQLite transactions and ready-snapshot state supplied durable atomicity; Effect scopes, gates, and interruption handling ensured failure paths reached cleanup and incomplete snapshots never became reader authority. Reliability was not a tax added after optimization. It was what made cached and incremental work safe to reuse.

## A parity-first comparison with Graphify needs two axes

A fair comparison starts with overlapping capabilities. The target here is Graphify v0.9.49 at commit `282976b2f4066b55cf2fa346c3d5568f7ac044e2`. Its official product describes local deterministic code extraction across 37 Tree-sitter grammars, cross-file relationships, bounded query/path/explain operations, incremental update/watch flows, and Model Context Protocol (MCP) access. It also has a broader document-and-media ingestion path through a configured model, including a fully local Ollama backend. The product explicitly says its graph is not an embedding/vector index. [32] [33] [34]

The feature overlap is substantial. The names and schemas differ, but these capability families are shared:

| Capability family          | Threadnote                                                                   | Graphify v0.9.49                                                                |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Topology                   | stable communities, hubs and god nodes, and surprising cross-community links | communities, god nodes, and surprising connections                              |
| Higher-order relationships | structural n-ary groups                                                      | explicit hyperedges rendered as group relationships                             |
| Confidence review          | authority tiers and confidence audits                                        | extracted/inferred/ambiguous provenance, confidence scores, and report evidence |
| Reports                    | deterministic Markdown architecture reports                                  | `GRAPH_REPORT.md`, plus wiki and call-flow views                                |
| Portable output            | streamed JSON, GraphML, HTML, and SVG                                        | `graph.json`/JSON, GraphML, interactive HTML, and SVG                           |

Both products also expose bounded graph queries to agents. “Structural n-ary group” and “hyperedge” are analogous higher-order relationship surfaces here, not a claim that their data models are identical. The god-node surfaces in both products identify unusually connected parts of the graph. Graphify additionally emphasizes specialized downstream targets such as Obsidian, Cypher, Neo4j, and FalkorDB, plus SCIP and remote-PR workflows; Threadnote emphasizes transactional ready snapshots, immutable committed bases with worktree-isolated dirty overlays, explicit authority tiers, and a disposable SQLite operational graph rather than a normally committed monolithic artifact. Threadnote also combines current-source evidence with persistent agent memory and local semantic retrieval. These are verified capability and architecture differences, not controlled performance results. [1] [33] [38]

Graphify’s worktree boundary deserves equal precision. v0.9.49 supports a `GRAPHIFY_OUT` override for separate worktree destinations or shared-output arrangements, uses atomic replacement for its graph file, and takes an advisory rebuild lock. Its installed Git hooks nevertheless exit deliberately in linked worktrees: their canonical graph belongs to the primary checkout, and rebuilding from a linked worktree is treated as a race-prone rogue delta. [40] A team can choose separate manual outputs or one serialized shared destination, but neither is the same contract as simultaneously queryable immutable committed bases with isolated dirty overlays. That is an operational architecture difference, not a claim that Graphify is unaware of Git worktrees.

The first fair axis is structural indexing: Threadnote lexical-only versus Graphify code-only. Both arms must use the same pinned repository, disclose each product's documented admission and exclusions, avoid embeddings and semantic model calls, exclude unrelated report or visualization work unless both products include an equivalent operation, and compare not only wall time but admitted files, symbols, relationship semantics, graph size, memory, disk, correctness samples, and incremental behavior. A stopwatch over non-equivalent graphs would be misleading.

The second axis is no-provider-token product capability. Threadnote can add its installed local embeddings to deterministic graph structure, improving semantic seed retrieval without sending repository chunks through the coding agent or consuming hosted-provider tokens. This does not mean “tokenization disappears”; the local embedding model consumes local compute and time outside the agent’s prompt and provider-billing boundary. A fully local Graphify configuration can combine deterministic code extraction with a loopback Ollama semantic pass for supported non-code inputs, while its product graph remains non-vector. Graphify’s separate benchmark harness documents local embedding experiments, but those harness adapters should not be treated as the v0.9.49 product retrieval contract without separate product evidence. [18] [33] [35]

For the controlled structural arm, the `graphifyy` v0.9.49 package ran on the same M1 Max, 64 GiB machine, internal APFS storage, and pinned IntelliJ checkout, using Python 3.12.5. Graphify records its four-worker limit in the public summary; Threadnote’s matching setting comes from the separately retained operator launcher disclosed above. The exact fully local Graphify command was `graphify extract . --code-only --no-cluster --timing --max-workers 4`; `--code-only` excluded document and media model calls, and `--no-cluster` excluded clustering. The products' native inventory boundaries were not identical: Graphify reported 191,249 code files, while Threadnote indexed 225,852 of 225,867 eligible files. Because the admitted work differs and the Graphify job did not complete, the evidence does not claim a throughput or completion-time ratio.

Construction is not the end of the structural comparison. Graphify v0.9.49’s supported query and MCP loaders apply a 512 MiB graph-file guard by default, read the complete JSON text, parse it, and hydrate the nodes and links into NetworkX; users can explicitly raise the size guard. [39] The controlled comparison must therefore report four separate outcomes: whether extraction reaches a terminal artifact, whether that artifact is admitted under the supported default, how long and how much memory cold hydration consumes when a safely raised-cap probe is admitted, and whether exact, natural structural, and affected-node queries return bounded content from a warm process. A default rejection, resource-cap termination, or predeclared safety non-admission is practical evidence under those conditions—not proof that no conceivable machine could load the file.

> **Controlled Graphify result: right-censored artifact non-arrival.** The guarded Graphify code-only run was allowed to continue beyond its original two-hour cap. After it exceeded a five-hour developer-utility threshold, the operator stopped it with `SIGINT` at 5 hours 32 minutes 39.939 seconds. That elapsed wall time was 5.825 times the observed duration of Threadnote’s completed v4.3.8 cold run, but it is context rather than a throughput or completion-time ratio. Graphify had produced neither `graph.json` nor an atomic write-temp file. The result is right-censored: it does not reveal an eventual completion time, and it does not claim that no larger machine or longer wait could finish. It establishes that this configuration delivered no terminal graph artifact within the operator’s working window. [42]
>
> The observed run reached 191,249 of 191,249 per-file AST progress reports and accumulated 20,309.960 process-tree CPU seconds over 19,959.939 wall seconds—about 1.018 CPU cores on average across the full run. Parent RSS was 12.1 GB immediately before termination, process-tree peak RSS was 14.8 GB, system swap did not grow, and no sampler failed. After the last per-file report, its output exposed no bounded remaining-work estimate or downstream phase total. A 3.7 GB per-file AST cache persisted. Source review—not a demonstrated restart experiment—indicates that this cache can avoid repeating every parse, while cross-file resolution and graph construction are rebuilt in memory and the JSON artifact is published atomically only at the end. On that basis, the interrupted downstream work had no durable continuation checkpoint. Because no graph existed, the default 512 MiB loader, raised-cap cold hydration, exact, natural, and affected-node warm-query controls, and incremental-update control could not run. This is artifact and queryability non-arrival, not a failed-query or failed-incremental result. [41] [42]
>
> The interrupt stack also turned an opaque phase into a bounded diagnostic lead. It landed in `disambiguate_ambiguous_candidates` at `nontest_cands = [c for c in candidates if c not in set(test_cands)]`, rebuilding a set inside a candidate loop. That line is a source-visible superlinear risk in a god-node tie-breaker and was the work active at interruption. One stack snapshot cannot show how much of the silent interval it consumed, so this is one candidate bottleneck, not a profile of the whole run. The optional Graphify semantic arm was not run at IntelliJ scale; it is a distinct document-and-media capability and does not answer whether the code-only structural artifact completed. [41] [42]

## What to do before a rewrite

The journey did not prove that TypeScript is “as fast as Rust.” It proved that the first implementation paid for the wrong things.

Metadata authority was hidden inside large payloads. One-file edits repeatedly observed Git and reconstructed repository state. Expensive parser work arrived late. Materialization amplified ordering and database writes. Resolution rebuilt transient structures too often. Query indexes existed during the phase in which they were costly and unnecessary. A line-for-line port would have preserved most of that waste.

Performance and correctness also converged at scale. A wider transaction needed resume semantics and heartbeats. Deferred indexes created a publication race. A private Git cache had to prove non-mutation. An incremental closure needed absence and overflow evidence. More workers were slower. A larger page shrank the database while growing WAL and RSS. A candidate that won once could still be noise.

Before rewriting a working system, ask:

1. Is the amount of work proportional to the logical change?
2. Are I/O, transactions, scheduling, and data layout shaped for the current runtime and storage engine?
3. Does profiling still identify a stable hot leaf whose cost is intrinsic to the language/runtime boundary?

If all three answers are yes, Rust may be exactly the right next tool. It can provide predictable memory layout, low-overhead kernels, safer native concurrency, or a strong base for an immutable segment or codec component. But by then the target is small, measured, and protected by parity tests. You are replacing a bottleneck rather than rediscovering years of semantics in another language.

There is a surprising amount of performance available before the first line of Rust. More importantly, doing that work tells you where Rust could actually matter.

## References and implementation record

[1] Threadnote, [README and native code-graph contract](https://github.com/Kashkovsky/threadnote/blob/v4.3.8/README.md), v4.3.8.

[2] Threadnote issue [#203: Make code-graph indexing proportional at IntelliJ scale](https://github.com/Kashkovsky/threadnote/issues/203), baseline, goals, research links, and delivery record.

[3] Threadnote [PR #200: cache authority](https://github.com/Kashkovsky/threadnote/pull/200), including 225,852-row focused evidence and cache-authority properties.

[4] Threadnote [PR #201: sparse admission, dependency closure, and bounded direct resolution](https://github.com/Kashkovsky/threadnote/pull/201).

[5] Threadnote [PR #202: learned-cost extraction scheduling](https://github.com/Kashkovsky/threadnote/pull/202).

[6] Threadnote [PR #204: materialization subphase observability](https://github.com/Kashkovsky/threadnote/pull/204).

[7] Threadnote [PR #205: bounded single-observation overlay admission](https://github.com/Kashkovsky/threadnote/pull/205).

[8] Threadnote [PR #206: bounded resolution capacity windows](https://github.com/Kashkovsky/threadnote/pull/206).

[9] Threadnote [PR #208: sorted materialization spool, storage and parser experiments, adaptive resolution, and the production ratchet](https://github.com/Kashkovsky/threadnote/pull/208).

[10] Threadnote [PR #207: stale MCP broker-child cleanup](https://github.com/Kashkovsky/threadnote/pull/207).

[11] Threadnote [PR #209: cross-process single-use `read_context` cursors](https://github.com/Kashkovsky/threadnote/pull/209).

[12] Threadnote [PR #210: Workset graph-query paging bounds](https://github.com/Kashkovsky/threadnote/pull/210).

[13] Threadnote [PR #211: remote-memory portability generator correction](https://github.com/Kashkovsky/threadnote/pull/211).

[14] Threadnote [PR #212: v4.3.3 release preparation](https://github.com/Kashkovsky/threadnote/pull/212) and [curated release notes](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/.github/release-notes/v4.3.3.md).

[15] Threadnote [PR #213: live process-fixture synchronization](https://github.com/Kashkovsky/threadnote/pull/213).

[16] Threadnote [PR #214: cold-index claim-race fix](https://github.com/Kashkovsky/threadnote/pull/214).

[17] Threadnote [PR #215: benchmark runner-provenance isolation](https://github.com/Kashkovsky/threadnote/pull/215).

[18] Threadnote [v4.2.5 local graph-embedding release record](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/.github/release-notes/v4.2.5.md) and [FAQ provider boundary](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/website/src/pages/FaqPage.tsx).

[19] Threadnote checked [dependency-surface development evidence](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/test/evaluation/baselines/code-graph-v1/dirty-overlay-dependency-surface-development.json).

[20] Threadnote checked [heavy-tail scheduler development evidence](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/test/evaluation/baselines/code-graph-v1/heavy-tail-scheduler-development.json).

[21] Threadnote checked [529-metric hosted production-ratchet seed](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/test/evaluation/baselines/code-graph-v1/production-ratchet-github-linux-x64.json) and [permanent workflow](https://github.com/Kashkovsky/threadnote/blob/v4.3.3/.github/workflows/code-graph-production-ratchet.yml).

[22] Andrey Mokhov, Neil Mitchell, and Simon Peyton Jones, [_Build Systems à la Carte_](https://www.microsoft.com/en-us/research/wp-content/uploads/2018/03/build-systems.pdf), PACMPL/ICFP 2018.

[23] Matthew A. Hammer et al., [_Adapton: Composable, Demand-Driven Incremental Computation_](https://doi.org/10.1145/2594291.2594324), PLDI 2014.

[24] Benno Stein, Bor-Yuh Evan Chang, and Manu Sridharan, [_Demanded Abstract Interpretation_](https://plv.colorado.edu/papers/dai-pldi21.pdf), PLDI 2021.

[25] Mihai Budiu et al., [_DBSP: Automatic Incremental View Maintenance for Rich Query Languages_](https://www.vldb.org/pvldb/vol16/p1601-budiu.pdf), PVLDB 2023.

[26] R. L. Graham, [_Bounds on Multiprocessing Timing Anomalies_](https://epubs.siam.org/doi/10.1137/0117039), SIAM Journal on Applied Mathematics 1969; see also [LPT schedules on uniform processors](https://epubs.siam.org/doi/10.1137/0206013).

[27] SQLite, [Transaction](https://sqlite.org/lang_transaction.html).

[28] SQLite, [Write-Ahead Logging](https://www.sqlite.org/wal.html).

[29] SQLite, [FAQ on transaction speed](https://www.sqlite.org/faq.html#q19), [Atomic Commit](https://sqlite.org/atomiccommit.html), and [PRAGMA reference](https://sqlite.org/pragma.html).

[30] Effect upstream [`Scope`](https://github.com/Effect-TS/effect/blob/de2a9a69099993087e57c64df58537c765ac0224/packages/effect/src/Scope.ts) and [`Fiber`](https://github.com/Effect-TS/effect/blob/de2a9a69099993087e57c64df58537c765ac0224/packages/effect/src/Fiber.ts) contracts at the Effect 4.0.0-beta.102 source commit used by Threadnote v4.3.8.

[31] Effect upstream [`@effect/vitest`](https://github.com/Effect-TS/effect/tree/de2a9a69099993087e57c64df58537c765ac0224/packages/vitest) test services, `TestClock`, scoped tests, and property integration at the pinned Effect 4.0.0-beta.102 source commit.

[32] Graphify [v0.9.49 release](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.49), commit `282976b2f4066b55cf2fa346c3d5568f7ac044e2`.

[33] Graphify v0.9.49 [README/product contract](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/README.md), including code-only privacy, non-vector graph, Ollama, file coverage, queries, MCP, update/watch, and exports.

[34] Graphify v0.9.49 [`pyproject.toml`](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/pyproject.toml), runtime and optional-backend dependencies.

[35] Graphify v0.9.49 [benchmark methodology](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/BENCHMARKS.md). Its harness claims are not substituted for the controlled product comparison reported in this article.

[36] Threadnote [PR #217: retain private Git-status acceleration when the filesystem-monitor daemon is already healthy](https://github.com/Kashkovsky/threadnote/pull/217), including the implementation and focused Effect tests. The governed reduced figures are retained local evidence from commit `7e89fc3fd4d34a096729f1a11770e9e74e2e31a7`, artifact SHA-256 `d3753ddf6c4d793d28ea6f68ca2a61a0a9162688441893fb0a36be43bc4270be`; the raw artifact is not publicly hosted.

[37] Threadnote exact merged-HEAD IntelliJ observation at commit `26a5f96ef35dd3c371163972e8f82071cd9a91b0`, artifact SHA-256 `3f516784f0a37ef943ecee77a180b83057d4e13efcf17734830dc37f8c037b1c`. This was retained local development evidence; its raw artifact was not publicly hosted.

[38] Graphify v0.9.49 source contracts for [analysis](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/analyze.py), [reports and confidence evidence](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/report.py), and [hyperedge and portable export serialization](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/export.py).

[39] Graphify v0.9.49 source contracts for the [default and configurable graph-file load guard](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/security.py) and [JSON-to-NetworkX query/MCP loading](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/serve.py).

[40] Graphify v0.9.49 source contracts for [`GRAPHIFY_OUT` and atomic shared-output writes](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/paths.py), [rebuild locking](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/watch.py), and the [linked-worktree hook guard](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/hooks.py).

[41] Graphify v0.9.49 source contracts for [persisting per-file AST extraction records](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/extract.py), [reconstructing the in-memory NetworkX graph from extracted records](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/build.py), and [atomic JSON publication only at the output-write boundary](https://github.com/Graphify-Labs/graphify/blob/v0.9.49/graphify/paths.py). The retained checkpoint and terminal observations are bound in [42].

[42] Threadnote controlled [Graphify v0.9.49 IntelliJ evidence](https://threadnote.io/graphify-intellij-evidence.bd4686d2fce1fe369c73ac77ebe65604bcb3af6fb4564691d10dfb296aca61b1.json): frozen code-only/no-cluster command, five-hour operator threshold, right-censored elapsed and resource observations, absent graph/queryability boundary, source-reviewed restart semantics, interrupt location, exact comparator provenance, and hashes of the retained raw guard, sampler, command-log, and Threadnote launcher artifacts.

[43] Threadnote exact v4.3.4 IntelliJ observations at commit `4f53313c8a605ff12d8ab9e494a3bf3cbe83958f`, artifact SHA-256 values `c25e1dc8cdbc96e5aa0e4803f37bc949e9b4220e109ecf0245171471d5f8bc9d` and `0f3ba956f491d4de39d81101ddfaae029eb097146cea29ce3f848f69bbf79fad`. These were retained local release observations; the raw artifacts were not publicly hosted.

[44] Threadnote [PR #221: reuse semantically stable Git index cache](https://github.com/Kashkovsky/threadnote/pull/221), including the receipt-v2 contract, focused Effect/Fast-check coverage, and IntelliJ private-index probe.

[45] Threadnote exact v4.3.5 IntelliJ observation at commit `f3e1bd46640a1c41488dfef89de712323ac4911a`, artifact SHA-256 `cc337e8778eb8e2d0590b995f43985f21f6da3ec50ec2bdb53d201cbce1110f7`, and [PR #224: defer completed-build cleanup](https://github.com/Kashkovsky/threadnote/pull/224). The raw observation was retained locally rather than publicly hosted; it missed only the hard registration gate.

[46] Threadnote exact v4.3.6 IntelliJ observation at commit `91cc2eb21beeccd3fe2b181201539709f184041e`, artifact SHA-256 `731f8694ac4e4617601ba814dacba7d95729ad32a7537c7dea1bfd2d7efcd569`; cold, one-file total, post-scan, proportionality, parity, transaction, polyglot-query, and every required failure control passed, while registration measured 5,178.427 milliseconds against the strict 5,000-millisecond gate. This was a retained local observation; its raw artifact was not publicly hosted.

[47] Threadnote [PR #227: bounded checksummed Git-index semantic admission](https://github.com/Kashkovsky/threadnote/pull/227), including the direct-parser contract, focused Effect/Fast-check and real-Git probes, and component measurements. The governed reduced-ratchet artifact, SHA-256 `388ec1c2885e74cd959ba77cd1eb153a1880953e12709c404a4e7cd047b645d9`, was retained locally rather than publicly hosted.

[48] Threadnote exact v4.3.7 IntelliJ observation at commit `ed2a7a8654149b1fb97fd4319bea95403557928b`, artifact SHA-256 `899faf6380b2fb6a69078b5cd79837451453be02541df4956854da1df6414a97`; cold, one-file total, post-scan, proportionality, parity, transaction, polyglot-query, and every required failure control passed, while registration measured 5,255.333 milliseconds against the strict 5,000-millisecond gate. This was a retained local observation; its raw artifact was not publicly hosted.

[49] Threadnote [PR #230: compact reusable registration receipt context](https://github.com/Kashkovsky/threadnote/pull/230), including receipt profiling, focused cross-session and project-closure coverage, and non-increasing proportional-work ratchets. The exact clean-HEAD reduced artifact at commit `a144744f6e810e89090e7c39112947e0a8b4120e`, SHA-256 `084db3df35d3ffc4d7e9239ea9b0b0ccf1b29450b19c56ecbe036200e91b3d4b`, was retained locally rather than publicly hosted.

[50] Threadnote [v4.3.8 immutable release](https://github.com/Kashkovsky/threadnote/releases/tag/v4.3.8), tag commit `f1e4102a78e4df2127fca0c4d59da39ffb5f70a6`, and [content-addressed exact-tag IntelliJ evidence](https://threadnote.io/performance-evidence.b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39.json), artifact SHA-256 `b56994fe99c3d68be80f79315b88d4420a7241a76de72c317d2fc3d84de23b39`.
