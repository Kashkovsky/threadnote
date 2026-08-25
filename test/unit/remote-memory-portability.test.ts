import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import {formatRemoteMemoryUri} from '../../src/memory_domain/address.js';
import {formatMemoryDocument} from '../../src/memory_document.js';
import {
  applyGitBetaImportOperator,
  planGitBetaImportOperator,
  remoteMemoryOperatorCapabilities,
  RemoteMemoryOperatorError,
  type RemoteMemoryOperatorAdapter,
} from '../../src/remote_memory/operator.js';
import {
  finalizeGitBetaCutover,
  materializeGitBetaImport,
  planGitBetaImport,
  planRemoteMemoryExport,
  verifyRemoteMemoryExportPlan,
  type GitBetaMemorySourceV1,
  type RemoteMemoryExistingRecordV1,
  type RemoteMemoryPortableRecordV1,
} from '../../src/remote_memory/portability.js';

const COMPATIBILITY_END = '2027-12-31T23:59:59.000Z';
const PORTABLE_SEGMENT_CHARACTERS = [...'abcdefghijklmnopqrstuvwxyz0123456789'] as const;

/**
 * Every generated value is portable by construction: single characters are
 * never reserved, while longer values carry a fixed prefix that cannot match
 * a Windows device name. The alphabet also excludes separators and controls.
 */
const portableSegmentArbitrary = fc.oneof(
  fc.constantFrom(...PORTABLE_SEGMENT_CHARACTERS),
  fc
    .array(fc.constantFrom(...PORTABLE_SEGMENT_CHARACTERS), {maxLength: 8})
    .map(characters => `seg-${characters.join('')}`),
);

