import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES,
  codeMemoryLinkRetainedBundleHashV1,
  createCodeMemoryLinkRetainedBundleV1,
  verifyCodeMemoryLinkRetainedBundleV1,
  type CodeMemoryLinkRetainedArtifactRole,
} from '../../src/evaluation/code-memory-link-retained-bundle.js';

const CANDIDATE = 'a'.repeat(40);
const CLIENTS = [
  {
    clientId: `cli_${'1'.repeat(16)}`,
    configProjection: json({appServerVersion: '0.144.5', model: 'gpt-5.6-luna', roleBinding: 'b'.repeat(64)}),
    descriptor: json({descriptorHash: 'c'.repeat(64), version: 1}),
  },
  {
    clientId: `cli_${'2'.repeat(16)}`,
    configProjection: json({appServerVersion: '0.144.5', model: 'gpt-5.6-terra', roleBinding: 'd'.repeat(64)}),
    descriptor: json({descriptorHash: 'e'.repeat(64), version: 1}),
  },
] as const;
const SEALED_FILES = [
  {content: json({task: 'hidden'}), path: `tasks/tsk_${'3'.repeat(16)}/packet.json`},
  {content: 'export const judge = 1;\n', path: `artifacts/judge/art_${'4'.repeat(16)}.ts`},
] as const;

describe('Code Memory Link retained evidence bundle', () => {
  it('round trips the exact complete role set through a canonical content-addressed blob map', () => {
    const bundle = createCodeMemoryLinkRetainedBundleV1({
      artifacts: artifacts(),
      candidateCommit: CANDIDATE,
      clients: CLIENTS,
      sealedFiles: SEALED_FILES,
    });
    const verified = verifyCodeMemoryLinkRetainedBundleV1({blobs: bundle.blobs, indexContent: bundle.indexContent});

    expect(codeMemoryLinkRetainedBundleHashV1(bundle.indexContent)).toBe(bundle.bundleHash);
    expect(Object.keys(verified.artifacts)).toEqual(CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES);
    expect(verified.clients.map(client => client.clientId)).toEqual(CLIENTS.map(client => client.clientId));
    expect(verified.sealedFiles.map(file => file.path)).toEqual([...SEALED_FILES].map(file => file.path).sort());
    expect(bundle.index.blobs.every(blob => blob.path === `blobs/${blob.sha256}`)).toBe(true);
  });

  it('rejects changed bytes, unreferenced blobs, and noncanonical indexes', () => {
    const bundle = createCodeMemoryLinkRetainedBundleV1({
      artifacts: artifacts(),
      candidateCommit: CANDIDATE,
      clients: CLIENTS,
      sealedFiles: SEALED_FILES,
    });
    const first = bundle.index.blobs[0]!;
    const changed = new Map(bundle.blobs);
    changed.set(first.sha256, `${changed.get(first.sha256)} `);
    expect(() => verifyCodeMemoryLinkRetainedBundleV1({blobs: changed, indexContent: bundle.indexContent})).toThrow(
      /byte length or SHA-256/u,
    );
    const extra = new Map(bundle.blobs);
    extra.set('f'.repeat(64), json({extra: true}));
    expect(() => verifyCodeMemoryLinkRetainedBundleV1({blobs: extra, indexContent: bundle.indexContent})).toThrow(
      /blob map differs/u,
    );
    expect(() => codeMemoryLinkRetainedBundleHashV1(JSON.stringify(JSON.parse(bundle.indexContent)))).toThrow(
      /canonical JSON encoding/u,
    );
  });

  it.each([
    json({authSourcePath: 'redacted'}),
    json({api_key: 'redacted'}),
    json({value: '/Users/operator/private/auth.json'}),
    json({value: String.raw`C:\Users\operator\auth.json`}),
    json({value: 'Bearer abcdefghijklmnopqrstuvwxyz'}),
    json({value: 'sk-abcdefghijklmnopqrstuvwxyz'}),
  ])('rejects auth configuration, absolute paths, and credential-shaped content', unsafe => {
    const input = artifacts();
    input.result = unsafe;
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: input,
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: SEALED_FILES,
      }),
    ).toThrow(/absolute path|credential/u);
  });

  it('retains ordinary relative repository paths and token accounting', () => {
    const input = artifacts();
    input.result = json({providerUsage: {tokens: 1200}, source: 'src/recall/code_links.ts'});
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: input,
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: SEALED_FILES,
      }),
    ).not.toThrow();
  });

  it.each(['../private.json', '/Users/operator/private.json', 'calibration/task.json', 'tasks/../private.json'])(
    'rejects a sealed source outside the reviewed artifacts/tasks tree',
    path => {
      expect(() =>
        createCodeMemoryLinkRetainedBundleV1({
          artifacts: artifacts(),
          candidateCommit: CANDIDATE,
          clients: CLIENTS,
          sealedFiles: [{content: json({version: 1}), path}],
        }),
      ).toThrow(/safe relative artifacts\/ or tasks\/ path/u);
    },
  );

  it('rejects a private absolute path embedded in a retained sealed text artifact', () => {
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: artifacts(),
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: [{content: 'const source = "/Users/operator/private.json";\n', path: 'artifacts/judge/judge.ts'}],
      }),
    ).toThrow(/absolute path/u);
  });

  it('rejects every text absolute path while allowing the reviewed portable interpreter shebang', () => {
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: artifacts(),
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: [{content: 'const source = "/etc/passwd";\n', path: 'artifacts/judge/judge.ts'}],
      }),
    ).toThrow(/absolute path/u);
    expect(() =>
      createCodeMemoryLinkRetainedBundleV1({
        artifacts: artifacts(),
        candidateCommit: CANDIDATE,
        clients: CLIENTS,
        sealedFiles: [{content: '#!/usr/bin/env bun\nexport const judge = 1;\n', path: 'artifacts/judge/judge.ts'}],
      }),
    ).not.toThrow();
  });

  it('rejects every generated Unix home path in any retained JSON role (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'), {minLength: 1, maxLength: 20}),
        characters => {
          const input = artifacts();
          input.sealedLayout = json({observed: `/home/${characters.join('')}/private.json`});
          expect(() =>
            createCodeMemoryLinkRetainedBundleV1({
              artifacts: input,
              candidateCommit: CANDIDATE,
              clients: CLIENTS,
              sealedFiles: SEALED_FILES,
            }),
          ).toThrow(/absolute path/u);
        },
      ),
      {numRuns: 32},
    );
  });
});

function artifacts(): Record<CodeMemoryLinkRetainedArtifactRole, string> {
  return {
    assignment: json({assignmentHash: '1'.repeat(64), version: 1}),
    attempts: jsonl({attemptHash: '2'.repeat(64), version: 1}),
    dogfood: json({artifactHash: '3'.repeat(64), version: 1}),
    evidence: jsonl({evidenceHash: '4'.repeat(64), version: 1}),
    manifest: json({manifestHash: '5'.repeat(64), version: 1}),
    result: json({gate: {status: 'passed'}, version: 1}),
    sealedLayout: json({layoutArtifactId: `art_${'6'.repeat(16)}`, version: 1}),
    sealedSuite: json({suiteHash: '7'.repeat(64), version: 1}),
    trials: jsonl({receiptHash: '8'.repeat(64), version: 1}),
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
