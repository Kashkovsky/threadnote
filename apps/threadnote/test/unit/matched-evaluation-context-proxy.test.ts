import {chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {afterEach, describe, expect, it} from 'vitest';
import {
  handleMatchedEvaluationContextRequest,
  renderMatchedEvaluationRuntimeManifestV1,
  type MatchedEvaluationContextProxyPacketV1,
} from '../../../../scripts/matched-evaluation-context-proxy.js';

describe('matched evaluation context proxy', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('uses a sealed run-local manifest bound to the isolated repository', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots);

    const result = await handleMatchedEvaluationContextRequest(fixture.packet, {
      callerCwd: fixture.repository,
      project: fixture.packet.project,
      task: fixture.packet.prompt,
    });

    expect(result.structuredContent).toEqual({answer: 'prepared context'});
    expect(result.meta).toMatchObject({
      matchedEvaluation: {
        graphReady: true,
        runNonce: fixture.packet.runNonce,
        runtimeManifestSha256: fixture.packet.runtimeManifestSha256,
      },
    });
  });

  it('rejects tampered, rebound, and escaped runtime manifests', async () => {
    if (process.platform === 'win32') return;
    const fixture = await contextFixture(roots);
    const request = {callerCwd: fixture.repository, task: fixture.packet.prompt};

    await writeFile(fixture.manifest, '{}\n');
    await expect(handleMatchedEvaluationContextRequest(fixture.packet, request)).rejects.toThrow(
      'differs from the sealed artifact',
    );

    const rebound = renderMatchedEvaluationRuntimeManifestV1(
      fixture.packet.project,
      join(fixture.root, 'different-repository'),
      fixture.packet.runNonce,
    );
    await writeFile(fixture.manifest, rebound);
    await expect(
      handleMatchedEvaluationContextRequest(
        {...fixture.packet, runtimeManifestSha256: sha256HexSync(Buffer.from(rebound))},
        request,
      ),
    ).rejects.toThrow('does not bind the isolated repository and run');

    const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-context-outside-')));
    roots.push(outsideRoot);
    const escapedManifest = join(outsideRoot, 'manifest.yaml');
    const expected = renderMatchedEvaluationRuntimeManifestV1(
      fixture.packet.project,
      fixture.repository,
      fixture.packet.runNonce,
    );
    await writeFile(escapedManifest, expected, {mode: 0o600});
    await expect(
      handleMatchedEvaluationContextRequest(
        {
          ...fixture.packet,
          runtimeManifestPath: escapedManifest,
          runtimeManifestSha256: sha256HexSync(Buffer.from(expected)),
        },
        request,
      ),
    ).rejects.toThrow('escaped its isolated private root');
  });
});

async function contextFixture(roots: string[]): Promise<{
  readonly manifest: string;
  readonly packet: MatchedEvaluationContextProxyPacketV1;
  readonly repository: string;
  readonly root: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadnote-matched-context-')));
  roots.push(root);
  const repository = join(root, 'repository');
  const threadnoteHome = join(root, 'threadnote-home');
  const privateRoot = join(root, 'agent', 'private');
  await Promise.all([
    mkdir(repository, {recursive: true}),
    mkdir(threadnoteHome, {recursive: true}),
    mkdir(privateRoot, {recursive: true}),
  ]);
  const project = 'matched-evaluation-fixture';
  const runNonce = 'run_0123456789abcdef0123456789abcdef';
  const manifest = join(privateRoot, 'manifest.json');
  const manifestText = renderMatchedEvaluationRuntimeManifestV1(project, repository, runNonce);
  const manifestBytes = Buffer.from(manifestText);
  const executable = join(root, 'threadnote');
  await writeFile(
    executable,
    `#!/bin/sh
manifest=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--manifest' ]; then
    shift
    manifest="$1"
  fi
  shift
done
[ -n "$manifest" ] && [ -f "$manifest" ] || exit 17
grep -F ${shellQuote(JSON.stringify(project))} "$manifest" >/dev/null || exit 18
grep -F ${shellQuote(JSON.stringify(repository))} "$manifest" >/dev/null || exit 19
grep -F ${shellQuote(JSON.stringify(runNonce))} "$manifest" >/dev/null || exit 20
printf '%s\\n' '{"answer":"prepared context"}'
`,
    {mode: 0o700},
  );
  await chmod(executable, 0o700);
  await writeFile(manifest, manifestBytes, {mode: 0o600});
  return {
    manifest,
    packet: {
      budgetTokens: 1_500,
      detail: 'compact',
      expectedContext: {
        graphContentHash: '1'.repeat(64),
        graphSnapshotHash: '2'.repeat(64),
        linkReceiptsHash: null,
        memoryAccess: 'disabled',
        studyHash: '3'.repeat(64),
        taskContextHash: null,
      },
      project,
      prompt: 'Inspect the isolated repository.',
      repositoryRoot: repository,
      runNonce,
      runtimeManifestPath: manifest,
      runtimeManifestSha256: sha256HexSync(manifestBytes),
      threadnoteExecutable: executable,
      threadnoteExecutableSha256: sha256HexSync(await readFile(executable)),
      threadnoteHome,
      version: 1,
    },
    repository,
    root,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
