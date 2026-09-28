export type UpdateChannel = 'beta' | 'latest';

const DEVELOPMENT_VERSION_SUFFIX = /(?:^|[.-])local\.g[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

export function isPrereleaseVersion(version: string): boolean {
  const normalized = version.trim().replace(/^v/i, '').split('+', 1)[0] ?? '';
  const releaseVersion = normalized.replace(DEVELOPMENT_VERSION_SUFFIX, '');
  return /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u.test(releaseVersion);
}

/** Compatibility name retained for callers that predate the inclusive preview-channel contract. */
export function isBetaVersion(version: string): boolean {
  return isPrereleaseVersion(version);
}

export function selectUpdateChannel(currentVersion: string, requestedChannel?: UpdateChannel): UpdateChannel {
  return requestedChannel ?? (isBetaVersion(currentVersion) ? 'beta' : 'latest');
}
