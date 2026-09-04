import {describe, expect, it} from 'vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  applyLogicalDelta,
  compactLogicalGraph,
  diffLogicalGraphs,
  emptyLogicalGraph,
  logicalGraphDigest,
  selectNewestPublishedAncestor,
  setLogicalRecord,
  deleteLogicalRecord,
} from '../../src/code_graph/sharing/delta.js';
import {
  GRAPH_SHARE_CONTROL_MAX_BODY_BYTES,
  dispatchGraphShareControl,
  emptyGraphShareCoordinatorState,
} from '../../src/code_graph/sharing/control_protocol.js';
import {
  enqueueGraphShareContribution,
  emptyGraphShareContributionQueue,
  parseGraphShareContributionQueue,
} from '../../src/code_graph/sharing/contribution.js';
import {parseGraphShareWorkerAdvertisements, planGraphWorkerActions} from '../../src/code_graph/sharing/worker.js';
import {sha256Digest} from '../../src/code_graph/sharing/digest.js';
import {parseGraphShareFrontierManifest} from '../../src/code_graph/sharing/artifacts.js';
import {graphShareLanguageAndRole, graphShareParseActionKey} from '../../src/code_graph/sharing/action.js';
import {
  admitsSharedParseCacheHydrate,
  quarantinedGraphShareActionKeys,
} from '../../src/code_graph/sharing/parse_cache.js';
import {graphShareParseResultArtifact} from '../../src/code_graph/sharing/parse_result.js';

