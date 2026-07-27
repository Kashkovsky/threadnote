import {Clock, Console, Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256Hex} from '../effect/digest.js';
import {
  LEGACY_OPENVIKING_HOME_DIRECTORY,
  THREADNOTE_HOME_DIRECTORY,
  THREADNOTE_STORAGE_LAYOUT_VERSION,
} from '../storage/layout.js';
import {SystemInfo} from '../effect/system.js';

export const HOME_MIGRATION_ID = 'openviking-home-v1';
export const HOME_MIGRATION_RECEIPT_VERSION = 1 as const;
const RECEIPT_RELATIVE_PATH = `migration/${HOME_MIGRATION_ID}.json`;
const LAYOUT_RELATIVE_PATH = 'layout.json';

const EXCLUDED_LEGACY_PATHS = new Set([
  '.venv',
  'cache',
  'local-ai-server.json',
  'local-ai-server.lock',
  'locks',
  'logs',
  'openviking-server.json',
  'openviking-server.lock',
  'ov.conf',
  'ovcli.conf',
  'venv',
]);

const EXCLUDED_LEGACY_THREADNOTE_PATHS = new Set([
  'threadnote/local-ai-token',
  'threadnote/local-ai.json',
  'threadnote/shared-repository.lock',
]);

export interface HomeMigrationOptions {
  readonly apply?: boolean;
  readonly legacyHome?: string;
  readonly targetHome?: string;
}

export interface HomeMigrationReceipt {
  readonly bytes: number;
  readonly completedAt: string;
  readonly directories: number;
  readonly files: number;
  readonly id: typeof HOME_MIGRATION_ID;
  readonly legacyHome: string;
  readonly sourceTreeSha256: string;
  readonly stagedTreeSha256?: string;
  readonly symlinks: number;
  readonly targetHome: string;
  readonly version: typeof HOME_MIGRATION_RECEIPT_VERSION;
}

export interface HomeMigrationResult {
  readonly action: 'already_migrated' | 'dry_run' | 'migrated' | 'no_legacy_home' | 'resumed';
  readonly receipt?: HomeMigrationReceipt;
}

interface InventoryEntry {
  readonly digest: string;
  readonly mode: number;
  readonly relativePath: string;
  readonly size: number;
  readonly type: 'directory' | 'file' | 'symlink';
}

interface HomeInventory {
  readonly bytes: number;
  readonly directories: number;
  readonly entries: readonly InventoryEntry[];
  readonly files: number;
  readonly symlinks: number;
  readonly treeSha256: string;
}

interface LegacyShareMigration {
  readonly finalGitdir: string;
  readonly finalWorktree: string;
  readonly name: string;
  readonly sourceGitdir: string;
  readonly sourceGitdirRelative: string;
  readonly sourceWorktree: string;
  readonly sourceWorktreeRelative: string;
  readonly stageGitdirRelative: string;
  readonly stageWorktreeRelative: string;
}

export class HomeMigrationConflict extends Schema.TaggedErrorClass<HomeMigrationConflict>()('HomeMigrationConflict', {
  message: Schema.String,
  path: Schema.String,
}) {}

export class HomeMigrationFailed extends Schema.TaggedErrorClass<HomeMigrationFailed>()('HomeMigrationFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
}) {}

export class HomeMigrationInsufficientSpace extends Schema.TaggedErrorClass<HomeMigrationInsufficientSpace>()(
  'HomeMigrationInsufficientSpace',
  {
    availableBytes: Schema.Number,
    message: Schema.String,
    requiredBytes: Schema.Number,
  },
) {}

export class HomeMigrationUnsafe extends Schema.TaggedErrorClass<HomeMigrationUnsafe>()('HomeMigrationUnsafe', {
  message: Schema.String,
  path: Schema.String,
}) {}

export type HomeMigrationError =
  HomeMigrationConflict | HomeMigrationFailed | HomeMigrationInsufficientSpace | HomeMigrationUnsafe;

