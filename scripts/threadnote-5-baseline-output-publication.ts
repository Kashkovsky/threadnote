/* oxlint-disable effecttsgo/node-builtin-import, threadnote/no-node-runtime -- This boundary pins output parents and commits fresh files with native descriptor-relative operations. */
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {lstat, mkdir, open, realpath} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {dlopen, read} from 'bun:ffi';
import {
  copyThreadnote5BaselineBoundBytes,
  verifyThreadnote5BaselineBoundBytes,
  writeThreadnote5BaselineBoundBytes,
  type Threadnote5BaselineByteBinding,
} from './threadnote-5-baseline-byte-binding.js';

const EVIDENCE_BYTE_DOMAIN = 'threadnote-5-baseline-public-evidence-v1';
const PRIVATE_REPLAY_BYTE_DOMAIN = 'threadnote-5-baseline-private-replay-v1';
const REPLAY_RECOVERY_BYTE_DOMAIN = 'threadnote-5-baseline-replay-recovery-v1';

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface OutputParent extends FileIdentity {
  readonly handle: FileHandle;
  readonly path: string;
}

interface DestinationSnapshot {
  readonly identity?: FileIdentity;
}

type OutputState = 'committed' | 'preserved-unverified' | 'published' | 'retained' | 'staged' | 'untrusted';

type StageEntry =
  | {readonly kind: 'absent'}
  | {readonly identity: FileIdentity; readonly kind: 'displaced' | 'staged'}
  | {readonly kind: 'untrusted'};

interface StagedOutput extends FileIdentity {
  cleanupHookRun?: boolean;
  readonly destination: DestinationSnapshot;
  expectedBytes?: Threadnote5BaselineByteBinding;
  readonly handle: FileHandle;
  readonly parent: OutputParent;
  readonly path: string;
  recovery?: ReplayRecovery;
  stageEntry: StageEntry;
  stageDirectory: OutputParent;
  readonly stageName: string;
  state: OutputState;
  readonly targetName: string;
}

interface ReplayRecovery extends FileIdentity {
  readonly expectedBytes: Threadnote5BaselineByteBinding;
  readonly handle: FileHandle;
  readonly name: string;
}

interface RelativeEntry extends FileIdentity {
  readonly mode: number;
}

interface NativeCallResult {
  readonly errno?: number;
  readonly ok: boolean;
}

interface NativeDirectoryOperations {
  readonly close: () => void;
  readonly exchange: (leftDirectory: number, left: string, rightDirectory: number, right: string) => NativeCallResult;
  readonly mkdir: (directory: number, name: string, mode: number) => NativeCallResult;
  readonly noReplace: (
    sourceDirectory: number,
    source: string,
    targetDirectory: number,
    target: string,
  ) => NativeCallResult;
  readonly stat: (directory: number, name: string) => RelativeEntry | undefined;
  readonly unlink: (directory: number, name: string, directoryEntry: boolean) => NativeCallResult;
}

interface CanonicalOutputPath {
  readonly parentPath: string;
  readonly path: string;
  readonly targetName: string;
}

export interface PreparedThreadnote5BaselineOutputPathsV1 {
  readonly cleanupReservations: () => Promise<void>;
  readonly evidenceOutputPath: string;
  readonly publish: (input: {readonly evidence: string; readonly privateReplay: string}) => Promise<void>;
  readonly privateReplayOutputPath: string;
}

export interface Threadnote5BaselineOutputPublicationTestHooks {
  readonly afterFinalValidationBeforeCommit?: (outputPath: string) => Promise<void>;
  readonly afterPublicCommit?: () => Promise<void>;
  readonly afterStageOutputPrepared?: (stageDirectoryPath: string) => Promise<void>;
  readonly beforePublicCommit?: () => Promise<void>;
  readonly beforeStageDirectoryCleanup?: (stageDirectoryPath: string) => Promise<void>;
}

export async function prepareThreadnote5BaselineOutputPathsV1(
  input: {
    readonly evidenceOutputPath: string;
    readonly privateReplayOutputPath: string;
  },
  hooks: Threadnote5BaselineOutputPublicationTestHooks = {},
): Promise<PreparedThreadnote5BaselineOutputPathsV1> {
  const native = openNativeDirectoryOperations();
  const outputs: StagedOutput[] = [];
  let attempted = false;
  let closed = false;
  let closing = false;
  let committed = false;
  let cleanupPromise: Promise<void> | undefined;
  let publicationPromise: Promise<void> | undefined;
  try {
    const evidencePath = await canonicalOutputPath(input.evidenceOutputPath);
    const privateReplayPath = await canonicalOutputPath(input.privateReplayOutputPath);
    if (evidencePath.path === privateReplayPath.path) {
      throw new Error('Baseline evidence and private replay outputs must be different files.');
    }
    const evidence = await stageOutput(evidencePath, native, hooks);
    outputs.push(evidence);
    const privateReplay = await stageOutput(privateReplayPath, native, hooks);
    outputs.push(privateReplay);
    assertDistinctOutputs(evidence, privateReplay);
    await verifyOutputs(outputs, native);
    const cleanup = (): Promise<void> =>
      (cleanupPromise ??= (async () => {
        closing = true;
        await publicationPromise?.catch(() => {});
        if (closed) return;
        try {
          await cleanupOutputs(outputs, committed, native, hooks);
        } finally {
          closed = true;
          native.close();
        }
      })());
    return {
      cleanupReservations: cleanup,
      evidenceOutputPath: evidence.path,
      publish: contents => {
        if (closed || closing) throw new Error('Baseline output staging is closed.');
        if (attempted) throw new Error('Baseline output publication has already been attempted.');
        attempted = true;
        publicationPromise = publishOutputs({
          evidence,
          privateReplay,
          outputs,
          contents,
          native,
          hooks,
          isClosing: () => closing,
          markCommitted: () => {
            committed = true;
          },
        });
        return publicationPromise;
      },
      privateReplayOutputPath: privateReplay.path,
    };
  } catch (cause) {
    closed = true;
    try {
      await cleanupOutputs(outputs, committed, native, hooks);
    } finally {
      native.close();
    }
    throw cause;
  }
}

