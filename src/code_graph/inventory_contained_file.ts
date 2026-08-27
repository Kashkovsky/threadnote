import {Effect, FileSystem, Option, Path} from 'effect';
import {SystemInfo} from '../effect/system.js';
import {createCodeGraphCommittedFileContentHasher} from './content_identity.js';
import {decodeUtf8} from './inventory_content.js';
import {CodeGraphInventoryError} from './inventory_error.js';
import type {RepositoryIdentity} from './types.js';

export const readOptionalText = Effect.fn('codeGraph.readOptionalText')(function* (
  fs: FileSystem.FileSystem,
  target: string,
) {
  const opened = yield* readStableRegularFile(fs, target).pipe(Effect.option);
  return opened._tag === 'Some' ? (decodeUtf8(opened.value.bytes) ?? '') : '';
});

interface StableRegularFile {
  readonly bytes: Uint8Array;
  readonly identity: FileSystem.File.Info;
  readonly openedPath: Option.Option<string>;
}

export interface ContainedReadInterlock {
  readonly afterOpen?: Effect.Effect<void>;
  readonly beforeOpen?: Effect.Effect<void>;
}

function readStableRegularFile(
  fs: FileSystem.FileSystem,
  target: string,
  interlock?: ContainedReadInterlock,
): Effect.Effect<StableRegularFile, Error, SystemInfo> {
  return Effect.gen(function* () {
    const linkTarget = yield* fs.readLink(target).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(linkTarget)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Refusing to read a symbolic repository file: ${target}`));
    }
    const pathInfoBefore = yield* fs.stat(target);
    if (pathInfoBefore.type !== 'File') {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Refusing to read a non-regular repository file: ${target}`),
      );
    }
    yield* interlock?.beforeOpen ?? Effect.void;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        yield* interlock?.afterOpen ?? Effect.void;
        const openedInfoBefore = yield* file.stat;
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        if (!sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore)) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file changed while it was opened: ${target}`),
          );
        }
        const byteLength = Number(openedInfoBefore.size);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file size cannot be represented safely: ${target}`),
          );
        }
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = Number(yield* file.read(bytes.subarray(offset)));
          if (read <= 0) {
            return yield* Effect.fail(
              new CodeGraphInventoryError(`Repository file ended while it was being read: ${target}`),
            );
          }
          offset += read;
        }
        const openedInfoAfter = yield* file.stat;
        const linkTargetAfter = yield* fs.readLink(target).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        if (Option.isSome(linkTargetAfter)) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file became a symbolic link while reading: ${target}`),
          );
        }
        const pathInfoAfter = yield* fs.stat(target);
        if (
          !sameRegularFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          openedInfoBefore.size !== openedInfoAfter.size
        ) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file changed while it was being read: ${target}`),
          );
        }
        return {bytes, identity: openedInfoAfter, openedPath};
      }),
    );
  }).pipe(
    Effect.mapError(cause => new CodeGraphInventoryError(`Could not safely read repository file ${target}.`, {cause})),
  );
}

export function readContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  interlock?: ContainedReadInterlock,
): Effect.Effect<Uint8Array, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...relative.split('/'));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Repository file resolves outside its root: ${relative}`));
    }
    const opened = yield* readStableRegularFile(fs, target, interlock);
    if (Option.isSome(opened.openedPath) && !isContainedPath(path, repositoryRoot, opened.openedPath.value)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Opened repository file is outside its root: ${relative}`));
    }
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    const finalInfo = yield* fs.stat(target);
    if (!isContainedPath(path, repositoryRoot, canonicalAfter)) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Repository file escaped its root while reading: ${relative}`),
      );
    }
    if (!sameRegularFile(opened.identity, finalInfo, opened.identity)) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Repository path no longer identifies the opened file: ${relative}`),
      );
    }
    return opened.bytes;
  }).pipe(
    Effect.mapError(
      cause => new CodeGraphInventoryError(`Could not safely read repository path ${relative}.`, {cause}),
    ),
  );
}

