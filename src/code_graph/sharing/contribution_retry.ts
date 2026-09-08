import {Effect} from 'effect';
import {drainQueuedGraphShareContributions} from './parse_cache.js';
import {readGraphShareTrustDocument} from './trust.js';

export const GRAPH_SHARE_RETRY_TICK_MILLISECONDS = 5_000;

export const monitorGraphShareContributions = Effect.fn('codeGraph.sharing.monitorContributions')(function* (
  threadnoteHome: string,
) {
  let cursor = 0;
  for (;;) {
    yield* Effect.sleep(GRAPH_SHARE_RETRY_TICK_MILLISECONDS);
    const document = yield* readGraphShareTrustDocument(threadnoteHome).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.catchDefect(() => Effect.void),
    );
    if (document === undefined) continue;
    const selected = Array.from(
      {length: Math.min(8, document.receipts.length)},
      (_, offset) => document.receipts[(cursor + offset) % document.receipts.length],
    );
    cursor = document.receipts.length === 0 ? 0 : (cursor + selected.length) % document.receipts.length;
    yield* Effect.forEach(
      selected,
      receipt =>
        drainQueuedGraphShareContributions({
          identity: receipt,
          threadnoteHome,
          propagateUnavailable: true,
        }).pipe(
          Effect.ignore,
          Effect.catchDefect(() => Effect.void),
        ),
      {concurrency: 2, discard: true},
    );
  }
});
