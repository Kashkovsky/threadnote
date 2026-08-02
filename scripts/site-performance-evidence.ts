import {
  pendingPerformanceEvidence,
  validateBoundRetainedPerformanceArtifact,
  validateRetainedPerformancePayload,
  type PerformanceEvidence,
} from '../website/src/content/performance.js';

export const performanceArtifactRelativePath = 'website/public/performance-evidence.json';
export const performanceBindingRelativePath = 'website/performance/evidence.binding.json';
export const performanceArtifactPublicUrl = 'https://threadnote.io/performance-evidence.json';

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
    throw new Error(`Performance binding ${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Performance binding ${path} has unexpected or missing fields.`);
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
    throw new Error(`Performance binding ${path}.${key} must be ${label}.`);
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
  if (binding.schemaVersion !== 1) throw new Error('Performance binding root.schemaVersion must be 1.');
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

export function bindRetainedPerformanceArtifact(input: {
  readonly artifactBytes: Uint8Array;
  readonly binding: unknown;
  readonly currentSourceTreeSha256: string;
}): PerformanceEvidence {
  const binding = validatePerformanceArtifactBinding(input.binding);
  if (!sha256Pattern.test(input.currentSourceTreeSha256)) {
    throw new Error('Current performance source-tree digest is invalid.');
  }
  const actualArtifactSha256 = sha256Hex(input.artifactBytes);
  if (actualArtifactSha256 !== binding.artifactSha256) {
    throw new Error(
      `Retained performance artifact SHA-256 mismatch: expected ${binding.artifactSha256}, got ${actualArtifactSha256}.`,
    );
  }
  if (input.currentSourceTreeSha256 !== binding.sourceTreeSha256) {
    throw new Error('Retained performance evidence does not match the current Threadnote source tree.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(input.artifactBytes));
  } catch {
    throw new Error('Retained performance artifact is not valid JSON.');
  }
  const payload = validateRetainedPerformancePayload(parsed);
  if (payload.source.threadnote.commit !== binding.sourceThreadnoteCommit) {
    throw new Error('Retained performance artifact and binding name different Threadnote source commits.');
  }

  const artifact = validateBoundRetainedPerformanceArtifact({
    ...payload,
    status: 'verified',
    artifact: {
      url: performanceArtifactPublicUrl,
      sha256: actualArtifactSha256,
      generatedAt: binding.generatedAt,
    },
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

function verifySourceCommit(repositoryRoot: string, sourceCommit: string): void {
  const commit = runGit(repositoryRoot, ['cat-file', '-e', `${sourceCommit}^{commit}`]);
  if (commit.exitCode !== 0) {
    throw new Error(
      `Retained performance source commit ${sourceCommit} is unavailable; use a full Git checkout for the website build.`,
    );
  }
  const ancestor = runGit(repositoryRoot, ['merge-base', '--is-ancestor', sourceCommit, 'HEAD']);
  if (ancestor.exitCode !== 0) {
    throw new Error(`Retained performance source commit ${sourceCommit} is not an ancestor of the website build.`);
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
    throw new Error('Threadnote runtime sources changed after the retained performance run; publish fresh evidence.');
  }
}

export async function computePerformanceSourceTreeSha256(repositoryRoot: string): Promise<string> {
  const listed = runGit(repositoryRoot, ['ls-files', '--stage', '-z', '--', ...performanceSourcePathspecs]);
  if (listed.exitCode !== 0) {
    throw new Error(`Could not inventory performance-bound sources: ${decodeOutput(listed.stderr)}.`);
  }
  const entries = new TextDecoder()
    .decode(listed.stdout)
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const tabIndex = entry.indexOf('\t');
      if (tabIndex === -1) throw new Error('Git returned an invalid performance source entry.');
      const metadata = entry.slice(0, tabIndex).split(' ');
      const mode = metadata[0];
      const path = entry.slice(tabIndex + 1);
      if (!mode || !path) throw new Error('Git returned an incomplete performance source entry.');
      return {mode, path};
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) throw new Error('Performance source inventory is empty.');

  const hasher = new Bun.CryptoHasher('sha256');
  for (const entry of entries) {
    const bytes = new Uint8Array(await Bun.file(`${repositoryRoot}/${entry.path}`).arrayBuffer());
    hasher.update(`${entry.mode}\0${entry.path}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

export async function loadRetainedPerformanceEvidence(repositoryRoot: string): Promise<PerformanceEvidence> {
  const artifactFile = Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`);
  const bindingFile = Bun.file(`${repositoryRoot}/${performanceBindingRelativePath}`);
  const [artifactExists, bindingExists] = await Promise.all([artifactFile.exists(), bindingFile.exists()]);
  if (!artifactExists && !bindingExists) {
    return pendingPerformanceEvidence(
      'Final exact-HEAD cold, incremental, independent-rebuild, query, storage, and Manager evidence is still being retained and reviewed.',
    );
  }
  if (!artifactExists || !bindingExists) {
    throw new Error('Retained performance evidence requires both the local JSON artifact and its binding file.');
  }

  let bindingInput: unknown;
  try {
    bindingInput = JSON.parse(await bindingFile.text());
  } catch {
    throw new Error('Retained performance binding is not valid JSON.');
  }
  const binding = validatePerformanceArtifactBinding(bindingInput);
  verifySourceCommit(repositoryRoot, binding.sourceThreadnoteCommit);
  const [artifactBuffer, currentSourceTreeSha256] = await Promise.all([
    artifactFile.arrayBuffer(),
    computePerformanceSourceTreeSha256(repositoryRoot),
  ]);
  return bindRetainedPerformanceArtifact({
    artifactBytes: new Uint8Array(artifactBuffer),
    binding,
    currentSourceTreeSha256,
  });
}

export async function writePerformanceArtifactBinding(
  repositoryRoot: string,
  generatedAt = new Date().toISOString(),
): Promise<PerformanceArtifactBinding> {
  const artifactFile = Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`);
  if (!(await artifactFile.exists())) {
    throw new Error(`Place the reviewed payload at ${performanceArtifactRelativePath} before creating its binding.`);
  }

  const artifactBytes = new Uint8Array(await artifactFile.arrayBuffer());
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(artifactBytes));
  } catch {
    throw new Error('Retained performance artifact is not valid JSON.');
  }
  const payload = validateRetainedPerformancePayload(parsed);
  verifySourceCommit(repositoryRoot, payload.source.threadnote.commit);
  const binding = validatePerformanceArtifactBinding({
    schemaVersion: 1,
    artifactSha256: sha256Hex(artifactBytes),
    generatedAt,
    sourceThreadnoteCommit: payload.source.threadnote.commit,
    sourceTreeSha256: await computePerformanceSourceTreeSha256(repositoryRoot),
  });
  await Bun.write(`${repositoryRoot}/${performanceBindingRelativePath}`, `${JSON.stringify(binding, undefined, 2)}\n`);
  return binding;
}

if (import.meta.main) {
  try {
    const binding = await writePerformanceArtifactBinding(process.cwd());
    console.log(`Wrote ${performanceBindingRelativePath}`);
    console.log(`Artifact SHA-256: ${binding.artifactSha256}`);
    console.log(`Source tree SHA-256: ${binding.sourceTreeSha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
