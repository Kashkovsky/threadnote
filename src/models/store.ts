import {Context, Crypto, Effect, FileSystem, Layer, Option, Path, Result, Schema} from 'effect';
import {
  InsufficientDiskSpace,
  ModelChecksumMismatch,
  ModelDownloadFailed,
  ModelNotInstalled,
} from '../effect/ai/errors.js';
import {sha256FileHex} from '../effect/digest.js';
import {withExclusiveFileLock} from '../effect/file_lock.js';
import {HttpService, type HttpServiceShape} from '../effect/http.js';
import {SystemInfo, type SystemInfoShape} from '../effect/system.js';
import type {LocalModelManifest} from './catalog.js';

export interface LocalModelInstallation {
  readonly bytes: number;
  readonly installed: boolean;
  readonly modelId: string;
  readonly partialBytes: number;
  readonly path: string;
  readonly verified: boolean;
}

export interface LocalModelInstallResult extends LocalModelInstallation {
  readonly resumed: boolean;
  readonly sourceUrl: string;
}

export interface LocalModelLockEvent {
  readonly lockPath: string;
  readonly modelId: string;
  readonly operation: string;
}

export interface LocalModelStoreLayerOptions {
  readonly onModelLockAcquired?: (event: LocalModelLockEvent) => Effect.Effect<void, never>;
  readonly onModelLockCompleted?: (event: LocalModelLockEvent) => Effect.Effect<void, never>;
  readonly onModelLockContention?: (event: LocalModelLockEvent) => Effect.Effect<void, never>;
}

export class ModelStoreIoFailed extends Schema.TaggedErrorClass<ModelStoreIoFailed>()('ModelStoreIoFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
  operation: Schema.String,
}) {}

export type LocalModelStoreError =
  InsufficientDiskSpace | ModelChecksumMismatch | ModelDownloadFailed | ModelNotInstalled | ModelStoreIoFailed;

export interface LocalModelStoreShape {
  readonly install: (
    home: string,
    manifest: LocalModelManifest,
    options?: {readonly sourceUrl?: string},
  ) => Effect.Effect<LocalModelInstallResult, LocalModelStoreError>;
  readonly path: (home: string, manifest: LocalModelManifest) => string;
  readonly remove: (home: string, manifest: LocalModelManifest) => Effect.Effect<boolean, LocalModelStoreError>;
  readonly status: (
    home: string,
    manifest: LocalModelManifest,
  ) => Effect.Effect<LocalModelInstallation, LocalModelStoreError>;
  readonly verify: (
    home: string,
    manifest: LocalModelManifest,
  ) => Effect.Effect<LocalModelInstallation, LocalModelStoreError>;
}

export class LocalModelStore extends Context.Service<LocalModelStore, LocalModelStoreShape>()(
  'threadnote/models/LocalModelStore',
) {
  static layerWith(options: LocalModelStoreLayerOptions = {}) {
    return Layer.effect(
      LocalModelStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const http = yield* HttpService;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const platform = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo>();
        const providePlatform = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, Exclude<R, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo>> =>
          effect.pipe(Effect.provide(platform));
        return LocalModelStore.of(makeLocalModelStore(fs, http, path, system, providePlatform, options));
      }),
    );
  }

  static readonly layer = LocalModelStore.layerWith();
}

// GitHub marks these releases immutable, and each asset is named by its verified model digest.
const THREADNOTE_MODEL_RELEASES_BY_SHA256: Readonly<Record<string, string>> = {
  f046db1dc724cf4f6f0a0c5917e922823b73eb1d27b8f9a9c2797f7866974804: 'v4.1.1',
};

