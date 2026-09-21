import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildKnowledgeDeltaGitProposalV1} from '../../src/git_proposal/knowledge_delta.js';
import {planKnowledgeDeltaGitMaterializationV1} from '../../src/git_proposal/materializer.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';
import type {KnowledgeDeltaV1} from '../../src/memory/knowledge_delta.js';

const reviewId = 'review-0123456789abcdef';
const source = [
  'MEMORY',
  'kind: durable',
  'status: active',
  'project: threadnote',
  'topic: architecture',
  'source_agent_client: test',
  'timestamp: 2026-01-01T00:00:00.000Z',
  'schema_version: 5',
  'memory_id: tn_source',
  'visibility: personal',
  'authority: user_approved',
  'trust: approved',
  `candidate_id: ${reviewId}-1`,
  'relation: references threadnote://memory/tn_platform_contract',
  '',
  'Text.',
].join('\n');
const delta: KnowledgeDeltaV1 = {
  items: [
    {
      candidateId: `${reviewId}-1`,
      comparison: 'new',
      comparisonReason: 'test',
      confidence: 0.9,
      mutationPreview: {bodyText: 'Text.', operation: 'create', truncated: false},
      proposedDestination: {kind: 'durable', project: 'threadnote', topic: 'architecture'},
      recommendation: 'create',
      sourceEvidence: ['test'],
      state: 'applied',
      truncated: false,
      type: 'decision-or-invariant',
    },
  ],
  noAction: false,
  reviewId,
  revision: 1,
  type: 'knowledge-delta',
  version: 1,
};
const proposal = buildKnowledgeDeltaGitProposalV1({
  baseCommit: 'a'.repeat(40),
  delta,
  mutations: [
    {
      approval: {expectedSourceContentHash: sha256HexSync(source), reviewId, revision: 1, share: true},
      candidateId: delta.items[0].candidateId,
      expectedTarget: {state: 'absent'},
      operation: 'create',
      sourceContent: source,
      sourceUri: 'threadnote://user/a/memories/durable/projects/threadnote/architecture.md',
    },
  ],
  project: 'threadnote',
  target: {repositoryId: '1'.repeat(64), team: 'default'},
}).proposal;
const state = {baseCommit: 'a'.repeat(40), files: {}, repositoryId: '1'.repeat(64)};

describe('Knowledge Delta Git materializer', () => {
  it('plans the deterministic local branch, commit message, and exact file bytes', () => {
    expect(planKnowledgeDeltaGitMaterializationV1(proposal, state)).toMatchObject({
      branch: proposal.branch.name,
      commitMessage: proposal.commit.message,
      files: proposal.files.map(file => ({content: file.content, path: file.path})),
      proposalHash: proposal.proposalHash,
    });
  });
  it('fails closed on repository, base, or target CAS drift', () => {
    expect(() => planKnowledgeDeltaGitMaterializationV1(proposal, {...state, repositoryId: '2'.repeat(64)})).toThrow(
      /repository binding/u,
    );
    expect(() => planKnowledgeDeltaGitMaterializationV1(proposal, {...state, baseCommit: 'b'.repeat(40)})).toThrow(
      /base commit/u,
    );
    expect(() =>
      planKnowledgeDeltaGitMaterializationV1(proposal, {...state, files: {[proposal.files[0].path]: 'changed'}}),
    ).toThrow(/target changed/u);
  });
  it('has deterministic plans independent of irrelevant state key ordering', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({minLength: 1, maxLength: 4}), {maxLength: 8}), keys => {
        const forward = Object.fromEntries(keys.map(key => [key, undefined]));
        const reverse = Object.fromEntries([...keys].reverse().map(key => [key, undefined]));
        expect(planKnowledgeDeltaGitMaterializationV1(proposal, {...state, files: forward})).toEqual(
          planKnowledgeDeltaGitMaterializationV1(proposal, {...state, files: reverse}),
        );
      }),
      {numRuns: 24},
    );
  });
});
