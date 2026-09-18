# Code graph readiness

Threadnote separates useful discovery from claims that require the exact current source.

## Stale discovery and current claims

`query`, `node`, `neighbors`, and `explain` may return an immutable compatible ready snapshot while a durable refresh is
active, queued, or deferred. Treat those cards as bounded discovery evidence: verify exact literals in the checkout
before relying on details. `path`, `impact`, `analyze_code_graph`, and exact-current citation claims remain strict and
must wait for current evidence. A cold checkout or a read with no usable card still follows the bounded current-refresh
path.

## Continuity and recovery

Refresh continuity is additive, privacy-safe metadata: `active`, `queued`, `deferred`, or `idle`, with an optional
bounded `retryAfterMilliseconds`. `cgdq_…` queue, current, and latest-demand tokens are opaque correlation values only;
they are never paths, capabilities, or inputs for selecting work. Shared targets converge on the same tokens.

The durable reducer is latest-wins before publication. Once a snapshot is published, publication is irrevocable; a
newer demand may follow it, but cannot rewrite the published result. After a crash, persisted demand and published
snapshots are reconciled so recovery converges without treating the sidecar as graph or publication authority.

Agents should keep making bounded progress with stale cards and exact source verification. Retry once before a strict
current or relationship claim, or when no usable cards survive; do not tight-poll an active, queued, or deferred state.
Use `threadnote graph status` or diagnostics for bounded inspection.

## Memory writes

An active private cited memory can store now, anchor privately, and finalize after a current graph is ready. Pending
anchors are not evidence or shared backlinks. Shared and inactive writes remain strict and require current citations.

For the supported agent catalog, see [/agents/](https://threadnote.io/agents/); this article intentionally does not
duplicate that list.

## Stage 3 release gate

The release runner creates three disposable linked worktrees, seeds real graph snapshots, and starts two independent
stdio MCP hosts against one private `THREADNOTE_HOME`. It holds the production database writer lock and a real SQLite
WAL writer transaction while checking stale discovery and strict-current boundaries. It then drives f1 → f2 → f3,
checks durable demand and build history, kills an MCP claimant while the production spawn lock is held, and kills a
host after its real graph child has adopted the demand. Recovery must converge through the surviving host.

Run from an exact clean candidate checkout after installing that candidate with `bun run dev:install-global` and
resolving any global-runtime ownership handoff. Supply the canonical managed executable and its verified SHA-256;
the runner revalidates the complete managed payload, dependency manifests, runtime, and source commit before and
after execution. It does not install or switch runtimes. It currently requires a POSIX runner, Git, Bun, and private
temporary storage; subprocesses use an isolated process home and disabled inherited Git configuration.

```sh
bun run gate:code-graph:stage3 -- \
  --mode plan \
  --candidate-ref <reviewed-ref> \
  --candidate-commit <exact-40-hex-commit> \
  --candidate-executable <absolute-canonical-managed-threadnote> \
  --candidate-executable-sha256 <exact-64-hex-sha256> \
  --output <absolute-new-json-file-outside-any-git-checkout>
```

Use `--mode execute` only when intentionally running the final candidate gate. Plan mode performs no candidate
execution and cannot produce passing evidence. Execute mode accepts no observation imports or replay files. Any
missing phase, ambiguous ownership, failed cleanup, changed runtime, or privacy failure refuses the run. The output
parent must already exist, and an existing output file is never overwritten.

The retained artifact contains candidate provenance, opaque continuity tokens, observed states, and bounded retry
guidance. Paths, source text, process IDs, request fingerprints, and native errors stay out of the observation
projection. The runner makes no latency or performance claim. A timeout is a failed gate, not evidence of successful
continuity; investigate the failure and run a fresh complete gate. Temporary fixtures are removed after their owned
processes stop; an ownership or cleanup failure retains the temporary directory for local investigation.
