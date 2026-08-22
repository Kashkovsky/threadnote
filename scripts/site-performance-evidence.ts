import {ScriptError} from './effect/errors.js';
import {parseBenchmarkArtifactV1} from '../src/evaluation/benchmark.js';
import {RELEASE_EVIDENCE_HARNESS_DELTA_PATHS} from '../src/evaluation/external_evidence.js';
import {
  pendingPerformanceEvidence,
  retainedPerformanceArtifactFromHarness,
  validateRetainedPerformancePayload,
  type PerformanceEvidence,
  type RetainedPerformancePayload,
} from '../website/src/content/performance.js';

export const performanceArtifactRelativePath = 'website/public/performance-evidence.json';
export const performanceBindingRelativePath = 'website/performance/evidence.binding.json';
export function performanceArtifactPublicUrl(siteBase: string): string {
  const segments = siteBase.split('/').filter(Boolean);
  if (
    !siteBase.startsWith('/') ||
    !siteBase.endsWith('/') ||
    siteBase.includes('//') ||
    segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    throw new ScriptError('THREADNOTE_SITE_BASE must be a root-relative directory path ending in /.');
  }
  return `${siteBase}performance-evidence.json`;
}

export const performanceSourcePathspecs = [
  'src',
  'scripts',
  'manager',
  'config',
  'assets',
  'package.json',
  'bun.lock',
  'tsconfig.json',
] as const;

export type PerformanceArtifactBinding = Readonly<{
  schemaVersion: 1;
  artifactSha256: string;
  generatedAt: string;
  sourceThreadnoteCommit: string;
  sourceTreeSha256: string;
}>;

