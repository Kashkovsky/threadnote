import {mkdtemp, mkdir, realpath, rm, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import fc from 'fast-check';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  canonicalEmptyContextBrief,
  handleCodeMemoryLinkContextBriefRequest,
  type CodeMemoryLinkContextProxyPacketV1,
} from '../../scripts/code-memory-link-context-proxy.js';
import {
  codeMemoryLinkArmPacketHashV1,
  codeMemoryLinkTaskPacketHashV1,
  type CodeMemoryLinkArmPolicy,
} from '../../src/evaluation/code-memory-link-agent-protocol.js';

describe('Code Memory Link context proxy', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('forwards agent-discovered refs only for the anchored arm', async () => {
    const root = await fixtureRoot(temporaryRoots);
    const runCandidate = vi.fn(async (candidatePacket, request) =>
      candidateResult(candidatePacket.armPacket.policy, {codeRefs: request.codeRefs}),
    );
    const anchored = packet(root, 'anchored');
    const taskOnly = packet(root, 'task-only');
    const request = {
      callerCwd: root,
      codeRefs: ['src/service.ts', 'cgs_0123456789abcdef'],
      task: anchored.taskPacket.prompt,
    };

    await handleCodeMemoryLinkContextBriefRequest(anchored, request, runCandidate);
    await handleCodeMemoryLinkContextBriefRequest(taskOnly, request, runCandidate);

    expect(runCandidate.mock.calls.map(call => call[1].codeRefs)).toEqual([
      ['src/service.ts', 'cgs_0123456789abcdef'],
      [],
    ]);
  });

  it('returns the canonical empty response without invoking the candidate for no-memory', async () => {
    const root = await fixtureRoot(temporaryRoots);
    const runCandidate = vi.fn();
    const result = await handleCodeMemoryLinkContextBriefRequest(
      packet(root, 'no-memory'),
      {callerCwd: root, codeRefs: ['src/service.ts'], task: packet(root, 'no-memory').taskPacket.prompt},
      runCandidate,
    );

    expect(result).toMatchObject({
      ...canonicalEmptyContextBrief(),
      proxyReceipt: {
        armPacketHash: packet(root, 'no-memory').armPacket.armPacketHash,
        proxyDecisionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        rawRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        responseHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        runBindingHash: '4'.repeat(64),
        version: 1,
      },
    });
    expect(runCandidate).not.toHaveBeenCalled();
  });

  it('rejects attempts to escape the sealed task, repository, project, or workset scope', async () => {
    const root = await fixtureRoot(temporaryRoots);
    const outside = await fixtureRoot(temporaryRoots);
    const sealed = packet(root, 'anchored');
    const valid = {callerCwd: root, task: sealed.taskPacket.prompt};

    await expect(handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, callerCwd: outside})).rejects.toThrow(
      'outside the isolated fixture',
    );
    await expect(handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, task: 'Read the rubric.'})).rejects.toThrow(
      'sealed task packet',
    );
    await expect(handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, project: 'other'})).rejects.toThrow(
      'sealed fixture',
    );
    await expect(handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, workset: 'private'})).rejects.toThrow(
      'unavailable',
    );
    await expect(
      handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, codeRefs: '../rubric.json'}),
    ).rejects.toThrow('escaped');
    await expect(
      handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, codeRefs: '..\\private/rubric.json'}),
    ).rejects.toThrow('escaped');
    await expect(handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, budgetTokens: 1_249})).rejects.toThrow(
      'exact preregistered token dose',
    );
    await expect(
      handleCodeMemoryLinkContextBriefRequest(sealed, {...valid, codeRefs: ['src/service.ts', 'src/service.ts']}),
    ).rejects.toThrow('must be unique');
  });

  it('strips every bounded valid ref sequence in task-only mode', async () => {
    const root = await fixtureRoot(temporaryRoots);
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,12}\.ts$/u), {maxLength: 8}),
        async codeRefs => {
          let observed: readonly string[] | undefined;
          await handleCodeMemoryLinkContextBriefRequest(
            packet(root, 'task-only'),
            {callerCwd: root, codeRefs, task: packet(root, 'task-only').taskPacket.prompt},
            async (_packet, request) => {
              observed = request.codeRefs;
              return candidateResult('task-only');
            },
          );
          expect(observed).toEqual([]);
        },
      ),
      {numRuns: 40},
    );
  });

  it('rejects bounded mixed-separator parent traversals before forwarding', async () => {
    const root = await fixtureRoot(temporaryRoots);
    const sealed = packet(root, 'anchored');
    const runCandidate = vi.fn();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('\\', '/'), {maxLength: 3}),
        fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u),
        async (additionalSeparators, leaf) => {
          const separators = ['\\', ...additionalSeparators];
          const reference = `${separators.map(separator => `..${separator}`).join('')}private/${leaf}.json`;
          await expect(
            handleCodeMemoryLinkContextBriefRequest(
              sealed,
              {callerCwd: root, codeRefs: reference, task: sealed.taskPacket.prompt},
              runCandidate,
            ),
          ).rejects.toThrow('escaped');
        },
      ),
      {numRuns: 40},
    );
    expect(runCandidate).not.toHaveBeenCalled();
  });
});

async function fixtureRoot(roots: string[]): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'threadnote-context-proxy-test-'));
  roots.push(created);
  await mkdir(join(created, 'src'));
  await writeFile(join(created, 'src/service.ts'), 'export const service = true;\n');
  return realpath(created);
}

function packet(root: string, policy: CodeMemoryLinkArmPolicy): CodeMemoryLinkContextProxyPacketV1 {
  const taskWithoutHash = {
    budget: {steps: 1, tokens: 1_250},
    fixtureHash: '1'.repeat(64),
    prompt: 'Respect the repository constraint.',
    taskId: 'tsk_0123456789abcdef',
    taskKind: 'hidden-constraint' as const,
    version: 1 as const,
  };
  const taskPacket = {...taskWithoutHash, packetHash: codeMemoryLinkTaskPacketHashV1(taskWithoutHash)};
  const armWithoutHash = {
    assignmentHash: '2'.repeat(64),
    blindLabel: 'X' as const,
    fixtureHash: taskPacket.fixtureHash,
    packetHash: taskPacket.packetHash,
    policy,
    rubricHash: '3'.repeat(64),
    runNonce: 'run_0123456789abcdef',
    taskId: taskPacket.taskId,
    taskKind: taskPacket.taskKind,
    version: 1 as const,
  };
  return {
    account: 'local',
    agentId: 'code-memory-gate',
    armPacket: {...armWithoutHash, armPacketHash: codeMemoryLinkArmPacketHashV1(armWithoutHash)},
    candidateExecutable: '/opt/threadnote/bin/threadnote',
    candidateExecutableSha256: 'a'.repeat(64),
    callerCwd: root,
    project: 'code-memory-fixture',
    runBindingHash: '4'.repeat(64),
    safeExecutablePath: '/usr/bin:/bin',
    taskPacket,
    threadnoteHome: '/private/threadnote-home',
    user: 'evaluation',
    version: 1,
  };
}

function candidateResult(policy: 'anchored' | 'task-only', extra: Record<string, unknown> = {}) {
  return {
    structuredContent: {
      activeHandoffs: [],
      durableDecisions: [],
      ...extra,
      type: 'context-brief',
      version: policy === 'anchored' ? 3 : 2,
    },
    text: 'candidate',
  };
}
