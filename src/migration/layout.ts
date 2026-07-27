import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256FileHex, sha256Hex} from '../effect/digest.js';
import {SystemInfo} from '../effect/system.js';
import {
  LEGACY_THREADNOTE_DATA_DIRECTORY,
  LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION,
  THREADNOTE_STORAGE_LAYOUT_VERSION,
} from '../storage/layout.js';
import {validatePortableSegment} from '../storage/resource-id.js';

export const STORAGE_LAYOUT_MIGRATION_ID = 'threadnote-storage-layout-v2';
const STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION = 1 as const;
const MIGRATION_RECEIPT_RELATIVE_PATH = `migration/${STORAGE_LAYOUT_MIGRATION_ID}.json`;
const LAYOUT_RECEIPT_RELATIVE_PATH = 'layout.json';

interface AccountMigration {
  readonly name: string;
  readonly treeSha256: string;
}

interface StorageLayoutMigrationReceipt {
  readonly accounts: readonly AccountMigration[];
  readonly id: typeof STORAGE_LAYOUT_MIGRATION_ID;
  readonly sourceLayoutVersion: typeof LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION;
  readonly status: 'completed' | 'pending';
  readonly targetLayoutVersion: typeof THREADNOTE_STORAGE_LAYOUT_VERSION;
  readonly version: typeof STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION;
}

export interface StorageLayoutMigrationResult {
  readonly accounts: number;
  readonly action: 'already_current' | 'dry_run' | 'migrated' | 'no_legacy_layout' | 'resumed';
}

