import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_MINIMUM_BACKGROUND_MIGRATION_REVISION,
  codeGraphDatabaseIntegrity,
} from '../../src/code_graph/store_health.js';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '../../src/code_graph/types.js';

describe('code graph database health', () => {
  it('classifies every supported older additive revision as migration-pending only with a readable core', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: CODE_GRAPH_MINIMUM_BACKGROUND_MIGRATION_REVISION,
          max: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION - 1,
        }),
        fc.boolean(),
        (revision, coreReadSchemaCompatible) => {
          expect(
            codeGraphDatabaseIntegrity({
              coreReadSchemaCompatible,
              integrityOk: true,
              persistentExtensionCurrent: false,
              persistentExtensionSchemaRevision: revision,
              schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            }),
          ).toBe(coreReadSchemaCompatible ? 'migration-pending' : 'incompatible');
        },
      ),
    );
  });

  it('never treats current, future, or corrupt stores as pending migration', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
          max: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION + 100,
        }),
        fc.boolean(),
        (revision, integrityOk) => {
          expect(
            codeGraphDatabaseIntegrity({
              coreReadSchemaCompatible: true,
              integrityOk,
              persistentExtensionCurrent: false,
              persistentExtensionSchemaRevision: revision,
              schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
            }),
          ).not.toBe('migration-pending');
        },
      ),
    );
  });
});
