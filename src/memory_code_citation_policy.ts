import {MEMORY_CODE_CITATION_HEADER} from './memory_code_citation.js';
import {parseMemoryDocument, type MemoryMetadata} from './memory_document.js';

export type MemoryCodeCitationSharingBlocker = 'dirty-source' | 'local-repository-identity' | 'malformed-citation';

/**
 * Only clean citations backed by a portable remote repository identity may
 * cross a sharing boundary. The immutable citation itself is preserved.
 */
export function memoryCodeCitationSharingBlocker(
  metadata: Pick<MemoryMetadata, 'citationErrors' | 'codeCitations'>,
): MemoryCodeCitationSharingBlocker | undefined {
  if ((metadata.citationErrors?.length ?? 0) > 0) return 'malformed-citation';
  if (metadata.codeCitations?.some(citation => citation.sourceDirty)) return 'dirty-source';
  if (metadata.codeCitations?.some(citation => citation.repositoryIdentityKind !== 'remote')) {
    return 'local-repository-identity';
  }
  return undefined;
}

/** Fail closed when an otherwise-unparseable memory still declares citation metadata. */
export function memoryCodeCitationContentSharingBlocker(
  uri: string,
  content: string,
): MemoryCodeCitationSharingBlocker | undefined {
  const shapedHeader = inspectCodeCitationHeaderShape(content);
  const parsed = parseMemoryDocument(uri, content);
  if (parsed) {
    const blocker = memoryCodeCitationSharingBlocker(parsed.metadata);
    if (blocker) return blocker;
    return shapedHeader.hasNonCanonical ? 'malformed-citation' : undefined;
  }
  return shapedHeader.hasCitationShape ? 'malformed-citation' : undefined;
}

export function memoryCodeCitationSharingBlockerMessage(blocker: MemoryCodeCitationSharingBlocker): string {
  switch (blocker) {
    case 'dirty-source':
      return 'code citations captured from a dirty worktree cannot be shared; commit the cited source and recapture';
    case 'local-repository-identity':
      return 'code citations without a portable remote repository identity cannot be shared';
    case 'malformed-citation':
      return 'malformed code citation metadata must be repaired or recaptured before sharing';
  }
}

function inspectCodeCitationHeaderShape(content: string): {
  readonly hasCitationShape: boolean;
  readonly hasNonCanonical: boolean;
} {
  const canonical = content.trim().replace(/\r\n?/gu, '\n');
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const prefix = `${MEMORY_CODE_CITATION_HEADER}:`;
  let hasCitationShape = false;
  let hasNonCanonical = false;
  for (const line of header.split('\n')) {
    if (!/^\s*code_citation\s*:/u.test(line)) continue;
    hasCitationShape = true;
    if (!line.startsWith(`${prefix} `)) hasNonCanonical = true;
  }
  return {hasCitationShape, hasNonCanonical};
}