describe('remote memory Git beta portability', () => {
  it('classifies existing divergence, duplicates, invalid content, scrubber blocks, and unmapped sources', () => {
    const importable = source('threadnote', 'importable', 'Safe durable context.');
    const duplicate = source('threadnote', 'importable', 'Safe durable context.', 'other-user');
    const diverged = source('threadnote', 'diverged', 'Changed source content.');
    const unchanged = source('threadnote', 'unchanged', 'Already imported.');
    const invalid = {...source('threadnote', 'invalid', 'ignored'), content: 'not a memory document'};
    const blocked = source('threadnote', 'blocked', 'Credential AKIA1234567890ABCDEF must not migrate.');
    const unmapped = source('private-project', 'mapping', 'Requires an explicit mapping.');
    const plan = planGitBetaImport({
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      dryRun: true,
      existing: [existing(diverged, '0'.repeat(64)), existing(unchanged, sha256HexSync(unchanged.content))],
      policy: {projects: ['threadnote']},
      records: [unmapped, blocked, invalid, unchanged, duplicate, diverged, importable],
      shareId: 'share-1',
    });

    expect(plan.counts).toEqual({
      blocked: 2,
      conflict: 1,
      duplicate: 1,
      invalid: 1,
      unchanged: 1,
      would_import: 1,
    });
    expect(plan.entries.map(entry => entry.reason).filter(Boolean)).toEqual(
      expect.arrayContaining([
        'blocked:credential',
        'existing_content_conflict',
        'invalid_memory_document',
        'unmapped_project_or_repository_binding',
      ]),
    );
    expect(plan.sourceMutation).toBe('none');
  });

  it('detects source changes after planning and refuses a cutover until post-apply hashes and aliases verify', () => {
    const original = source('threadnote', 'decision', 'Original body.');
    const plan = planGitBetaImport({
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      dryRun: false,
      records: [original],
      shareId: 'share-1',
    });
    const changed = source('threadnote', 'decision', 'Changed body.');

    expect(() => materializeGitBetaImport(plan, [changed])).toThrow('changed after planning');
    expect(
      finalizeGitBetaCutover({
        outcomes: [
          {sourceUri: original.sourceUri, status: 'imported', targetUri: plan.entries[0]!.targetUri, version: 1},
        ],
        plan,
        verified: false,
      }),
    ).toMatchObject({
      dualWrite: 'disabled',
      sourceDeletion: 'not_performed',
      status: 'blocked',
      switch: 'explicit_required',
      verification: 'failed',
    });
  });

  it('keeps Windows-reserved source paths blocked from cross-platform materialization', () => {
    const reserved = source('prn', 'portable', 'Reserved project path.');
    const plan = planGitBetaImport({
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      dryRun: false,
      records: [reserved],
      shareId: 'share-1',
    });

    expect(plan.entries).toEqual([expect.objectContaining({classification: 'invalid', reason: 'invalid_source_uri'})]);
    expect(() => materializeGitBetaImport(plan, [reserved])).toThrow(
      'A blocking Git beta import plan cannot be materialized for apply.',
    );
  });

  it('materializes unchanged records so apply can add missing aliases, and rejects rehashed plan tampering', () => {
    const beta = source('threadnote', 'unchanged-alias', 'Already present remotely.');
    const plan = planGitBetaImport({
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      dryRun: false,
      existing: [existing(beta, sha256HexSync(beta.content), [])],
      policy: {projects: ['threadnote'], sourceTeams: ['engineering'], sourceUsers: ['cloud-user']},
      records: [beta],
      shareId: 'share-1',
    });

    expect(plan.entries[0]?.classification).toBe('unchanged');
    expect(materializeGitBetaImport(plan, [beta])).toEqual([
      expect.objectContaining({aliases: [beta.sourceUri], contentHash: sha256HexSync(beta.content)}),
    ]);

    // A caller can recompute an untrusted local plan digest, but source semantics
    // are independently revalidated during materialization.
    const arbitraryAlias = forgePlan({
      ...plan,
      entries: [{...plan.entries[0]!, aliasUri: beta.sourceUri.replace('cloud-user', 'attacker')}],
    });
    expect(() => materializeGitBetaImport(arbitraryAlias, [beta])).toThrow('changed after planning');
    const omitted = forgePlan({
      ...plan,
      counts: {blocked: 0, conflict: 0, duplicate: 0, invalid: 0, unchanged: 0, would_import: 0},
      entries: [],
    });
    expect(() => materializeGitBetaImport(omitted, [beta])).toThrow('exact source set');
  });

  it('rejects a rehashed plan that changes deterministic duplicate classifications', () => {
    const first = source('threadnote', 'duplicate-semantics', 'Same canonical body.', 'a-user');
    const second = source('threadnote', 'duplicate-semantics', 'Same canonical body.', 'b-user');
    const plan = planGitBetaImport({
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      dryRun: false,
      records: [first, second],
      shareId: 'share-1',
    });
    const changed = forgePlan({
      ...plan,
      entries: plan.entries.map(entry => ({
        ...entry,
        classification: entry.classification === 'duplicate' ? 'would_import' : 'duplicate',
      })),
    });

    expect(() => materializeGitBetaImport(changed, [first, second])).toThrow('classification semantics');
  });

  it('verifies deterministic canonical exports and rejects content-hash drift', () => {
    const sourceRecord = source('threadnote', 'portable', 'Portable body.');
    const importPlan = planGitBetaImport({
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      dryRun: false,
      records: [sourceRecord],
      shareId: 'share-1',
    });
    const records = materializeGitBetaImport(importPlan, [sourceRecord]);
    const exportPlan = planRemoteMemoryExport(records);

    expect(exportPlan.files).toEqual([
      expect.objectContaining({
        aliases: [sourceRecord.sourceUri],
        relativePath: 'durable/projects/threadnote/portable.md',
      }),
    ]);
    expect(() => verifyRemoteMemoryExportPlan(exportPlan)).not.toThrow();
    expect(() => planRemoteMemoryExport([{...records[0]!, contentHash: 'f'.repeat(64)}])).toThrow('hash mismatch');
    const changedFiles = [{...exportPlan.files[0]!, relativePath: 'durable/projects/threadnote/other.md'}];
    const rehashed = {
      ...exportPlan,
      bundleDigest: sha256HexSync(stableJson({files: changedFiles, sourceMutation: 'none', version: 1})),
      files: changedFiles,
    };
    expect(() => verifyRemoteMemoryExportPlan(rehashed)).toThrow('path does not match');
  });

  it('preserves terminal handoff lifecycle in the exit-export path', () => {
    const uri = formatRemoteMemoryUri({kind: 'handoff', project: 'threadnote', shareId: 'share-1', topic: 'done'});
    const canonicalContent = formatMemoryDocument(
      'HANDOFF',
      {
        kind: 'handoff',
        project: 'threadnote',
        sourceAgentClient: 'cursor',
        status: 'archived',
        timestamp: '2026-08-13T00:00:00.000Z',
        topic: 'done',
      },
      'Completed handoff.',
    );
    const exportPlan = planRemoteMemoryExport([
      {
        aliases: [],
        canonicalContent,
        contentHash: sha256HexSync(canonicalContent),
        kind: 'handoff',
        project: 'threadnote',
        topic: 'done',
        uri,
        version: 1,
      },
    ]);

    expect(exportPlan.files[0]?.relativePath).toBe('handoffs/archived/threadnote/done.md');
    expect(() => verifyRemoteMemoryExportPlan(exportPlan)).not.toThrow();
  });

  it('is input-order invariant and export/import preserves canonical hashes', () => {
    const body = fc
      .tuple(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'),
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789'), {maxLength: 59}),
      )
      .map(([first, rest]) => [first, ...rest].join(''));
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({body, project: portableSegmentArbitrary, topic: portableSegmentArbitrary}), {
          maxLength: 20,
          minLength: 1,
          selector: value => `${value.project}/${value.topic}`,
        }),
        values => {
          const sources = values.map((value, index) => source(value.project, value.topic, value.body, `user-${index}`));
          const forward = planGitBetaImport({
            aliasCompatibilityEndsAt: COMPATIBILITY_END,
            dryRun: false,
            records: sources,
            shareId: 'share-1',
          });
          const reverse = planGitBetaImport({
            aliasCompatibilityEndsAt: COMPATIBILITY_END,
            dryRun: false,
            records: [...sources].reverse(),
            shareId: 'share-1',
          });
          expect(reverse).toEqual(forward);
          const records = materializeGitBetaImport(forward, sources);
          const exported = planRemoteMemoryExport([...records].reverse());
          expect(exported.files.map(file => file.contentHash)).toEqual(
            [...records]
              .sort((left, right) => (left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0))
              .map(record => record.contentHash),
          );
          verifyRemoteMemoryExportPlan(exported);
        },
      ),
      {numRuns: 100},
    );
  });
});

