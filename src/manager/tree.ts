import {Effect} from 'effect';

export function emptyManagerTree(name: string, uri: string) {
  return {
    children: [],
    isDir: true as const,
    isShared: false,
    isSystem: false,
    name,
    relativePath: '',
    uri,
  };
}

export function isMissingManagerTreePath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (('code' in cause && (cause as NodeJS.ErrnoException).code === 'ENOENT') ||
      ('reason' in cause &&
        typeof cause.reason === 'object' &&
        cause.reason !== null &&
        '_tag' in cause.reason &&
        cause.reason._tag === 'NotFound'))
  );
}

export function readManagerTreeRoot<A, B, E1, E2, R1, R2>(
  rootLookup: Effect.Effect<A, E1, R1>,
  readTree: Effect.Effect<B, E2, R2>,
  emptyTree: B,
): Effect.Effect<B, E1 | E2, R1 | R2> {
  return rootLookup.pipe(
    Effect.matchEffect({
      onFailure: cause => (isMissingManagerTreePath(cause) ? Effect.succeed(emptyTree) : Effect.fail(cause)),
      onSuccess: () => readTree,
    }),
  );
}
