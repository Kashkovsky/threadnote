import {BunFileSystem} from '@effect/platform-bun';
import {Effect, FileSystem} from 'effect';
import {describe, expect, it} from 'vitest';

const readWorkflow = (name: string) =>
  Effect.runPromise(
    FileSystem.FileSystem.pipe(
      Effect.flatMap(fs => fs.readFileString(`${process.cwd()}/.github/workflows/${name}`)),
      Effect.provide(BunFileSystem.layer),
    ),
  );

describe('standalone release workflows', () => {
  it('publishes macOS and Linux while retaining disabled Windows release definitions', async () => {
    const workflow = await readWorkflow('publish.yml');

    expect(workflow).toContain('oven-sh/setup-bun@v2');
    expect(workflow).toContain('bun-linux-x64-baseline');
    expect(workflow).toContain('bun-linux-arm64');
    expect(workflow).toContain('bun-darwin-x64');
    expect(workflow).toContain('bun-darwin-arm64');
    expect(workflow).toContain('bun-windows-x64-baseline');
    expect(workflow).toContain('bun-windows-arm64');
    expect(workflow).toContain('windows-11-arm');
    expect(workflow.match(/if: \$\{\{ false \}\}/g)).toHaveLength(2);
    expect(workflow).toContain('needs: [linux, macos]');
    expect(workflow).not.toContain('needs: [linux, macos, windows-sign]');
    expect(workflow).not.toMatch(/\bnpm(?:\s|$)/);
  });

  it('signs and notarizes Apple artifacts and keeps the deferred Authenticode sequence intact', async () => {
    const workflow = await readWorkflow('publish.yml');
    const signing = workflow.indexOf('Sign nested native code and Bun executable');
    const notarization = workflow.indexOf('Notarize the exact release payload');
    const macArchive = workflow.indexOf('THREADNOTE_RELEASE_TARGET: darwin-');
    const authenticode = workflow.indexOf('Authenticode-sign executable and native payload');
    const windowsArchive = workflow.indexOf('THREADNOTE_RELEASE_TARGET: windows-');

    expect(signing).toBeGreaterThan(0);
    expect(notarization).toBeGreaterThan(signing);
    expect(macArchive).toBeGreaterThan(notarization);
    expect(workflow).not.toContain('codesign --deep');
    expect(workflow).toContain('find dist/runtime -type f -print0');
    expect(workflow).toContain('azure/artifact-signing-action@v2');
    expect(workflow).toContain('timestamp-rfc3161: http://timestamp.acs.microsoft.com');
    expect(windowsArchive).toBeGreaterThan(authenticode);
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('Verify release immutability');
    expect(workflow).not.toContain('types: [published]');
  });

  it('produces a real embedding on every native release runner before signing or archiving', async () => {
    const workflow = await readWorkflow('publish.yml');
    expect(workflow.match(/Produce a real embedding with the release payload/g)).toHaveLength(3);
    expect(workflow.match(/test\/e2e\/local-bins\.e2e\.ts/g)).toHaveLength(3);
  });

  it('bytecode-compiles every base target Bun supports in ordinary CI', async () => {
    const workflow = await readWorkflow('ci.yml');
    for (const target of [
      'bun-darwin-arm64',
      'bun-darwin-x64',
      'bun-linux-arm64',
      'bun-linux-arm64-musl',
      'bun-linux-x64-baseline',
      'bun-linux-x64-musl-baseline',
      'bun-windows-arm64',
      'bun-windows-x64-baseline',
    ]) {
      expect(workflow).toContain(target);
    }
  });
});
