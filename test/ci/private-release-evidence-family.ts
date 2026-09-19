export interface PrivateReleaseEvidenceFamily {
  readonly focusedTestPaths: readonly string[];
  readonly name: string;
  readonly paths: readonly string[];
}

export const privateReleaseEvidenceFamilies = [
  {
    focusedTestPaths: ['test/unit/evaluation.threadnote-5-product-capture.test.ts'],
    name: 'threadnote-5-product-capture',
    paths: [
      'src/evaluation/threadnote-5-product-capture-events.ts',
      'src/evaluation/threadnote-5-product-capture-sink.ts',
      'src/evaluation/threadnote-5-product-capture.ts',
      'test/unit/evaluation.threadnote-5-product-capture.test.ts',
    ],
  },
  {
    focusedTestPaths: [
      'test/unit/evaluation.threadnote-5-collection-integrity.test.ts',
      'test/unit/evaluation.threadnote-5-release-collection.test.ts',
    ],
    name: 'threadnote-5-release-collection',
    paths: [
      'docs/development/threadnote-5-private-collection.md',
      'scripts/collect-threadnote-5-release-readiness.ts',
      'scripts/threadnote-5-collection-process.ts',
      'scripts/threadnote-5-collection-runner.ts',
      'scripts/threadnote-5-collection-transport.ts',
      'src/evaluation/threadnote-5-release-collection-envelope.ts',
      'src/evaluation/threadnote-5-release-collection.ts',
      'test/helpers/threadnote-5-collection-transcripts.ts',
      'test/unit/evaluation.threadnote-5-collection-integrity.test.ts',
      'test/unit/evaluation.threadnote-5-release-collection.test.ts',
    ],
  },
] as const satisfies readonly PrivateReleaseEvidenceFamily[];

export type PrivateReleaseEvidenceFamilyName = (typeof privateReleaseEvidenceFamilies)[number]['name'];

export interface PrivateReleaseEvidenceSelection {
  readonly focusedTestPaths: readonly string[];
  readonly name: PrivateReleaseEvidenceFamilyName;
}

const familyByPath = new Map<string, (typeof privateReleaseEvidenceFamilies)[number]>();

for (const family of privateReleaseEvidenceFamilies) {
  for (const path of family.paths) familyByPath.set(path, family);
}

export function classifyPurePrivateReleaseEvidenceDiff(
  paths: Iterable<string>,
): PrivateReleaseEvidenceSelection | undefined {
  let family: (typeof privateReleaseEvidenceFamilies)[number] | undefined;
  let changed = false;
  try {
    for (const path of paths) {
      if (typeof path !== 'string') return undefined;
      const candidate = familyByPath.get(path);
      if (!candidate || (family && candidate !== family)) return undefined;
      family = candidate;
      changed = true;
    }
  } catch {
    return undefined;
  }
  return changed && family ? {focusedTestPaths: family.focusedTestPaths, name: family.name} : undefined;
}

export function isPurePrivateReleaseEvidenceDiff(paths: Iterable<string>): boolean {
  return classifyPurePrivateReleaseEvidenceDiff(paths) !== undefined;
}
