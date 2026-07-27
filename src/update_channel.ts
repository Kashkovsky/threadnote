export type UpdateChannel = 'beta' | 'latest';

export function isBetaVersion(version: string): boolean {
  const normalized = version.trim().replace(/^v/i, '').split('+', 1)[0] ?? '';
  return /-beta(?:[.-]?\d+)?(?:[.-]|$)/i.test(normalized);
}

export function selectUpdateChannel(currentVersion: string, requestedChannel?: UpdateChannel): UpdateChannel {
  return requestedChannel ?? (isBetaVersion(currentVersion) ? 'beta' : 'latest');
}