describe('remote memory portability operator', () => {
  it('applies idempotently through an injected atomic adapter and returns only an explicit cutover receipt', async () => {
    const state = new Map<string, RemoteMemoryExistingRecordV1>();
    const recordsByUri = new Map<string, RemoteMemoryPortableRecordV1>();
    const adapter: RemoteMemoryOperatorAdapter = {
      applyGitBetaImport: async input =>
        input.records.map(record => {
          const status = state.has(record.uri) ? 'unchanged' : 'imported';
          state.set(record.uri, {
            aliases: record.aliases,
            contentHash: record.contentHash,
            uri: record.uri,
            version: 1,
          });
          recordsByUri.set(record.uri, record);
          return {sourceUri: record.aliases[0]!, status, targetUri: record.uri, version: 1};
        }),
      capabilities: remoteMemoryOperatorCapabilities(['apply_git_beta_import', 'export_records', 'inspect_records']),
      exportRecords: async () => [...recordsByUri.values()],
      inspectRecords: async () => [...state.values()],
    };
    const beta = source('threadnote', 'operator', 'Operator import.');
    const plan = await planGitBetaImportOperator(adapter, {
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      apply: true,
      records: [beta],
      shareId: 'share-1',
    });

    const first = await applyGitBetaImportOperator(adapter, {plan, records: [beta]});
    const replay = await applyGitBetaImportOperator(adapter, {plan, records: [beta]});

    expect(first.cutover).toMatchObject({
      dualWrite: 'disabled',
      sourceDeletion: 'not_performed',
      status: 'ready',
      switch: 'explicit_required',
      verification: 'matched',
    });
    expect(replay.cutover.status).toBe('ready');
    expect(state.size).toBe(1);
  });

  it('reports a missing apply port as a capability gate instead of implying migration succeeded', async () => {
    const adapter: RemoteMemoryOperatorAdapter = {
      capabilities: remoteMemoryOperatorCapabilities(['inspect_records'], {
        apply_git_beta_import: 'atomic repository apply is not implemented',
      }),
      inspectRecords: async () => [],
    };
    const beta = source('threadnote', 'gated', 'Gated import.');
    const plan = await planGitBetaImportOperator(adapter, {
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      apply: true,
      records: [beta],
      shareId: 'share-1',
    });

    await expect(applyGitBetaImportOperator(adapter, {plan, records: [beta]})).rejects.toMatchObject({
      code: 'capability_unavailable',
      name: 'RemoteMemoryOperatorError',
    } satisfies Partial<RemoteMemoryOperatorError>);
  });

  it('rechecks target state before apply and blocks divergence without invoking the adapter write', async () => {
    const beta = source('threadnote', 'target-race', 'Planned content.');
    const current: RemoteMemoryExistingRecordV1[] = [];
    let applyCalls = 0;
    const adapter: RemoteMemoryOperatorAdapter = {
      applyGitBetaImport: async () => {
        applyCalls += 1;
        return [];
      },
      capabilities: remoteMemoryOperatorCapabilities(['apply_git_beta_import', 'inspect_records']),
      inspectRecords: async () => current,
    };
    const plan = await planGitBetaImportOperator(adapter, {
      aliasCompatibilityEndsAt: COMPATIBILITY_END,
      apply: true,
      records: [beta],
      shareId: 'share-1',
    });
    current.push(existing(beta, '0'.repeat(64)));

    await expect(applyGitBetaImportOperator(adapter, {plan, records: [beta]})).rejects.toMatchObject({
      code: 'blocked_plan',
    } satisfies Partial<RemoteMemoryOperatorError>);
    expect(applyCalls).toBe(0);
  });
});

