import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {codeGraphInventoryReuseContract, readCodeGraphInventoryReuseEnvironment} from './inventory_reuse.js';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphLayout} from './layout.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from './types.js';

const hash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const receiptSchema = Schema.Struct({
  contract: hash,
  environmentFingerprint: hash,
  includeOpaqueCorpusAssets: Schema.Boolean,
  repositoryId: hash,
  snapshotId: Schema.String,
  version: Schema.Literal(1),
  worktreeId: hash,
});
type AdmissionReceipt = typeof receiptSchema.Type;

class CodeGraphAdmissionError extends Schema.TaggedError<CodeGraphAdmissionError>()('CodeGraphAdmissionError', {
  message: Schema.String,
}) {}

function receiptPath(path: Path.Path, layout: CodeGraphLayout, worktreeId: string, clean: boolean): string {
  return path.join(layout.repositoryRoot, 'admission', `${worktreeId}${clean ? '.clean' : ''}.json`);
}

/** Missing cache evidence can deny freshness, but never substitutes for a ready SQLite snapshot. */
const readReceipt = Effect.fn('codeGraph.readAdmissionReceipt')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  clean = false,
) {
  if (!/^[0-9a-f]{64}$/u.test(worktreeId)) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = receiptPath(path, layout, worktreeId, clean);
  for (const file of [path.dirname(target), target]) {
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
  }
  const info = yield* fs.stat(target);
  if (info.type !== 'File' || Number(info.size) > 4_096) return undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(target, {flag: 'r'});
      const bytes = new Uint8Array(4_097);
      let length = 0;
      while (length < bytes.length) {
        const count = Number(yield* file.read(bytes.subarray(length)));
        if (count === 0) break;
        length += count;
      }
      if (length > 4_096) return undefined;
      const parsed = yield* Effect.try(() =>
        JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length))),
      );
      return Option.getOrUndefined(Schema.decodeUnknownOption(receiptSchema)(parsed));
    }),
  );
});

export const codeGraphSnapshotAdmissionCurrent = Effect.fn('codeGraph.snapshotAdmissionCurrent')(function* (
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  environmentFingerprint: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  producingWorktree = false,
) {
  const worktreeId = producingWorktree ? snapshot.worktreeId : layout.worktreeId;
  return (
    (yield* matchingReceipt(layout, worktreeId, snapshot, environmentFingerprint, languagePacks, producingWorktree)) !==
    undefined
  );
});

const matchingReceipt = Effect.fn('codeGraph.matchingAdmissionReceipt')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  snapshot: CodeGraphSnapshot,
  environment: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  includeClean: boolean,
) {
  for (const clean of includeClean && !snapshot.dirty ? [false, true] : [false]) {
    const receipt = yield* readReceipt(layout, worktreeId, clean).pipe(Effect.orElseSucceed(() => undefined));
    if (receiptMatches(receipt, worktreeId, snapshot, environment, languagePacks)) return receipt;
  }
  return undefined;
});

function receiptMatches(
  receipt: AdmissionReceipt | undefined,
  worktreeId: string,
  snapshot: CodeGraphSnapshot,
  environmentFingerprint: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): boolean {
  return (
    receipt !== undefined &&
    receipt.worktreeId === worktreeId &&
    receipt.repositoryId === snapshot.repositoryId &&
    receipt.snapshotId === snapshot.id &&
    receipt.environmentFingerprint === environmentFingerprint &&
    receipt.contract === codeGraphInventoryReuseContract(languagePacks, receipt.includeOpaqueCorpusAssets)
  );
}

/** Caller owns target-worktree publication and has fenced the captured admission environment. */
export const recordCodeGraphSnapshotAdmission = Effect.fn('codeGraph.recordSnapshotAdmission')(function* (
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  environmentFingerprint: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  includeOpaqueCorpusAssets: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (!/^[0-9a-f]{64}$/u.test(layout.worktreeId)) {
    return yield* CodeGraphAdmissionError.make({message: 'Invalid graph admission worktree identity.'});
  }
  const target = receiptPath(path, layout, layout.worktreeId, false);
  const directory = path.dirname(target);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
    return yield* CodeGraphAdmissionError.make({message: 'Graph admission directory must not be a symbolic link.'});
  }
  const receipt: AdmissionReceipt = {
    contract: codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets),
    environmentFingerprint,
    includeOpaqueCorpusAssets,
    repositoryId: snapshot.repositoryId,
    snapshotId: snapshot.id,
    version: 1,
    worktreeId: layout.worktreeId,
  };
  // Retain the last verified clean base while its producer works on a dirty overlay.
  // Two bounded files per worktree avoid retaining proof for every historical snapshot.
  for (const clean of snapshot.dirty ? [false] : [false, true]) {
    const destination = receiptPath(path, layout, layout.worktreeId, clean);
    const temporary = `${destination}.${yield* crypto.randomUUIDv4}.tmp`;
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, `${JSON.stringify(receipt)}\n`, {flag: 'wx', mode: 0o600});
      yield* fs.rename(temporary, destination);
    }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  }
});

export const observeCodeGraphAdmissionEnvironment = Effect.fn('codeGraph.observeAdmissionEnvironment')(function* (
  identity: RepositoryIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path)).fingerprint;
});

export const codeGraphSnapshotAdmissionCurrentForIdentity = Effect.fn('codeGraph.snapshotAdmissionCurrentForIdentity')(
  function* (
    layout: CodeGraphLayout,
    snapshot: CodeGraphSnapshot,
    identity: RepositoryIdentity,
    languagePacks: CodeGraphLanguagePackRegistryShape,
    producingWorktree = false,
  ) {
    const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
    return yield* codeGraphSnapshotAdmissionCurrent(layout, snapshot, environment, languagePacks, producingWorktree);
  },
);

export const adoptCodeGraphSnapshotAdmission = Effect.fn('codeGraph.adoptSnapshotAdmission')(function* (
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  identity: RepositoryIdentity,
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
  const receipt = yield* matchingReceipt(layout, snapshot.worktreeId, snapshot, environment, languagePacks, true);
  if (receipt === undefined) return false;
  yield* recordCodeGraphSnapshotAdmission(
    layout,
    snapshot,
    environment,
    languagePacks,
    receipt.includeOpaqueCorpusAssets,
  );
  return true;
});
