import {sha256HexSync} from '../crypto/sha256.js';
import {
  boundedText,
  compareStrings,
  exactKeys,
  hashArray,
  invalid,
  literal,
  matchingHash,
  normalizeContextBriefProxyRequest,
  normalizeJsonValue,
  protocolDigest,
  protocolVersion,
  record,
  unique,
  type CanonicalJsonValue,
} from './code-memory-link-agent-protocol-primitives.js';

export type CodeMemoryLinkContextBriefProxyDecisionV1 =
  | {
      readonly action: 'forward';
      readonly request: Readonly<Record<string, unknown>>;
      readonly requestHash: string;
    }
  | {
      readonly action: 'return-empty';
      readonly response: typeof CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1;
      readonly responseHash: string;
    };

export interface CodeMemoryLinkContextBriefProxyReceiptV1 {
  readonly armPacketHash: string;
  readonly proxyDecisionHash: string;
  readonly rawRequestHash: string;
  readonly responseHash: string;
  readonly runBindingHash: string;
  readonly version: 1;
}

export const CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1 = Object.freeze({
  content: Object.freeze([]) as readonly never[],
  structuredContent: Object.freeze({
    evidenceCount: 0,
    state: 'empty',
    type: 'code-memory-link-context-brief-proxy',
    version: 1 as const,
  }),
});

export type CodeMemoryLinkContextBriefResponseClassV1 = 'anchored-v3' | 'empty-v1' | 'task-v2';

export interface CodeMemoryLinkSelectedMemoryReceiptV1 {
  readonly contentSha256: string;
  readonly memoryIdDigest: string;
}

export interface CodeMemoryLinkContextBriefResponseReceiptV1 {
  readonly citationDigests: readonly string[];
  readonly directCurrentRelationDigests: readonly string[];
  readonly modelVisibleContentHash: string;
  readonly responseClass: CodeMemoryLinkContextBriefResponseClassV1;
  readonly selectedMemories: readonly CodeMemoryLinkSelectedMemoryReceiptV1[];
  readonly structuredContentHash: string;
}

export interface CodeMemoryLinkCodexContextBriefCallProjectionV1 {
  readonly associatedStep: number;
  readonly associatedTokens: number;
  readonly beforeQualifyingAction: boolean;
  readonly callIdDigest: string;
  readonly goldCitationCount: number;
  readonly goldCitationMatched: boolean;
  readonly modelVisibleContentHash: string | null;
  readonly responseClass: CodeMemoryLinkContextBriefResponseClassV1 | null;
  readonly structuredContentHash: string | null;
  readonly succeeded: boolean;
}

export function codeMemoryLinkContextBriefRawRequestHashV1(value: unknown): string {
  return protocolDigest('context-brief-raw-request', normalizeJsonValue(value, 'Context Brief raw request'));
}

export function codeMemoryLinkContextBriefProxyDecisionHashV1(value: unknown): string {
  const decision = record(value, 'Context Brief proxy decision');
  return protocolDigest('context-brief-proxy-decision', normalizeJsonValue(decision, 'Context Brief proxy decision'));
}

export function parseCodeMemoryLinkContextBriefProxyReceiptV1(
  value: unknown,
): CodeMemoryLinkContextBriefProxyReceiptV1 {
  const receipt = record(value, 'Context Brief proxy receipt');
  exactKeys(
    receipt,
    ['armPacketHash', 'proxyDecisionHash', 'rawRequestHash', 'responseHash', 'runBindingHash', 'version'],
    'Context Brief proxy receipt',
  );
  return {
    armPacketHash: matchingHash(receipt.armPacketHash, 'proxy arm packet'),
    proxyDecisionHash: matchingHash(receipt.proxyDecisionHash, 'proxy decision'),
    rawRequestHash: matchingHash(receipt.rawRequestHash, 'proxy raw request'),
    responseHash: matchingHash(receipt.responseHash, 'proxy response'),
    runBindingHash: matchingHash(receipt.runBindingHash, 'proxy run binding'),
    version: protocolVersion(receipt.version, 'Context Brief proxy receipt'),
  };
}

export function codeMemoryLinkGoldCitationDigest(citationId: string): string {
  return protocolDigest('gold-citation-id', boundedText(citationId, 'citation id', 256));
}

