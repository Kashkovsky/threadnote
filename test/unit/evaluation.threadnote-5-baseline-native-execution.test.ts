/* oxlint-disable effecttsgo/node-builtin-import -- Native process boundary regressions use compiler and filesystem fixtures. */
import {chmod, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {pinBaselineExecutableCopy} from '../../scripts/threadnote-5-baseline-filesystem-boundary.js';
import {
  captureThreadnote5PinnedExecutableV1,
  prepareThreadnote5DescriptorExecHelperV1,
} from '../../scripts/threadnote-5-baseline-runtime-capture.js';
import {sha256HexSync} from '../../src/crypto/sha256.js';

const roles = ['baseline', 'observer', 'judge'] as const;
const routes = roles.flatMap(role => [false, true].map(networkIsolated => ({role, networkIsolated})));
const sandboxAvailable =
  process.platform === 'darwin' ||
  (process.platform === 'linux' &&
    Bun.spawnSync(['/usr/bin/unshare', '--user', '--map-root-user', '--net', '--', '/usr/bin/true']).exitCode === 0);

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'kernel-bound evidence image selection',
  () => {
    for (const {role, networkIsolated} of routes) {
      describe.skipIf(networkIsolated && !sandboxAvailable)(`${role}, sandbox=${networkIsolated}`, () => {
        it('ignores helper pathname substitution after parent verification', async () => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-helper-selection-'));
          try {
            const identity = await nativeFixture(root, 'reviewed');
            const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
            const result = await captureThreadnote5PinnedExecutableV1({
              ...captureOptions(root),
              executable: identity,
              helper,
              networkIsolated,
              role,
              hooks: {
                afterExecutableVerification: async ({helperPath}) => {
                  await rename(helperPath, `${helperPath}-original`);
                  await writeFile(helperPath, 'raise RuntimeError("unreviewed helper ran")');
                },
              },
            });
            expect(result.stdout).toBe('reviewed');
            expect(await readFile(helper.path, 'utf8')).toContain('unreviewed helper ran');
          } finally {
            await rm(root, {recursive: true, force: true});
          }
        });

        it('executes the pinned image after post-verification target path substitution', async () => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-image-selection-'));
          try {
            const identity = await nativeFixture(root, 'reviewed');
            const replacement = await nativeFixture(root, 'replaced');
            const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
            const result = await captureThreadnote5PinnedExecutableV1({
              ...captureOptions(root),
              executable: identity,
              helper,
              networkIsolated,
              role,
              hooks: {
                afterExecutableVerification: async ({executablePath}) => {
                  await rename(executablePath, `${executablePath}-original`);
                  await rename(replacement.path, executablePath);
                },
              },
            });
            expect(result.stdout).toBe('reviewed');
          } finally {
            await rm(root, {recursive: true, force: true});
          }
        });

        it('rejects equal-length in-place target mutation after parent verification', async () => {
          const root = await mkdtemp(join(tmpdir(), 'threadnote-image-mutation-'));
          try {
            const identity = await nativeFixture(root, 'reviewed');
            const replacement = await nativeFixture(root, 'replaced');
            const alternateBytes = await readFile(replacement.path);
            expect(alternateBytes.byteLength).toBe(Number(identity.size));
            const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
            await expect(
              captureThreadnote5PinnedExecutableV1({
                ...captureOptions(root),
                executable: identity,
                helper,
                networkIsolated,
                role,
                hooks: {
                  afterExecutableVerification: async ({executablePath}) => {
                    await chmod(executablePath, 0o700);
                    await writeFile(executablePath, alternateBytes);
                    await chmod(executablePath, 0o500);
                  },
                },
              }),
            ).rejects.toThrow(/failed with exit code 125/u);
            await expect(readFile(join(root, 'unreviewed-ran'))).rejects.toMatchObject({code: 'ENOENT'});
          } finally {
            await rm(root, {recursive: true, force: true});
          }
        });
      });
    }

    it('rejects script inputs before running their interpreter', async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-script-image-'));
      try {
        const source = join(root, 'source');
        const contents = '#!/bin/sh\ntouch unreviewed-ran\n';
        await writeFile(source, contents, {mode: 0o500});
        const identity = await pinBaselineExecutableCopy(source, join(root, 'pinned'), sha256HexSync(contents));
        const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
        await expect(
          captureThreadnote5PinnedExecutableV1({
            ...captureOptions(root),
            executable: identity,
            helper,
            networkIsolated: false,
            role: 'observer',
          }),
        ).rejects.toThrow(/failed with exit code 125/u);
        await expect(readFile(join(root, 'unreviewed-ran'))).rejects.toMatchObject({code: 'ENOENT'});
      } finally {
        await rm(root, {recursive: true, force: true});
      }
    });
  },
);

