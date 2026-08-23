import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  decodeCodeGraphInventoryReuseReceipt,
  encodeCodeGraphInventoryReuseReceipt,
} from '../../src/code_graph/inventory_reuse.js';
import {CODE_GRAPH_INVENTORY_EXCLUSION_REASONS} from '../../src/code_graph/inventory_policy.js';
import {CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION} from '../../src/code_graph/store_models.js';
import {mergeCodeGraphWorkspaces} from '../../src/code_graph/workspace.js';

const emptyWorkspace = mergeCodeGraphWorkspaces([]);

describe('code graph inventory reuse receipts', () => {
  it.prop(
    'round-trips bounded admission evidence without changing its normalized workspace',
    {
      diagnostics: FC.array(FC.string({maxLength: 80}), {maxLength: 8}),
      skipped: FC.integer({max: 1_000_000, min: 0}),
    },
    ({diagnostics, skipped}) => {
      const receipt = {
        attributionFiles: [
          {
            blobId: 'blob:package',
            content: '{"name":"fixture"}',
            contentHash: 'c'.repeat(64),
            language: 'json',
            mode: '100644',
            path: 'package.json',
            size: 18,
            source: 'commit' as const,
          },
        ],
        contract: 'a'.repeat(64),
        diagnostics,
        environmentFingerprint: 'b'.repeat(64),
        includeOpaqueCorpusAssets: true,
        policyExclusions: {
          bytes: 0,
          files: 0,
          policyVersion: 1,
          reasons: CODE_GRAPH_INVENTORY_EXCLUSION_REASONS.map(reason => ({bytes: 0, files: 0, reason})),
        },
        skipped,
        version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
        workspace: emptyWorkspace,
      } as const;

      expect(decodeCodeGraphInventoryReuseReceipt(encodeCodeGraphInventoryReuseReceipt(receipt))).toEqual(receipt);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'rejects arbitrary non-receipt payloads instead of trusting persisted JSON',
    {payload: FC.string({maxLength: 2_000}).filter(payload => !payload.trimStart().startsWith('{'))},
    ({payload}) => {
      expect(decodeCodeGraphInventoryReuseReceipt(payload)).toBeUndefined();
    },
    {fastCheck: {numRuns: 100}},
  );
});
