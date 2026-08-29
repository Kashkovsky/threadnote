import {Effect, FileSystem, Path} from 'effect';
import type {LocalModelManifest} from '../models/catalog.js';
import {ensureVectorIndex, vectorIndexGenerationReadiness, vectorIndexStatus} from '../search/vector-index.js';
import {
  currentRecallCorpusGeneration,
  loadRecallIndexData,
  recallIndexStatus,
  type RecallIndexStatus,
} from './index.js';

interface McpRecallRefreshConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export type McpRecallBackgroundRefreshSchedule = 'coalesced' | 'scheduled';

const activeRefreshes = new Map<string, object>();

class McpRecallBackgroundRefreshBlocked extends Error {
  override readonly name = 'McpRecallBackgroundRefreshBlocked';
}

/**
 * Start one process-local derived-index refresh without joining it to the MCP
 * request. The filesystem locks remain the cross-process authority; this map
 * only prevents redundant work from concurrent requests in this process.
 */
export const scheduleMcpRecallBackgroundRefresh = Effect.fn('recall.scheduleMcpBackgroundRefresh')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalHome = yield* fs
    .realPath(config.agentContextHome)
    .pipe(Effect.catch(() => Effect.succeed(path.resolve(config.agentContextHome))));
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const token = {};
      const admitted = yield* Effect.sync(() => {
        if (activeRefreshes.has(canonicalHome)) return false;
        activeRefreshes.set(canonicalHome, token);
        return true;
      });
      if (!admitted) return 'coalesced' as const;

      const clear = Effect.sync(() => {
        if (activeRefreshes.get(canonicalHome) === token) activeRefreshes.delete(canonicalHome);
      });
      const refresh = refreshMcpRecallDerivedIndexes(config, manifest).pipe(
        Effect.catchCause(() =>
          Effect.logWarning(
            'Threadnote background recall-index refresh failed; deterministic lexical recall remains available. Run threadnote doctor --dry-run.',
          ),
        ),
        Effect.ensuring(clear),
      );
      yield* Effect.forkDetach(refresh);
      return 'scheduled' as const;
    }),
  );
});

const refreshMcpRecallDerivedIndexes = Effect.fn('recall.refreshMcpDerivedIndexes')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
) {
  const lexicalStatus = yield* recallIndexStatus(config, false);
  if (lexicalRefreshDisposition(lexicalStatus) === 'unsafe') {
    return yield* Effect.fail(new McpRecallBackgroundRefreshBlocked());
  }
  const index = yield* loadRecallIndexData(config, {includeInactive: false});
  const vectorStatus = yield* vectorIndexStatus(config.agentContextHome, manifest);
  if (!vectorStatus.ready && vectorStatus.reason !== 'not built') {
    return yield* Effect.fail(new McpRecallBackgroundRefreshBlocked());
  }
  const readiness = yield* vectorIndexGenerationReadiness(config.agentContextHome, manifest, index.generation);
  if (readiness === 'corrupt') return yield* Effect.fail(new McpRecallBackgroundRefreshBlocked());
  if (readiness === 'current') return;
  yield* ensureVectorIndex(config, manifest, index.candidates, {
    corpusGeneration: index.generation,
    currentCorpusGeneration: () => currentRecallCorpusGeneration(config),
  });
});

export function lexicalRefreshDisposition(status: RecallIndexStatus): 'current' | 'refreshable' | 'unsafe' {
  if (status.ready && status.generation) return 'current';
  if (
    status.reason === 'not built; run `threadnote repair`' ||
    status.reason === 'canonical documents changed; run `threadnote repair`'
  ) {
    return 'refreshable';
  }
  return 'unsafe';
}
