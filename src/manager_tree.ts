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
