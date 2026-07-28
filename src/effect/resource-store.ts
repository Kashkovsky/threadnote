import {Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {uriSegment} from '../manifest.js';
import {globToRegExp} from '../utils.js';
import {withExclusiveFileLock} from './file_lock.js';
import {SystemInfo} from './system.js';
import {
  canonicalResourceUri,
  InvalidResourceId,
  parseResourceId,
  resourceIdWithoutAnchor,
  type ResourceId,
  validatePortableSegment,
} from '../storage/resource-id.js';
import {threadnoteStorageLayout} from '../storage/layout.js';
import {expireRecallIndexValidation} from '../recall/index.js';
import {sha256Hex} from './digest.js';

export interface ResourceStoreLocation {
  readonly account: string;
  readonly home: string;
  readonly user: string;
}

export interface ResourceMutationLockEvent {
  readonly account: string;
  readonly lockPath: string;
  readonly uri: string;
}

export interface ResourceStoreLayerOptions {
  readonly onMutationLockAcquired?: (event: ResourceMutationLockEvent) => Effect.Effect<void, never>;
  readonly onMutationLockCompleted?: (event: ResourceMutationLockEvent) => Effect.Effect<void, never>;
  readonly onMutationLockContention?: (event: ResourceMutationLockEvent) => Effect.Effect<void, never>;
}

export interface ResourceStoreEntry {
  readonly modifiedAt?: string;
  readonly size: number;
  readonly type: 'directory' | 'file';
  readonly uri: string;
}

export interface ResourceStoreWriteOptions {
  readonly expectedFingerprint?: string;
  readonly mode: 'create' | 'replace' | 'upsert';
}

export type ResourceStoreMutation =
  | {
      readonly content: string;
      readonly options: ResourceStoreWriteOptions;
      readonly type: 'write';
      readonly uri: string;
    }
  | {
      readonly ignoreMissing?: boolean;
      readonly options?: {readonly recursive?: boolean};
      readonly type: 'remove';
      readonly uri: string;
    };

export interface ResourceStoreGrepMatch {
  readonly line: number;
  readonly text: string;
  readonly uri: string;
}

export interface ResourceStoreMultiGrepMatch extends ResourceStoreGrepMatch {
  readonly term: string;
}

export class ResourceAccessDenied extends Schema.TaggedErrorClass<ResourceAccessDenied>()('ResourceAccessDenied', {
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceAlreadyExists extends Schema.TaggedErrorClass<ResourceAlreadyExists>()('ResourceAlreadyExists', {
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceConflict extends Schema.TaggedErrorClass<ResourceConflict>()('ResourceConflict', {
  actualFingerprint: Schema.String,
  expectedFingerprint: Schema.String,
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceIoFailed extends Schema.TaggedErrorClass<ResourceIoFailed>()('ResourceIoFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
  uri: Schema.String,
}) {}

export class ResourceNotFound extends Schema.TaggedErrorClass<ResourceNotFound>()('ResourceNotFound', {
  message: Schema.String,
  uri: Schema.String,
}) {}

export class ResourcePathUnsafe extends Schema.TaggedErrorClass<ResourcePathUnsafe>()('ResourcePathUnsafe', {
  message: Schema.String,
  path: Schema.String,
  uri: Schema.String,
}) {}

export type ResourceStoreError =
  | InvalidResourceId
  | ResourceAccessDenied
  | ResourceAlreadyExists
  | ResourceConflict
  | ResourceIoFailed
  | ResourceNotFound
  | ResourcePathUnsafe;

export interface ResourceStoreShape {
  readonly fingerprint: (content: string | Uint8Array) => Effect.Effect<string, ResourceStoreError>;
  readonly glob: (
    location: ResourceStoreLocation,
    uri: string,
    pattern: string,
  ) => Effect.Effect<readonly ResourceStoreEntry[], ResourceStoreError>;
  readonly grep: (
    location: ResourceStoreLocation,
    uri: string,
    term: string,
    limit?: number,
  ) => Effect.Effect<readonly ResourceStoreGrepMatch[], ResourceStoreError>;
  readonly grepMany: (
    location: ResourceStoreLocation,
    uri: string,
    terms: readonly string[],
    limitPerTerm?: number,
  ) => Effect.Effect<readonly ResourceStoreMultiGrepMatch[], ResourceStoreError>;
  readonly list: (
    location: ResourceStoreLocation,
    uri: string,
    options?: {readonly recursive?: boolean},
  ) => Effect.Effect<readonly ResourceStoreEntry[], ResourceStoreError>;
  readonly makeDirectory: (location: ResourceStoreLocation, uri: string) => Effect.Effect<void, ResourceStoreError>;
  readonly mutate: (
    location: ResourceStoreLocation,
    mutations: readonly ResourceStoreMutation[],
  ) => Effect.Effect<void, ResourceStoreError>;
  readonly read: (location: ResourceStoreLocation, uri: string) => Effect.Effect<string, ResourceStoreError>;
  readonly remove: (
    location: ResourceStoreLocation,
    uri: string,
    options?: {readonly recursive?: boolean},
  ) => Effect.Effect<void, ResourceStoreError>;
  readonly stat: (
    location: ResourceStoreLocation,
    uri: string,
  ) => Effect.Effect<ResourceStoreEntry, ResourceStoreError>;
  readonly write: (
    location: ResourceStoreLocation,
    uri: string,
    content: string,
    options: ResourceStoreWriteOptions,
  ) => Effect.Effect<{readonly fingerprint: string; readonly uri: string}, ResourceStoreError>;
}

export class ResourceStore extends Context.Service<ResourceStore, ResourceStoreShape>()(
  'threadnote/effect/ResourceStore',
) {
  static layerWith(options: ResourceStoreLayerOptions = {}) {
    return Layer.effect(
      ResourceStore,
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const provideLockServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          ) as Effect.Effect<A, E, Exclude<R, Crypto.Crypto | Path.Path | SystemInfo>>;
        const operation = createResourceStoreOperations(fs, path, provideLockServices, options);
        return ResourceStore.of(operation);
      }),
    );
  }

  static readonly layer = ResourceStore.layerWith();
}

function createResourceStoreOperations(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  provideLockServices: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Crypto.Crypto | Path.Path | SystemInfo>>,
  layerOptions: ResourceStoreLayerOptions,
): ResourceStoreShape {
  const resolve = (location: ResourceStoreLocation, uri: string) =>
    resolveResourcePath(fs, path, location, uri).pipe(mapIoError('resolve', uri));
  const invalidateRecall = (location: ResourceStoreLocation) =>
    provideLockServices(
      Effect.all(
        [expireRecallIndexValidation(location.home, false), expireRecallIndexValidation(location.home, true)],
        {concurrency: 2},
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );
  const invalidateRecallBestEffort = (location: ResourceStoreLocation) =>
    invalidateRecall(location).pipe(Effect.catchCause(() => Effect.void));
  const withLock = <A, E, R>(
    location: ResourceStoreLocation,
    id: ResourceId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ResourceIoFailed, Exclude<R, Crypto.Crypto | Path.Path | SystemInfo>> => {
    const layout = threadnoteStorageLayout(path, location.home, location.account, uriSegment(location.user));
    const lockPath = path.join(layout.locksRoot, 'resources', location.account, 'mutations.lock');
    const event = {account: location.account, lockPath, uri: id.canonicalUri};
    const lockEffect = withExclusiveFileLock(
      fs,
      lockPath,
      {
        heartbeatIntervalMilliseconds: 10_000,
        ...(layerOptions.onMutationLockAcquired ? {onAcquired: () => layerOptions.onMutationLockAcquired!(event)} : {}),
        ...(layerOptions.onMutationLockCompleted
          ? {onCompleted: () => layerOptions.onMutationLockCompleted!(event)}
          : {}),
        ...(layerOptions.onMutationLockContention
          ? {onContention: () => layerOptions.onMutationLockContention!(event)}
          : {}),
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 30_000,
        waitTimeoutMilliseconds: 30_000,
      },
      effect,
    );
    return provideLockServices(lockEffect).pipe(
      Effect.mapError(error =>
        isResourceStoreError(error)
          ? error
          : new ResourceIoFailed({
              cause: error,
              message: `Resource lock failed for ${id.canonicalUri}.`,
              operation: 'lock',
              uri: id.canonicalUri,
            }),
      ),
    ) as Effect.Effect<A, E | ResourceIoFailed, Exclude<R, Crypto.Crypto | Path.Path | SystemInfo>>;
  };
  const removeResource = (location: ResourceStoreLocation, uri: string, options?: {readonly recursive?: boolean}) =>
    Effect.gen(function* () {
      const resolved = yield* resolve(location, uri);
      yield* withLock(
        location,
        resolved.id,
        Effect.gen(function* () {
          yield* verifyExistingPath(fs, path, resolved);
          yield* fs.remove(resolved.path, {recursive: options?.recursive === true});
          yield* syncDirectory(fs, path.dirname(resolved.path));
        }),
      );
    }).pipe(mapIoError('remove', uri));
  const writeResource = (
    location: ResourceStoreLocation,
    uri: string,
    content: string,
    options: ResourceStoreWriteOptions,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolve(location, uri);
      const fingerprint = yield* provideLockServices(sha256Hex(content));
      yield* withLock(
        location,
        resolved.id,
        Effect.gen(function* () {
          yield* makeSafeDirectoryChain(fs, path, {...resolved, path: path.dirname(resolved.path)});
          yield* assertCaseCompatible(fs, path.dirname(resolved.path), path.basename(resolved.path), resolved.id);
          const exists = yield* fs.exists(resolved.path);
          if (options.mode === 'create' && exists) {
            return yield* new ResourceAlreadyExists({
              message: `Resource already exists: ${resolved.id.canonicalUri}`,
              uri: resolved.id.canonicalUri,
            });
          }
          if (options.mode === 'replace' && !exists) {
            return yield* new ResourceNotFound({
              message: `Resource does not exist: ${resolved.id.canonicalUri}`,
              uri: resolved.id.canonicalUri,
            });
          }
          if (exists) {
            yield* verifyExistingPath(fs, path, resolved, 'File');
            if (options.expectedFingerprint) {
              const actualFingerprint = yield* provideLockServices(sha256Hex(yield* fs.readFile(resolved.path)));
              if (actualFingerprint !== options.expectedFingerprint) {
                return yield* new ResourceConflict({
                  actualFingerprint,
                  expectedFingerprint: options.expectedFingerprint,
                  message: `Resource changed before compare-and-replace: ${resolved.id.canonicalUri}`,
                  uri: resolved.id.canonicalUri,
                });
              }
            }
          } else if (options.expectedFingerprint) {
            return yield* new ResourceNotFound({
              message: `Resource does not exist for compare-and-replace: ${resolved.id.canonicalUri}`,
              uri: resolved.id.canonicalUri,
            });
          }
          yield* writeAtomically(fs, path, resolved, content, options.mode === 'create');
        }),
      );
      return {fingerprint, uri: resolved.id.canonicalUri};
    }).pipe(mapIoError('write', uri));
  const applyMutation = (location: ResourceStoreLocation, mutation: ResourceStoreMutation) => {
    if (mutation.type === 'write') {
      return writeResource(location, mutation.uri, mutation.content, mutation.options).pipe(Effect.asVoid);
    }
    const remove = removeResource(location, mutation.uri, mutation.options);
    return mutation.ignoreMissing === true
      ? remove.pipe(Effect.catchTag('ResourceNotFound', () => Effect.void))
      : remove;
  };
  return {
    fingerprint: content =>
      provideLockServices(sha256Hex(content)).pipe(mapIoError('fingerprint', 'threadnote://local/content')),
    glob: (location, uri, pattern) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        const matcher = globToRegExp(pattern.replaceAll('\\', '/'));
        const entries = yield* listEntries(fs, path, resolved, true);
        return entries.filter(entry => {
          const relative = entry.uri.slice(resolved.id.canonicalUri.replace(/#.*$/, '').length).replace(/^\/+/, '');
          return matcher.test(relative);
        });
      }).pipe(mapIoError('glob', uri)),
    grep: (location, uri, term, limit = 100) =>
      Effect.gen(function* () {
        if (!term) return [];
        const resolved = yield* resolve(location, uri);
        return (yield* grepManyInTree(fs, path, resolved, [term], limit)).map(({line, text, uri}) => ({
          line,
          text,
          uri,
        }));
      }).pipe(mapIoError('grep', uri)),
    grepMany: (location, uri, terms, limitPerTerm = 100) =>
      Effect.gen(function* () {
        const normalizedTerms = [...new Set(terms.map(term => term.trim()).filter(Boolean))];
        if (normalizedTerms.length === 0 || limitPerTerm <= 0) return [];
        const resolved = yield* resolve(location, uri);
        return yield* grepManyInTree(fs, path, resolved, normalizedTerms, limitPerTerm);
      }).pipe(mapIoError('grep', uri)),
    list: (location, uri, options) =>
      resolve(location, uri).pipe(
        Effect.flatMap(resolved => listEntries(fs, path, resolved, options?.recursive === true)),
        mapIoError('list', uri),
      ),
    makeDirectory: (location, uri) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        yield* withLock(
          location,
          resolved.id,
          Effect.gen(function* () {
            yield* makeSafeDirectoryChain(fs, path, resolved);
            yield* verifyExistingPath(fs, path, resolved, 'Directory');
          }),
        );
      }).pipe(mapIoError('mkdir', uri)),
    mutate: (location, mutations) =>
      mutations.length === 0
        ? Effect.void
        : Effect.forEach(mutations, mutation => applyMutation(location, mutation), {
            discard: true,
          }).pipe(Effect.ensuring(invalidateRecallBestEffort(location))),
    read: (location, uri) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        yield* verifyExistingPath(fs, path, resolved, 'File');
        return yield* fs.readFileString(resolved.path);
      }).pipe(mapIoError('read', uri)),
    remove: (location, uri, options) =>
      removeResource(location, uri, options).pipe(Effect.tap(() => invalidateRecallBestEffort(location))),
    stat: (location, uri) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(location, uri);
        const info = yield* verifyExistingPath(fs, path, resolved);
        return entryForInfo(resolved.id.canonicalUri, info);
      }).pipe(mapIoError('stat', uri)),
    write: (location, uri, content, options) =>
      writeResource(location, uri, content, options).pipe(Effect.tap(() => invalidateRecallBestEffort(location))),
  };
}

