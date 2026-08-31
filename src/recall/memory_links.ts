import {sha256HexSync} from '../crypto/sha256.js';
import {parseMemoryDocument, type MemoryRelation, type MemoryRelationType} from '../memory/document.js';
import {isMemoryId, memoryIdFromIdentityAlias} from '../memory/identity_alias.js';
import {parseResourceId} from '../storage/resource-id.js';

export const MAX_INDEXED_MEMORY_LINKS_PER_SOURCE = 64;

export type RecallMemoryLinkOrigin = 'evidence' | 'references' | 'relation' | 'supersedes';

export interface IndexedRecallMemoryLink {
  readonly relationOrdinal: number;
  readonly relationOrigin: RecallMemoryLinkOrigin;
  readonly relationType: MemoryRelationType;
  readonly sourceMemoryId: string;
  /** Stable identity selectors use this field directly. Legacy locators are resolved during refresh. */
  readonly targetMemoryId: string;
  /** Present for every legacy canonical URI, including when its current target resolves. */
  readonly targetLocatorDigest: string;
}

export interface IndexedRecallMemoryLinkProjection {
  readonly links: readonly IndexedRecallMemoryLink[];
  readonly truncated: boolean;
}

interface OriginRelation extends MemoryRelation {
  readonly ordinal: number;
  readonly origin: RecallMemoryLinkOrigin;
}

/** Project canonical metadata into privacy-safe, rebuildable memory-edge selectors. */
export function deriveIndexedRecallMemoryLinks(
  memory: ReturnType<typeof parseMemoryDocument>,
): IndexedRecallMemoryLinkProjection {
  if (!memory) return {links: [], truncated: false};
  const sourceMemoryId = isMemoryId(memory.metadata.memoryId ?? '') ? memory.metadata.memoryId! : '';
  // Preserve explicit authoring and supersession before lower-priority legacy
  // provenance so a noisy imported header cannot starve currentness evidence.
  const relations: OriginRelation[] = [
    ...(memory.metadata.supersedes
      ? [{ordinal: 0, origin: 'supersedes' as const, type: 'supersedes' as const, uri: memory.metadata.supersedes}]
      : []),
    ...(memory.metadata.relations ?? []).map((relation, ordinal) => ({
      ...relation,
      ordinal,
      origin: 'relation' as const,
    })),
    ...(memory.metadata.references ?? []).map((uri, ordinal) => ({
      ordinal,
      origin: 'references' as const,
      type: 'references' as const,
      uri,
    })),
    ...(memory.metadata.evidence ?? []).flatMap((uri, ordinal) =>
      uri.startsWith('threadnote://')
        ? [{ordinal, origin: 'evidence' as const, type: 'evidence_for' as const, uri}]
        : [],
    ),
  ];
  const projected = relations.flatMap(relation => {
    let uri: string;
    try {
      uri = parseResourceId(relation.uri).canonicalUri;
    } catch {
      return [];
    }
    const targetMemoryId = memoryIdFromIdentityAlias(uri);
    return [
      {
        relationOrdinal: relation.ordinal,
        relationOrigin: relation.origin,
        relationType: relation.type,
        sourceMemoryId,
        targetLocatorDigest: targetMemoryId === undefined ? memoryLinkLocatorDigest(uri) : '',
        targetMemoryId: targetMemoryId ?? '',
      } satisfies IndexedRecallMemoryLink,
    ];
  });
  const selected = projected.slice(0, MAX_INDEXED_MEMORY_LINKS_PER_SOURCE);
  return {
    links: selected,
    truncated: projected.length > selected.length,
  };
}

/** Domain separation prevents these private locator hashes from being confused with other selectors. */
export function memoryLinkLocatorDigest(uri: string): string {
  const canonicalUri = parseResourceId(uri).canonicalUri;
  return sha256HexSync(JSON.stringify({kind: 'memory-link-locator', uri: canonicalUri, version: 1}));
}
