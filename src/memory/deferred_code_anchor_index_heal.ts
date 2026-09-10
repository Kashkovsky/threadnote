import {Context, Effect, FileSystem, Option, Path} from 'effect';
import type {CodeGraphIndexOptions, CodeGraphIndexerShape} from '../code_graph/indexer_types.js';
import type {CodeGraphIndexSummary, RepositoryIdentity} from '../code_graph/types.js';
import {getRuntimeConfig} from '../runtime.js';
import {healAnchorsAfterGraphIndex} from './deferred_code_anchor_recovery.js';

export function withDeferredCodeAnchorIndexHeal(
  indexer: CodeGraphIndexerShape,
  afterIndex: (options: CodeGraphIndexOptions, summary: CodeGraphIndexSummary) => Effect.Effect<void, unknown>,
): CodeGraphIndexerShape {
  return {
    ensureCommit: options => indexer.ensureCommit(options),
    index: options =>
      indexer.index(options).pipe(Effect.tap(summary => afterIndex(options, summary).pipe(Effect.ignoreCause))),
  };
}

const publishedGraphIndexHeal = (
  threadnoteHome: string,
  cwd: string,
  identity: Pick<RepositoryIdentity, 'repositoryId' | 'worktreeId'>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Index-only homes never store private deferred intents. Skip before
    // getRuntimeConfig so post-index heal cannot hold the ApplicationLayer
    // scope open long enough for opportunistic graph maintenance to open
    // extra SQLite sessions.
    const dataRoot = path.join(threadnoteHome, 'data');
    const info = yield* fs.stat(dataRoot).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'Directory') return;
    const config = yield* getRuntimeConfig({home: threadnoteHome});
    yield* healAnchorsAfterGraphIndex(config, cwd, identity);
  }).pipe(Effect.ignoreCause);

type PublishedGraphIndexHealServices = Effect.Services<ReturnType<typeof publishedGraphIndexHeal>>;

function isFiberServiceContext<R>(_context: Context.Context<never>): _context is Context.Context<R> {
  return true;
}

export const healAfterPublishedGraphIndex = (
  threadnoteHome: string,
  cwd: string,
  identity: Pick<RepositoryIdentity, 'repositoryId' | 'worktreeId'>,
): Effect.Effect<void> =>
  Effect.withFiber(fiber => {
    const context = fiber.context;
    if (!isFiberServiceContext<PublishedGraphIndexHealServices>(context)) {
      return Effect.void;
    }
    return publishedGraphIndexHeal(threadnoteHome, cwd, identity).pipe(Effect.setContext(context), Effect.asVoid);
  });
