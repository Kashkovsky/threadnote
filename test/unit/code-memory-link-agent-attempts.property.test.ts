import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {CodeMemoryLinkAgentAbManifestV1} from '../../src/evaluation/code-memory-link-agent-ab.js';
import {
  assertCodeMemoryLinkAgentAttemptLedgerV1,
  CODE_MEMORY_LINK_AGENT_RETRY_REASONS,
  codeMemoryLinkAgentAttemptEventDigest,
  createCodeMemoryLinkAgentAttemptFailedV1,
  createCodeMemoryLinkAgentAttemptStartedV1,
  parseCodeMemoryLinkAgentAttemptsJsonl,
  serializeCodeMemoryLinkAgentAttemptsJsonl,
} from '../../src/evaluation/code-memory-link-agent-attempts.js';

const HASH = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const CLIENT = {clientId: 'client-a', implementationDescriptorHash: 'c'.repeat(64)};
const MANIFEST = {
  assignmentHash: 'd'.repeat(64),
  clients: [CLIENT],
  manifestHash: 'e'.repeat(64),
  schedule: [
    {
      armPosition: 1,
      blindLabel: 'X',
      clientId: CLIENT.clientId,
      runNonce: 'run_0000000000000001',
      runOrder: 0,
      taskId: 'task-a',
    },
  ],
} as unknown as CodeMemoryLinkAgentAbManifestV1;

describe('Code Memory Link agent attempt ledger', () => {
  it('round-trips every categorical observed failure and detects chain tampering', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CODE_MEMORY_LINK_AGENT_RETRY_REASONS.filter(reason => reason !== 'interrupted-attempt')),
        failureKind => {
          const started = createCodeMemoryLinkAgentAttemptStartedV1({
            approvalCommit: COMMIT,
            assignmentHash: MANIFEST.assignmentHash,
            attemptId: 'attempt_00000000000000000000000000000001',
            blindLabel: 'X',
            clientDescriptorHash: CLIENT.implementationDescriptorHash,
            clientId: CLIENT.clientId,
            invocationNonce: 'inv_0000000000000001',
            manifestHash: MANIFEST.manifestHash,
            previousEventDigest: null,
            retryOfAttemptId: null,
            retryReason: null,
            runBindingHash: 'f'.repeat(64),
            runNonce: 'run_0000000000000001',
            runOrder: 0,
            taskId: 'task-a',
          });
          const failed = createCodeMemoryLinkAgentAttemptFailedV1({
            attemptId: started.attemptId,
            failureKind,
            previousEventDigest: codeMemoryLinkAgentAttemptEventDigest(started),
          });
          const events = [started, failed];
          expect(parseCodeMemoryLinkAgentAttemptsJsonl(serializeCodeMemoryLinkAgentAttemptsJsonl(events))).toEqual(
            events,
          );
          expect(
            assertCodeMemoryLinkAgentAttemptLedgerV1({
              approvalCommit: COMMIT,
              events,
              manifest: MANIFEST,
              trials: [],
            }).requiredRetry,
          ).toEqual({attemptId: started.attemptId, reason: failureKind, runOrder: 0});
          expect(() =>
            assertCodeMemoryLinkAgentAttemptLedgerV1({
              approvalCommit: COMMIT,
              events: [{...started, assignmentHash: HASH}, failed],
              manifest: MANIFEST,
              trials: [],
            }),
          ).toThrow(/frozen schedule/u);
        },
      ),
      {numRuns: 20},
    );
  });
});