export class StorageLayoutMigrationConflict extends Schema.TaggedErrorClass<StorageLayoutMigrationConflict>()(
  'StorageLayoutMigrationConflict',
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export interface StorageLayoutMigrationOptions {
  readonly apply?: boolean;
  readonly home: string;
}

/**
 * Flattens the short-lived 4.0.0-beta.1 data/viking/<account> layout into
 * data/<account>. A pending receipt makes every account move/merge resumable,
 * and the expected merged tree is verified before the legacy directory is
 * removed.
 */
export const migrateThreadnoteStorageLayout = Effect.fn('storageLayoutMigration.migrate')(function* (
  options: StorageLayoutMigrationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.resolve(options.home);
  const currentLayoutVersion = yield* readLayoutVersion(fs, path.join(home, LAYOUT_RECEIPT_RELATIVE_PATH));
  if (currentLayoutVersion === THREADNOTE_STORAGE_LAYOUT_VERSION) {
    return {accounts: 0, action: 'already_current'} satisfies StorageLayoutMigrationResult;
  }

  const dataRoot = path.join(home, 'data');
  const legacyRoot = path.join(dataRoot, LEGACY_THREADNOTE_DATA_DIRECTORY);
  const receiptPath = path.join(home, MIGRATION_RECEIPT_RELATIVE_PATH);
  const existingReceipt = yield* readMigrationReceipt(fs, receiptPath);
  if (!(yield* fs.exists(legacyRoot)) && !existingReceipt) {
    return {accounts: 0, action: 'no_legacy_layout'} satisfies StorageLayoutMigrationResult;
  }

  const receipt = existingReceipt ?? (yield* planMigration(fs, path, dataRoot, legacyRoot));
  if (receipt.status === 'completed') {
    if (options.apply === true && currentLayoutVersion !== THREADNOTE_STORAGE_LAYOUT_VERSION) {
      yield* writeCurrentLayoutReceipt(fs, path, home);
    }
    return {accounts: receipt.accounts.length, action: 'already_current'} satisfies StorageLayoutMigrationResult;
  }
  if (options.apply !== true) {
    return {accounts: receipt.accounts.length, action: 'dry_run'} satisfies StorageLayoutMigrationResult;
  }

  if (!existingReceipt) {
    yield* writeMigrationReceipt(fs, path, receiptPath, receipt);
  }
  let resumed = false;
  for (const account of receipt.accounts) {
    const source = path.join(legacyRoot, account.name);
    const target = path.join(dataRoot, account.name);
    const sourceExists = yield* fs.exists(source);
    const targetExists = yield* fs.exists(target);
    if (sourceExists && targetExists) {
      yield* mergeDirectories(fs, path, source, target);
    } else if (sourceExists) {
      yield* fs.rename(source, target);
    } else if (targetExists) {
      resumed = true;
    } else {
      return yield* new StorageLayoutMigrationConflict({
        message: `Account "${account.name}" disappeared during the storage layout migration.`,
        path: source,
      });
    }
    const actualDigest = yield* digestDirectory(fs, path, target);
    if (actualDigest !== account.treeSha256) {
      return yield* new StorageLayoutMigrationConflict({
        message: `Canonical account "${account.name}" does not match the validated merged tree.`,
        path: target,
      });
    }
  }

  if (yield* fs.exists(legacyRoot)) {
    const remaining = yield* fs.readDirectory(legacyRoot);
    if (remaining.length > 0) {
      return yield* new StorageLayoutMigrationConflict({
        message: 'Unexpected entries remain in the legacy canonical-store directory.',
        path: legacyRoot,
      });
    }
    yield* fs.remove(legacyRoot, {recursive: true});
  }
  yield* writeCurrentLayoutReceipt(fs, path, home);
  yield* writeMigrationReceipt(fs, path, receiptPath, {...receipt, status: 'completed'});
  return {
    accounts: receipt.accounts.length,
    action: resumed ? 'resumed' : 'migrated',
  } satisfies StorageLayoutMigrationResult;
});

function planMigration(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dataRoot: string,
  legacyRoot: string,
): Effect.Effect<StorageLayoutMigrationReceipt, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(legacyRoot))) {
      return yield* new StorageLayoutMigrationConflict({
        message: 'The pending storage migration has no legacy source directory.',
        path: legacyRoot,
      });
    }
    const names = (yield* fs.readDirectory(legacyRoot)).sort();
    const accounts: AccountMigration[] = [];
    for (const name of names) {
      validatePortableSegment(name, name);
      const source = path.join(legacyRoot, name);
      const target = path.join(dataRoot, name);
      if (Option.isSome(yield* fs.readLink(source).pipe(Effect.option))) {
        return yield* new StorageLayoutMigrationConflict({
          message: 'Symbolic links are not allowed as Threadnote account roots.',
          path: source,
        });
      }
      const info = yield* fs.stat(source);
      if (info.type !== 'Directory') {
        return yield* new StorageLayoutMigrationConflict({
          message: 'Every entry in the legacy canonical store must be an account directory.',
          path: source,
        });
      }
      accounts.push({
        name,
        treeSha256: (yield* fs.exists(target))
          ? yield* digestMergedDirectories(fs, path, source, target)
          : yield* digestDirectory(fs, path, source),
      });
    }
    return {
      accounts,
      id: STORAGE_LAYOUT_MIGRATION_ID,
      sourceLayoutVersion: LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION,
      status: 'pending',
      targetLayoutVersion: THREADNOTE_STORAGE_LAYOUT_VERSION,
      version: STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION,
    };
  });
}

function digestDirectory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<string, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    const entries: string[] = [];
    const visit = (directory: string, relativeDirectory: string): Effect.Effect<void, unknown, Crypto.Crypto> =>
      Effect.gen(function* () {
        for (const name of (yield* fs.readDirectory(directory)).sort()) {
          const absolute = path.join(directory, name);
          const relative = path.join(relativeDirectory, name).split(path.sep).join('/');
          if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
            return yield* new StorageLayoutMigrationConflict({
              message: 'Symbolic links are not allowed in the canonical Threadnote store.',
              path: absolute,
            });
          }
          const info = yield* fs.stat(absolute);
          if (info.type === 'Directory') {
            entries.push(`directory\0${relative}\n`);
            yield* visit(absolute, relative);
          } else if (info.type === 'File') {
            entries.push(
              `file\0${relative}\0${Number(info.size)}\0${yield* sha256FileHex(absolute).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              )}\n`,
            );
          } else {
            return yield* new StorageLayoutMigrationConflict({
              message: `Unsupported canonical-store entry type: ${info.type}.`,
              path: absolute,
            });
          }
        }
      });
    yield* visit(root, '');
    return yield* sha256Hex(entries.join(''));
  });
}

