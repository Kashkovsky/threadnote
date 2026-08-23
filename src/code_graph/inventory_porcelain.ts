/**
 * Parses Git's stable porcelain-v1 `-z` contract. Rename/copy records use the
 * documented destination-then-source order, while untracked rows remain
 * distinguishable for exact overlay admission.
 */
export function parsePorcelainV1Status(output: string): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
  readonly untracked: Set<string>;
} {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const untracked = new Set<string>();
  const fields = output.split('\0');
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record || record.length < 4 || record[2] !== ' ') continue;
    const status = record.slice(0, 2);
    const path = normalizeRepositoryPath(record.slice(3));
    if (!path) continue;
    if (status === '??') {
      added.add(path);
      changed.add(path);
      untracked.add(path);
      continue;
    }
    const rename = status.includes('R');
    const copy = status.includes('C');
    if (rename || copy) {
      const source = normalizeRepositoryPath(fields[index++] ?? '');
      if (rename && source) deleted.add(source);
      added.add(path);
      changed.add(path);
      continue;
    }
    const [indexStatus, worktreeStatus] = status;
    // Every two-letter unmerged state containing D still represents a
    // conflicted worktree path. Only the ordinary staged/unstaged delete
    // states remove the path without hashing a possible conflict file.
    if (status === 'D ' || status === ' D') {
      deleted.add(path);
      continue;
    }
    if (status !== '  ' && status !== '!!') {
      changed.add(path);
      if (indexStatus === 'A' || worktreeStatus === 'A') added.add(path);
    }
  }
  return {added, changed, deleted, untracked};
}

function normalizeRepositoryPath(value: string): string {
  return value.replace(/^\.\/+/, '');
}
