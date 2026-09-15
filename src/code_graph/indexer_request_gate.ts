import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {CODE_GRAPH_LOCK_OPTIONS} from './indexer_materialization.js';
import type {CodeGraphIndexOptions} from './indexer_types.js';
import {codeGraphRequestBuildLockPath} from './layout.js';

export function withSharedCodeGraphRequestGate<A, E, R>(input: {
  readonly checkoutId: string;
  readonly effect: Effect.Effect<A, E, R>;
  readonly fs: FileSystem.FileSystem;
  readonly onProgress: CodeGraphIndexOptions['onProgress'];
  readonly path: Path.Path;
  readonly requestedOverlay: {readonly dirty: boolean; readonly fingerprint?: string} | undefined;
  readonly requestKey: string | undefined;
  readonly threadnoteHome: string;
}) {
  if (
    !input.requestKey ||
    !input.requestedOverlay ||
    (input.requestedOverlay.dirty && !input.requestedOverlay.fingerprint)
  ) {
    return input.effect;
  }
  return withExclusiveFileLock(
    input.fs,
    codeGraphRequestBuildLockPath(input.path, input.threadnoteHome, input.checkoutId, input.requestKey),
    {
      ...CODE_GRAPH_LOCK_OPTIONS,
      onContention: () =>
        (input.onProgress?.({phase: 'waiting', reason: 'request-lock'}) ?? Effect.void).pipe(Effect.ignore),
    },
    input.effect,
  );
}
