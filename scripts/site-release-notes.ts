import {ScriptError} from './effect/errors.js';
export interface StableReleaseVersion {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface PublishedReleaseRef extends StableReleaseVersion {
  readonly publishedAt: string;
}

export interface WebsiteRelease extends PublishedReleaseRef {
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly releaseUrl: string;
}

interface WebsiteReleaseSource extends PublishedReleaseRef {
  readonly noteRef: string;
}

const STABLE_RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseStableReleaseVersion(version: string): StableReleaseVersion | undefined {
  const match = STABLE_RELEASE.exec(version);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return {major, minor, patch, version};
}

function compareReleasesDescending(left: StableReleaseVersion, right: StableReleaseVersion): number {
  return right.major - left.major || right.minor - left.minor || right.patch - left.patch;
}

export function selectLatestMajorReleases(releases: readonly PublishedReleaseRef[]): readonly PublishedReleaseRef[] {
  if (releases.length === 0) return [];
  const latestMajor = Math.max(...releases.map(release => release.major));
  const byVersion = new Map<string, PublishedReleaseRef>();
  for (const release of releases) {
    if (release.major === latestMajor) byVersion.set(release.version, release);
  }
  return [...byVersion.values()].sort(compareReleasesDescending);
}

function includePreparedWebsiteRelease<T extends PublishedReleaseRef>(
  published: readonly T[],
  prepared: T | undefined,
): readonly T[] {
  if (prepared === undefined || published.some(release => release.version === prepared.version)) return published;
  return [...published, prepared];
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeReleaseNote(markdown: string): {
  readonly summary: string;
  readonly highlights: readonly string[];
} {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const body = normalized.replace(/^## What's new\s*/i, '');
  const lines = body.split('\n');
  const summaryLines: string[] = [];
  let startedSummary = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!startedSummary && (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- '))) continue;
    if (startedSummary && !trimmed) break;
    if (trimmed.startsWith('#') || trimmed.startsWith('- ')) break;
    startedSummary = true;
    summaryLines.push(trimmed);
  }

  const sectionHeadings = lines
    .map(line => /^###\s+(.+)$/.exec(line.trim())?.[1])
    .filter((heading): heading is string => Boolean(heading))
    .map(plainText);
  const bulletHeadings = lines
    .map(line => /^-\s+\*\*(.+?)\.?\*\*/.exec(line.trim())?.[1])
    .filter((heading): heading is string => Boolean(heading))
    .map(plainText);

  return {
    summary: plainText(summaryLines.join(' ')),
    highlights: [...new Set(sectionHeadings.length > 0 ? sectionHeadings : bulletHeadings)],
  };
}

function runGit(repositoryRoot: string, arguments_: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new ScriptError(`Could not load website release notes${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout.toString();
}

function gitObjectExists(repositoryRoot: string, object: string): boolean {
  return (
    Bun.spawnSync({
      cmd: ['git', 'cat-file', '-e', object],
      cwd: repositoryRoot,
      stderr: 'ignore',
      stdout: 'ignore',
    }).exitCode === 0
  );
}

function loadPreparedWebsiteRelease(
  repositoryRoot: string,
  published: readonly WebsiteReleaseSource[],
): WebsiteReleaseSource | undefined {
  const manifest = JSON.parse(runGit(repositoryRoot, ['show', 'HEAD:package.json'])) as {readonly version?: unknown};
  if (typeof manifest.version !== 'string') return undefined;
  const parsed = parseStableReleaseVersion(`v${manifest.version}`);
  if (parsed === undefined) return undefined;
  if (published.some(release => compareReleasesDescending(parsed, release) >= 0)) return undefined;

  const releaseNotePath = `.github/release-notes/${parsed.version}.md`;
  if (!gitObjectExists(repositoryRoot, `HEAD:${releaseNotePath}`)) return undefined;
  const publishedAt = runGit(repositoryRoot, [
    'log',
    '-1',
    '--format=%cI',
    '--',
    'package.json',
    releaseNotePath,
  ]).trim();
  return {...parsed, noteRef: 'HEAD', publishedAt};
}

export function loadLatestMajorWebsiteReleases(repositoryRoot: string): readonly WebsiteRelease[] {
  const published = runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname:short)|%(creatordate:iso-strict)',
    'refs/tags/v*',
  ])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      const separator = line.indexOf('|');
      if (separator < 0) return [];
      const version = line.slice(0, separator);
      const parsed = parseStableReleaseVersion(version);
      if (!parsed) return [];
      return [{...parsed, noteRef: version, publishedAt: line.slice(separator + 1)} satisfies WebsiteReleaseSource];
    });
  const refs = includePreparedWebsiteRelease(published, loadPreparedWebsiteRelease(repositoryRoot, published));

  const selected = selectLatestMajorReleases(refs);
  if (selected.length === 0)
    throw new ScriptError('The website needs at least one published or prepared stable release.');
  const sourcesByVersion = new Map(refs.map(release => [release.version, release]));

  return selected.map(release => {
    const releaseNotePath = `.github/release-notes/${release.version}.md`;
    const source = sourcesByVersion.get(release.version);
    if (source === undefined) throw new ScriptError(`Could not resolve website release source for ${release.version}.`);
    const markdown = runGit(repositoryRoot, ['show', `${source.noteRef}:${releaseNotePath}`]);
    const {summary, highlights} = summarizeReleaseNote(markdown);
    if (!summary) throw new ScriptError(`${releaseNotePath} needs an introductory release summary.`);
    return {
      ...release,
      highlights,
      releaseUrl: `https://github.com/Kashkovsky/threadnote/releases/tag/${release.version}`,
      summary,
    };
  });
}