function makeLocalModelStore(
  fs: FileSystem.FileSystem,
  http: HttpServiceShape,
  path: Path.Path,
  system: SystemInfoShape,
  providePlatform: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo>>,
  layerOptions: LocalModelStoreLayerOptions,
): LocalModelStoreShape {
  const verifiedModels = new Map<
    string,
    {readonly fileIdentity: string; readonly installation: LocalModelInstallation}
  >();
  const modelPath = (home: string, manifest: LocalModelManifest) =>
    path.join(modelDirectory(path, home, manifest), `${manifest.sha256}.gguf`);
  const partialPath = (home: string, manifest: LocalModelManifest) => `${modelPath(home, manifest)}.partial`;
  const status = (home: string, manifest: LocalModelManifest) =>
    Effect.gen(function* () {
      const installedPath = modelPath(home, manifest);
      const partial = partialPath(home, manifest);
      const installed = yield* fs.exists(installedPath);
      const partialExists = yield* fs.exists(partial);
      const bytes = installed ? Number((yield* fs.stat(installedPath)).size) : 0;
      const partialBytes = partialExists ? Number((yield* fs.stat(partial)).size) : 0;
      return {
        bytes,
        installed,
        modelId: manifest.id,
        partialBytes,
        path: installedPath,
        verified: false,
      };
    }).pipe(mapStoreIoError(manifest, 'status'));
  const verificationCacheKey = (home: string, manifest: LocalModelManifest) =>
    `${modelPath(home, manifest)}\0${manifest.sha256}`;
  const installedFileIdentity = (installedPath: string) =>
    fs.stat(installedPath).pipe(
      Effect.map(info => {
        const inode = Option.getOrUndefined(info.ino);
        const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
        return inode === undefined || modifiedAt === undefined
          ? Option.none<string>()
          : Option.some(`${info.size}:${inode}:${modifiedAt}`);
      }),
    );
  const cacheVerifiedInstallation = (
    home: string,
    manifest: LocalModelManifest,
    installation: LocalModelInstallation,
  ) =>
    installedFileIdentity(installation.path).pipe(
      Effect.tap(identity =>
        Option.isSome(identity)
          ? Effect.sync(() =>
              verifiedModels.set(verificationCacheKey(home, manifest), {
                fileIdentity: identity.value,
                installation,
              }),
            )
          : Effect.void,
      ),
      Effect.asVoid,
    );
  const cachedVerification = (home: string, manifest: LocalModelManifest) =>
    Effect.gen(function* () {
      const cached = verifiedModels.get(verificationCacheKey(home, manifest));
      if (!cached || !(yield* fs.exists(cached.installation.path))) {
        return Option.none<LocalModelInstallation>();
      }
      const identity = yield* installedFileIdentity(cached.installation.path);
      return Option.isSome(identity) && identity.value === cached.fileIdentity
        ? Option.some(cached.installation)
        : Option.none<LocalModelInstallation>();
    }).pipe(mapStoreIoError(manifest, 'verify'));
  const verifyUnlocked = (home: string, manifest: LocalModelManifest, allowCache: boolean) =>
    Effect.gen(function* () {
      const current = yield* status(home, manifest);
      if (!current.installed) {
        return yield* new ModelNotInstalled({
          message: `Model ${manifest.id} is not installed.`,
          modelId: manifest.id,
          path: current.path,
        });
      }
      if (current.bytes !== manifest.size) {
        return yield* checksumMismatch(manifest, `size:${current.bytes}`);
      }
      if (allowCache) {
        const cached = yield* cachedVerification(home, manifest);
        if (Option.isSome(cached)) return cached.value;
      }
      const digest = yield* providePlatform(sha256FileHex(current.path));
      if (digest !== manifest.sha256) {
        return yield* checksumMismatch(manifest, digest);
      }
      const verified = {...current, verified: true};
      yield* cacheVerifiedInstallation(home, manifest, verified);
      return verified;
    }).pipe(mapStoreIoError(manifest, 'verify'));
  const withModelLock = <A, E, R>(
    home: string,
    manifest: LocalModelManifest,
    operation: string,
    effect: Effect.Effect<A, E, R>,
  ) => {
    const lockPath = path.join(home, 'locks', 'models', `${manifest.id}.lock`);
    const event = {lockPath, modelId: manifest.id, operation};
    return providePlatform(
      withExclusiveFileLock(
        fs,
        lockPath,
        {
          heartbeatIntervalMilliseconds: 10_000,
          ...(layerOptions.onModelLockAcquired ? {onAcquired: () => layerOptions.onModelLockAcquired!(event)} : {}),
          ...(layerOptions.onModelLockCompleted ? {onCompleted: () => layerOptions.onModelLockCompleted!(event)} : {}),
          ...(layerOptions.onModelLockContention
            ? {onContention: () => layerOptions.onModelLockContention!(event)}
            : {}),
          retryIntervalMilliseconds: 100,
          staleAfterMilliseconds: 60_000,
          waitTimeoutMilliseconds: 60_000,
        },
        effect,
      ).pipe(mapStoreIoError(manifest, operation)),
    );
  };
  return {
    install: (home, manifest, options) =>
      withModelLock(
        home,
        manifest,
        'install',
        Effect.gen(function* () {
          const current = yield* status(home, manifest);
          const sourceUrl = options?.sourceUrl ?? modelDownloadUrl(manifest);
          const directory = modelDirectory(path, home, manifest);
          if (current.installed) {
            const verified = yield* verifyUnlocked(home, manifest, false).pipe(Effect.result);
            if (Result.isSuccess(verified)) {
              return {...verified.success, resumed: false, sourceUrl};
            }
            if (!(verified.failure instanceof ModelChecksumMismatch)) {
              return yield* Effect.fail(verified.failure);
            }
            yield* fs.remove(modelPath(home, manifest), {force: true});
            yield* fs.remove(path.join(directory, 'manifest.json'), {force: true});
          }
          const partial = partialPath(home, manifest);
          yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
          let offset = current.partialBytes;
          if (offset > manifest.size) {
            yield* fs.remove(partial, {force: true});
            offset = 0;
          }
          const availableBytes = yield* system.availableDiskBytes(directory).pipe(
            Effect.mapError(
              cause =>
                new ModelStoreIoFailed({
                  cause,
                  message: `Could not inspect free space before downloading ${manifest.id}.`,
                  modelId: manifest.id,
                  operation: 'disk-space-preflight',
                }),
            ),
          );
          if (availableBytes !== undefined) {
            yield* assertSufficientModelDiskSpace(manifest, availableBytes, manifest.size - offset);
          }
          const response = yield* http.downloadToFile(sourceUrl, partial, {offset}).pipe(
            Effect.mapError(
              cause =>
                new ModelDownloadFailed({
                  cause,
                  message: `Could not download model ${manifest.id}: ${cause.message}`,
                  modelId: manifest.id,
                }),
            ),
          );
          const downloadedBytes = Number((yield* fs.stat(partial)).size);
          if (downloadedBytes !== manifest.size) {
            return yield* new ModelDownloadFailed({
              cause: {actualBytes: downloadedBytes, expectedBytes: manifest.size},
              message: `Model ${manifest.id} download has ${downloadedBytes} bytes; expected ${manifest.size}. The partial file was retained for resume.`,
              modelId: manifest.id,
            });
          }
          const digest = yield* providePlatform(sha256FileHex(partial));
          if (digest !== manifest.sha256) {
            yield* fs.remove(partial, {force: true});
            return yield* checksumMismatch(manifest, digest);
          }
          const installedPath = modelPath(home, manifest);
          yield* fs.rename(partial, installedPath);
          yield* fs.chmod(installedPath, 0o600);
          yield* writeManifestReceipt(fs, path, directory, manifest);
          const installed = {
            bytes: downloadedBytes,
            installed: true,
            modelId: manifest.id,
            partialBytes: 0,
            path: installedPath,
            resumed: offset > 0 && response.resumed,
            sourceUrl,
            verified: true,
          };
          yield* cacheVerifiedInstallation(home, manifest, installed);
          return installed;
        }),
      ),
    path: modelPath,
    remove: (home, manifest) =>
      withModelLock(
        home,
        manifest,
        'remove',
        Effect.gen(function* () {
          const directory = modelDirectory(path, home, manifest);
          if (!(yield* fs.exists(directory))) return false;
          yield* fs.remove(directory, {recursive: true});
          verifiedModels.delete(verificationCacheKey(home, manifest));
          return true;
        }),
      ),
    status,
    verify: (home, manifest) =>
      cachedVerification(home, manifest).pipe(
        Effect.flatMap(cached =>
          Option.isSome(cached)
            ? Effect.succeed(cached.value)
            : withModelLock(home, manifest, 'verify', verifyUnlocked(home, manifest, true)),
        ),
      ),
  };
}