function digestMergedDirectories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
): Effect.Effect<string, unknown, Crypto.Crypto> {
  return Effect.gen(function* () {
    if (
      Option.isSome(yield* fs.readLink(targetRoot).pipe(Effect.option)) ||
      (yield* fs.stat(targetRoot)).type !== 'Directory'
    ) {
      return yield* new StorageLayoutMigrationConflict({
        message: 'The canonical account destination must be a regular directory.',
        path: targetRoot,
      });
    }
    const entries: string[] = [];
    const visit = (
      sourceDirectory: string | undefined,
      targetDirectory: string | undefined,
      relativeDirectory: string,
    ): Effect.Effect<void, unknown, Crypto.Crypto> =>
      Effect.gen(function* () {
        const names = new Set<string>();
        if (sourceDirectory) {
          for (const name of yield* fs.readDirectory(sourceDirectory)) names.add(name);
        }
        if (targetDirectory) {
          for (const name of yield* fs.readDirectory(targetDirectory)) names.add(name);
        }
        for (const name of [...names].sort()) {
          const source = sourceDirectory ? path.join(sourceDirectory, name) : undefined;
          const target = targetDirectory ? path.join(targetDirectory, name) : undefined;
          const sourceExists = source !== undefined && (yield* fs.exists(source));
          const targetExists = target !== undefined && (yield* fs.exists(target));
          const sourcePath = sourceExists ? source : undefined;
          const targetPath = targetExists ? target : undefined;
          const relative = path.join(relativeDirectory, name).split(path.sep).join('/');
          for (const absolute of [sourcePath, targetPath]) {
            if (absolute && Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
              return yield* new StorageLayoutMigrationConflict({
                message: 'Symbolic links are not allowed in the canonical Threadnote store.',
                path: absolute,
              });
            }
          }
          const sourceInfo = sourcePath ? yield* fs.stat(sourcePath) : undefined;
          const targetInfo = targetPath ? yield* fs.stat(targetPath) : undefined;
          if (sourceInfo && targetInfo && sourceInfo.type !== targetInfo.type) {
            return yield* new StorageLayoutMigrationConflict({
              message: `Legacy and canonical entries have different types at "${relative}".`,
              path: targetPath!,
            });
          }
          const info = sourceInfo ?? targetInfo;
          if (info?.type === 'Directory') {
            entries.push(`directory\0${relative}\n`);
            yield* visit(sourcePath, targetPath, relative);
          } else if (info?.type === 'File') {
            const selected = sourcePath ?? targetPath!;
            const size = Number(info.size);
            const digest = yield* sha256FileHex(selected).pipe(Effect.provideService(FileSystem.FileSystem, fs));
            if (sourcePath && targetPath) {
              const targetSize = Number(targetInfo!.size);
              const targetDigest = yield* sha256FileHex(targetPath).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              );
              if (size !== targetSize || digest !== targetDigest) {
                return yield* new StorageLayoutMigrationConflict({
                  message: `Legacy and canonical files differ at "${relative}".`,
                  path: targetPath,
                });
              }
            }
            entries.push(`file\0${relative}\0${size}\0${digest}\n`);
          } else {
            return yield* new StorageLayoutMigrationConflict({
              message: `Unsupported canonical-store entry type: ${info?.type ?? 'missing'}.`,
              path: sourcePath ?? targetPath ?? targetRoot,
            });
          }
        }
      });
    yield* visit(sourceRoot, targetRoot, '');
    return yield* sha256Hex(entries.join(''));
  });
}

