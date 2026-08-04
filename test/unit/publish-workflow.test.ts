import {BunFileSystem} from '@effect/platform-bun';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';

const readProjectFile = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.readFileString(`${process.cwd()}/${path}`)),
    Effect.provide(BunFileSystem.layer),
  );

const projectFileExists = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap(fs => fs.exists(`${process.cwd()}/${path}`)),
    Effect.provide(BunFileSystem.layer),
  );

describe('standalone release workflows', () => {
  it.effect('keeps internal architecture records and implementation plans out of the public docs tree', () =>
    Effect.gen(function* () {
      const ignore = yield* readProjectFile('.gitignore');

      expect(ignore).toContain('docs/**/architecture.md');
      expect(ignore).toContain('docs/**/*-architecture.md');
      expect(ignore).toContain('docs/**/*-implementation-plan.md');
      expect(ignore).toContain('docs/**/adr/');
    }),
  );

  it.effect('publishes macOS and Linux while retaining disabled Windows release definitions', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');

      expect(workflow).toContain('oven-sh/setup-bun@v2');
      expect(workflow).toContain('bun-linux-x64-baseline');
      expect(workflow).toContain('bun-linux-arm64');
      expect(workflow).toContain('bun-darwin-x64');
      expect(workflow).toContain('bun-darwin-arm64');
      expect(workflow).toContain('bun-windows-x64-baseline');
      expect(workflow).toContain('bun-windows-arm64');
      expect(workflow).toContain('windows-11-arm');
      expect(workflow.match(/if: \$\{\{ false \}\}/g)).toHaveLength(2);
      expect(workflow).toContain('needs: [verify, linux, macos]');
      expect(workflow).not.toContain('needs: [verify, linux, macos, production-large-evidence]');
      expect(workflow).not.toContain('needs: [linux, macos, windows-sign]');
      expect(workflow).not.toMatch(/\bnpm(?:\s|$)/);
    }),
  );

  it.effect('retains bounded exact-tag production-large evidence without blocking publication', () =>
    Effect.gen(function* () {
      const publish = yield* readProjectFile('.github/workflows/publish.yml');
      const releaseEvidence = yield* readProjectFile('.github/workflows/release-evidence.yml');
      const benchmarks = yield* readProjectFile('.github/workflows/benchmarks.yml');
      const evidence = yield* readProjectFile('.github/workflows/production-large-evidence.yml');

      expect(publish).not.toContain('production-large-evidence:');
      expect(publish).not.toContain('needs.production-large-evidence.result');
      expect(releaseEvidence).toContain('production-large-evidence:');
      expect(releaseEvidence).toContain('uses: ./.github/workflows/production-large-evidence.yml');
      expect(releaseEvidence).toContain('release_ref: ${{ github.ref }}');
      expect(releaseEvidence).toContain('release_sha: ${{ github.sha }}');
      expect(releaseEvidence).toContain('strict: false');
      expect(evidence).toContain('workflow_call:');
      expect(evidence).toContain('timeout-minutes: 30');
      expect(evidence).toContain('timeout-minutes: 20');
      expect(evidence).toContain('continue-on-error: true');
      expect(evidence).toContain('if-no-files-found: error');
      expect(evidence).toContain('retention-days: 90');
      expect(benchmarks).not.toContain("startsWith(github.ref, 'refs/tags/v4.0.0-");
      expect(benchmarks).not.toMatch(/^\s+push:\s*$/m);
    }),
  );

  it.effect('signs and notarizes Apple artifacts and keeps the deferred Authenticode sequence intact', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const publisher = yield* readProjectFile('.github/workflows/publish-release-assets.yml');
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
      expect(publisher).toContain('gh release create');
      expect(publisher).toContain('Verify release immutability');
      expect(workflow).not.toContain('types: [published]');
    }),
  );

  it.effect('requires curated versioned notes and prepends them to generated release notes', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      const publisher = yield* readProjectFile('.github/workflows/publish-release-assets.yml');
      const manifest = JSON.parse(yield* readProjectFile('package.json')) as {readonly version: string};
      const notes = yield* readProjectFile(`.github/release-notes/v${manifest.version}.md`);

      expect(notes.trimStart()).toMatch(/^## What's new\s/);
      expect(workflow).toContain('Verify versioned release notes');
      expect(workflow).toContain('.github/release-notes/${{ github.ref_name }}.md');
      expect(publisher).toContain('release_flags=(--verify-tag --generate-notes)');
      expect(publisher).toContain('--notes "$release_notes"');
    }),
  );

  it.effect('produces a real embedding on every native release runner before signing or archiving', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/publish.yml');
      expect(workflow.match(/Produce a real embedding with the release payload/g)).toHaveLength(3);
      expect(workflow.match(/test\/e2e\/local-bins\.e2e\.ts/g)).toHaveLength(3);
    }),
  );

  it.effect('bytecode-compiles every base target Bun supports in ordinary CI', () =>
    Effect.gen(function* () {
      const workflow = yield* readProjectFile('.github/workflows/ci.yml');
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
    }),
  );

  it.effect('validates exact hosted release runners without broad Actionlint exceptions', () =>
    Effect.gen(function* () {
      const ci = yield* readProjectFile('.github/workflows/ci.yml');
      const publish = yield* readProjectFile('.github/workflows/publish.yml');
      const hostedReleaseRunners = ['macos-15-intel', 'windows-11-arm'] as const;

      expect(ci).toContain('docker://rhysd/actionlint:1.7.8');
      expect(ci).toContain('args: -color');
      expect(ci).not.toMatch(/^\s*args:[^\n]*-ignore/gm);
      expect(yield* projectFileExists('.github/actionlint.yaml')).toBe(false);
      expect(yield* projectFileExists('.github/actionlint.yml')).toBe(false);
      for (const runner of hostedReleaseRunners) {
        expect(publish.match(new RegExp(`runner: ${runner}$`, 'gm'))).toHaveLength(1);
      }
    }),
  );
});
