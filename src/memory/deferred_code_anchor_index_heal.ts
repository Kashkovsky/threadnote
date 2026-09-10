import {Context, Effect} from 'effect';
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
  getRuntimeConfig({home: threadnoteHome}).pipe(
    Effect.flatMap(config => healAnchorsAfterGraphIndex(config, cwd, identity)),
    Effect.ignoreCause,
  );

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