function mergeDirectories(fs: FileSystem.FileSystem, path: Path.Path, sourceRoot: string, targetRoot: string) {
  const visit = (sourceDirectory: string, targetDirectory: string): Effect.Effect<void, unknown, Crypto.Crypto> =>
    Effect.gen(function* () {
      for (const name of (yield* fs.readDirectory(sourceDirectory)).sort()) {
        const source = path.join(sourceDirectory, name);
        const target = path.join(targetDirectory, name);
        if (Option.isSome(yield* fs.readLink(source).pipe(Effect.option))) {
          return yield* new StorageLayoutMigrationConflict({
            message: 'Symbolic links are not allowed in the canonical Threadnote store.',
            path: source,
          });
        }
        if (!(yield* fs.exists(target))) {
          yield* fs.rename(source, target);
          continue;
        }
        if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
          return yield* new StorageLayoutMigrationConflict({
            message: 'Symbolic links are not allowed in the canonical Threadnote store.',
            path: target,
          });
        }
        const sourceInfo = yield* fs.stat(source);
        const targetInfo = yield* fs.stat(target);
        if (sourceInfo.type === 'Directory' && targetInfo.type === 'Directory') {
          yield* visit(source, target);
          continue;
        }
        if (sourceInfo.type === 'File' && targetInfo.type === 'File') {
          const sourceDigest = yield* sha256FileHex(source).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          const targetDigest = yield* sha256FileHex(target).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          if (Number(sourceInfo.size) === Number(targetInfo.size) && sourceDigest === targetDigest) {
            yield* fs.remove(source);
            continue;
          }
        }
        return yield* new StorageLayoutMigrationConflict({
          message: `Cannot safely merge different entries at "${target}".`,
          path: target,
        });
      }
      if ((yield* fs.readDirectory(sourceDirectory)).length > 0) {
        return yield* new StorageLayoutMigrationConflict({
          message: 'The legacy account directory still contains unmerged entries.',
          path: sourceDirectory,
        });
      }
      yield* fs.remove(sourceDirectory, {recursive: true});
    });
  return visit(sourceRoot, targetRoot);
}

function readLayoutVersion(fs: FileSystem.FileSystem, receiptPath: string): Effect.Effect<number | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => {
      const parsed = JSON.parse(content) as {readonly version?: unknown};
      return typeof parsed.version === 'number' ? parsed.version : undefined;
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function readMigrationReceipt(
  fs: FileSystem.FileSystem,
  receiptPath: string,
): Effect.Effect<StorageLayoutMigrationReceipt | undefined, unknown> {
  return fs.readFileString(receiptPath).pipe(
    Effect.map(content => {
      const parsed = JSON.parse(content) as Partial<StorageLayoutMigrationReceipt>;
      if (
        parsed.id !== STORAGE_LAYOUT_MIGRATION_ID ||
        parsed.version !== STORAGE_LAYOUT_MIGRATION_RECEIPT_VERSION ||
        parsed.sourceLayoutVersion !== LEGACY_THREADNOTE_STORAGE_LAYOUT_VERSION ||
        parsed.targetLayoutVersion !== THREADNOTE_STORAGE_LAYOUT_VERSION ||
        (parsed.status !== 'pending' && parsed.status !== 'completed') ||
        !Array.isArray(parsed.accounts)
      ) {
        throw new Error('Invalid Threadnote storage layout migration receipt.');
      }
      for (const account of parsed.accounts) {
        validatePortableSegment(account.name, account.name);
        if (!/^[a-f0-9]{64}$/.test(account.treeSha256)) {
          throw new Error('Invalid account digest in storage layout migration receipt.');
        }
      }
      return parsed as StorageLayoutMigrationReceipt;
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

function writeMigrationReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  receiptPath: string,
  receipt: StorageLayoutMigrationReceipt,
) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true, mode: 0o700});
    const temporary = `${receiptPath}.${system.processId}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(receipt, undefined, 2)}\n`, {mode: 0o600});
    yield* fs.rename(temporary, receiptPath);
  });
}

function writeCurrentLayoutReceipt(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const target = path.join(home, LAYOUT_RECEIPT_RELATIVE_PATH);
    const temporary = `${target}.${STORAGE_LAYOUT_MIGRATION_ID}.tmp`;
    yield* fs.writeFileString(
      temporary,
      `${JSON.stringify({createdBy: 'threadnote', version: THREADNOTE_STORAGE_LAYOUT_VERSION}, undefined, 2)}\n`,
      {mode: 0o600},
    );
    yield* fs.rename(temporary, target);
  });
}
