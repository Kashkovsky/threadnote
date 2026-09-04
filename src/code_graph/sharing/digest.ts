import {sha256HexSync} from '../../crypto/sha256.js';
import {graphSharingFailure} from './errors.js';

export const SHA256_HEX = /^[0-9a-f]{64}$/u;
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type Sha256Digest = `sha256:${string}`;

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  return `sha256:${sha256HexSync(value)}`;
}

export function parseSha256Digest(value: string, label = 'Digest'): Sha256Digest {
  const trimmed = value.trim();
  if (SHA256_DIGEST.test(trimmed)) return trimmed as Sha256Digest;
  if (SHA256_HEX.test(trimmed)) return `sha256:${trimmed}`;
  throw graphSharingFailure(`${label} must be a SHA-256 digest.`);
}

export function sha256HexFromDigest(digest: string): string {
  const parsed = parseSha256Digest(digest);
  return parsed.slice('sha256:'.length);
}