interface ResolvedResourcePath {
  readonly boundaryRoot: string;
  readonly id: ResourceId;
  readonly path: string;
}

function resolveResourcePath(fs: FileSystem.FileSystem, path: Path.Path, location: ResourceStoreLocation, uri: string) {
  return Effect.gen(function* () {
    const id = resourceIdWithoutAnchor(parseResourceId(uri));
    const userSegment = uriSegment(location.user);
    const layout = threadnoteStorageLayout(path, location.home, location.account, userSegment);
    let relativeSegments: readonly string[];
    if (id.namespace === 'resources') {
      relativeSegments = ['resources', ...id.segments];
    } else if (id.namespace === 'user') {
      if (id.segments[0] !== userSegment) {
        return yield* new ResourceAccessDenied({
          message: `Resource user scope does not match the configured Threadnote user.`,
          uri: id.canonicalUri,
        });
      }
      relativeSegments = ['user', ...id.segments];
    } else {
      return yield* new ResourceAccessDenied({
        message: `Unsupported Threadnote resource namespace: ${id.namespace}`,
        uri: id.canonicalUri,
      });
    }
    validatePortableSegment(location.account, location.account);
    const resolved = path.resolve(layout.accountRoot, ...relativeSegments);
    const relative = path.relative(layout.accountRoot, resolved);
    if (escapesBoundary(relative, path)) {
      return yield* new ResourcePathUnsafe({
        message: `Resolved resource path escapes the Threadnote account root.`,
        path: resolved,
        uri: id.canonicalUri,
      });
    }
    const realBoundaryRoot = yield* resolveOwnedAccountBoundary(fs, path, location, id.canonicalUri);
    return {boundaryRoot: realBoundaryRoot, id, path: path.resolve(realBoundaryRoot, relative)};
  });
}

