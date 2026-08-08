import {Effect, FileSystem, Stdio, Stream} from 'effect';
import {fromPromiseError} from '../effect/errors.js';
import {SystemInfo} from '../effect/system.js';
import {
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS,
  scanCodeGraphGitWorktreeRegistry,
  scanCodeGraphGitWorktreeRegistryBatch,
  scanCodeGraphWorktreeAuthorityWorkerRequest,
  validCodeGraphGitWorktreeRegistryBatchRequest,
  validCodeGraphWorktreeAuthorityWorkerRequest,
  type CodeGraphGitWorktreeRegistryRequest,
} from './git_worktree_registration.js';

const UTF8 = new TextEncoder();

/** One-shot, path-private helper. It always emits one bounded, path-free response. */
export const gitWorktreeRegistrationWorkerProgram = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const response = yield* readBoundedStandardInput(
    stdio,
    CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.authorityWorkerInputBytes,
  ).pipe(
    Effect.flatMap(workerResponse),
    Effect.catch(() => Effect.succeed({reason: 'invalid', state: 'unknown'} as const)),
  );
  yield* Stream.run(Stream.make(UTF8.encode(`${JSON.stringify(response)}\n`)), stdio.stdout({endOnDone: false}));
});

const workerResponse = Effect.fn('codeGraph.gitWorktreeRegistrationWorkerResponse')(function* (input: Uint8Array) {
  const decoded = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input),
    catch: () => new Error('invalid'),
  });
  if (!decoded.endsWith('\n') || decoded.slice(0, -1).includes('\n')) {
    return yield* Effect.fail(new Error('invalid'));
  }
  const request = yield* Effect.try({
    try: (): unknown => JSON.parse(decoded.slice(0, -1)),
    catch: () => new Error('invalid'),
  });
  if (validCodeGraphWorktreeAuthorityWorkerRequest(request)) {
    yield* blockAuthorityLstatForTest();
    return yield* fromPromiseError(() => scanCodeGraphWorktreeAuthorityWorkerRequest(request));
  }
  if (validCodeGraphGitWorktreeRegistryBatchRequest(request)) {
    return yield* fromPromiseError(() => scanCodeGraphGitWorktreeRegistryBatch(request));
  }
  return yield* fromPromiseError(() =>
    scanCodeGraphGitWorktreeRegistry(request as CodeGraphGitWorktreeRegistryRequest),
  );
});

const readBoundedStandardInput = Effect.fn('codeGraph.readGitWorktreeRegistrationWorkerInput')(function* (
  stdio: Stdio.Stdio,
  limit: number,
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  yield* stdio.stdin.pipe(
    Stream.runForEach(chunk => {
      total += chunk.byteLength;
      if (total > limit) return Effect.fail(new Error('invalid'));
      chunks.push(chunk);
      return Effect.void;
    }),
  );
  const input = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return input;
});

const blockAuthorityLstatForTest = Effect.fn('codeGraph.blockAuthorityLstatForTest')(function* () {
  const system = yield* SystemInfo;
  const environment = system.environment();
  if (environment.THREADNOTE_CODE_GRAPH_TEST_BLOCK_WORKTREE_LSTAT !== '1') return;
  const pidFile = environment.THREADNOTE_CODE_GRAPH_TEST_WORKTREE_LSTAT_PID_FILE;
  if (pidFile) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(pidFile, `${String(system.processId)}\n`, {mode: 0o600});
  }
  return yield* Effect.never;
});