/** Canonicalize and summarize exactly what the MCP client shows to the model. */
export function canonicalizeCodeMemoryLinkContextBriefResultV1(structuredInput: unknown): {
  readonly content: readonly {readonly text: string; readonly type: 'text'}[];
  readonly receipt: CodeMemoryLinkContextBriefResponseReceiptV1;
  readonly structuredContent: Readonly<Record<string, CanonicalJsonValue>>;
} {
  const normalized = normalizeJsonValue(structuredInput, 'Context Brief structured content');
  const brief = record(normalized, 'Context Brief structured content') as Record<string, CanonicalJsonValue>;
  let responseClass: CodeMemoryLinkContextBriefResponseClassV1;
  if (brief.type === 'code-memory-link-context-brief-proxy') {
    if (brief.version !== 1 || brief.state !== 'empty' || brief.evidenceCount !== 0) {
      invalid('no-memory proxy returned a non-canonical empty Context Brief');
    }
    responseClass = 'empty-v1';
  } else {
    if (brief.type !== 'context-brief' || (brief.version !== 2 && brief.version !== 3)) {
      invalid('successful proxy result is not a supported Context Brief');
    }
    responseClass = brief.version === 2 ? 'task-v2' : 'anchored-v3';
  }
  const content =
    responseClass === 'empty-v1'
      ? []
      : ([{text: `Context Brief JSON:\n${JSON.stringify(brief)}`, type: 'text' as const}] as const);
  const citationDigests: string[] = [];
  const directCurrentRelationDigests: string[] = [];
  const selectedMemories: CodeMemoryLinkSelectedMemoryReceiptV1[] = [];
  if (responseClass !== 'empty-v1') {
    if (!Array.isArray(brief.durableDecisions) || !Array.isArray(brief.activeHandoffs)) {
      invalid('Context Brief result is missing its memory evidence arrays');
    }
    const memories = [...brief.durableDecisions, ...brief.activeHandoffs];
    if (memories.length > 256) invalid('Context Brief result contains too many memory evidence entries');
    for (const [index, candidate] of memories.entries()) {
      const memory = record(candidate, `Context Brief memory ${index + 1}`);
      const uri = boundedText(memory.uri, 'Context Brief memory URI', 2_048);
      if (!uri.startsWith('threadnote://')) invalid('Context Brief memory identity is not a Threadnote URI');
      const excerpt = boundedText(memory.excerpt, 'Context Brief memory excerpt', 16 * 1_024);
      selectedMemories.push({
        contentSha256: sha256HexSync(excerpt),
        memoryIdDigest: protocolDigest('selected-memory-id', uri),
      });
      const receipts = memory.citationReceipts;
      if (receipts !== undefined && (!Array.isArray(receipts) || receipts.length > 64)) {
        invalid('Context Brief memory citation receipts must be a bounded array');
      }
      const currentReceipts = (receipts ?? []).flatMap((candidateReceipt, receiptIndex) => {
        const receipt = record(candidateReceipt, `Context Brief citation receipt ${receiptIndex + 1}`);
        if (receipt.status !== 'exact' && receipt.status !== 'relocated') return [];
        return [
          {citationId: boundedText(receipt.citationId, 'Context Brief citation id', 256), status: receipt.status},
        ];
      });
      citationDigests.push(...currentReceipts.map(receipt => codeMemoryLinkGoldCitationDigest(receipt.citationId)));
      if (responseClass === 'task-v2' && memory.selectionBasis === 'code-citation') {
        invalid('task-only Context Brief v2 cannot contain code-selected memory');
      }
      if (responseClass === 'anchored-v3' && memory.selectionBasis === 'code-citation') {
        if (
          !Array.isArray(memory.codeRelations) ||
          memory.codeRelations.length === 0 ||
          memory.codeRelations.length > 8
        ) {
          invalid('code-selected Context Brief v3 memory is missing bounded code relations');
        }
        for (const [relationIndex, candidateRelation] of memory.codeRelations.entries()) {
          const relation = record(candidateRelation, `Context Brief code relation ${relationIndex + 1}`);
          const citationId = boundedText(relation.citationId, 'Context Brief code relation citation id', 256);
          if (relation.status !== 'exact' && relation.status !== 'relocated') continue;
          if (
            !currentReceipts.some(receipt => receipt.citationId === citationId && receipt.status === relation.status)
          ) {
            invalid('Context Brief v3 code relation is inconsistent with its citation receipts');
          }
          directCurrentRelationDigests.push(codeMemoryLinkGoldCitationDigest(citationId));
        }
      }
    }
  }
  selectedMemories.sort((left, right) =>
    left.memoryIdDigest < right.memoryIdDigest
      ? -1
      : left.memoryIdDigest > right.memoryIdDigest
        ? 1
        : compareStrings(left.contentSha256, right.contentSha256),
  );
  unique(
    selectedMemories.map(memory => memory.memoryIdDigest),
    'Context Brief selected memory identities',
  );
  return {
    content,
    receipt: {
      citationDigests: [...new Set(citationDigests)].sort(compareStrings),
      directCurrentRelationDigests: [...new Set(directCurrentRelationDigests)].sort(compareStrings),
      modelVisibleContentHash: sha256HexSync(JSON.stringify(content)),
      responseClass,
      selectedMemories,
      structuredContentHash: sha256HexSync(JSON.stringify(brief)),
    },
    structuredContent: brief,
  };
}