const sha40Pattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function exactRecord(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScriptError(`Performance binding ${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ScriptError(`Performance binding ${path} has unexpected or missing fields.`);
  }
  return record;
}

function matchingString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  pattern: RegExp,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ScriptError(`Performance binding ${path}.${key} must be ${label}.`);
  }
  return value;
}

export function validatePerformanceArtifactBinding(input: unknown): PerformanceArtifactBinding {
  const binding = exactRecord(input, 'root', [
    'schemaVersion',
    'artifactSha256',
    'generatedAt',
    'sourceThreadnoteCommit',
    'sourceTreeSha256',
  ]);
  if (binding.schemaVersion !== 1) throw new ScriptError('Performance binding root.schemaVersion must be 1.');
  matchingString(binding, 'artifactSha256', 'root', sha256Pattern, 'a lowercase SHA-256 digest');
  matchingString(binding, 'generatedAt', 'root', utcTimestampPattern, 'an ISO-8601 UTC timestamp');
  matchingString(binding, 'sourceThreadnoteCommit', 'root', sha40Pattern, 'a lowercase 40-character Git commit');
  matchingString(binding, 'sourceTreeSha256', 'root', sha256Pattern, 'a lowercase SHA-256 digest');
  return input as PerformanceArtifactBinding;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function parseRetainedPerformanceArtifactBytes(artifactBytes: Uint8Array): RetainedPerformancePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(artifactBytes));
  } catch {
    throw new ScriptError('Retained performance artifact is not valid JSON.');
  }
  parseBenchmarkArtifactV1(parsed);
  return validateRetainedPerformancePayload(parsed);
}

export function bindRetainedPerformanceArtifact(input: {
  readonly artifactBytes: Uint8Array;
  readonly artifactPublicUrl: string;
  readonly binding: unknown;
  readonly currentLockfileSha256: string;
  readonly currentPackageManifestSha256: string;
  readonly currentSourceTreeSha256: string;
}): PerformanceEvidence {
  const binding = validatePerformanceArtifactBinding(input.binding);
  if (!sha256Pattern.test(input.currentSourceTreeSha256)) {
    throw new ScriptError('Current performance source-tree digest is invalid.');
  }
  const actualArtifactSha256 = sha256Hex(input.artifactBytes);
  if (actualArtifactSha256 !== binding.artifactSha256) {
    throw new ScriptError(
      `Retained performance artifact SHA-256 mismatch: expected ${binding.artifactSha256}, got ${actualArtifactSha256}.`,
    );
  }
  if (input.currentSourceTreeSha256 !== binding.sourceTreeSha256) {
    throw new ScriptError('Retained performance evidence does not match the current Threadnote source tree.');
  }

  const payload = parseRetainedPerformanceArtifactBytes(input.artifactBytes);
  if (payload.environment.commit !== binding.sourceThreadnoteCommit) {
    throw new ScriptError('Retained performance artifact and binding name different Threadnote source commits.');
  }
  const artifact = retainedPerformanceArtifactFromHarness(payload, {
    artifactUrl: input.artifactPublicUrl,
    artifactSha256: actualArtifactSha256,
    generatedAt: binding.generatedAt,
    currentLockfileSha256: input.currentLockfileSha256,
    currentPackageManifestSha256: input.currentPackageManifestSha256,
  });
  return {state: 'verified', artifact};
}

function decodeOutput(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes).trim() : '';
}

function runGit(repositoryRoot: string, arguments_: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function requireSuccessfulGit(result: ReturnType<typeof Bun.spawnSync>, operation: string): void {
  if (result.exitCode !== 0) {
    throw new ScriptError(
      `Could not ${operation}: ${decodeOutput(result.stderr) || `git exited with ${result.exitCode}`}.`,
    );
  }
}

export function assertPerformanceSourceClean(repositoryRoot: string): void {
  const unstaged = runGit(repositoryRoot, ['diff', '--quiet', '--', ...performanceSourcePathspecs]);
  if (unstaged.exitCode === 1) {
    throw new ScriptError('Performance-bound sources contain tracked working-tree modifications.');
  }
  requireSuccessfulGit(unstaged, 'inspect tracked performance-source modifications');

  const staged = runGit(repositoryRoot, ['diff', '--cached', '--quiet', '--', ...performanceSourcePathspecs]);
  if (staged.exitCode === 1) {
    throw new ScriptError('Performance-bound sources contain staged modifications.');
  }
  requireSuccessfulGit(staged, 'inspect staged performance-source modifications');

  const untracked = runGit(repositoryRoot, ['ls-files', '--others', '-z', '--', ...performanceSourcePathspecs]);
  requireSuccessfulGit(untracked, 'inspect untracked performance sources');
  if ((untracked.stdout?.byteLength ?? 0) > 0) {
    throw new ScriptError('Performance-bound sources contain untracked files.');
  }
}

function verifySourceCommit(repositoryRoot: string, sourceCommit: string): void {
  assertPerformanceSourceClean(repositoryRoot);
  const commit = runGit(repositoryRoot, ['cat-file', '-e', `${sourceCommit}^{commit}`]);
  if (commit.exitCode !== 0) {
    throw new ScriptError(
      `Retained performance source commit ${sourceCommit} is unavailable; use a full Git checkout for the website build.`,
    );
  }
  const ancestor = runGit(repositoryRoot, ['merge-base', '--is-ancestor', sourceCommit, 'HEAD']);
  if (ancestor.exitCode !== 0) {
    throw new ScriptError(
      `Retained performance source commit ${sourceCommit} is not an ancestor of the website build.`,
    );
  }
  const changed = runGit(repositoryRoot, [
    'diff',
    '--quiet',
    sourceCommit,
    'HEAD',
    '--',
    ...performanceSourcePathspecs,
  ]);
  if (changed.exitCode !== 0) {
    throw new ScriptError(
      'Threadnote runtime sources changed after the retained performance run; publish fresh evidence.',
    );
  }
}

function verifyReleaseEvidenceSource(repositoryRoot: string, payload: RetainedPerformancePayload): void {
  const ref = String(payload.metadata.releaseEvidenceRef);
  const releaseSha = String(payload.metadata.releaseEvidenceSha);
  const sourceMode = String(payload.metadata.releaseEvidenceSourceMode);
  const harnessCommit = String(payload.metadata.releaseEvidenceHarnessCommit);
  const resolved = runGit(repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  requireSuccessfulGit(resolved, 'resolve the retained performance release tag');
  if (decodeOutput(resolved.stdout) !== releaseSha) {
    throw new ScriptError('Retained performance release tag does not resolve to its recorded release commit.');
  }
  if (
    sourceMode === 'exact-release' &&
    harnessCommit === releaseSha &&
    payload.environment.commit === releaseSha &&
    payload.metadata.releaseEvidenceHarnessDeltaPaths === '[]'
  ) {
    return;
  }
  if (
    sourceMode !== 'release-plus-reviewed-harness-delta' ||
    harnessCommit !== payload.environment.commit ||
    harnessCommit === releaseSha
  ) {
    throw new ScriptError('Retained performance evidence has invalid release/harness source binding.');
  }
  const mergeBase = runGit(repositoryRoot, ['merge-base', releaseSha, harnessCommit]);
  requireSuccessfulGit(mergeBase, 'verify the retained performance harness ancestry');
  if (decodeOutput(mergeBase.stdout) !== releaseSha) {
    throw new ScriptError('Retained performance harness commit is not a descendant of its release commit.');
  }
  const changed = runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    `${releaseSha}..${harnessCommit}`,
    '--',
    ...performanceSourcePathspecs,
  ]);
  requireSuccessfulGit(changed, 'inspect the retained performance harness delta');
  const deltaPaths = decodeOutput(changed.stdout).split('\n').filter(Boolean).sort();
  const recordedDelta = String(payload.metadata.releaseEvidenceHarnessDeltaPaths);
  if (
    JSON.stringify(deltaPaths) !== recordedDelta ||
    deltaPaths.length === 0 ||
    deltaPaths.some(path => !(RELEASE_EVIDENCE_HARNESS_DELTA_PATHS as readonly string[]).includes(path))
  ) {
    throw new ScriptError('Retained performance harness delta contains unreviewed runtime-source changes.');
  }
}

export async function computePerformanceSourceTreeSha256(repositoryRoot: string): Promise<string> {
  assertPerformanceSourceClean(repositoryRoot);
  const listed = runGit(repositoryRoot, ['ls-files', '--stage', '-z', '--', ...performanceSourcePathspecs]);
  if (listed.exitCode !== 0) {
    throw new ScriptError(`Could not inventory performance-bound sources: ${decodeOutput(listed.stderr)}.`);
  }
  const entries = new TextDecoder()
    .decode(listed.stdout)
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const tabIndex = entry.indexOf('\t');
      if (tabIndex === -1) throw new ScriptError('Git returned an invalid performance source entry.');
      const metadata = entry.slice(0, tabIndex).split(' ');
      const mode = metadata[0];
      const path = entry.slice(tabIndex + 1);
      if (!mode || !path) throw new ScriptError('Git returned an incomplete performance source entry.');
      return {mode, path};
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) throw new ScriptError('Performance source inventory is empty.');

  const hasher = new Bun.CryptoHasher('sha256');
  for (const entry of entries) {
    const bytes = new Uint8Array(await Bun.file(`${repositoryRoot}/${entry.path}`).arrayBuffer());
    hasher.update(`${entry.mode}\0${entry.path}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

async function currentSourceDependencyHashes(repositoryRoot: string): Promise<{
  readonly lockfileSha256: string;
  readonly packageManifestSha256: string;
}> {
  const [lockfile, packageManifest] = await Promise.all([
    Bun.file(`${repositoryRoot}/bun.lock`).arrayBuffer(),
    Bun.file(`${repositoryRoot}/package.json`).arrayBuffer(),
  ]);
  return {
    lockfileSha256: sha256Hex(new Uint8Array(lockfile)),
    packageManifestSha256: sha256Hex(new Uint8Array(packageManifest)),
  };
}

export async function loadRetainedPerformanceEvidence(
  repositoryRoot: string,
  siteBase: string,
): Promise<PerformanceEvidence> {
  const artifactFile = Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`);
  const bindingFile = Bun.file(`${repositoryRoot}/${performanceBindingRelativePath}`);
  const [artifactExists, bindingExists] = await Promise.all([artifactFile.exists(), bindingFile.exists()]);
  if (!artifactExists && !bindingExists) {
    return pendingPerformanceEvidence(
      'Final exact-HEAD cold, incremental, independent-rebuild, query, storage, and Manager evidence is still being retained and reviewed.',
    );
  }
  if (!artifactExists || !bindingExists) {
    throw new ScriptError('Retained performance evidence requires both the local JSON artifact and its binding file.');
  }

  let bindingInput: unknown;
  try {
    bindingInput = JSON.parse(await bindingFile.text());
  } catch {
    throw new ScriptError('Retained performance binding is not valid JSON.');
  }
  const binding = validatePerformanceArtifactBinding(bindingInput);
  verifySourceCommit(repositoryRoot, binding.sourceThreadnoteCommit);
  const [artifactBuffer, currentSourceTreeSha256, dependencyHashes] = await Promise.all([
    artifactFile.arrayBuffer(),
    computePerformanceSourceTreeSha256(repositoryRoot),
    currentSourceDependencyHashes(repositoryRoot),
  ]);
  const artifactBytes = new Uint8Array(artifactBuffer);
  verifyReleaseEvidenceSource(repositoryRoot, parseRetainedPerformanceArtifactBytes(artifactBytes));
  return bindRetainedPerformanceArtifact({
    artifactBytes,
    artifactPublicUrl: performanceArtifactPublicUrl(siteBase),
    binding,
    currentLockfileSha256: dependencyHashes.lockfileSha256,
    currentPackageManifestSha256: dependencyHashes.packageManifestSha256,
    currentSourceTreeSha256,
  });
}

export async function writePerformanceArtifactBinding(repositoryRoot: string): Promise<PerformanceArtifactBinding> {
  const artifactFile = Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`);
  if (!(await artifactFile.exists())) {
    throw new ScriptError(
      `Place the reviewed payload at ${performanceArtifactRelativePath} before creating its binding.`,
    );
  }

  const artifactBytes = new Uint8Array(await artifactFile.arrayBuffer());
  const payload = parseRetainedPerformanceArtifactBytes(artifactBytes);
  verifySourceCommit(repositoryRoot, payload.environment.commit);
  verifyReleaseEvidenceSource(repositoryRoot, payload);
  const [sourceTreeSha256, dependencyHashes] = await Promise.all([
    computePerformanceSourceTreeSha256(repositoryRoot),
    currentSourceDependencyHashes(repositoryRoot),
  ]);
  const binding = validatePerformanceArtifactBinding({
    schemaVersion: 1,
    artifactSha256: sha256Hex(artifactBytes),
    generatedAt: payload.createdAt,
    sourceThreadnoteCommit: payload.environment.commit,
    sourceTreeSha256,
  });
  retainedPerformanceArtifactFromHarness(payload, {
    artifactUrl: performanceArtifactPublicUrl('/'),
    artifactSha256: binding.artifactSha256,
    generatedAt: binding.generatedAt,
    currentLockfileSha256: dependencyHashes.lockfileSha256,
    currentPackageManifestSha256: dependencyHashes.packageManifestSha256,
  });
  await Bun.write(`${repositoryRoot}/${performanceBindingRelativePath}`, `${JSON.stringify(binding, undefined, 2)}\n`);
  return binding;
}

if (import.meta.main) {
  try {
    const binding = await writePerformanceArtifactBinding(process.cwd());
    process.stdout.write(
      `Wrote ${performanceBindingRelativePath}\n` +
        `Artifact SHA-256: ${binding.artifactSha256}\n` +
        `Source tree SHA-256: ${binding.sourceTreeSha256}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
