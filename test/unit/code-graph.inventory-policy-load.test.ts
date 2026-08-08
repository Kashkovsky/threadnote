import {describe, expect, it} from 'vitest';
import {
  PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  productionEligibleFileCount,
  productionExcludedByteDistribution,
  productionRepositoryFileCount,
} from '../../scripts/code-graph-fixture.js';
import {codeGraphInventoryExclusionReason} from '../../src/code_graph/inventory.js';
import {CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES} from '../../src/code_graph/inventory_policy.js';

interface PolicyMetadataEntry {
  readonly path: string;
  readonly size: number;
}

describe('code graph production-shape inventory admission', () => {
  it('classifies the versioned 73k metadata shape deterministically without allocating blob bodies', () => {
    const entries = productionPolicyMetadata();
    const first = classify(entries);
    const second = classify(entries);
    const profile = PRODUCTION_LARGE_CODE_GRAPH_PROFILE;
    const excludedBytes = productionExcludedByteDistribution(profile);

    expect(entries).toHaveLength(productionRepositoryFileCount(profile.classMix));
    expect(first).toEqual(second);
    expect(first).toEqual({
      eligibleFiles: productionEligibleFileCount(profile.classMix),
      excludedBytes: excludedBytes.totalBytes,
      excludedFiles: profile.classMix.generatedSvgFiles + profile.classMix.duplicateHeavyJsonFiles,
      reasons: {
        'generic-json-size': 0,
        'high-signal-json-hard-cap': 0,
        'low-signal-json': profile.classMix.duplicateHeavyJsonFiles,
        svg: profile.classMix.generatedSvgFiles,
      },
    });
  });
});

function classify(entries: readonly PolicyMetadataEntry[]) {
  const reasons = {
    'generic-json-size': 0,
    'high-signal-json-hard-cap': 0,
    'low-signal-json': 0,
    svg: 0,
  };
  let eligibleFiles = 0;
  let excludedBytes = 0;
  for (const entry of entries) {
    const reason = codeGraphInventoryExclusionReason(entry.path, entry.size);
    if (reason === undefined) {
      eligibleFiles += 1;
      continue;
    }
    reasons[reason] += 1;
    excludedBytes += entry.size;
  }
  return {eligibleFiles, excludedBytes, excludedFiles: entries.length - eligibleFiles, reasons};
}

function productionPolicyMetadata(): readonly PolicyMetadataEntry[] {
  const profile = PRODUCTION_LARGE_CODE_GRAPH_PROFILE;
  const entries: PolicyMetadataEntry[] = [];
  append(entries, profile.classMix.typescriptSourceFiles, index => `src/module-${index}.ts`, 128);
  append(entries, profile.classMix.tsxSourceFiles, index => `src/view-${index}.tsx`, 128);
  append(
    entries,
    profile.classMix.packageManifestFiles,
    index => `packages/package-${index}/package.json`,
    CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  );
  append(
    entries,
    profile.classMix.nxProjectFiles,
    index => `apps/application-${index}/project.json`,
    CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  );
  append(
    entries,
    profile.classMix.tsconfigFiles,
    index => `packages/package-${index}/tsconfig.json`,
    CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  );
  append(entries, profile.classMix.workspaceManifestFiles, () => 'pnpm-workspace.yaml', 128);
  append(entries, profile.classMix.supportMarkdownFiles, index => `docs/support/topic-${index}.md`, 128);

  const svgBytes = productionExcludedByteDistribution(profile).generatedSvgBytes;
  const svgBaseSize = Math.floor(svgBytes / profile.classMix.generatedSvgFiles);
  const largerSvgCount = svgBytes % profile.classMix.generatedSvgFiles;
  append(
    entries,
    profile.classMix.generatedSvgFiles,
    index => `assets/generated/icon-${index}.svg`,
    index => svgBaseSize + (index < largerSvgCount ? 1 : 0),
  );
  append(
    entries,
    profile.classMix.duplicateHeavyJsonFiles,
    index => `test/golden-data/payload-${index}.json`,
    profile.duplicateBlobs.heavyJsonPayloadBytes,
  );
  return entries;
}

function append(
  entries: PolicyMetadataEntry[],
  count: number,
  path: (index: number) => string,
  size: number | ((index: number) => number),
): void {
  for (let index = 0; index < count; index += 1) {
    entries.push({path: path(index), size: typeof size === 'number' ? size : size(index)});
  }
}