async function publishOutputs(input: {
  readonly contents: {readonly evidence: string; readonly privateReplay: string};
  readonly evidence: StagedOutput;
  readonly hooks: Threadnote5BaselineOutputPublicationTestHooks;
  readonly isClosing: () => boolean;
  readonly markCommitted: () => void;
  readonly native: NativeDirectoryOperations;
  readonly outputs: readonly StagedOutput[];
  readonly privateReplay: StagedOutput;
}): Promise<void> {
  const {evidence, privateReplay, outputs, contents, native, hooks} = input;
  await verifyOutputs(outputs, native);
  await writeStagedOutput(privateReplay, contents.privateReplay, PRIVATE_REPLAY_BYTE_DOMAIN, true);
  await writeStagedOutput(evidence, contents.evidence, EVIDENCE_BYTE_DOMAIN, false);
  await verifyOutputs(outputs, native);
  try {
    await pinReplayRecovery(privateReplay, native);
    await commitStagedOutput(privateReplay, true, native, hooks);
    await verifyStagedOutput(evidence, native);
    await hooks.beforePublicCommit?.();
    if (input.isClosing()) throw new Error('Baseline output publication was interrupted before public commit.');
    await verifyStagedOutput(evidence, native);
    await hooks.afterFinalValidationBeforeCommit?.(evidence.path);
    if (input.isClosing()) throw new Error('Baseline output publication was interrupted before public commit.');
    await verifyStagedPayload(evidence, native);
    await assertPrivateReplayReadyForPublicCommit(privateReplay, native);
    commitVerifiedStagedOutput(evidence, native);
    await hooks.afterPublicCommit?.();
    await runCleanupHooks(outputs, hooks);
    await verifyPublishedOutput(evidence, false, native);
    await verifyPublishedOutput(privateReplay, true, native);
    await verifyReplayRecovery(privateReplay, native);
    privateReplay.state = 'published';
    evidence.state = 'published';
    input.markCommitted();
  } catch (cause) {
    const rollback = await rollbackCommittedOutputs(evidence, privateReplay, native, hooks);
    if (!rollback.publicWithdrawn && rollback.recoveryPath !== undefined) {
      throw new Error(
        `Baseline public evidence could not be withdrawn; private replay retained at ${rollback.recoveryPath}.`,
        {cause},
      );
    }
    if (!rollback.publicWithdrawn) {
      throw new Error(
        'Baseline public evidence could not be withdrawn, and exact private replay recovery could not be proven.',
        {cause},
      );
    }
    throw cause;
  }
}

async function pinReplayRecovery(output: StagedOutput, native: NativeDirectoryOperations): Promise<void> {
  if (output.expectedBytes === undefined) throw new Error('Baseline private replay has no exact-byte binding.');
  output.recovery = await createReplayRecovery(output, native, 'replay-recovery', {
    expectedBytes: output.expectedBytes,
    handle: output.handle,
  });
}

async function canonicalOutputPath(value: string): Promise<CanonicalOutputPath> {
  const absolutePath = resolve(value);
  await mkdir(dirname(absolutePath), {mode: 0o700, recursive: true});
  const parentPath = await realpath(dirname(absolutePath));
  const targetName = basename(absolutePath);
  if (!/^[a-z0-9][a-z0-9._-]{0,254}$/u.test(targetName)) {
    throw new Error(
      'Baseline output filenames must use distinct lowercase ASCII letters, digits, dots, hyphens, or underscores.',
    );
  }
  return {parentPath, path: join(parentPath, targetName), targetName};
}