const migrateOpenVikingHomeImpl = Effect.fn('homeMigration.migrate')(function* (options: HomeMigrationOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const legacyHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.legacyHome ?? path.join(system.homeDirectory, LEGACY_OPENVIKING_HOME_DIRECTORY),
  );
  const targetHome = resolveHomeInput(
    path,
    system.homeDirectory,
    options.targetHome ?? path.join(system.homeDirectory, THREADNOTE_HOME_DIRECTORY),
  );
  assertSeparateHomes(path, legacyHome, targetHome);

  if (yield* fs.exists(targetHome)) {
    const receipt = yield* readReceipt(fs, path.join(targetHome, RECEIPT_RELATIVE_PATH));
    if (receipt?.legacyHome === legacyHome && receipt.targetHome === targetHome) {
      return {action: 'already_migrated', receipt};
    }
    return yield* Effect.fail(
      new HomeMigrationConflict({
        message: `Target home already exists without a matching ${HOME_MIGRATION_ID} receipt.`,
        path: targetHome,
      }),
    );
  }
  if (!(yield* fs.exists(legacyHome))) {
    return {action: 'no_legacy_home'};
  }
  yield* fs.access(legacyHome, {readable: true});
  const targetParent = path.dirname(targetHome);
  yield* fs.makeDirectory(targetParent, {recursive: true, mode: 0o700});
  yield* fs.access(targetParent, {writable: true});

  const resumable = yield* findResumableStage(fs, path, targetParent, targetHome, legacyHome);
  if (resumable) {
    if (options.apply !== true) {
      return {action: 'dry_run', receipt: resumable.receipt};
    }
    yield* fs.rename(resumable.path, targetHome);
    return {action: 'resumed', receipt: resumable.receipt};
  }

  const inventory = yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
  const shareMigrations = yield* planLegacyShareMigrations(fs, path, legacyHome, targetHome);
  const duplicatedShareBytes = duplicatedMigrationBytes(inventory, shareMigrations);
  const availableBytes = yield* system.availableDiskBytes(targetParent);
  if (availableBytes !== undefined) {
    yield* assertSufficientHomeMigrationDiskSpace(inventory.bytes + duplicatedShareBytes, availableBytes);
  }
  const now = new Date(yield* Clock.currentTimeMillis).toISOString();
  const receipt: HomeMigrationReceipt = {
    bytes: inventory.bytes,
    completedAt: now,
    directories: inventory.directories,
    files: inventory.files,
    id: HOME_MIGRATION_ID,
    legacyHome,
    sourceTreeSha256: inventory.treeSha256,
    symlinks: inventory.symlinks,
    targetHome,
    version: HOME_MIGRATION_RECEIPT_VERSION,
  };
  if (options.apply !== true) {
    return {action: 'dry_run', receipt};
  }

  const stage = yield* fs.makeTempDirectory({
    directory: targetParent,
    prefix: `${path.basename(targetHome)}.migrate-`,
  });
  yield* fs.chmod(stage, 0o700);
  yield* copyInventory(fs, path, legacyHome, stage, inventory);
  yield* verifyCopiedInventory(fs, path, stage, inventory);

  const sourceAfterCopy = yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
  if (sourceAfterCopy.treeSha256 !== inventory.treeSha256) {
    return yield* Effect.fail(
      new HomeMigrationConflict({
        message: 'The legacy home changed during migration. The staged copy was retained; rerun after writes stop.',
        path: legacyHome,
      }),
    );
  }

  yield* migrateLegacyShares(fs, path, stage, shareMigrations);
  const stagedInventory = yield* inventoryHome(fs, path, stage, () => true);
  const completedReceipt: HomeMigrationReceipt = {
    ...receipt,
    stagedTreeSha256: stagedInventory.treeSha256,
  };
  yield* fs.writeFileString(
    path.join(stage, LAYOUT_RELATIVE_PATH),
    `${JSON.stringify({version: THREADNOTE_STORAGE_LAYOUT_VERSION}, null, 2)}\n`,
    {flag: 'wx', mode: 0o600},
  );
  const receiptPath = path.join(stage, RECEIPT_RELATIVE_PATH);
  yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(receiptPath, `${JSON.stringify(completedReceipt, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs.rename(stage, targetHome);
  return {action: 'migrated', receipt: completedReceipt};
});

export const migrateOpenVikingHome = (options: HomeMigrationOptions = {}) =>
  migrateOpenVikingHomeImpl(options).pipe(
    Effect.mapError(cause =>
      isHomeMigrationError(cause)
        ? cause
        : new HomeMigrationFailed({
            cause,
            message: cause instanceof Error ? cause.message : String(cause),
            operation: 'migrate OpenViking home',
          }),
    ),
  ) as Effect.Effect<
    HomeMigrationResult,
    HomeMigrationError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo
  >;

export const runHomeMigration = Effect.fn('homeMigration.run')(function* (options: HomeMigrationOptions) {
  const result = yield* migrateOpenVikingHome(options);
  switch (result.action) {
    case 'already_migrated':
      yield* Console.log(`Threadnote home is already migrated: ${result.receipt?.targetHome}`);
      return;
    case 'dry_run':
      yield* Console.log(
        `Would migrate ${result.receipt?.files ?? 0} files (${result.receipt?.bytes ?? 0} bytes) from ${result.receipt?.legacyHome} to ${result.receipt?.targetHome}.`,
      );
      yield* Console.log('Rerun with --apply to stage, validate, and atomically promote the new home.');
      return;
    case 'migrated':
      yield* Console.log(`Migrated and validated Threadnote home: ${result.receipt?.targetHome}`);
      yield* Console.log(`Legacy home was preserved unchanged: ${result.receipt?.legacyHome}`);
      return;
    case 'no_legacy_home':
      yield* Console.log('No legacy ~/.openviking home was found; nothing to migrate.');
      return;
    case 'resumed':
      yield* Console.log(`Promoted a previously validated migration: ${result.receipt?.targetHome}`);
  }
});

function assertSeparateHomes(path: Path.Path, legacyHome: string, targetHome: string): void {
  if (
    legacyHome === targetHome ||
    isWithin(path, legacyHome, targetHome) ||
    isWithin(path, targetHome, legacyHome) ||
    path.parse(legacyHome).root === legacyHome ||
    path.parse(targetHome).root === targetHome
  ) {
    throw new HomeMigrationUnsafe({
      message: 'Legacy and target homes must be separate, non-root directories and cannot contain each other.',
      path: targetHome,
    });
  }
}

function inventoryHome(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  include: (relativePath: string) => boolean,
): Effect.Effect<HomeInventory, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const entries: InventoryEntry[] = [];
    const visit = (directory: string, relativeDirectory: string): Effect.Effect<void, unknown, Crypto.Crypto> =>
      Effect.gen(function* () {
        const names = (yield* fs.readDirectory(directory)).sort((left, right) => left.localeCompare(right));
        for (const name of names) {
          const relativePath = portableRelative(path, path.join(relativeDirectory, name));
          if (!include(relativePath)) continue;
          const absolutePath = path.join(directory, name);
          const symbolicLink = yield* fs.readLink(absolutePath).pipe(Effect.option);
          if (Option.isSome(symbolicLink)) {
            const target = symbolicLink.value;
            if (path.isAbsolute(target)) {
              return yield* Effect.fail(
                new HomeMigrationUnsafe({
                  message: `Absolute symbolic links are not migrated because they would retain a dependency on the legacy home: ${relativePath}.`,
                  path: absolutePath,
                }),
              );
            }
            const resolved = path.resolve(path.dirname(absolutePath), target);
            if (!isWithinOrSame(path, root, resolved)) {
              return yield* Effect.fail(
                new HomeMigrationUnsafe({
                  message: `Symbolic link escapes the legacy home: ${relativePath}.`,
                  path: absolutePath,
                }),
              );
            }
            entries.push({
              digest: yield* sha256Hex(target),
              mode: 0,
              relativePath,
              size: new TextEncoder().encode(target).length,
              type: 'symlink',
            });
            continue;
          }
          const info = yield* fs.stat(absolutePath);
          if (info.type === 'Directory') {
            entries.push({digest: '', mode: info.mode, relativePath, size: 0, type: 'directory'});
            yield* visit(absolutePath, relativePath);
          } else if (info.type === 'File') {
            const content = yield* fs.readFile(absolutePath);
            entries.push({
              digest: yield* sha256Hex(content),
              mode: info.mode,
              relativePath,
              size: Number(info.size),
              type: 'file',
            });
          } else {
            return yield* Effect.fail(
              new HomeMigrationUnsafe({
                message: `Unsupported filesystem entry in legacy home: ${relativePath} (${info.type}).`,
                path: absolutePath,
              }),
            );
          }
        }
      });
    yield* visit(root, '');
    const treeSha256 = yield* sha256Hex(
      entries
        .filter(entry => entry.type !== 'directory')
        .map(entry => `${entry.type}\0${entry.relativePath}\0${entry.size}\0${entry.digest}\n`)
        .join(''),
    );
    return {
      bytes: entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.size : 0), 0),
      directories: entries.filter(entry => entry.type === 'directory').length,
      entries,
      files: entries.filter(entry => entry.type === 'file').length,
      symlinks: entries.filter(entry => entry.type === 'symlink').length,
      treeSha256,
    };
  });
}

function copyInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
  inventory: HomeInventory,
) {
  return Effect.gen(function* () {
    for (const entry of inventory.entries) {
      const source = path.join(sourceRoot, entry.relativePath);
      const target = path.join(targetRoot, entry.relativePath);
      if (entry.type === 'directory') {
        yield* fs.makeDirectory(target, {recursive: true, mode: 0o700});
      } else if (entry.type === 'file') {
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.copyFile(source, target);
        yield* fs.chmod(target, 0o600 | (entry.mode & 0o100));
      } else {
        yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
        yield* fs.symlink(yield* fs.readLink(source), target);
      }
    }
  });
}

function verifyCopiedInventory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stage: string,
  expected: HomeInventory,
): Effect.Effect<void, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const actual = yield* inventoryHome(fs, path, stage, () => true);
    if (actual.treeSha256 !== expected.treeSha256) {
      return yield* Effect.fail(
        new HomeMigrationConflict({
          message: 'Staged home validation failed: copied file metadata or hashes do not match.',
          path: stage,
        }),
      );
    }
  });
}

function findResumableStage(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  parent: string,
  targetHome: string,
  legacyHome: string,
): Effect.Effect<{readonly path: string; readonly receipt: HomeMigrationReceipt} | undefined, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const prefix = `${path.basename(targetHome)}.migrate-`;
    const names = (yield* fs.readDirectory(parent)).filter(name => name.startsWith(prefix)).sort();
    let currentSourceInventory: HomeInventory | undefined;
    for (const name of names) {
      const candidate = path.join(parent, name);
      const receipt = yield* readReceipt(fs, path.join(candidate, RECEIPT_RELATIVE_PATH));
      if (!receipt || receipt.targetHome !== targetHome || receipt.legacyHome !== legacyHome) continue;
      const inventory = yield* inventoryHome(
        fs,
        path,
        candidate,
        relativePath => relativePath !== RECEIPT_RELATIVE_PATH && relativePath !== LAYOUT_RELATIVE_PATH,
      );
      if (inventory.treeSha256 === (receipt.stagedTreeSha256 ?? receipt.sourceTreeSha256)) {
        currentSourceInventory ??= yield* inventoryHome(fs, path, legacyHome, shouldIncludeLegacyPath);
        if (currentSourceInventory.treeSha256 !== receipt.sourceTreeSha256) {
          continue;
        }
        return {path: candidate, receipt};
      }
    }
    return undefined;
  });
}

function readReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<HomeMigrationReceipt | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => parseReceipt(JSON.parse(content))),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function parseReceipt(value: unknown): HomeMigrationReceipt {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Partial<HomeMigrationReceipt>).id !== HOME_MIGRATION_ID ||
    (value as Partial<HomeMigrationReceipt>).version !== HOME_MIGRATION_RECEIPT_VERSION
  ) {
    throw new Error('Invalid migration receipt.');
  }
  const receipt = value as HomeMigrationReceipt;
  if (
    !Number.isInteger(receipt.files) ||
    !Number.isInteger(receipt.directories) ||
    !Number.isInteger(receipt.symlinks) ||
    !Number.isFinite(receipt.bytes) ||
    !/^[0-9a-f]{64}$/.test(receipt.sourceTreeSha256) ||
    (receipt.stagedTreeSha256 !== undefined && !/^[0-9a-f]{64}$/.test(receipt.stagedTreeSha256)) ||
    !receipt.legacyHome ||
    !receipt.targetHome ||
    !receipt.completedAt
  ) {
    throw new Error('Invalid migration receipt fields.');
  }
  return receipt;
}

function planLegacyShareMigrations(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  legacyHome: string,
  targetHome: string,
): Effect.Effect<readonly LegacyShareMigration[], HomeMigrationUnsafe | unknown> {
  return Effect.gen(function* () {
    const teamsPath = path.join(legacyHome, 'share', 'teams.json');
    if (!(yield* fs.exists(teamsPath))) return [];
    const raw = yield* fs.readFileString(teamsPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return yield* Effect.fail(
        new HomeMigrationUnsafe({
          message: 'Legacy share teams file is not valid JSON.',
          path: teamsPath,
        }),
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const teams = (parsed as {readonly teams?: unknown}).teams;
    if (typeof teams !== 'object' || teams === null || Array.isArray(teams)) return [];

    const plans: LegacyShareMigration[] = [];
    for (const [name, value] of Object.entries(teams)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || /^\.+$/.test(name)) {
        return yield* Effect.fail(
          new HomeMigrationUnsafe({
            message: `Legacy share has an unsafe team name: ${name}.`,
            path: teamsPath,
          }),
        );
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as {readonly gitdir?: unknown; readonly worktree?: unknown};
      if (typeof entry.worktree !== 'string' || typeof entry.gitdir !== 'string') continue;
      const sourceWorktreeRelative = checkedLegacyRelative(path, legacyHome, entry.worktree, 'share worktree');
      const sourceGitdirRelative = checkedLegacyRelative(path, legacyHome, entry.gitdir, 'share gitdir');
      plans.push({
        finalGitdir: path.join(targetHome, 'share', 'teams', `${name}.gitdir`),
        finalWorktree: path.join(targetHome, 'share', 'worktrees', name),
        name,
        sourceGitdir: path.resolve(entry.gitdir),
        sourceGitdirRelative,
        sourceWorktree: path.resolve(entry.worktree),
        sourceWorktreeRelative,
        stageGitdirRelative: path.join('share', 'teams', `${name}.gitdir`),
        stageWorktreeRelative: path.join('share', 'worktrees', name),
      });
    }
    return plans;
  });
}

function checkedLegacyRelative(path: Path.Path, legacyHome: string, value: string, label: string): string {
  const absolute = path.resolve(value);
  if (!isWithin(path, legacyHome, absolute)) {
    throw new HomeMigrationUnsafe({
      message: `Legacy ${label} is outside the owned home and cannot be migrated safely.`,
      path: absolute,
    });
  }
  return path.relative(legacyHome, absolute);
}

function duplicatedMigrationBytes(inventory: HomeInventory, migrations: readonly LegacyShareMigration[]): number {
  const roots = migrations.flatMap(migration => [
    portableInput(migration.sourceWorktreeRelative),
    ...(migration.sourceGitdirRelative === migration.stageGitdirRelative
      ? []
      : [portableInput(migration.sourceGitdirRelative)]),
  ]);
  return inventory.entries
    .filter(
      entry =>
        entry.type === 'file' &&
        roots.some(root => entry.relativePath === root || entry.relativePath.startsWith(`${root}/`)),
    )
    .reduce((total, entry) => total + entry.size, 0);
}

function migrateLegacyShares(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stage: string,
  migrations: readonly LegacyShareMigration[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (migrations.length === 0) return;
    const teamsPath = path.join(stage, 'share', 'teams.json');
    const teamsFile = JSON.parse(yield* fs.readFileString(teamsPath)) as {
      teams?: Record<string, Record<string, unknown>>;
    };
    for (const migration of migrations) {
      const sourceWorktree = path.join(stage, migration.sourceWorktreeRelative);
      const stageWorktree = path.join(stage, migration.stageWorktreeRelative);
      if (!(yield* fs.exists(sourceWorktree))) {
        return yield* Effect.fail(
          new HomeMigrationUnsafe({
            message: `Legacy share worktree is missing: ${migration.name}.`,
            path: sourceWorktree,
          }),
        );
      }
      yield* fs.makeDirectory(path.dirname(stageWorktree), {recursive: true, mode: 0o700});
      yield* fs.copy(sourceWorktree, stageWorktree, {preserveTimestamps: true});

      const canonicalGitMarker = path.join(sourceWorktree, '.git');
      if (yield* fs.exists(canonicalGitMarker)) {
        yield* fs.remove(canonicalGitMarker, {recursive: true});
      }

      const sourceGitdir = path.join(stage, migration.sourceGitdirRelative);
      const stageGitdir = path.join(stage, migration.stageGitdirRelative);
      if (!(yield* fs.exists(sourceGitdir))) {
        return yield* Effect.fail(
          new HomeMigrationUnsafe({
            message: `Legacy share gitdir is missing: ${migration.name}.`,
            path: sourceGitdir,
          }),
        );
      }
      if (sourceGitdir !== stageGitdir) {
        yield* fs.makeDirectory(path.dirname(stageGitdir), {recursive: true, mode: 0o700});
        yield* fs.copy(sourceGitdir, stageGitdir, {preserveTimestamps: true});
      }
      yield* fs.writeFileString(path.join(stageWorktree, '.git'), `gitdir: ${migration.finalGitdir}\n`, {mode: 0o600});
      const gitConfigPath = path.join(stageGitdir, 'config');
      if (yield* fs.exists(gitConfigPath)) {
        const gitConfig = yield* fs.readFileString(gitConfigPath);
        yield* fs.writeFileString(
          gitConfigPath,
          gitConfig
            .replaceAll(migration.sourceWorktree, migration.finalWorktree)
            .replaceAll(migration.sourceGitdir, migration.finalGitdir),
          {mode: 0o600},
        );
      }
      const entry = teamsFile.teams?.[migration.name];
      if (entry) {
        entry.gitdir = migration.finalGitdir;
        entry.worktree = migration.finalWorktree;
      }
    }
    yield* fs.writeFileString(teamsPath, `${JSON.stringify(teamsFile, null, 2)}\n`, {mode: 0o600});
  });
}

function shouldIncludeLegacyPath(relativePath: string): boolean {
  const portable = portableInput(relativePath);
  const top = portable.split('/')[0] ?? '';
  return !EXCLUDED_LEGACY_PATHS.has(top) && !EXCLUDED_LEGACY_THREADNOTE_PATHS.has(portable);
}

function portableRelative(path: Path.Path, value: string): string {
  return portableInput(path.normalize(value)).replace(/^\/+/, '');
}

function portableInput(value: string): string {
  return value.replaceAll('\\', '/');
}

function resolveHomeInput(path: Path.Path, userHome: string, value: string): string {
  if (value === '~') return path.resolve(userHome);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(userHome, value.slice(2));
  }
  return path.resolve(value);
}

function isWithin(path: Path.Path, parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isWithinOrSame(path: Path.Path, parent: string, candidate: string): boolean {
  return parent === candidate || isWithin(path, parent, candidate);
}

function isHomeMigrationError(cause: unknown): cause is HomeMigrationError {
  return (
    cause instanceof HomeMigrationConflict ||
    cause instanceof HomeMigrationFailed ||
    cause instanceof HomeMigrationInsufficientSpace ||
    cause instanceof HomeMigrationUnsafe
  );
}

export function assertSufficientHomeMigrationDiskSpace(
  sourceBytes: number,
  availableBytes: number,
): Effect.Effect<void, HomeMigrationInsufficientSpace> {
  const safetyMargin = Math.min(
    512 * 1024 * 1024,
    Math.max(16 * 1024 * 1024, Math.ceil(Math.max(0, sourceBytes) * 0.1)),
  );
  const requiredBytes = Math.max(0, sourceBytes) + safetyMargin;
  return availableBytes >= requiredBytes
    ? Effect.void
    : Effect.fail(
        new HomeMigrationInsufficientSpace({
          availableBytes,
          message: `Home migration needs ${requiredBytes} free bytes for a validated staged copy; only ${availableBytes} are available.`,
          requiredBytes,
        }),
      );
}