function resolveOwnedAccountBoundary(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  location: ResourceStoreLocation,
  uri: string,
) {
  return Effect.gen(function* () {
    const logicalHome = path.resolve(location.home);
    yield* fs.makeDirectory(logicalHome, {recursive: true, mode: 0o700});
    const realHome = yield* fs.realPath(logicalHome);
    let logicalCurrent = logicalHome;
    let realCurrent = realHome;
    for (const segment of ['data', location.account]) {
      logicalCurrent = path.join(logicalCurrent, segment);
      if (Option.isSome(yield* fs.readLink(logicalCurrent).pipe(Effect.option))) {
        return yield* new ResourcePathUnsafe({
          message: 'Symbolic links are not allowed inside Threadnote-owned storage roots.',
          path: logicalCurrent,
          uri,
        });
      }
      if (!(yield* fs.exists(logicalCurrent))) {
        yield* fs.makeDirectory(logicalCurrent, {mode: 0o700});
      }
      const info = yield* fs.stat(logicalCurrent);
      if (info.type !== 'Directory') {
        return yield* new ResourcePathUnsafe({
          message: 'Threadnote-owned storage root component is not a directory.',
          path: logicalCurrent,
          uri,
        });
      }
      realCurrent = path.join(realCurrent, segment);
      const actual = yield* fs.realPath(logicalCurrent);
      if (actual !== realCurrent) {
        return yield* new ResourcePathUnsafe({
          message: 'Threadnote-owned storage root was redirected through a path alias.',
          path: logicalCurrent,
          uri,
        });
      }
    }
    return realCurrent;
  });
}

