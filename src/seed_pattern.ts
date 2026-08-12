const UTF8 = new TextEncoder();
const WINDOWS_DRIVE = /^[a-z]:/iu;

export const PROJECT_SEED_PATTERN_BYTES_MAXIMUM = 1_024;
export const PROJECT_SEED_PATTERN_COUNT_MAXIMUM = 256;
export const PROJECT_SEED_PATTERNS_BYTES_MAXIMUM = 64 * 1_024;

export class InvalidProjectSeedPattern extends Error {
  readonly _tag = 'InvalidProjectSeedPattern' as const;
}

/** Validate a repository-relative seed path/glob without rewriting its bytes. */
export function validateProjectSeedPattern(pattern: string): string {
  if (
    pattern.length === 0 ||
    UTF8.encode(pattern).byteLength > PROJECT_SEED_PATTERN_BYTES_MAXIMUM ||
    hasControlCharacter(pattern)
  ) {
    throw new InvalidProjectSeedPattern('Seed patterns must be non-empty bounded text without control characters.');
  }
  const normalized = pattern.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('~/') ||
    WINDOWS_DRIVE.test(pattern) ||
    normalized.split('/').includes('..')
  ) {
    throw new InvalidProjectSeedPattern('Seed patterns must stay within the configured project root.');
  }
  return pattern;
}

export function validateProjectSeedPatterns(patterns: readonly string[]): readonly string[] {
  if (patterns.length > PROJECT_SEED_PATTERN_COUNT_MAXIMUM) {
    throw new InvalidProjectSeedPattern(
      `A project may configure at most ${PROJECT_SEED_PATTERN_COUNT_MAXIMUM} seed patterns.`,
    );
  }
  let bytes = 0;
  return patterns.map(pattern => {
    const validated = validateProjectSeedPattern(pattern);
    bytes += UTF8.encode(validated).byteLength;
    if (bytes > PROJECT_SEED_PATTERNS_BYTES_MAXIMUM) {
      throw new InvalidProjectSeedPattern('The aggregate seed-pattern payload exceeds the safe limit.');
    }
    return validated;
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
