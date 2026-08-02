/**
 * Compare two semver-ish / PEP 440 versions. Returns positive if `left > right`,
 * negative if `left < right`, and zero if they are equivalent. This module is
 * intentionally dependency-free so process leases can be inspected without
 * evaluating the full application utility graph.
 */
export function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference;
  }
  const rankDelta = suffixRank(left.suffix) - suffixRank(right.suffix);
  if (rankDelta !== 0) return rankDelta;
  if (left.suffix === right.suffix) return 0;
  return (left.suffix ?? '').localeCompare(right.suffix ?? '', 'en', {numeric: true});
}

function suffixRank(suffix: string | undefined): number {
  if (suffix === undefined) return 0;
  return /^post/i.test(suffix) ? 1 : -1;
}

function parseVersion(version: string): {
  readonly numbers: readonly [number, number, number];
  readonly suffix?: string;
} {
  const normalized = version.trim().replace(/^v/, '').split('+', 1)[0];
  const core = normalized.match(/^\d+(?:\.\d+){0,2}/)?.[0] ?? '';
  const rawSuffix = normalized.slice(core.length).replace(/^[-_.]/, '');
  const suffix = core.length > 0 && rawSuffix.length > 0 ? rawSuffix : undefined;
  const parts = core.split('.');
  return {
    numbers: [
      safeVersionNumber(Number.parseInt(parts[0] ?? '', 10)),
      safeVersionNumber(Number.parseInt(parts[1] ?? '', 10)),
      safeVersionNumber(Number.parseInt(parts[2] ?? '', 10)),
    ],
    suffix,
  };
}

function safeVersionNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