async function stageOutput(
  output: CanonicalOutputPath,
  native: NativeDirectoryOperations,
  hooks: Threadnote5BaselineOutputPublicationTestHooks,
): Promise<StagedOutput> {
  const parent = await openOutputParent(output.parentPath);
  const stageName = 'payload';
  let stageDirectory: OutputParent | undefined;
  let stageDirectoryName: string | undefined;
  let handle: FileHandle | undefined;
  try {
    await verifyParent(parent);
    const destination = snapshotDestination(parent, output.targetName, output.path, native);
    stageDirectoryName = `.threadnote-baseline-stage-${randomBytes(16).toString('hex')}`;
    const stageDirectoryPath = join(parent.path, stageDirectoryName);
    requireNativeCall(native.mkdir(parent.handle.fd, stageDirectoryName, 0o700), 'staging directory creation');
    stageDirectory = await openOutputParent(stageDirectoryPath);
    const stageDirectoryInfo = await stageDirectory.handle.stat({bigint: true});
    if ((stageDirectoryInfo.mode & 0o777n) !== 0o700n) {
      throw new Error('Baseline output staging directories must have mode 0700.');
    }
    verifyAtomicRenameCapabilities(stageDirectory.handle.fd, native);
    handle = await open(
      join(stageDirectory.path, stageName),
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    await handle.chmod(0o600);
    const info = await handle.stat({bigint: true});
    if (!info.isFile()) throw new Error('Baseline output staging must be an ordinary file.');
    const staged = {
      destination,
      device: info.dev,
      handle,
      inode: info.ino,
      parent,
      path: output.path,
      stageEntry: {identity: {device: info.dev, inode: info.ino}, kind: 'staged'},
      stageDirectory,
      stageName,
      state: 'staged',
      targetName: output.targetName,
    } satisfies StagedOutput;
    await hooks.afterStageOutputPrepared?.(stageDirectory.path);
    await verifyStagedOutput(staged, native);
    handle = undefined;
    stageDirectory = undefined;
    stageDirectoryName = undefined;
    return staged;
  } catch (cause) {
    await handle?.close();
    if (stageDirectory !== undefined) {
      try {
        native.unlink(stageDirectory.handle.fd, stageName, false);
      } catch {
        // The private staging entry may not have been created.
      }
    }
    await stageDirectory?.handle.close();
    // The directory pathname may have been substituted. Retain the empty mode-0700
    // directory instead of removing any caller-mutable name after closing its handle.
    await parent.handle.close();
    throw cause;
  }
}

async function openOutputParent(path: string): Promise<OutputParent> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({bigint: true});
    if (!info.isDirectory()) throw new Error('Baseline output parents must be ordinary directories.');
    return {device: info.dev, handle, inode: info.ino, path};
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

function snapshotDestination(
  parent: OutputParent,
  targetName: string,
  path: string,
  native: NativeDirectoryOperations,
): DestinationSnapshot {
  const info = native.stat(parent.handle.fd, targetName);
  if (info === undefined) return {};
  if (!isRegularFileMode(info.mode)) {
    throw new Error(`Baseline output destinations must be ordinary files when they already exist: ${path}`);
  }
  return {identity: info};
}

async function verifyOutputs(outputs: readonly StagedOutput[], native: NativeDirectoryOperations): Promise<void> {
  for (const output of outputs) await verifyStagedOutput(output, native);
  if (outputs.length === 2) assertDistinctOutputs(outputs[0], outputs[1]);
}

async function verifyStagedOutput(output: StagedOutput, native: NativeDirectoryOperations): Promise<void> {
  await verifyStagedPayload(output, native);
  verifyDestinationSnapshot(output, native);
}

async function verifyStagedPayload(output: StagedOutput, native: NativeDirectoryOperations): Promise<void> {
  if (output.state !== 'staged') {
    throw new Error(`Baseline output is not staged for publication: ${output.path}`);
  }
  await verifyParent(output.parent);
  await verifyParent(output.stageDirectory);
  const handleInfo = await output.handle.stat({bigint: true});
  const pathInfo = native.stat(output.stageDirectory.handle.fd, output.stageName);
  if (
    !handleInfo.isFile() ||
    pathInfo === undefined ||
    !isRegularFileMode(pathInfo.mode) ||
    !sameIdentity(output, handleInfo) ||
    !sameIdentity(output, pathInfo)
  ) {
    throw new Error(`Baseline output staging changed before publication: ${output.path}`);
  }
  if (output.expectedBytes !== undefined) {
    await verifyThreadnote5BaselineBoundBytes(output.handle, output.expectedBytes, 'Baseline staged output');
  }
  assertStagedOutputPathIdentity(output, native);
}

function assertStagedOutputPathIdentity(output: StagedOutput, native: NativeDirectoryOperations): void {
  const directoryAtPath = native.stat(output.stageDirectory.handle.fd, output.stageDirectory.path);
  const payloadAtPath = native.stat(output.stageDirectory.handle.fd, output.stageName);
  if (
    directoryAtPath === undefined ||
    (directoryAtPath.mode & 0o170000) !== 0o040000 ||
    !sameIdentity(output.stageDirectory, directoryAtPath) ||
    payloadAtPath === undefined ||
    !isRegularFileMode(payloadAtPath.mode) ||
    !sameIdentity(output, payloadAtPath)
  ) {
    throw new Error(`Baseline output staging changed before publication: ${output.path}`);
  }
}

async function verifyParent(parent: OutputParent): Promise<void> {
  const handleInfo = await parent.handle.stat({bigint: true});
  const pathInfo = await lstat(parent.path, {bigint: true});
  if (
    !handleInfo.isDirectory() ||
    !pathInfo.isDirectory() ||
    !sameIdentity(parent, handleInfo) ||
    !sameIdentity(parent, pathInfo)
  ) {
    throw new Error(`Baseline output parent changed after it was pinned: ${parent.path}`);
  }
}

function verifyDestinationSnapshot(output: StagedOutput, native: NativeDirectoryOperations): void {
  const observed = snapshotDestination(output.parent, output.targetName, output.path, native);
  if (
    (output.destination.identity === undefined) !== (observed.identity === undefined) ||
    (output.destination.identity !== undefined &&
      observed.identity !== undefined &&
      !sameIdentity(output.destination.identity, observed.identity))
  ) {
    throw new Error(`Baseline output destination changed after staging began: ${output.path}`);
  }
}

async function writeStagedOutput(
  output: StagedOutput,
  contents: string,
  domain: string,
  requirePrivateMode: boolean,
): Promise<void> {
  await output.handle.chmod(0o600);
  output.expectedBytes = await writeThreadnote5BaselineBoundBytes(output.handle, contents, domain);
  const info = await output.handle.stat({bigint: true});
  if (
    !info.isFile() ||
    !sameIdentity(output, info) ||
    info.size !== BigInt(output.expectedBytes.byteLength) ||
    (requirePrivateMode && (info.mode & 0o777n) !== 0o600n)
  ) {
    throw new Error('Baseline output staging identity, size, or private permissions changed while writing.');
  }
}

async function commitStagedOutput(
  output: StagedOutput,
  requirePrivateMode: boolean,
  native: NativeDirectoryOperations,
  hooks: Threadnote5BaselineOutputPublicationTestHooks,
): Promise<void> {
  await verifyStagedOutput(output, native);
  await hooks.afterFinalValidationBeforeCommit?.(output.path);
  await verifyStagedPayload(output, native);
  commitVerifiedStagedOutput(output, native);
  await verifyPublishedOutput(output, requirePrivateMode, native);
}

function commitVerifiedStagedOutput(output: StagedOutput, native: NativeDirectoryOperations): void {
  if (output.destination.identity === undefined) {
    const result = native.noReplace(
      output.stageDirectory.handle.fd,
      output.stageName,
      output.parent.handle.fd,
      output.targetName,
    );
    if (!result.ok) {
      throw new Error(`Baseline output destination changed after staging began (atomic no-replace): ${output.path}`);
    }
    output.stageEntry = {kind: 'absent'};
    output.state = 'committed';
  } else {
    requireNativeCall(
      native.exchange(output.stageDirectory.handle.fd, output.stageName, output.parent.handle.fd, output.targetName),
      'atomic destination exchange',
    );
    output.stageEntry = {kind: 'untrusted'};
    output.state = 'committed';
    const displaced = native.stat(output.stageDirectory.handle.fd, output.stageName);
    if (
      displaced === undefined ||
      !isRegularFileMode(displaced.mode) ||
      !sameIdentity(output.destination.identity, displaced)
    ) {
      restoreMismatchedExchange(output, displaced, native);
      throw new Error(`Baseline output destination changed during atomic publication: ${output.path}`);
    }
    output.stageEntry = {identity: output.destination.identity, kind: 'displaced'};
  }
}

async function assertPrivateReplayReadyForPublicCommit(
  output: StagedOutput,
  native: NativeDirectoryOperations,
): Promise<void> {
  if (output.state !== 'committed') {
    throw new Error(`Baseline private replay is not committed before public publication: ${output.path}`);
  }
  try {
    await verifyPublishedOutput(output, true, native);
    await verifyReplayRecovery(output, native);
    assertPrivateReplayPathIdentity(output, native);
  } catch (cause) {
    throw new Error(`Baseline private replay changed before public publication: ${output.path}`, {cause});
  }
}

function assertPrivateReplayPathIdentity(output: StagedOutput, native: NativeDirectoryOperations): void {
  const recovery = output.recovery;
  const published = native.stat(output.parent.handle.fd, output.targetName);
  const parentAtPath = native.stat(output.parent.handle.fd, output.parent.path);
  const publishedAtPath = native.stat(output.parent.handle.fd, output.path);
  const recoveryAtPath =
    recovery === undefined ? undefined : native.stat(output.stageDirectory.handle.fd, recovery.name);
  if (
    recovery === undefined ||
    recoveryAtPath === undefined ||
    !sameIdentity(recovery, recoveryAtPath) ||
    parentAtPath === undefined ||
    (parentAtPath.mode & 0o170000) !== 0o040000 ||
    !sameIdentity(output.parent, parentAtPath) ||
    publishedAtPath === undefined ||
    !sameIdentity(output, publishedAtPath) ||
    published === undefined ||
    !isRegularFileMode(published.mode) ||
    !sameIdentity(output, published) ||
    (published.mode & 0o777) !== 0o600
  ) {
    throw new Error(`Baseline private replay changed before public publication: ${output.path}`);
  }
}

async function verifyPublishedOutput(
  output: StagedOutput,
  requirePrivateMode: boolean,
  native: NativeDirectoryOperations,
): Promise<void> {
  await verifyParent(output.parent);
  const handleInfo = await output.handle.stat({bigint: true});
  const pathInfo = native.stat(output.parent.handle.fd, output.targetName);
  if (
    !handleInfo.isFile() ||
    pathInfo === undefined ||
    !isRegularFileMode(pathInfo.mode) ||
    !sameIdentity(output, handleInfo) ||
    !sameIdentity(output, pathInfo) ||
    (requirePrivateMode && (handleInfo.mode & 0o777n) !== 0o600n)
  ) {
    throw new Error(`Baseline output changed while it was being published: ${output.path}`);
  }
  if (output.expectedBytes === undefined) throw new Error('Baseline output has no exact-byte binding.');
  await verifyThreadnote5BaselineBoundBytes(output.handle, output.expectedBytes, 'Baseline published output');
  assertPublishedOutputPathIdentity(output, requirePrivateMode, native);
}

function assertPublishedOutputPathIdentity(
  output: StagedOutput,
  requirePrivateMode: boolean,
  native: NativeDirectoryOperations,
): void {
  const parentAtPath = native.stat(output.parent.handle.fd, output.parent.path);
  const pathInfo = native.stat(output.parent.handle.fd, output.targetName);
  if (
    parentAtPath === undefined ||
    (parentAtPath.mode & 0o170000) !== 0o040000 ||
    !sameIdentity(output.parent, parentAtPath) ||
    pathInfo === undefined ||
    !isRegularFileMode(pathInfo.mode) ||
    !sameIdentity(output, pathInfo) ||
    (requirePrivateMode && (pathInfo.mode & 0o777) !== 0o600)
  ) {
    throw new Error(`Baseline output changed while it was being published: ${output.path}`);
  }
}

function restoreMismatchedExchange(
  output: StagedOutput,
  displaced: RelativeEntry | undefined,
  native: NativeDirectoryOperations,
): void {
  const restored = native.exchange(
    output.stageDirectory.handle.fd,
    output.stageName,
    output.parent.handle.fd,
    output.targetName,
  );
  if (!restored.ok) {
    output.state = 'untrusted';
    return;
  }
  const staged = native.stat(output.stageDirectory.handle.fd, output.stageName);
  const destination = native.stat(output.parent.handle.fd, output.targetName);
  if (
    staged !== undefined &&
    isRegularFileMode(staged.mode) &&
    sameIdentity(output, staged) &&
    displaced !== undefined &&
    destination !== undefined &&
    sameIdentity(displaced, destination)
  ) {
    output.stageEntry = {identity: output, kind: 'staged'};
    output.state = 'staged';
    return;
  }
  output.stageEntry = {kind: 'untrusted'};
  output.state = 'untrusted';
}

async function verifyReplayRecovery(output: StagedOutput, native: NativeDirectoryOperations): Promise<string> {
  const recovery = output.recovery;
  if (recovery === undefined) throw new Error('Baseline private replay has no independent recovery copy.');
  await verifyParent(output.stageDirectory);
  const handleInfo = await recovery.handle.stat({bigint: true});
  const pathInfo = native.stat(output.stageDirectory.handle.fd, recovery.name);
  if (
    !handleInfo.isFile() ||
    pathInfo === undefined ||
    !isRegularFileMode(pathInfo.mode) ||
    !sameIdentity(recovery, handleInfo) ||
    !sameIdentity(recovery, pathInfo) ||
    sameIdentity(output, recovery) ||
    (handleInfo.mode & 0o777n) !== 0o600n
  ) {
    throw new Error('Baseline private replay recovery identity changed before publication.');
  }
  await verifyThreadnote5BaselineBoundBytes(
    recovery.handle,
    recovery.expectedBytes,
    'Baseline private replay recovery',
  );
  assertReplayRecoveryPathIdentity(output, recovery, native);
  return join(output.stageDirectory.path, recovery.name);
}

function assertReplayRecoveryPathIdentity(
  output: StagedOutput,
  recovery: ReplayRecovery,
  native: NativeDirectoryOperations,
): void {
  const directoryAtPath = native.stat(output.stageDirectory.handle.fd, output.stageDirectory.path);
  const recoveryAtPath = native.stat(output.stageDirectory.handle.fd, recovery.name);
  if (
    directoryAtPath === undefined ||
    (directoryAtPath.mode & 0o170000) !== 0o040000 ||
    !sameIdentity(output.stageDirectory, directoryAtPath) ||
    recoveryAtPath === undefined ||
    !isRegularFileMode(recoveryAtPath.mode) ||
    !sameIdentity(recovery, recoveryAtPath) ||
    (recoveryAtPath.mode & 0o777) !== 0o600
  ) {
    throw new Error('Baseline private replay recovery path changed after exact-byte verification.');
  }
}

async function createReplayRecovery(
  output: StagedOutput,
  native: NativeDirectoryOperations,
  name: string,
  source: {
    readonly expectedBytes: Threadnote5BaselineByteBinding;
    readonly handle: FileHandle;
  },
): Promise<ReplayRecovery> {
  await verifyParent(output.stageDirectory);
  const handle = await open(
    join(output.stageDirectory.path, name),
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    const expectedBytes = await copyThreadnote5BaselineBoundBytes(
      source.handle,
      source.expectedBytes,
      handle,
      REPLAY_RECOVERY_BYTE_DOMAIN,
    );
    await handle.sync();
    await verifyParent(output.stageDirectory);
    const handleInfo = await handle.stat({bigint: true});
    const pathInfo = native.stat(output.stageDirectory.handle.fd, name);
    const recovery = {
      device: handleInfo.dev,
      expectedBytes,
      handle,
      inode: handleInfo.ino,
      name,
    } satisfies ReplayRecovery;
    if (
      !handleInfo.isFile() ||
      pathInfo === undefined ||
      !isRegularFileMode(pathInfo.mode) ||
      !sameIdentity(recovery, pathInfo) ||
      sameIdentity(output, recovery) ||
      (handleInfo.mode & 0o777n) !== 0o600n
    ) {
      throw new Error('Baseline private replay recovery was not created as an independent private file.');
    }
    return recovery;
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
}

async function ensureRecoverableReplay(
  output: StagedOutput,
  native: NativeDirectoryOperations,
): Promise<string | undefined> {
  try {
    return await verifyReplayRecovery(output, native);
  } catch {
    // Recreate from the still-pinned exact replay bytes below.
  }
  if (output.expectedBytes === undefined) return undefined;
  try {
    try {
      await verifyParent(output.stageDirectory);
    } catch {
      await verifyParent(output.parent);
      const name = `.threadnote-baseline-stage-${randomBytes(16).toString('hex')}`;
      requireNativeCall(native.mkdir(output.parent.handle.fd, name, 0o700), 'recovery directory creation');
      const replacement = await openOutputParent(join(output.parent.path, name));
      const previous = output.stageDirectory;
      output.stageDirectory = replacement;
      output.stageEntry = {kind: 'untrusted'};
      await previous.handle.close();
    }
    let source: {readonly expectedBytes: Threadnote5BaselineByteBinding; readonly handle: FileHandle};
    try {
      await verifyThreadnote5BaselineBoundBytes(output.handle, output.expectedBytes, 'Baseline private replay');
      source = {expectedBytes: output.expectedBytes, handle: output.handle};
    } catch (privateCause) {
      const recovery = output.recovery;
      if (recovery === undefined) throw privateCause;
      await verifyThreadnote5BaselineBoundBytes(
        recovery.handle,
        recovery.expectedBytes,
        'Baseline private replay recovery',
      );
      source = recovery;
    }
    const replacement = await createReplayRecovery(
      output,
      native,
      `replay-recovery-${randomBytes(16).toString('hex')}`,
      source,
    );
    const previous = output.recovery;
    output.recovery = replacement;
    await previous?.handle.close().catch(() => undefined);
    return await verifyReplayRecovery(output, native);
  } catch {
    return undefined;
  }
}

async function rollbackCommittedOutputs(
  evidence: StagedOutput,
  privateReplay: StagedOutput,
  native: NativeDirectoryOperations,
  hooks: Threadnote5BaselineOutputPublicationTestHooks,
): Promise<{readonly publicWithdrawn: boolean; readonly recoveryPath?: string}> {
  let publicWithdrawn = false;
  try {
    publicWithdrawn = rollbackOutput(evidence, native);
  } catch {
    // An unreadable public entry is not evidence that publication was withdrawn.
  }
  if (!publicWithdrawn) {
    await runCleanupHooks([evidence, privateReplay], hooks).catch(() => undefined);
    const recoveryPath = await ensureRecoverableReplay(privateReplay, native);
    for (const output of [evidence, privateReplay]) {
      output.state = recoveryPath === undefined ? 'preserved-unverified' : 'retained';
      output.stageEntry = {kind: 'untrusted'};
    }
    return recoveryPath === undefined ? {publicWithdrawn: false} : {publicWithdrawn: false, recoveryPath};
  }
  try {
    rollbackOutput(privateReplay, native);
  } catch {
    privateReplay.state = 'untrusted';
    privateReplay.stageEntry = {kind: 'untrusted'};
  }
  return {publicWithdrawn: true};
}

function rollbackOutput(output: StagedOutput, native: NativeDirectoryOperations): boolean {
  if (output.state === 'staged') return true;
  const destination = native.stat(output.parent.handle.fd, output.targetName);
  if (destination === undefined || !sameIdentity(output, destination)) {
    output.stageEntry = {kind: 'untrusted'};
    output.state = 'untrusted';
    return true;
  }
  const expected = output.destination.identity;
  if (expected !== undefined) {
    const displaced = native.stat(output.stageDirectory.handle.fd, output.stageName);
    if (displaced === undefined || !sameIdentity(expected, displaced)) return false;
  }
  const restored =
    expected === undefined
      ? native.noReplace(output.parent.handle.fd, output.targetName, output.stageDirectory.handle.fd, output.stageName)
      : native.exchange(output.stageDirectory.handle.fd, output.stageName, output.parent.handle.fd, output.targetName);
  const staged = native.stat(output.stageDirectory.handle.fd, output.stageName);
  const destinationAfterRestore = native.stat(output.parent.handle.fd, output.targetName);
  if (
    restored.ok &&
    staged !== undefined &&
    sameIdentity(output, staged) &&
    (expected === undefined
      ? destinationAfterRestore === undefined
      : destinationAfterRestore !== undefined && sameIdentity(expected, destinationAfterRestore))
  ) {
    output.stageEntry = {identity: output, kind: 'staged'};
    output.state = 'staged';
  } else {
    output.stageEntry = {kind: 'untrusted'};
    output.state = 'untrusted';
  }
  return destinationAfterRestore === undefined || !sameIdentity(output, destinationAfterRestore);
}

async function cleanupOutputs(
  outputs: readonly StagedOutput[],
  committed: boolean,
  native: NativeDirectoryOperations,
  hooks: Threadnote5BaselineOutputPublicationTestHooks,
): Promise<void> {
  let failure: unknown;
  for (const output of outputs) {
    const preserve = output.state === 'retained' || output.state === 'preserved-unverified';
    if (!committed && !preserve) {
      try {
        await output.handle.truncate(0);
        await output.handle.sync();
      } catch (cause) {
        failure ??= cause;
      }
    }
    if (output.recovery !== undefined && !preserve) {
      try {
        const recovery = native.stat(output.stageDirectory.handle.fd, output.recovery.name);
        if (recovery !== undefined && sameIdentity(output.recovery, recovery)) {
          requireNativeCall(
            native.unlink(output.stageDirectory.handle.fd, output.recovery.name, false),
            'replay recovery cleanup',
          );
        }
      } catch (cause) {
        failure ??= cause;
      }
    }
    try {
      await output.recovery?.handle.close();
    } catch (cause) {
      failure ??= cause;
    }
    const removableStageEntry = trustedStageEntryIdentity(output.stageEntry);
    if (removableStageEntry !== undefined) {
      try {
        const observed = native.stat(output.stageDirectory.handle.fd, output.stageName);
        if (observed !== undefined && sameIdentity(removableStageEntry, observed)) {
          requireNativeCall(native.unlink(output.stageDirectory.handle.fd, output.stageName, false), 'staging cleanup');
        }
      } catch (cause) {
        failure ??= cause;
      }
    }
    try {
      await output.handle.close();
    } catch (cause) {
      failure ??= cause;
    }
    try {
      await runCleanupHooks([output], hooks);
    } catch (cause) {
      failure ??= cause;
    }
    try {
      await output.stageDirectory.handle.close();
    } catch (cause) {
      failure ??= cause;
    }
    // No portable kernel primitive can remove this caller-visible directory
    // only if its pathname still names the pinned inode. Retain it deliberately.
    try {
      await output.parent.handle.close();
    } catch (cause) {
      failure ??= cause;
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error('Baseline output cleanup failed.', {cause: failure});
  }
}

async function runCleanupHooks(
  outputs: readonly StagedOutput[],
  hooks: Threadnote5BaselineOutputPublicationTestHooks,
): Promise<void> {
  let failure: unknown;
  for (const output of outputs) {
    if (output.cleanupHookRun) continue;
    output.cleanupHookRun = true;
    try {
      await hooks.beforeStageDirectoryCleanup?.(output.stageDirectory.path);
    } catch (cause) {
      failure ??= cause;
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error('Baseline cleanup hook failed.', {cause: failure});
  }
}

function trustedStageEntryIdentity(stageEntry: StageEntry): FileIdentity | undefined {
  return stageEntry.kind === 'staged' || stageEntry.kind === 'displaced' ? stageEntry.identity : undefined;
}

function assertDistinctOutputs(left: StagedOutput, right: StagedOutput): void {
  if (sameIdentity(left.parent, right.parent) && left.targetName === right.targetName) {
    throw new Error('Baseline evidence and private replay outputs must be different files.');
  }
}

function sameIdentity(
  left: FileIdentity,
  right: {readonly dev?: bigint; readonly device?: bigint; readonly ino?: bigint; readonly inode?: bigint},
): boolean {
  return left.device === (right.dev ?? right.device) && left.inode === (right.ino ?? right.inode);
}

function verifyAtomicRenameCapabilities(directory: number, native: NativeDirectoryOperations): void {
  const left = 'capability-left';
  const right = 'capability-right';
  const moved = 'capability-moved';
  try {
    requireNativeCall(native.mkdir(directory, left, 0o700), 'atomic capability probe setup');
    requireNativeCall(native.mkdir(directory, right, 0o700), 'atomic capability probe setup');
    requireNativeCall(native.exchange(directory, left, directory, right), 'atomic exchange capability probe');
    requireNativeCall(native.exchange(directory, left, directory, right), 'atomic exchange capability probe restore');
    requireNativeCall(native.noReplace(directory, left, directory, moved), 'atomic no-replace capability probe');
    requireNativeCall(
      native.noReplace(directory, moved, directory, left),
      'atomic no-replace capability probe restore',
    );
  } finally {
    for (const name of [left, right, moved]) native.unlink(directory, name, true);
  }
}

function requireNativeCall(result: NativeCallResult, operation: string): void {
  if (!result.ok) {
    throw new Error(
      `Baseline output ${operation} failed closed${result.errno === undefined ? '.' : ` (errno ${result.errno}).`}`,
    );
  }
}

function isRegularFileMode(mode: number): boolean {
  return (mode & 0o170000) === 0o100000;
}

function openNativeDirectoryOperations(): NativeDirectoryOperations {
  if (process.platform === 'darwin') return openDarwinDirectoryOperations();
  if (process.platform === 'linux') return openLinuxDirectoryOperations();
  throw new Error('Baseline output publication requires Darwin renameatx_np or Linux renameat2 atomic rename support.');
}

function openDarwinDirectoryOperations(): NativeDirectoryOperations {
  const fstatatSymbol = darwinFstatatSymbol(process.arch);
  const library = dlopen('/usr/lib/libSystem.B.dylib', {
    __error: {args: [], returns: 'ptr'},
    [fstatatSymbol]: {args: ['i32', 'cstring', 'ptr', 'i32'], returns: 'i32'},
    mkdirat: {args: ['i32', 'cstring', 'i32'], returns: 'i32'},
    renameatx_np: {args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32'},
    unlinkat: {args: ['i32', 'cstring', 'i32'], returns: 'i32'},
  });
  const result = (returnCode: number): NativeCallResult =>
    returnCode === 0 ? {ok: true} : {errno: nativeErrno(library.symbols.__error()), ok: false};
  const stat = (directory: number, name: string): RelativeEntry | undefined => {
    const bytes = new Uint8Array(256);
    const returnCode = library.symbols[fstatatSymbol](directory, name, bytes, 0x20);
    if (returnCode !== 0) {
      if (nativeErrno(library.symbols.__error()) === 2) return undefined;
      throw new Error('Baseline output descriptor-relative identity check failed closed.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      device: BigInt.asUintN(32, BigInt(view.getInt32(0, true))),
      inode: view.getBigUint64(8, true),
      mode: view.getUint16(4, true),
    };
  };
  return {
    close: () => library.close(),
    exchange: (leftDirectory, left, rightDirectory, right) =>
      result(library.symbols.renameatx_np(leftDirectory, left, rightDirectory, right, 0x2)),
    mkdir: (directory, name, mode) => result(library.symbols.mkdirat(directory, name, mode)),
    noReplace: (sourceDirectory, source, targetDirectory, target) =>
      result(library.symbols.renameatx_np(sourceDirectory, source, targetDirectory, target, 0x4)),
    stat,
    unlink: (directory, name, directoryEntry) =>
      result(library.symbols.unlinkat(directory, name, directoryEntry ? 0x80 : 0)),
  };
}

export function darwinFstatatSymbol(architecture: NodeJS.Architecture): 'fstatat' | 'fstatat$INODE64' {
  if (architecture === 'arm64') return 'fstatat';
  if (architecture === 'x64') return 'fstatat$INODE64';
  throw new Error(`Baseline output publication does not support Darwin ${architecture} ABI.`);
}

function openLinuxDirectoryOperations(): NativeDirectoryOperations {
  const library = dlopen('libc.so.6', {
    __errno_location: {args: [], returns: 'ptr'},
    mkdirat: {args: ['i32', 'cstring', 'i32'], returns: 'i32'},
    renameat2: {args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32'},
    statx: {args: ['i32', 'cstring', 'i32', 'u32', 'ptr'], returns: 'i32'},
    unlinkat: {args: ['i32', 'cstring', 'i32'], returns: 'i32'},
  });
  const result = (returnCode: number): NativeCallResult =>
    returnCode === 0 ? {ok: true} : {errno: nativeErrno(library.symbols.__errno_location()), ok: false};
  const stat = (directory: number, name: string): RelativeEntry | undefined => {
    const bytes = new Uint8Array(256);
    const returnCode = library.symbols.statx(directory, name, 0x100, 0x7ff, bytes);
    if (returnCode !== 0) {
      if (nativeErrno(library.symbols.__errno_location()) === 2) return undefined;
      throw new Error('Baseline output descriptor-relative identity check failed closed.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      device: linuxDeviceNumber(view.getUint32(136, true), view.getUint32(140, true)),
      inode: view.getBigUint64(32, true),
      mode: view.getUint16(28, true),
    };
  };
  return {
    close: () => library.close(),
    exchange: (leftDirectory, left, rightDirectory, right) =>
      result(library.symbols.renameat2(leftDirectory, left, rightDirectory, right, 0x2)),
    mkdir: (directory, name, mode) => result(library.symbols.mkdirat(directory, name, mode)),
    noReplace: (sourceDirectory, source, targetDirectory, target) =>
      result(library.symbols.renameat2(sourceDirectory, source, targetDirectory, target, 0x1)),
    stat,
    unlink: (directory, name, directoryEntry) =>
      result(library.symbols.unlinkat(directory, name, directoryEntry ? 0x200 : 0)),
  };
}

function nativeErrno(pointer: bigint | number | null): number {
  if (pointer === null) throw new Error('Baseline output native errno lookup failed closed.');
  return read.i32(pointer);
}

function linuxDeviceNumber(major: number, minor: number): bigint {
  const majorBits = BigInt(major);
  const minorBits = BigInt(minor);
  return (
    ((majorBits & 0xfffff000n) << 32n) |
    ((majorBits & 0xfffn) << 8n) |
    ((minorBits & 0xffffff00n) << 12n) |
    (minorBits & 0xffn)
  );
}