export function modelDownloadUrl(manifest: LocalModelManifest): string {
  const threadnoteRelease = THREADNOTE_MODEL_RELEASES_BY_SHA256[manifest.sha256];
  if (threadnoteRelease) {
    return `https://github.com/Kashkovsky/threadnote/releases/download/${threadnoteRelease}/${manifest.sha256}.gguf`;
  }
  const repository = manifest.repository.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const file = manifest.file.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repository}/resolve/${manifest.revision}/${file}`;
}

function modelDirectory(path: Path.Path, home: string, manifest: LocalModelManifest): string {
  return path.join(home, 'models', manifest.role, manifest.id);
}

function checksumMismatch(manifest: LocalModelManifest, actual: string): ModelChecksumMismatch {
  return new ModelChecksumMismatch({
    actual,
    expected: manifest.sha256,
    message: `Model ${manifest.id} checksum does not match its immutable manifest.`,
    modelId: manifest.id,
  });
}

function writeManifestReceipt(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  manifest: LocalModelManifest,
) {
  return Effect.gen(function* () {
    const target = path.join(directory, 'manifest.json');
    const temporary = `${target}.tmp`;
    yield* fs.writeFileString(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`, {mode: 0o600});
    yield* fs.rename(temporary, target);
  });
}

function mapStoreIoError(manifest: LocalModelManifest, operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LocalModelStoreError, R> =>
    effect.pipe(
      Effect.mapError(error =>
        error instanceof ModelChecksumMismatch ||
        error instanceof InsufficientDiskSpace ||
        error instanceof ModelDownloadFailed ||
        error instanceof ModelNotInstalled ||
        error instanceof ModelStoreIoFailed
          ? error
          : new ModelStoreIoFailed({
              cause: error,
              message: `Local model ${operation} failed for ${manifest.id}.`,
              modelId: manifest.id,
              operation,
            }),
      ),
    ) as Effect.Effect<A, LocalModelStoreError, R>;
}

export function assertSufficientModelDiskSpace(
  manifest: LocalModelManifest,
  availableBytes: number,
  remainingModelBytes: number,
): Effect.Effect<void, InsufficientDiskSpace> {
  const requiredBytes = Math.max(0, remainingModelBytes) + Math.min(512 * 1024 * 1024, manifest.size);
  return availableBytes >= requiredBytes
    ? Effect.void
    : Effect.fail(
        new InsufficientDiskSpace({
          availableBytes,
          message: `Model ${manifest.id} needs ${requiredBytes} free bytes to download and promote safely; only ${availableBytes} are available.`,
          modelId: manifest.id,
          requiredBytes,
        }),
      );
}