interface StableContainedMaterialization {
  readonly bytes?: Uint8Array;
  readonly codeGraphContentHash?: string;
  readonly contentHash: string;
  readonly size: number;
}

export interface StableContainedRegularFileMetadata {
  readonly size: number;
}

/**
 * Inspect only stable, contained path metadata. Admission depends on path and
 * size, so excluded dirty files never need to be opened, read, or hashed.
 */
export function inspectContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
): Effect.Effect<StableContainedRegularFileMetadata, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...relative.split('/'));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Repository file resolves outside its root: ${relative}`));
    }
    const linkBefore = yield* fs.readLink(target).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(linkBefore)) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Refusing to inspect a symbolic repository file: ${relative}`),
      );
    }
    const infoBefore = yield* fs.stat(target);
    const size = Number(infoBefore.size);
    if (infoBefore.type !== 'File' || !Number.isSafeInteger(size) || size < 0) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Repository file metadata is not safely representable: ${relative}`),
      );
    }
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    const linkAfter = yield* fs.readLink(target).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    const infoAfter = yield* fs.stat(target);
    if (
      Option.isSome(linkAfter) ||
      !isContainedPath(path, repositoryRoot, canonicalAfter) ||
      !sameRegularFile(infoBefore, infoAfter, infoBefore) ||
      infoBefore.size !== infoAfter.size
    ) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Repository file changed while its metadata was inspected: ${relative}`),
      );
    }
    return {size};
  }).pipe(
    Effect.mapError(
      cause => new CodeGraphInventoryError(`Could not safely inspect repository path ${relative}.`, {cause}),
    ),
  );
}

/**
 * Safely materialize a worktree file, or hash it through a fixed-size buffer when
 * policy says its content should remain metadata-only. This keeps dirty large
 * corpus artifacts from allocating their full size while preserving an exact
 * content fingerprint and the same symlink/race interlocks as ordinary reads.
 */