describe('graph share deltas, coordinator, contribution, and workers', () => {
  it('keeps checkpoint plus ordered deltas equal to an independent clean model', () => {
    FC.assert(
      FC.property(
        FC.array(FC.tuple(FC.string({maxLength: 8, minLength: 1}), FC.string({maxLength: 8, minLength: 0})), {
          maxLength: 8,
        }),
        FC.array(FC.string({maxLength: 8, minLength: 1}), {maxLength: 4}),
        (upserts, deletions) => {
          let clean = emptyLogicalGraph();
          for (const [key, value] of upserts) clean = setLogicalRecord(clean, key, value);
          for (const key of deletions) clean = deleteLogicalRecord(clean, key);
          const base = emptyLogicalGraph();
          const delta = diffLogicalGraphs(base, clean, {
            baseCommit: '1'.repeat(40),
            baseSnapshotId: 'cgsn_' + 'a'.repeat(40),
            graphAbi: 'b'.repeat(64),
            targetCommit: '2'.repeat(40),
          });
          const applied = applyLogicalDelta(base, delta);
          expect(logicalGraphDigest(applied)).toBe(logicalGraphDigest(clean));
          expect(logicalGraphDigest(compactLogicalGraph(applied))).toBe(logicalGraphDigest(clean));
        },
      ),
      {numRuns: 40},
    );
  });

  it('selects the newest published ancestor of HEAD', () => {
    const published = [{sourceCommit: '1'.repeat(40)}, {sourceCommit: '2'.repeat(40)}, {sourceCommit: '3'.repeat(40)}];
    const ancestors = new Set(['1'.repeat(40), '2'.repeat(40), 'head']);
    expect(selectNewestPublishedAncestor(published, commit => ancestors.has(commit))?.sourceCommit).toBe(
      '2'.repeat(40),
    );
  });

  it('rejects oversize bodies, unknown fields, and source/graph payloads on the control API', () => {
    const state = emptyGraphShareCoordinatorState({organization: 'acme', repositoryId: 'a'.repeat(64)});
    expect(
      dispatchGraphShareControl(state, {
        body: {},
        bodyBytes: GRAPH_SHARE_CONTROL_MAX_BODY_BYTES + 1,
        method: 'POST',
        path: '/v1/results',
      }).response.status,
    ).toBe(413);
    expect(
      dispatchGraphShareControl(state, {
        body: {source: 'fn main() {}'},
        bodyBytes: 16,
        method: 'POST',
        path: '/v1/results',
      }).response.status,
    ).toBe(400);
    expect(
      dispatchGraphShareControl(state, {
        body: {
          actionKey: 'b'.repeat(64),
          attestationDigest: sha256Digest('att'),
          batchId: 'c'.repeat(40),
          extra: true,
          idempotencyKey: 'k1',
          resultManifestDigest: sha256Digest('res'),
          semanticDigest: sha256Digest('sem'),
        },
        bodyBytes: 200,
        method: 'POST',
        path: '/v1/results',
      }).response.status,
    ).toBe(400);
    const enrolled = dispatchGraphShareControl(state, {
      body: {idempotencyKey: 'k1', repositoryId: 'a'.repeat(64)},
      bodyBytes: 80,
      method: 'POST',
      path: '/v1/enroll',
    });
    expect(enrolled.response.status).toBe(201);
    const replay = dispatchGraphShareControl(enrolled.state, {
      body: {idempotencyKey: 'k1', repositoryId: 'a'.repeat(64)},
      bodyBytes: 80,
      method: 'POST',
      path: '/v1/enroll',
    });
    expect(replay.response.status).toBe(200);
    expect(
      dispatchGraphShareControl(state, {bodyBytes: 0, method: 'GET', path: '/.well-known/threadnote-graph'}).response
        .status,
    ).toBe(200);
    const firstResult = dispatchGraphShareControl(state, {
      body: {
        actionKey: 'b'.repeat(64),
        attestationDigest: sha256Digest('att'),
        batchId: 'c'.repeat(40),
        idempotencyKey: 'r1',
        resultManifestDigest: sha256Digest('res'),
        semanticDigest: sha256Digest('sem-a'),
      },
      bodyBytes: 200,
      method: 'POST',
      path: '/v1/results',
    });
    expect(firstResult.response.status).toBe(201);
    const quarantined = dispatchGraphShareControl(firstResult.state, {
      body: {
        actionKey: 'b'.repeat(64),
        attestationDigest: sha256Digest('att-2'),
        batchId: 'c'.repeat(40),
        idempotencyKey: 'r2',
        resultManifestDigest: sha256Digest('res-2'),
        semanticDigest: sha256Digest('sem-b'),
      },
      bodyBytes: 200,
      method: 'POST',
      path: '/v1/results',
    });
    expect(quarantined.response.status).toBe(409);
  });

  it('queues contribution only after join and skips missing git blobs', () => {
    const announcement = {
      actionKey: 'a'.repeat(64),
      attestationDigest: sha256Digest('1'),
      batchId: 'b'.repeat(40),
      resultManifestDigest: sha256Digest('2'),
      semanticDigest: sha256Digest('3'),
    };
    expect(
      enqueueGraphShareContribution(emptyGraphShareContributionQueue('passive'), announcement, 'read-only').queued,
    ).toBe(false);
    expect(enqueueGraphShareContribution(emptyGraphShareContributionQueue('off'), announcement, 'join').queued).toBe(
      false,
    );
    const queued = enqueueGraphShareContribution(emptyGraphShareContributionQueue('passive'), announcement, 'join');
    expect(queued.queued).toBe(true);
    const coordinatorDown = enqueueGraphShareContribution(queued.queue, announcement, 'join');
    expect(coordinatorDown.queued).toBe(false);
    expect(coordinatorDown.queue.announcements).toHaveLength(1);
    expect(parseGraphShareContributionQueue(JSON.parse(JSON.stringify(queued.queue)))).toEqual(queued.queue);
    const presentBlob = 'a'.repeat(40);
    const missingBlob = 'b'.repeat(40);
    expect(
      parseGraphShareWorkerAdvertisements([
        {actionKey: 'a'.repeat(64), gitBlobId: presentBlob},
        {actionKey: 'b'.repeat(64), gitBlobId: missingBlob},
      ]),
    ).toHaveLength(2);
    const plan = planGraphWorkerActions(
      [
        {actionKey: 'a'.repeat(64), gitBlobId: presentBlob},
        {actionKey: 'b'.repeat(64), gitBlobId: missingBlob},
      ],
      new Set([presentBlob]),
    );
    expect(plan.eligible).toHaveLength(1);
    expect(plan.skippedMissingBlob).toHaveLength(1);
    expect(() => parseGraphShareWorkerAdvertisements([{actionKey: 'a'.repeat(64), gitBlobId: 'c'.repeat(41)}])).toThrow(
      /invalid/i,
    );
    expect(() =>
      parseGraphShareContributionQueue({...queued.queue, announcements: [{...announcement, extra: true}]}),
    ).toThrow(/unsupported|invalid/i);
    const conflicted = enqueueGraphShareContribution(
      queued.queue,
      {...announcement, semanticDigest: sha256Digest('other')},
      'join',
    );
    expect(conflicted.queued).toBe(true);
    expect(conflicted.conflict).toBe(true);
  });

  it('rejects non-oid frontier sourceCommit values including HEAD', () => {
    const digest = sha256Digest('x');
    expect(() =>
      parseGraphShareFrontierManifest({
        branch: 'refs/heads/main',
        checkpoint: {
          manifestDigest: digest,
          snapshotId: 'cgsn_imported',
          sourceCommit: 'HEAD',
        },
        deltas: [],
        generation: 1,
        graphAbi: 'e'.repeat(64),
        graphContentId: `cgc_${'d'.repeat(40)}`,
        logicalGraphDigest: digest,
        previousManifestDigest: null,
        profileDigest: digest,
        publisherFence: 1,
        repositoryId: 'b'.repeat(64),
        schemaVersion: 1,
        snapshotId: 'cgsn_imported',
        sourceCommit: 'HEAD',
      }),
    ).toThrow(/object id/i);
  });

  it('admits parse-cache hydrate only for matching action keys and skips quarantined keys', () => {
    const repositoryId = 'b'.repeat(64);
    const extractorSet = 'c'.repeat(64);
    const contentHash = 'd'.repeat(64);
    const normalizedPath = 'src/index.ts';
    const languageAndRole = graphShareLanguageAndRole('typescript', 'source');
    const actionKey = graphShareParseActionKey({
      contentHash,
      extractorSet,
      languageAndRole,
      normalizedPath,
      repositoryId,
    });
    const parsed = graphShareParseResultArtifact({
      actionKey,
      contentHash,
      extractorSet,
      facts: {diagnostics: [], edges: [], path: normalizedPath, symbols: []},
      gitBlobId: 'e'.repeat(40),
      languageAndRole,
      normalizedPath,
      repositoryId,
    });
    const receipt = {
      actionKey,
      attestationDigest: sha256Digest('att'),
      batchId: 'f'.repeat(40),
      resultManifestDigest: sha256Digest('res'),
      semanticDigest: parsed.semanticDigest,
    };
    expect(
      admitsSharedParseCacheHydrate({
        identityRepositoryId: repositoryId,
        parsed,
        quarantinedActionKeys: new Set(),
        receipt,
      }),
    ).toBe(true);
    expect(
      admitsSharedParseCacheHydrate({
        identityRepositoryId: repositoryId,
        parsed,
        quarantinedActionKeys: new Set(),
        receipt: {...receipt, actionKey: 'a'.repeat(64)},
      }),
    ).toBe(false);
    const spoofed = graphShareParseResultArtifact({
      ...parsed,
      actionKey: 'a'.repeat(64),
    });
    expect(
      admitsSharedParseCacheHydrate({
        identityRepositoryId: repositoryId,
        parsed: spoofed,
        quarantinedActionKeys: new Set(),
        receipt: {...receipt, actionKey: spoofed.actionKey},
      }),
    ).toBe(false);
    const conflicted = [
      receipt,
      {
        ...receipt,
        attestationDigest: sha256Digest('att-2'),
        resultManifestDigest: sha256Digest('res-2'),
        semanticDigest: sha256Digest('other'),
      },
    ];
    expect([...quarantinedGraphShareActionKeys(conflicted)]).toEqual([actionKey]);
    expect(
      admitsSharedParseCacheHydrate({
        identityRepositoryId: repositoryId,
        parsed,
        quarantinedActionKeys: quarantinedGraphShareActionKeys(conflicted),
        receipt,
      }),
    ).toBe(false);
    FC.assert(
      FC.property(
        FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), {maxLength: 12, minLength: 1}).map(
          characters => `src/${characters.join('')}.ts`,
        ),
        normalizedPath => {
          const key = graphShareParseActionKey({
            contentHash,
            extractorSet,
            languageAndRole,
            normalizedPath,
            repositoryId,
          });
          const artifact = graphShareParseResultArtifact({
            actionKey: key,
            contentHash,
            extractorSet,
            facts: {diagnostics: [], edges: [], path: normalizedPath, symbols: []},
            gitBlobId: 'e'.repeat(40),
            languageAndRole,
            normalizedPath,
            repositoryId,
          });
          expect(
            admitsSharedParseCacheHydrate({
              identityRepositoryId: repositoryId,
              parsed: artifact,
              quarantinedActionKeys: new Set(),
              receipt: {actionKey: key},
            }),
          ).toBe(true);
          expect(
            admitsSharedParseCacheHydrate({
              identityRepositoryId: repositoryId,
              parsed: {...artifact, actionKey: 'a'.repeat(64)},
              quarantinedActionKeys: new Set(),
              receipt: {actionKey: 'a'.repeat(64)},
            }),
          ).toBe(false);
        },
      ),
      {numRuns: 20},
    );
  });
});
