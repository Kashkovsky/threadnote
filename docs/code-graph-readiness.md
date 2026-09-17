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
