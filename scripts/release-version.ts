const CANONICAL_STABLE_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANONICAL_BETA_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;

function hasOnlySafeIntegerComponents(match: RegExpExecArray | null): boolean {
  return match !== null && match.slice(1).every(component => Number.isSafeInteger(Number(component)));
}

export function isSupportedReleaseVersion(version: string): boolean {
  return (
    hasOnlySafeIntegerComponents(CANONICAL_STABLE_RELEASE_VERSION.exec(version)) ||
    hasOnlySafeIntegerComponents(CANONICAL_BETA_RELEASE_VERSION.exec(version))
  );
}
