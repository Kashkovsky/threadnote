import {createPackageAttributorFromIndex, createResolutionAttributorFromIndex, discoverPackages} from './extractor.js';
import {compareCodeUnits} from './ordering.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from './types.js';

/** Attribute changed facts from bounded context plus exact path-membership evidence. */
export function createRepositoryFactAttributorFromContext(
  contextFiles: readonly CodeGraphInventoryFile[],
  existingPaths: ReadonlySet<string>,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const packages = discoverPackages(contextFiles);
  const attributePackages = createPackageAttributorFromIndex(packages);
  const attributeResolution = createResolutionAttributorFromIndex(contextFiles, packages, existingPaths);
  return facts => attributeResolution(attributePackages(facts));
}

/** Record every repository-membership dependency for one exact batch probe. */
export function repositoryFactCandidatePaths(
  contextFiles: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
): readonly string[] {
  const candidates = new RecordingExistingPaths();
  createRepositoryFactAttributorFromContext(contextFiles, candidates)(facts);
  return [...candidates].sort(compareCodeUnits);
}

class RecordingExistingPaths extends Set<string> {
  override has(value: string): boolean {
    this.add(value);
    return false;
  }
}