export function materializeContainedStableRegularFile(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
  omitContent: (size: number) => boolean,
  expectedSize?: number,
  objectFormat?: RepositoryIdentity['objectFormat'],
): Effect.Effect<StableContainedMaterialization, Error, SystemInfo> {
  const target = path.join(repositoryRoot, ...relative.split('/'));
  return Effect.gen(function* () {
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalBefore = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalBefore)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Repository file resolves outside its root: ${relative}`));
    }
    const linkTarget = yield* fs.readLink(target).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(linkTarget)) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Refusing to read a symbolic repository file: ${relative}`),
      );
    }
    const pathInfoBefore = yield* fs.stat(target);
    if (pathInfoBefore.type !== 'File') {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Refusing to read a non-regular repository file: ${relative}`),
      );
    }
    const materialized = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(target, {flag: 'r'});
        const openedInfoBefore = yield* file.stat;
        const openedPath = yield* openedFilePath(fs, file);
        const pathInfoOpened = yield* fs.stat(target);
        if (!sameRegularFile(pathInfoBefore, pathInfoOpened, openedInfoBefore)) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file changed while it was opened: ${relative}`),
          );
        }
        if (Option.isSome(openedPath) && !isContainedPath(path, repositoryRoot, openedPath.value)) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Opened repository file is outside its root: ${relative}`),
          );
        }
        const size = Number(openedInfoBefore.size);
        if (!Number.isSafeInteger(size) || size < 0) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file size cannot be represented safely: ${relative}`),
          );
        }
        if (expectedSize !== undefined && size !== expectedSize) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file size changed before it was read: ${relative}`),
          );
        }
        const hasher = new Bun.CryptoHasher('sha256');
        const codeGraphHasher =
          objectFormat === undefined ? undefined : createCodeGraphCommittedFileContentHasher(objectFormat, size);
        const bytes = omitContent(size) ? undefined : new Uint8Array(size);
        const buffer = bytes ?? new Uint8Array(Math.min(1_048_576, Math.max(1, size)));
        let offset = 0;
        while (offset < size) {
          const view = bytes ? bytes.subarray(offset) : buffer.subarray(0, Math.min(buffer.byteLength, size - offset));
          const read = Number(yield* file.read(view));
          if (read <= 0) {
            return yield* Effect.fail(
              new CodeGraphInventoryError(`Repository file ended while it was being read: ${relative}`),
            );
          }
          hasher.update(view.subarray(0, read));
          codeGraphHasher?.update(view.subarray(0, read));
          offset += read;
        }
        const openedInfoAfter = yield* file.stat;
        const linkTargetAfter = yield* fs.readLink(target).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        const pathInfoAfter = yield* fs.stat(target);
        if (
          Option.isSome(linkTargetAfter) ||
          !sameRegularFile(pathInfoBefore, pathInfoAfter, openedInfoAfter) ||
          openedInfoBefore.size !== openedInfoAfter.size
        ) {
          return yield* Effect.fail(
            new CodeGraphInventoryError(`Repository file changed while it was being read: ${relative}`),
          );
        }
        return {
          bytes,
          ...(codeGraphHasher === undefined ? {} : {codeGraphContentHash: codeGraphHasher.digest()}),
          contentHash: hasher.digest('hex'),
          size,
        } satisfies StableContainedMaterialization;
      }),
    );
    yield* validateRepositoryAncestors(fs, path, repositoryRoot, relative);
    const canonicalAfter = yield* fs.realPath(target);
    if (!isContainedPath(path, repositoryRoot, canonicalAfter)) {
      return yield* Effect.fail(
        new CodeGraphInventoryError(`Repository file escaped its root while reading: ${relative}`),
      );
    }
    return materialized;
  }).pipe(
    Effect.mapError(
      cause => new CodeGraphInventoryError(`Could not safely materialize repository path ${relative}.`, {cause}),
    ),
  );
}

const validateRepositoryAncestors = Effect.fn('codeGraph.validateRepositoryAncestors')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repositoryRoot: string,
  relative: string,
) {
  let current = repositoryRoot;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    const link = yield* fs.readLink(current).pipe(
      Effect.map(Option.some),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
    if (Option.isSome(link)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Repository path has a symbolic ancestor: ${relative}`));
    }
    const canonical = yield* fs.realPath(current);
    const info = yield* fs.stat(current);
    if (info.type !== 'Directory' || !isContainedPath(path, repositoryRoot, canonical)) {
      return yield* Effect.fail(new CodeGraphInventoryError(`Repository path has an unsafe ancestor: ${relative}`));
    }
  }
});

function isContainedPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameRegularFile(
  before: FileSystem.File.Info,
  current: FileSystem.File.Info,
  opened: FileSystem.File.Info,
): boolean {
  const beforeInode = Option.getOrUndefined(before.ino);
  const currentInode = Option.getOrUndefined(current.ino);
  const openedInode = Option.getOrUndefined(opened.ino);
  return (
    before.type === 'File' &&
    current.type === 'File' &&
    opened.type === 'File' &&
    before.dev === current.dev &&
    current.dev === opened.dev &&
    beforeInode !== undefined &&
    currentInode !== undefined &&
    openedInode !== undefined &&
    beforeInode === currentInode &&
    currentInode === openedInode
  );
}

function openedFilePath(
  fs: FileSystem.FileSystem,
  file: FileSystem.File,
): Effect.Effect<Option.Option<string>, never, SystemInfo> {
  const descriptor = (file as FileSystem.File & {readonly fd?: unknown}).fd;
  if (typeof descriptor !== 'number' || !Number.isSafeInteger(descriptor) || descriptor < 0) {
    return Effect.succeed(Option.none());
  }
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const descriptorPath =
      system.platform === 'linux'
        ? `/proc/self/fd/${descriptor}`
        : system.platform === 'darwin'
          ? `/dev/fd/${descriptor}`
          : undefined;
    if (!descriptorPath) return Option.none<string>();
    const resolved = yield* fs.realPath(descriptorPath).pipe(Effect.option);
    return Option.isSome(resolved) && resolved.value !== descriptorPath
      ? Option.some(resolved.value)
      : Option.none<string>();
  });
}
