import {Effect} from 'effect';
import {
  CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS,
  scanCodeGraphGitWorktreeRegistry,
  type CodeGraphGitWorktreeRegistryObservation,
  type CodeGraphGitWorktreeRegistryRequest,
} from './git_worktree_registration.js';

const UTF8 = new TextEncoder();

/** One-shot, path-private helper. It always emits one bounded, path-free response. */
export const gitWorktreeRegistrationWorkerProgram: Effect.Effect<void> = Effect.promise(async () => {
  const response = await workerResponse();
  process.stdout.write(`${JSON.stringify(response)}\n`);
});

async function workerResponse(): Promise<CodeGraphGitWorktreeRegistryObservation> {
  try {
    const input = await readBoundedStandardInput(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_LIMITS.workerInputBytes);
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input);
    if (!decoded.endsWith('\n') || decoded.slice(0, -1).includes('\n')) throw new Error('invalid');
    return await scanCodeGraphGitWorktreeRegistry(
      JSON.parse(decoded.slice(0, -1)) as CodeGraphGitWorktreeRegistryRequest,
    );
  } catch {
    return {reason: 'invalid', state: 'unknown'};
  }
}

async function readBoundedStandardInput(limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === 'string' ? UTF8.encode(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > limit) throw new Error('invalid');
    chunks.push(bytes);
  }
  const input = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return input;
}