function source(
  project: string,
  topic: string,
  body: string,
  user = 'cloud-user',
  team = 'engineering',
): GitBetaMemorySourceV1 {
  return {
    content: formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        project,
        sourceAgentClient: 'cursor',
        status: 'active',
        timestamp: '2026-08-13T00:00:00.000Z',
        topic,
      },
      body,
    ),
    sourceUri: `threadnote://user/${user}/memories/shared/${team}/durable/projects/${project}/${topic}.md`,
    version: 1,
  };
}

function existing(
  sourceRecord: GitBetaMemorySourceV1,
  contentHash: string,
  aliases: readonly string[] = [sourceRecord.sourceUri],
): RemoteMemoryExistingRecordV1 {
  const parsed = sourceRecord.sourceUri.split('/');
  const project = parsed.at(-2)!;
  const topic = parsed.at(-1)!.slice(0, -3);
  return {
    aliases,
    contentHash,
    uri: formatRemoteMemoryUri({kind: 'durable', project, shareId: 'share-1', topic}),
    version: 1,
  };
}

function forgePlan(value: ReturnType<typeof planGitBetaImport>): ReturnType<typeof planGitBetaImport> {
  const digest = sha256HexSync(
    stableJson({
      aliasCompatibilityEndsAt: value.aliasCompatibilityEndsAt,
      counts: value.counts,
      dryRun: value.dryRun,
      entries: value.entries,
      policy: value.policy,
      shareId: value.shareId,
      sourceMutation: value.sourceMutation,
      version: value.version,
    }),
  );
  return {...value, planDigest: digest, planId: `tnmi_${digest.slice(0, 32)}`};
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(
      Object.entries(current).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });
}