function makeSafeDirectoryChain(fs: FileSystem.FileSystem, path: Path.Path, resolved: ResolvedResourcePath) {
  return Effect.gen(function* () {
    const logicalBoundary = path.resolve(resolved.boundaryRoot);
    const relative = path.relative(logicalBoundary, path.resolve(resolved.path));
    if (escapesBoundary(relative, path)) {
      return yield* unsafe(resolved, 'Directory path escapes its boundary.');
    }
    let current = logicalBoundary;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      yield* assertCaseCompatible(fs, current, segment, resolved.id);
      current = path.join(current, segment);
      if (!(yield* fs.exists(current))) {
        yield* fs.makeDirectory(current, {mode: 0o700});
      }
      yield* verifyPathAtExpectedLocation(fs, path, resolved, current, 'Directory');
    }
  });
}

function verifyExistingPath(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  expectedType?: 'Directory' | 'File',
) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(resolved.path))) {
      return yield* new ResourceNotFound({
        message: `Resource does not exist: ${resolved.id.canonicalUri}`,
        uri: resolved.id.canonicalUri,
      });
    }
    return yield* verifyPathAtExpectedLocation(fs, path, resolved, resolved.path, expectedType);
  });
}

function verifyPathAtExpectedLocation(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  logicalPath: string,
  expectedType?: 'Directory' | 'File',
) {
  return Effect.gen(function* () {
    const relative = path.relative(path.resolve(resolved.boundaryRoot), path.resolve(logicalPath));
    if (escapesBoundary(relative, path)) return yield* unsafe(resolved, 'Path escapes its storage boundary.');
    const actual = yield* fs.realPath(logicalPath);
    const expected = path.resolve(resolved.boundaryRoot, relative);
    if (actual !== expected) return yield* unsafe(resolved, 'Symbolic links or path aliases are not allowed.');
    const info = yield* fs.stat(logicalPath);
    if (info.type === 'SymbolicLink') return yield* unsafe(resolved, 'Symbolic links are not allowed.');
    if (expectedType && info.type !== expectedType) {
      return yield* unsafe(resolved, `Expected a ${expectedType.toLowerCase()}, found ${info.type}.`);
    }
    return info;
  });
}