describe.skipIf(process.platform !== 'darwin')('suspended image attestation', () => {
  it('rejects a substituted actual image before resuming the suspended child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-suspended-vnode-'));
    try {
      const identity = await nativeFixture(root, 'reviewed');
      const replacement = await nativeFixture(root, 'replaced');
      const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
      const source = helper.source.replace(
        'error = lib.posix_spawn(',
        `lib.fchflags(image, 0); os.replace(${JSON.stringify(replacement.path)}, path); error = lib.posix_spawn(`,
      );
      expect(source).not.toBe(helper.source);
      await expect(
        captureThreadnote5PinnedExecutableV1({
          ...captureOptions(root),
          executable: identity,
          helper: {...helper, source},
          networkIsolated: true,
          role: 'baseline',
        }),
      ).rejects.toThrow(/failed with exit code 125/u);
      await expect(readFile(join(root, 'unreviewed-ran'))).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects in-place image mutation after the child was suspended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-suspended-bytes-'));
    try {
      const identity = await nativeFixture(root, 'reviewed');
      const replacement = await nativeFixture(root, 'replaced');
      const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
      const source = helper.source.replace(
        'final = version(os.fstat(image))',
        `lib.fchflags(image, 0); attack = os.open(path, os.O_WRONLY); os.write(attack, open(${JSON.stringify(replacement.path)}, 'rb').read()); os.close(attack); lib.fchflags(image, stat.UF_IMMUTABLE)\n        final = version(os.fstat(image))`,
      );
      expect(source).not.toBe(helper.source);
      await expect(
        captureThreadnote5PinnedExecutableV1({
          ...captureOptions(root),
          executable: identity,
          helper: {...helper, source},
          networkIsolated: true,
          role: 'judge',
        }),
      ).rejects.toThrow(/failed with exit code 125/u);
      await expect(readFile(join(root, 'unreviewed-ran'))).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'reaps a timed-out native child and releases its private image for cleanup',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadnote-native-timeout-'));
    try {
      const source = join(root, 'hang.c');
      const executable = join(root, 'hang-source');
      await writeFile(
        source,
        '#include <signal.h>\n#include <unistd.h>\nint main(void) { signal(SIGTERM, SIG_IGN); for (;;) pause(); }\n',
      );
      expect(Bun.spawnSync(['/usr/bin/cc', source, '-o', executable]).exitCode).toBe(0);
      const identity = await pinBaselineExecutableCopy(
        executable,
        join(root, 'hang'),
        sha256HexSync(await readFile(executable)),
      );
      const helper = await prepareThreadnote5DescriptorExecHelperV1(root);
      await expect(
        captureThreadnote5PinnedExecutableV1({
          ...captureOptions(root),
          executable: identity,
          helper,
          networkIsolated: process.platform === 'darwin',
          role: 'baseline',
          timeoutMilliseconds: 400,
        }),
      ).rejects.toThrow(/exceeded 400 ms/u);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  },
);

function captureOptions(root: string) {
  return {
    arguments: [],
    cwd: root,
    environment: {PATH: '/usr/bin:/bin', TMPDIR: root},
    label: 'native image regression',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 10_000,
  };
}

async function nativeFixture(root: string, message: 'reviewed' | 'replaced') {
  const source = join(root, `${message}.c`);
  const executable = join(root, `${message}-source`);
  await writeFile(
    source,
    `#include <stdio.h>\n#include <string.h>\nint main(void) { const char *s = "${message}"; if (strcmp(s, "replaced") == 0) { FILE *f = fopen("unreviewed-ran", "w"); if (f) fclose(f); } fputs(s, stdout); return 0; }\n`,
  );
  const result = Bun.spawnSync(['/usr/bin/cc', '-O0', source, '-o', executable]);
  expect(result.exitCode).toBe(0);
  return await pinBaselineExecutableCopy(executable, join(root, message), sha256HexSync(await readFile(executable)));
}
