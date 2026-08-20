import {Effect} from 'effect';
import type {RuntimeConfig} from '../types.js';
import type {CodeGraphAnalysisView} from './analysis_render.js';
import {
  CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS,
  CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS,
  codeGraphCliReadPlan,
  type CodeGraphCliFreshnessPolicy,
} from './cli_freshness.js';
import {CodeGraphQueryService} from './query.js';
import type {CodeGraphStatus} from './types.js';

class CodeGraphAnalysisCommandError extends Error {
  readonly _tag = 'CodeGraphAnalysisCommandError' as const;
}

export interface CodeGraphCliAnalysisState {
  readonly budgetMilliseconds?: number;
  readonly freshness: CodeGraphStatus['freshness'];
  readonly freshnessPolicy: CodeGraphCliFreshnessPolicy;
  readonly operation: CodeGraphAnalysisView | 'report';
  readonly reason: 'no-ready-snapshot' | 'read-timeout';
  readonly repository: {
    readonly displayName: string;
    readonly repositoryId: string;
  };
  readonly retryAfterMilliseconds: number;
  readonly snapshot?: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly id: string;
  };
  readonly state: 'timed-out' | 'unavailable';
  readonly type: 'code-graph-analysis-state';
  readonly version: 1;
}

function codeGraphCliAnalysisState(
  status: CodeGraphStatus,
  policy: CodeGraphCliFreshnessPolicy,
  operation: CodeGraphCliAnalysisState['operation'],
  reason: CodeGraphCliAnalysisState['reason'],
  budgetMilliseconds?: number,
): CodeGraphCliAnalysisState {
  return {
    ...(budgetMilliseconds === undefined ? {} : {budgetMilliseconds}),
    freshness: status.freshness,
    freshnessPolicy: policy,
    operation,
    reason,
    repository: {
      displayName: status.identity.displayName,
      repositoryId: status.identity.repositoryId,
    },
    retryAfterMilliseconds: CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS,
    ...(status.readySnapshot
      ? {
          snapshot: {
            commit: status.readySnapshot.commit,
            dirty: status.readySnapshot.dirty,
            id: status.readySnapshot.id,
          },
        }
      : {}),
    state: reason === 'read-timeout' ? 'timed-out' : 'unavailable',
    type: 'code-graph-analysis-state',
    version: 1,
  };
}

export function renderCodeGraphCliAnalysisState(state: CodeGraphCliAnalysisState): string {
  if (state.state === 'unavailable') {
    return (
      'No ready code graph snapshot is available, and --freshness allow-stale never starts indexing. ' +
      'No analysis ran. Run graph index, or use --freshness ready/current to allow a bounded refresh.\n'
    );
  }
  const readyHint =
    state.operation === 'report'
      ? ' Run graph index explicitly, then retry the report.'
      : state.snapshot === undefined
        ? ' Run graph index, then retry.'
        : ' A ready snapshot remains available; retry with --freshness ready to analyze it without waiting.';
  return (
    `Code graph ${state.freshnessPolicy} ${state.operation === 'report' ? 'report' : 'analysis'} refresh exceeded ` +
    `Threadnote's ${(state.budgetMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS) / 1_000}-second ` +
    `foreground budget. No analysis ran.${readyHint}\n`
  );
}

/** @internal Exported for focused freshness-policy verification. */
export function resolveCodeGraphAnalysisSnapshot<RefreshError, RefreshRequirements>(
  config: RuntimeConfig,
  cwd: string,
  freshnessPolicy: CodeGraphCliFreshnessPolicy,
  refresh: () => Effect.Effect<unknown, RefreshError, RefreshRequirements>,
  options: {
    readonly operation: CodeGraphCliAnalysisState['operation'];
    readonly readTimeoutMilliseconds?: number;
  },
) {
  return Effect.gen(function* () {
    const query = yield* CodeGraphQueryService;
    let status = yield* query.status(config.agentContextHome, cwd, {requestMaintenance: false});
    const identity = status.identity;
    if (status.stale || !status.readySnapshot) {
      status = yield* query.attachSharedReadySnapshot(config.agentContextHome, identity, status, {
        allowBorrowedStale: false,
        requestMaintenance: false,
      });
    }
    const readPlan = codeGraphCliReadPlan(freshnessPolicy, status);
    if (readPlan.unavailable) {
      return {
        ready: false as const,
        state: codeGraphCliAnalysisState(status, freshnessPolicy, options.operation, 'no-ready-snapshot'),
      };
    }
    if (readPlan.refresh) {
      const readTimeoutMilliseconds = options.readTimeoutMilliseconds ?? CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS;
      const refreshed = yield* refresh().pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: readTimeoutMilliseconds,
          orElse: () => Effect.succeed(false),
        }),
      );
      if (!refreshed) {
        return {
          ready: false as const,
          state: codeGraphCliAnalysisState(
            status,
            freshnessPolicy,
            options.operation,
            'read-timeout',
            readTimeoutMilliseconds,
          ),
        };
      }
      status = yield* query.status(config.agentContextHome, cwd, {requestMaintenance: false});
    }
    if (freshnessPolicy === 'current' && (status.stale || status.freshness !== 'current')) {
      return yield* Effect.fail(
        new CodeGraphAnalysisCommandError(
          'A current native code graph snapshot is unavailable after indexing; the worktree may have changed during the refresh.',
        ),
      );
    }
    if (!status.readySnapshot) {
      return yield* Effect.fail(
        new CodeGraphAnalysisCommandError('No ready native code graph snapshot exists after indexing.'),
      );
    }
    return {
      databasePath: status.databasePath,
      freshness: status.freshness,
      freshnessPolicy,
      ready: true as const,
      repository: {
        displayName: status.identity.displayName,
        repositoryId: status.identity.repositoryId,
      },
      snapshot: status.readySnapshot,
    };
  });
}
