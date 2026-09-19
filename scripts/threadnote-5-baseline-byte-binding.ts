/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Release evidence binds exact bytes through pinned file handles. */
import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';

export interface Threadnote5BaselineByteBinding {
  readonly byteLength: number;
  readonly domain: string;
  readonly sha256: string;
}

export interface Threadnote5BaselineByteReadTestHooks {
  readonly afterChunk?: (position: number) => Promise<void>;
  readonly beforeFinalStat?: () => Promise<void>;
}

export async function writeThreadnote5BaselineBoundBytes(
  handle: FileHandle,
  contents: string,
  domain: string,
): Promise<Threadnote5BaselineByteBinding> {
  const bytes = Buffer.from(contents, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, written);
    if (result.bytesWritten === 0) throw new Error('Baseline output write made no progress.');
    written += result.bytesWritten;
  }
  await handle.sync();
  const binding = bindingForBytes(bytes, domain);
  await verifyThreadnote5BaselineBoundBytes(handle, binding, 'Baseline output');
  return binding;
}

export async function copyThreadnote5BaselineBoundBytes(
  source: FileHandle,
  sourceBinding: Threadnote5BaselineByteBinding,
  destination: FileHandle,
  destinationDomain: string,
  hooks: Threadnote5BaselineByteReadTestHooks = {},
): Promise<Threadnote5BaselineByteBinding> {
  await verifyThreadnote5BaselineBoundBytes(source, sourceBinding, 'Baseline replay source');
  const before = await source.stat({bigint: true});
  const hash = domainHash(destinationDomain, sourceBinding.byteLength);
  const sourceHash = domainHash(sourceBinding.domain, sourceBinding.byteLength);
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  while (position < sourceBinding.byteLength) {
    const requested = Math.min(buffer.byteLength, sourceBinding.byteLength - position);
    const {bytesRead} = await source.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new Error('Baseline replay source ended before its bound byte length.');
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    sourceHash.update(chunk);
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(chunk, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) throw new Error('Baseline replay recovery write made no progress.');
      written += result.bytesWritten;
    }
    position += bytesRead;
    await hooks.afterChunk?.(position);
  }
  await destination.sync();
  await hooks.beforeFinalStat?.();
  const after = await source.stat({bigint: true});
  if (
    !stableFile(before, after) ||
    after.size !== BigInt(sourceBinding.byteLength) ||
    sourceHash.digest('hex') !== sourceBinding.sha256
  ) {
    throw new Error('Baseline replay source changed while its bound bytes were copied.');
  }
  const binding = {
    byteLength: sourceBinding.byteLength,
    domain: destinationDomain,
    sha256: hash.digest('hex'),
  } satisfies Threadnote5BaselineByteBinding;
  await verifyThreadnote5BaselineBoundBytes(destination, binding, 'Baseline replay recovery');
  return binding;
}

export async function verifyThreadnote5BaselineBoundBytes(
  handle: FileHandle,
  binding: Threadnote5BaselineByteBinding,
  label: string,
  hooks: Threadnote5BaselineByteReadTestHooks = {},
): Promise<void> {
  const before = await handle.stat({bigint: true});
  if (!before.isFile() || before.size !== BigInt(binding.byteLength)) {
    throw new Error(`${label} byte length changed after it was bound.`);
  }
  const hash = domainHash(binding.domain, binding.byteLength);
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  while (position < binding.byteLength) {
    const requested = Math.min(buffer.byteLength, binding.byteLength - position);
    const {bytesRead} = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) throw new Error(`${label} ended before its bound byte length.`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    await hooks.afterChunk?.(position);
  }
  await hooks.beforeFinalStat?.();
  const after = await handle.stat({bigint: true});
  if (
    !stableFile(before, after) ||
    after.size !== BigInt(binding.byteLength) ||
    hash.digest('hex') !== binding.sha256
  ) {
    throw new Error(`${label} bytes changed after they were bound.`);
  }
}

function stableFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.isFile() &&
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.ctimeNs === after.ctimeNs &&
    before.mtimeNs === after.mtimeNs
  );
}

function bindingForBytes(bytes: Uint8Array, domain: string): Threadnote5BaselineByteBinding {
  return {
    byteLength: bytes.byteLength,
    domain,
    sha256: domainHash(domain, bytes.byteLength).update(bytes).digest('hex'),
  };
}

function domainHash(domain: string, byteLength: number) {
  return createHash('sha256').update(`${domain}\0${byteLength}\0`, 'utf8');
}
