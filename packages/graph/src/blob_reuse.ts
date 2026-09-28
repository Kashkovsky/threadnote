import type {CodeGraphInventoryFile} from './types.js';
import {isLowSignalStructuredPath} from './languages/schemas/policy.js';

const GIT_BLOB_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FULL_STRUCTURED_OBJECT_BYTES_MAXIMUM = 4 * 1_048_576;
const STRUCTURED_OBJECT_LANGUAGES = new Set(['json', 'jsonc', 'yaml']);

export type CodeGraphBlobReuseFile = Pick<CodeGraphInventoryFile, 'contentHash' | 'path'> &
  Partial<Pick<CodeGraphInventoryFile, 'blobId' | 'contentOmittedReason' | 'language' | 'size' | 'source'>>;

/**
 * Returns a versioned extraction class only when the raw parser result is
 * location-independent apart from identities derived from the repository path.
 */
export function codeGraphBlobExtractionReuseClass(file: CodeGraphBlobReuseFile): string | undefined {
  if (
    file.source !== 'commit' ||
    file.contentOmittedReason !== undefined ||
    file.blobId === undefined ||
    !GIT_BLOB_OID.test(file.blobId) ||
    file.language === undefined ||
    !STRUCTURED_OBJECT_LANGUAGES.has(file.language) ||
    isLowSignalStructuredPath(file.path) ||
    file.size === undefined ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > FULL_STRUCTURED_OBJECT_BYTES_MAXIMUM
  ) {
    return undefined;
  }
  return `structured-object-v1:${file.language}:full`;
}

export function codeGraphBlobReuseCacheKey(file: CodeGraphBlobReuseFile, extractorSet: string): string | undefined {
  const reuseClass = codeGraphBlobExtractionReuseClass(file);
  return reuseClass === undefined
    ? undefined
    : codeGraphStoredBlobReuseCacheKey(file.blobId!, file.contentHash, extractorSet, reuseClass);
}

export function codeGraphStoredBlobReuseCacheKey(
  blobId: string,
  contentHash: string,
  extractorSet: string,
  reuseClass: string,
): string {
  return `blob\0${blobId}\0${contentHash}\0${extractorSet}\0${reuseClass}`;
}
