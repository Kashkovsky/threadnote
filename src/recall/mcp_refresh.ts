import {Effect, FileSystem, Path, Schema} from 'effect';
import {LocalModelCatalog, type LocalModelManifest} from '../models/catalog.js';
import {readModelSelection} from '../models/selection.js';
import {LocalModelStore} from '../models/store.js';
import {ensureVectorIndex, vectorIndexGenerationReadiness, vectorIndexStatus} from '../search/vector-index.js';
import {
  currentRecallCorpusGeneration,
  expireRecallIndexValidation,
  loadRecallIndexData,
  recallIndexStatus,
  type RecallIndexData,
  type RecallIndexStatus,
} from './index.js';

interface McpRecallRefreshConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export type McpRecallBackgroundRefreshSchedule = 'coalesced' | 'scheduled';

interface ActiveMcpRecallRefresh {
  config: McpRecallRefreshConfig;
  manifest: LocalModelManifest;
  pending: boolean;
}

const activeRefreshes = new Map<string, ActiveMcpRecallRefresh>();

class McpRecallBackgroundRefreshBlocked extends Schema.TaggedError<McpRecallBackgroundRefreshBlocked>()(
  'McpRecallBackgroundRefreshBlocked',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/**
 * Start one process-local derived-index refresh without joining it to the MCP
 * request. Concurrent calls retain the latest inputs for one trailing rerun so
 * a newer generation is not lost behind an obsolete generation fence. The
 * filesystem locks remain the cross-process authority; this map only prevents
 * redundant work from concurrent requests in this process.
 */
export const scheduleMcpRecallBackgroundRefresh = Effect.fn('recall.scheduleMcpBackgroundRefresh')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalHome = yield* fs
    .realPath(config.agentContextHome)
    .pipe(Effect.orElseSucceed(() => path.resolve(config.agentContextHome)));
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const candidate: ActiveMcpRecallRefresh = {config, manifest, pending: false};
      const active = yield* Effect.sync(() => {
        const existing = activeRefreshes.get(canonicalHome);
        if (existing !== undefined) {
          existing.config = config;
          existing.manifest = manifest;
          existing.pending = true;
          return existing;
        }
        activeRefreshes.set(canonicalHome, candidate);
        return candidate;
      });
      if (active !== candidate) return 'coalesced' as const;

      const clear = Effect.sync(() => {
        if (activeRefreshes.get(canonicalHome) === active) activeRefreshes.delete(canonicalHome);
      });
      const refresh = Effect.gen(function* () {
        for (;;) {
          const latest = yield* Effect.sync(() => {
            active.pending = false;
            return {config: active.config, manifest: active.manifest};
          });
          yield* refreshMcpRecallDerivedIndexes(latest.config, latest.manifest).pipe(
            Effect.catchCause(() =>
              Effect.logWarning(
                'Threadnote background recall-index refresh failed; deterministic lexical recall remains available. Run threadnote doctor --dry-run.',
              ),
            ),
          );
          const rerun = yield* Effect.sync(() => {
            if (activeRefreshes.get(canonicalHome) !== active) return false;
            if (active.pending) return true;
            activeRefreshes.delete(canonicalHome);
            return false;
          });
          if (!rerun) return;
        }
      }).pipe(Effect.ensuring(clear));
      yield* Effect.forkDetach(refresh);
      return 'scheduled' as const;
    }),
  );
});

const refreshMcpRecallDerivedIndexes = Effect.fn('recall.refreshMcpDerivedIndexes')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
) {
  const index = yield* refreshRecallLexicalIndex(config);
  yield* refreshRecallVectorIndex(config, manifest, index);
});

/**
 * Restore derived-index readiness after a trusted product mutation. Lexical
 * readiness is synchronous and independently invalidated. An already-built
 * selected vector index finishes before this hook returns because graph and
 * Workset preparation can run in an ephemeral child process; process-local
 * detached work would be lost when that child exits. Incremental vector reuse
 * avoids re-embedding unchanged memory chunks. This hook never constructs a
 * previously absent vector index.
 */
export const refreshRecallDerivedIndexesFromSelection = Effect.fn('recall.refreshDerivedIndexesFromSelection')(
  function* (config: McpRecallRefreshConfig, invalidatedUris: readonly string[]) {
    const uris = [...new Set(invalidatedUris)];
    const forceRefresh =
      uris.length === 0
        ? false
        : yield* expireRecallIndexValidation(config.agentContextHome, false, uris).pipe(
            Effect.as(false),
            Effect.catchCause(() => Effect.succeed(true)),
          );
    const index = yield* refreshRecallLexicalIndex(config, forceRefresh);
    yield* Effect.gen(function* () {
      const selection = yield* readModelSelection(config.agentContextHome);
      const modelId = selection.roles.embedding;
      if (modelId === undefined) return;
      const catalog = yield* LocalModelCatalog;
      const manifest = yield* catalog.get(modelId);
      if (manifest.role !== 'embedding') return;
      const store = yield* LocalModelStore;
      const installed = yield* store.status(config.agentContextHome, manifest);
      if (!installed.installed) return;
      const vectorStatus = yield* vectorIndexStatus(config.agentContextHome, manifest);
      if (!vectorStatus.ready && vectorStatus.reason === 'not built') return;
      yield* refreshRecallVectorIndex(config, manifest, index);
    }).pipe(Effect.ignoreCause);
  },
);

const refreshRecallLexicalIndex = Effect.fn('recall.refreshDerivedLexicalIndex')(function* (
  config: McpRecallRefreshConfig,
  forceRefresh = false,
) {
  const lexicalStatus = yield* recallIndexStatus(config, false);
  if (lexicalRefreshDisposition(lexicalStatus) === 'unsafe') {
    return yield* McpRecallBackgroundRefreshBlocked.make({message: ''});
  }
  return yield* loadRecallIndexData(config, {forceRefresh, includeInactive: false});
});

const refreshRecallVectorIndex = Effect.fn('recall.refreshDerivedVectorIndex')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
  index: RecallIndexData,
) {
  const vectorStatus = yield* vectorIndexStatus(config.agentContextHome, manifest);
  if (!vectorStatus.ready && vectorStatus.reason !== 'not built') {
    return yield* McpRecallBackgroundRefreshBlocked.make({message: ''});
  }
  const readiness = yield* vectorIndexGenerationReadiness(config.agentContextHome, manifest, index.generation);
  if (readiness === 'corrupt') return yield* McpRecallBackgroundRefreshBlocked.make({message: ''});
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
