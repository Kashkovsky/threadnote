/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed evaluation helper owns exact byte-level fixture isolation. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, chmod, cp, lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, sep} from 'node:path';

export {access, isAbsolute, join, realpath};

export interface PinnedBaselineExecutable {
  readonly device: bigint;
  readonly inode: bigint;
  readonly path: string;
  readonly sha256: string;
  readonly size: bigint;
}

export interface BaselineExecutableReadTestHooks {
  readonly beforeFinalStat?: () => Promise<void>;
}

export interface BaselineNativeExecutionBoundary {
  readonly interpreter: string;
  readonly path: string;
  readonly source: string;
}

export async function prepareBaselineNativeExecutionBoundary(root: string): Promise<BaselineNativeExecutionBoundary> {
  const interpreter = await realpath(
    process.platform === 'darwin'
      ? '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/Current/Resources/Python.app/Contents/MacOS/Python'
      : '/usr/bin/python3',
  );
  for (let path = interpreter; ; path = dirname(path)) {
    const info = await lstat(path);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0 || info.isSymbolicLink()) {
      throw new Error('Baseline execution requires a root-owned interpreter and non-writable ancestor directories.');
    }
    if (path === '/') break;
  }
  const source = await readFile(new URL('./support/threadnote-5-baseline-native.py', import.meta.url), 'utf8');
  const path = join(root, 'descriptor-exec.py');
  await writeBaselinePrivateFile(path, source);
  return {interpreter, path, source};
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, {dereference: false, errorOnExist: true, force: false, recursive: true});
}

export async function makeBaselineTemporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  await chmod(path, 0o700);
  return path;
}

export async function removeBaselineTemporaryDirectory(path: string): Promise<void> {
  await rm(path, {force: true, recursive: true});
}

export async function hashBaselineFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const {sha256} = await hashOrdinaryFileHandle(handle);
    return sha256;
  } finally {
    await handle.close();
  }
}

export async function pinBaselineExecutableCopy(
  sourcePath: string,
  destinationPath: string,
  expectedSha256: string,
): Promise<PinnedBaselineExecutable> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination;
  try {
    const sourceBefore = await source.stat({bigint: true});
    assertOrdinaryFile(sourceBefore, 'Baseline executable');
    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o500,
    );
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let sourcePosition = 0;
    let size = 0n;
    while (true) {
      const {bytesRead} = await source.read(buffer, 0, buffer.byteLength, sourcePosition);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(chunk, written, bytesRead - written);
        written += result.bytesWritten;
      }
      sourcePosition += bytesRead;
      size += BigInt(bytesRead);
    }
    const sourceAfter = await source.stat({bigint: true});
    if (!sameFileVersion(sourceBefore, sourceAfter) || sourceAfter.size !== size) {
      throw new Error('Baseline executable changed while its reviewed bytes were being pinned.');
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedSha256) {
      throw new Error('Baseline executable bytes do not match the independently supplied expected hash.');
    }
    await destination.sync();
    await destination.chmod(0o500);
    const destinationInfo = await destination.stat({bigint: true});
    assertOrdinaryFile(destinationInfo, 'Pinned baseline executable');
    const identity = {
      device: destinationInfo.dev,
      inode: destinationInfo.ino,
      path: destinationPath,
      sha256,
      size: destinationInfo.size,
    };
    await destination.close();
    destination = undefined;
    await verifyPinnedBaselineExecutable(identity);
    return identity;
  } finally {
    await source.close();
    await destination?.close();
  }
}

export async function verifyPinnedBaselineExecutable(
  identity: PinnedBaselineExecutable,
  hooks: BaselineExecutableReadTestHooks = {},
): Promise<void> {
  const handle = await open(identity.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await verifyPinnedBaselineExecutableHandle(identity, handle, hooks);
  } finally {
    await handle.close();
  }
}

export async function withPinnedBaselineExecutableDescriptor<T>(
  identity: PinnedBaselineExecutable,
  use: (descriptor: number, verify: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const handle = await open(identity.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const verify = (): Promise<void> => verifyPinnedBaselineExecutableHandle(identity, handle);
    await verify();
    const result = await use(handle.fd, verify);
    await verify();
    return result;
  } finally {
    await handle.close();
  }
}

export async function writeBaselinePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, {encoding: 'utf8', flag: 'wx', mode: 0o600});
}

export async function hashBaselineFixtureTree(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const hash = createHash('sha256');
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, {withFileTypes: true})).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relative = path
        .slice(canonicalRoot.length + 1)
        .split(sep)
        .join('/');
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error('Baseline fixtures may contain only ordinary directories and files.');
      }
      if (info.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await visit(path);
      } else {
        hash.update(`file\0${relative}\0${info.size}\0`);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.allocUnsafe(64 * 1_024);
          let position = 0;
          while (true) {
            const {bytesRead} = await handle.read(buffer, 0, buffer.byteLength, position);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
        } finally {
          await handle.close();
        }
      }
    }
  };
  await visit(canonicalRoot);
  return hash.digest('hex');
}

async function hashOrdinaryFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  hooks: BaselineExecutableReadTestHooks = {},
): Promise<{readonly sha256: string; readonly size: bigint}> {
  const before = await handle.stat({bigint: true});
  assertOrdinaryFile(before, 'Baseline executable');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  while (true) {
    const {bytesRead} = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  await hooks.beforeFinalStat?.();
  const after = await handle.stat({bigint: true});
  if (!sameFileVersion(before, after) || after.size !== BigInt(position)) {
    throw new Error('Baseline executable changed while it was being hashed.');
  }
  return {sha256: hash.digest('hex'), size: after.size};
}

async function verifyPinnedBaselineExecutableHandle(
  identity: PinnedBaselineExecutable,
  handle: Awaited<ReturnType<typeof open>>,
  hooks: BaselineExecutableReadTestHooks = {},
): Promise<void> {
  const observed = await handle.stat({bigint: true});
  assertOrdinaryFile(observed, 'Pinned baseline executable');
  if (
    observed.dev !== identity.device ||
    observed.ino !== identity.inode ||
    observed.size !== identity.size ||
    (await hashOrdinaryFileHandle(handle, hooks)).sha256 !== identity.sha256
  ) {
    throw new Error('Pinned baseline executable identity or bytes changed.');
  }
}

function assertOrdinaryFile(info: {readonly isFile: () => boolean}, label: string): void {
  if (!info.isFile()) throw new Error(`${label} must be an ordinary file.`);
}

function sameFileVersion(
  left: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly ctimeNs: bigint;
    readonly mtimeNs: bigint;
  },
  right: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly ctimeNs: bigint;
    readonly mtimeNs: bigint;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}
