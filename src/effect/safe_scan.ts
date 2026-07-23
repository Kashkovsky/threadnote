import {Effect, FileSystem, Option, Path} from 'effect';

export interface SafeScannedFile {
  readonly modifiedAt?: Date;
  readonly path: string;
  readonly size: number;
}

export interface SafeFileScanOptions {
  readonly includeDirectory?: (path: string) => boolean;
  readonly includeFile: (path: string, name: string) => boolean;
  readonly recursive?: boolean;
}

const SAFE_SCAN_ENTRY_CONCURRENCY = 64;

/**
 * Walks only real files and directories whose canonical path matches their
 * logical location beneath `boundaryRoot`. This rejects symlink aliases and
 * escapes while the visited set provides a second guard against directory
 * cycles.
 */
export const scanFilesWithinBoundary = Effect.fn('filesystem.scanFilesWithinBoundary')(function* (
  fs: FileSystem.FileSystem,
  scanRoot: string,
  boundaryRoot: string,
  options: SafeFileScanOptions,
) {
  const pathService = yield* Path.Path;
  const roots = yield* resolveScanRoots(fs, scanRoot, boundaryRoot);
  if (!roots) {
    return [];
  }
  const visitedRealDirectories = new Set<string>();
  const visit = (logicalDirectory: string): Effect.Effect<readonly SafeScannedFile[], never> =>
    Effect.gen(function* () {
      const inspectedDirectory = yield* inspectMappedPath(fs, logicalDirectory, roots);
      if (
        !inspectedDirectory ||
        inspectedDirectory.type !== 'Directory' ||
        visitedRealDirectories.has(inspectedDirectory.realPath)
      ) {
        return [];
      }
      visitedRealDirectories.add(inspectedDirectory.realPath);
      const files: SafeScannedFile[] = [];
      const names = yield* fs.readDirectory(logicalDirectory).pipe(Effect.catch(() => Effect.succeed([])));
      const entries = yield* Effect.forEach(
        [...names].sort(),
        name => {
          const path = pathService.join(logicalDirectory, name);
          return inspectMappedPath(fs, path, roots).pipe(Effect.map(inspected => ({inspected, name, path})));
        },
        {concurrency: SAFE_SCAN_ENTRY_CONCURRENCY},
      );
      for (const {inspected, name, path} of entries) {
        if (!inspected) {
          continue;
        }
        if (
          inspected.type === 'Directory' &&
          options.recursive !== false &&
          (options.includeDirectory?.(path) ?? true)
        ) {
          files.push(...(yield* visit(path)));
        } else if (inspected.type === 'File' && options.includeFile(path, name)) {
          files.push({
            modifiedAt: inspected.modifiedAt,
            path,
            size: inspected.size,
          });
        }
      }
      return files;
    });
  return yield* visit(scanRoot);
});

export const safeChildDirectoryNames = Effect.fn('filesystem.safeChildDirectoryNames')(function* (
  fs: FileSystem.FileSystem,
  root: string,
  boundaryRoot: string,
) {
  const pathService = yield* Path.Path;
  const roots = yield* resolveScanRoots(fs, root, boundaryRoot);
  if (!roots) {
    return [];
  }
  const names = yield* fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([])));
  const entries = yield* Effect.forEach(
    [...names].sort(),
    name =>
      inspectMappedPath(fs, pathService.join(root, name), roots).pipe(Effect.map(inspected => ({inspected, name}))),
    {concurrency: SAFE_SCAN_ENTRY_CONCURRENCY},
  );
  return entries.filter(entry => entry.inspected?.type === 'Directory').map(entry => entry.name);
});

interface ScanRoots {
  readonly boundaryRoot: string;
  readonly pathService: Path.Path;
  readonly realBoundaryRoot: string;
}

interface InspectedMappedPath {
  readonly modifiedAt?: Date;
  readonly realPath: string;
  readonly size: number;
  readonly type: 'Directory' | 'File' | 'Other';
}

function resolveScanRoots(
  fs: FileSystem.FileSystem,
  scanRoot: string,
  boundaryRoot: string,
): Effect.Effect<ScanRoots | undefined, never, Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const realBoundaryRoot = yield* fs.realPath(boundaryRoot);
    const roots = {boundaryRoot: pathService.resolve(boundaryRoot), pathService, realBoundaryRoot};
    const inspectedRoot = yield* inspectMappedPath(fs, scanRoot, roots);
    return inspectedRoot?.type === 'Directory' ? roots : undefined;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function inspectMappedPath(
  fs: FileSystem.FileSystem,
  path: string,
  roots: ScanRoots,
): Effect.Effect<InspectedMappedPath | undefined, never> {
  return Effect.gen(function* () {
    const relativePath = roots.pathService.relative(roots.boundaryRoot, roots.pathService.resolve(path));
    if (pathEscapesBoundary(relativePath, roots.pathService)) {
      return undefined;
    }
    const expectedRealPath = roots.pathService.resolve(roots.realBoundaryRoot, relativePath);
    const realPath = yield* fs.realPath(path);
    if (realPath !== expectedRealPath) {
      return undefined;
    }
    const info = yield* fs.stat(path);
    const type: InspectedMappedPath['type'] =
      info.type === 'Directory' ? 'Directory' : info.type === 'File' ? 'File' : 'Other';
    return {
      modifiedAt: Option.getOrUndefined(info.mtime),
      realPath,
      size: Number(info.size),
      type,
    };
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function pathEscapesBoundary(relativePath: string, pathService: Path.Path): boolean {
  return (
    relativePath === '..' || relativePath.startsWith(`..${pathService.sep}`) || pathService.isAbsolute(relativePath)
  );
}
