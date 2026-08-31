import {Console, Effect, Path} from 'effect';
import {runIsolatedCodeGraphIndexSnapshot} from '../code_graph/isolated_index.js';
import {resolveAndRecordCodeGraphLocalAssociation} from '../code_graph/local_provenance.js';
import {captureConsole} from '../effect/console.js';
import type {RuntimeConfig} from '../types.js';
import {errorMessage} from '../utils.js';
import {requireString} from './request_inputs.js';

class ManagerExplicitGraphActionError extends Error {
  readonly _tag = 'ManagerExplicitGraphActionError' as const;
}

export const runManagerExplicitCwdGraphIndex = Effect.fn('managerGraphActions.runExplicitCwdGraphIndex')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  const suppliedCwd = yield* Effect.try({
    try: () => requireString(body.cwd, 'cwd'),
    catch: cause => new ManagerExplicitGraphActionError(errorMessage(cause), {cause}),
  });
  const path = yield* Path.Path;
  if (!path.isAbsolute(suppliedCwd)) {
    return yield* Effect.fail(new ManagerExplicitGraphActionError('Supply cwd as an absolute local worktree path.'));
  }
  const {identity} = yield* resolveAndRecordCodeGraphLocalAssociation(config.agentContextHome, suppliedCwd).pipe(
    Effect.mapError(
      () =>
        new ManagerExplicitGraphActionError(
          'The selected workspace is not an available local Git repository. Check its path and retry.',
        ),
    ),
  );
  const captured = yield* captureConsole(
    runIsolatedCodeGraphIndexSnapshot({
      cwd: identity.repoRoot,
      expectedIdentity: {
        checkoutId: identity.checkoutId,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      },
      force: body.full === true,
      threadnoteHome: config.agentContextHome,
    }).pipe(
      Effect.flatMap(summary =>
        Console.log(
          `Ready in an isolated process · ${summary.snapshot.fileCount.toLocaleString()} files · ` +
            `${summary.snapshot.symbolCount.toLocaleString()} symbols · ` +
            `${summary.snapshot.edgeCount.toLocaleString()} edges`,
        ),
      ),
    ),
  );
  return {output: captured.output};
});
