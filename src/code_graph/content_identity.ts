import {sha256HexSync} from '../crypto/sha256.js';
import type {RepositoryIdentity} from './types.js';

export interface CodeGraphCommittedFileContentHasher {
  readonly digest: () => string;
  readonly update: (bytes: Uint8Array) => void;
}

/**
 * Current graph snapshots key every file by a SHA-256 envelope around its Git
 * blob identity. Raw byte SHA-256 remains accepted while reading source so a
 * pre-fix dirty snapshot can be verified safely before it is rebuilt.
 */
export function codeGraphFileContentHashMatchesBytes(
  expectedHash: string,
  objectFormat: RepositoryIdentity['objectFormat'],
  bytes: Uint8Array,
): boolean {
  return (
    expectedHash === sha256HexSync(bytes) || expectedHash === codeGraphCommittedFileContentHash(objectFormat, bytes)
  );
}

export function codeGraphCommittedFileContentHash(
  objectFormat: RepositoryIdentity['objectFormat'],
  bytes: Uint8Array,
): string {
  const hasher = createCodeGraphCommittedFileContentHasher(objectFormat, bytes.byteLength);
  hasher.update(bytes);
  return hasher.digest();
}

export function createCodeGraphCommittedFileContentHasher(
  objectFormat: RepositoryIdentity['objectFormat'],
  byteLength: number,
): CodeGraphCommittedFileContentHasher {
  const hasher = new Bun.CryptoHasher(objectFormat);
  hasher.update(`blob ${byteLength}\0`);
  return {
    digest: () => codeGraphCommittedContentHash(objectFormat, hasher.digest('hex')),
    update: bytes => void hasher.update(bytes),
  };
}

export function codeGraphCommittedContentHash(
  objectFormat: RepositoryIdentity['objectFormat'],
  blobId: string,
): string {
  return sha256HexSync(`git-object-v1\n${objectFormat}\n${blobId}`);
}