export function parseCodeMemoryLinkContextBriefResponseReceiptV1(
  value: unknown,
): CodeMemoryLinkContextBriefResponseReceiptV1 {
  const receipt = record(value, 'Context Brief response receipt');
  exactKeys(
    receipt,
    [
      'citationDigests',
      'directCurrentRelationDigests',
      'modelVisibleContentHash',
      'responseClass',
      'selectedMemories',
      'structuredContentHash',
    ],
    'Context Brief response receipt',
  );
  if (!Array.isArray(receipt.selectedMemories) || receipt.selectedMemories.length > 24) {
    invalid('Context Brief selected-memory receipt roster is invalid');
  }
  const selectedMemories = receipt.selectedMemories.map((value, index) => {
    const memory = record(value, `Context Brief selected-memory receipt ${index + 1}`);
    exactKeys(memory, ['contentSha256', 'memoryIdDigest'], `Context Brief selected-memory receipt ${index + 1}`);
    return {
      contentSha256: matchingHash(memory.contentSha256, 'selected memory content'),
      memoryIdDigest: matchingHash(memory.memoryIdDigest, 'selected memory identity'),
    };
  });
  if (
    selectedMemories.some(
      (entry, index) =>
        index > 0 &&
        (selectedMemories[index - 1]!.memoryIdDigest > entry.memoryIdDigest ||
          (selectedMemories[index - 1]!.memoryIdDigest === entry.memoryIdDigest &&
            selectedMemories[index - 1]!.contentSha256 >= entry.contentSha256)),
    )
  ) {
    invalid('Context Brief selected-memory receipt roster is not unique canonical order');
  }
  unique(
    selectedMemories.map(memory => memory.memoryIdDigest),
    'Context Brief selected-memory receipt identities',
  );
  return {
    citationDigests: hashArray(receipt.citationDigests, 'response citation digests', 64),
    directCurrentRelationDigests: hashArray(
      receipt.directCurrentRelationDigests,
      'response direct current relation digests',
      64,
    ),
    modelVisibleContentHash: matchingHash(receipt.modelVisibleContentHash, 'model-visible Context Brief content'),
    responseClass: literal(
      receipt.responseClass,
      ['anchored-v3', 'empty-v1', 'task-v2'] as const,
      'Context Brief response class',
    ),
    selectedMemories,
    structuredContentHash: matchingHash(receipt.structuredContentHash, 'Context Brief structured content'),
  };
}

export function codeMemoryLinkContextBriefResponseReceiptHashV1(value: unknown): string {
  return protocolDigest('context-brief-response-receipt', parseCodeMemoryLinkContextBriefResponseReceiptV1(value));
}

export function projectParsedCodeMemoryLinkContextBriefRequestV1(input: {
  readonly policy: 'anchored' | 'task-only' | 'no-memory';
  readonly prompt: string;
  readonly request: unknown;
}): CodeMemoryLinkContextBriefProxyDecisionV1 {
  const request = normalizeContextBriefProxyRequest(input.request, input.prompt);
  if (input.policy === 'no-memory') {
    return {
      action: 'return-empty',
      response: CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1,
      responseHash: protocolDigest('canonical-empty-context-brief', CODE_MEMORY_LINK_CANONICAL_EMPTY_CONTEXT_BRIEF_V1),
    };
  }
  const forwarded =
    input.policy === 'task-only'
      ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'codeRefs'))
      : request;
  return {
    action: 'forward',
    request: forwarded,
    requestHash: protocolDigest('context-brief-proxy-request', forwarded),
  };
}