function assertCaseCompatible(fs: FileSystem.FileSystem, parent: string, desired: string, id: ResourceId) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(parent))) return;
    const desiredNfc = desired.normalize('NFC');
    const collision = (yield* fs.readDirectory(parent)).find(entry => {
      const entryNfc = entry.normalize('NFC');
      return entryNfc.toLocaleLowerCase() === desiredNfc.toLocaleLowerCase() && entryNfc !== desiredNfc;
    });
    if (collision) {
      return yield* new ResourcePathUnsafe({
        message: `Portable path collision between "${desired}" and existing "${collision}".`,
        path: pathForMessage(parent, desired),
        uri: id.canonicalUri,
      });
    }
  });
}

function listEntries(fs: FileSystem.FileSystem, path: Path.Path, resolved: ResolvedResourcePath, recursive: boolean) {
  return Effect.gen(function* () {
    const rootInfo = yield* verifyExistingPath(fs, path, resolved);
    if (rootInfo.type === 'File') return [entryForInfo(resolved.id.canonicalUri, rootInfo)];
    if (rootInfo.type !== 'Directory') return yield* unsafe(resolved, `Unsupported resource type ${rootInfo.type}.`);
    const entries: ResourceStoreEntry[] = [];
    const visit = (directory: string, segments: readonly string[]): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        for (const name of [...(yield* fs.readDirectory(directory))].sort()) {
          const childPath = path.join(directory, name);
          const childResolved = {...resolved, path: childPath};
          const info = yield* verifyPathAtExpectedLocation(fs, path, childResolved, childPath);
          if (info.type !== 'Directory' && info.type !== 'File') continue;
          const childSegments = [...segments, name.normalize('NFC')];
          const uri = canonicalResourceUri(resolved.id.namespace, [...resolved.id.segments, ...childSegments]);
          entries.push(entryForInfo(uri, info));
          if (recursive && info.type === 'Directory') yield* visit(childPath, childSegments);
        }
      });
    yield* visit(resolved.path, []);
    return entries;
  });
}

