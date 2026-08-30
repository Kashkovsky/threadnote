import {readFile} from '../helpers/node-fs-promises.js';
import {dirname, join} from '../helpers/node-path.js';
import {fileURLToPath} from '../helpers/node-url.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_CORE_SCHEMA_VERSION,
  CODE_GRAPH_PERSISTENT_SCHEMA_CHECKPOINT_PREDECESSOR,
  CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR,
  CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT,
  CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS,
  CODE_GRAPH_PROTOCOL_VERSIONS,
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION,
  codeGraphPersistentSchemaIsCurrent,
  codeGraphPersistentSchemaMigrationPending,
  codeGraphPersistentSchemaSupports,
  codeGraphRuntimeSchemaRequiresReconnect,
  observeCodeGraphPersistentSchemaRevision,
  planCodeGraphPersistentSchemaUpgrade,
} from '../../src/code_graph/store/schema_revision.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const historicalProfiles = [
  [2, 'build-owner-plan', 'rebuild-extensions'],
  [3, 'reference-candidate', 'retire-legacy-references-and-rebuild'],
  [4, 'legacy-lexical', 'rebuild-extensions'],
  [5, 'compact-lexical', 'rebuild-extensions'],
  [6, 'content-shards', 'bridge-build-owner-instance'],
  [7, 'build-owner-instance', 'adopt-current-contract'],
  [8, 'removed-view-cleanup', 'adopt-current-contract'],
  [9, 'component-aggregates', 'adopt-current-contract'],
  [10, 'query-indexes', 'adopt-current-contract'],
  [11, 'evidence-cross-repository', 'adopt-current-contract'],
  [12, 'file-blob-authority', 'adopt-current-contract'],
  [13, 'inventory-reuse', 'rebuild-extensions'],
  [14, 'transient-spool', 'adopt-current-contract'],
  [15, 'sorted-spool-citation-predecessor', 'adopt-current-contract'],
  [16, 'citation-alias-checkpoint-predecessor', 'extend-checkpoint-import'],
  [17, 'checkpoint-import', 'current'],
] as const;

describe('code graph schema revision entity', () => {
  it('pins every released persistent revision to its named upgrade route', () => {
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS.map(value => [value.value, value.key, value.upgradeRoute])).toEqual(
      historicalProfiles,
    );
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR.value).toBe(15);
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_CHECKPOINT_PREDECESSOR.value).toBe(16);
    expect(CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.value).toBe(17);
  });

  it('keeps storage, receipt, artifact, reuse, resolution, and Manager versions distinct', () => {
    expect(CODE_GRAPH_CORE_SCHEMA_VERSION).toBe(3);
    expect(CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION).toEqual({
      citationAliasPredecessor: 2,
      foldForwardPredecessor: 3,
      current: 4,
    });
    expect(CODE_GRAPH_PROTOCOL_VERSIONS).toEqual({
      checkpointArtifact: 1,
      checkpointImport: 1,
      checkpointRecordSchema: 1,
      checkpointSemantic: 1,
      inventoryReuseReceipt: 2,
      managerCatalogRevision: 1,
      resolutionSurface: 1,
      reusableBaseReceipt: 2,
    });
  });

  it('preserves the deliberately non-arithmetic r13 and predecessor behavior', () => {
    expect(codeGraphPersistentSchemaSupports(12, 'direct-current-contract-adoption')).toBe(true);
    expect(codeGraphPersistentSchemaSupports(13, 'direct-current-contract-adoption')).toBe(false);
    expect(codeGraphPersistentSchemaSupports(14, 'direct-current-contract-adoption')).toBe(true);
    expect(codeGraphPersistentSchemaSupports(15, 'citation-released-predecessor-authority')).toBe(true);
    expect(codeGraphPersistentSchemaSupports(15, 'citation-column-predecessor-authority')).toBe(false);
    expect(codeGraphPersistentSchemaSupports(16, 'citation-column-predecessor-authority')).toBe(true);
  });

  it('round-trips every historical integer and canonical SQLite string through one profile', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS), profile => {
        expect(observeCodeGraphPersistentSchemaRevision(profile.value)).toEqual({profile, state: 'known'});
        expect(observeCodeGraphPersistentSchemaRevision(String(profile.value))).toEqual({profile, state: 'known'});
        expect(codeGraphPersistentSchemaIsCurrent(profile.value)).toBe(profile.key === 'checkpoint-import');
        expect(codeGraphPersistentSchemaMigrationPending(profile.value)).toBe(
          profile.lifecycle === 'background-readable',
        );
        const plan = planCodeGraphPersistentSchemaUpgrade(profile.value);
        expect(plan.state).toBe(profile.key === 'checkpoint-import' ? 'ready' : 'upgrade');
        if (plan.state !== 'ready' && plan.state !== 'upgrade')
          throw new Error('Historical revision plan unavailable.');
        expect(plan.route).toBe(profile.upgradeRoute);
      }),
      {numRuns: 64},
    );
  });

  it('classifies future observations monotonically without treating malformed values as newer', () => {
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: 1}), increment => {
        const future = CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.value + increment;
        expect(observeCodeGraphPersistentSchemaRevision(future)).toEqual({state: 'newer', value: future});
        expect(planCodeGraphPersistentSchemaUpgrade(future)).toEqual({state: 'reject-newer', value: future});
        expect(codeGraphRuntimeSchemaRequiresReconnect(CODE_GRAPH_CORE_SCHEMA_VERSION, future)).toBe(true);
      }),
      {numRuns: 64},
    );
    expect(observeCodeGraphPersistentSchemaRevision('016')).toEqual({state: 'invalid', value: '016'});
    expect(observeCodeGraphPersistentSchemaRevision(-1)).toEqual({state: 'invalid', value: -1});
    expect(codeGraphRuntimeSchemaRequiresReconnect(undefined, undefined)).toBe(false);
  });

  it('keeps semantic revision checks behind the revision entity', async () => {
    const governedFiles = [
      'maintenance.ts',
      'store_diagnostics.ts',
      'store_file_alias_schema.ts',
      'store_health.ts',
      'store_leases.ts',
      'store_maintenance_core.ts',
      'store_reconciliation.ts',
      'store_reconciliation_preparation.ts',
      'store_schema_core.ts',
      'store_schema_migration.ts',
      'store_schema_receipt.ts',
    ];
    const subject = String.raw`(?:recordedRevision|persistentExtensionSchemaRevision|revision\.value|receipt\.contract_revision|receipt\.persistent_extension_revision)`;
    const numericRevision = String.raw`(?:[2-9]|1[0-7])`;
    const leftComparison = new RegExp(String.raw`\b${subject}\s*(?:===|!==|<=|>=|<|>)\s*${numericRevision}\b`, 'u');
    const rightComparison = new RegExp(String.raw`\b${numericRevision}\s*(?:===|!==|<=|>=|<|>)\s*${subject}\b`, 'u');
    for (const file of governedFiles) {
      const source = await readFile(join(repoRoot, 'src', 'code_graph', file), 'utf8');
      expect(source, file).not.toMatch(leftComparison);
      expect(source, file).not.toMatch(rightComparison);
      expect(source, file).not.toMatch(/CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION\s*[+-]/u);
    }
  });
});