function grepManyInTree(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  terms: readonly string[],
  limitPerTerm: number,
) {
  return Effect.gen(function* () {
    const normalized = terms.map(term => ({lower: term.toLocaleLowerCase(), term}));
    const counts = new Map(normalized.map(({term}) => [term, 0]));
    const matches: ResourceStoreMultiGrepMatch[] = [];
    const entries = yield* listEntries(fs, path, resolved, true);
    for (const entry of entries) {
      if (entry.type !== 'file') continue;
      const entryId = resourceIdWithoutAnchor(parseResourceId(entry.uri));
      const relativeSegments = entryId.segments.slice(resolved.id.segments.length);
      const fileResolved = {...resolved, id: entryId, path: path.join(resolved.path, ...relativeSegments)};
      yield* verifyExistingPath(fs, path, fileResolved, 'File');
      const content = yield* fs.readFileString(fileResolved.path);
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const lowerLine = line.toLocaleLowerCase();
        for (const {lower, term} of normalized) {
          if ((counts.get(term) ?? 0) >= limitPerTerm || !lowerLine.includes(lower)) continue;
          matches.push({line: index + 1, term, text: line, uri: entry.uri});
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
      if (normalized.every(({term}) => (counts.get(term) ?? 0) >= limitPerTerm)) break;
    }
    return matches;
  });
}

function entryForInfo(uri: string, info: FileSystem.File.Info): ResourceStoreEntry {
  return {
    ...(Option.isSome(info.mtime) ? {modifiedAt: info.mtime.value.toISOString()} : {}),
    size: Number(info.size),
    type: info.type === 'Directory' ? 'directory' : 'file',
    uri,
  };
}

function writeAtomically(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
  content: string,
  createOnly: boolean,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const parent = path.dirname(resolved.path);
    const temporary = path.join(parent, `.${path.basename(resolved.path)}.${yield* crypto.randomUUIDv4}.tmp`);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
        yield* file.writeAll(new TextEncoder().encode(content));
        yield* file.sync;
      }),
    );
    yield* verifyPathAtExpectedLocation(fs, path, {...resolved, path: temporary}, temporary, 'File');
    if (createOnly) {
      const linked = yield* fs.link(temporary, resolved.path).pipe(Effect.result);
      if (linked._tag === 'Failure') {
        if (yield* fs.exists(resolved.path)) {
          return yield* new ResourceAlreadyExists({
            message: `Resource already exists: ${resolved.id.canonicalUri}`,
            uri: resolved.id.canonicalUri,
          });
        }
        return yield* linked.failure;
      }
      yield* fs.remove(temporary, {force: true});
    } else {
      yield* fs.rename(temporary, resolved.path);
    }
    yield* syncDirectory(fs, parent);
  }).pipe(Effect.ensuring(removeTemporarySiblings(fs, path, resolved)));
}

function removeTemporarySiblings(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  resolved: ResolvedResourcePath,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const parent = path.dirname(resolved.path);
    if (!(yield* fs.exists(parent))) return;
    const prefix = `.${path.basename(resolved.path)}.`;
    for (const entry of yield* fs.readDirectory(parent)) {
      if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
        yield* fs.remove(path.join(parent, entry), {force: true});
      }
    }
  }).pipe(Effect.catch(() => Effect.void));
}

function syncDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(file => file.sync),
      Effect.catch(() => Effect.void),
    ),
  );
}

function escapesBoundary(relative: string, path: Path.Path): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function unsafe(resolved: ResolvedResourcePath, message: string): ResourcePathUnsafe {
  return new ResourcePathUnsafe({message, path: resolved.path, uri: resolved.id.canonicalUri});
}

function pathForMessage(parent: string, child: string): string {
  return `${parent}/${child}`;
}

function isResourceStoreError(error: unknown): error is ResourceStoreError {
  return (
    error instanceof InvalidResourceId ||
    error instanceof ResourceAccessDenied ||
    error instanceof ResourceAlreadyExists ||
    error instanceof ResourceConflict ||
    error instanceof ResourceIoFailed ||
    error instanceof ResourceNotFound ||
    error instanceof ResourcePathUnsafe
  );
}

function mapIoError(operation: string, uri: string) {
  return <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ResourceStoreError> =>
    effect.pipe(
      Effect.mapError(error =>
        isResourceStoreError(error)
          ? error
          : new ResourceIoFailed({
              cause: error,
              message: `Resource ${operation} failed for ${uri}.`,
              operation,
              uri,
            }),
      ),
    );
}
