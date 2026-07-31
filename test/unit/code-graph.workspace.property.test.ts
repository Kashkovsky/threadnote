import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import type {
  CodeGraphWorkspace,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceProject,
} from '../../src/code_graph/languages/types.js';
import type {CodeGraphInventoryFile} from '../../src/code_graph/types.js';
import {discoverManifestWorkspace, mergeCodeGraphWorkspaces} from '../../src/code_graph/workspace.js';

const files = [
  workspaceFile(
    'settings.gradle.kts',
    `
      rootProject.name = "platform"
      include(":libs:shared", ":apps:app")
      project(":libs:shared").projectDir = file("libs/shared")
      project(":apps:app").projectDir = file("apps/app")
    `,
  ),
  workspaceFile('build.gradle.kts', 'plugins { kotlin("jvm") version "2.0.0" }'),
  workspaceFile('libs/shared/build.gradle.kts', 'plugins { kotlin("jvm") }'),
  workspaceFile('libs/shared/src/main/kotlin/Shared.kt', 'class Shared', 'kotlin'),
  workspaceFile('apps/app/settings.gradle.kts', 'rootProject.name = "nested-app"\ninclude(":feature")'),
  workspaceFile(
    'apps/app/build.gradle.kts',
    'plugins { kotlin("jvm") }\ndependencies { implementation(project(":libs:shared")) }',
  ),
  workspaceFile('apps/app/src/main/kotlin/App.kt', 'class App', 'kotlin'),
  workspaceFile('apps/app/feature/build.gradle.kts', 'plugins { kotlin("jvm") }'),
  workspaceFile('apps/app/feature/src/main/kotlin/Feature.kt', 'class Feature', 'kotlin'),
  workspaceFile(
    'services/orders/pom.xml',
    '<project><groupId>dev.threadnote</groupId><artifactId>orders</artifactId><modules><module>api</module></modules></project>',
    'xml',
  ),
  workspaceFile(
    'services/orders/api/pom.xml',
    '<project><parent><groupId>dev.threadnote</groupId><artifactId>orders</artifactId></parent><artifactId>api</artifactId></project>',
    'xml',
  ),
  workspaceFile('services/orders/api/src/main/java/dev/threadnote/Api.java', 'class Api {}', 'java'),
  workspaceFile(
    'ios/Package.swift',
    'let package = Package(name: "Mobile", targets: [.target(name: "MobileCore"), .testTarget(name: "MobileCoreTests", dependencies: ["MobileCore"])])',
    'swift',
  ),
  workspaceFile('ios/Sources/MobileCore/Client.swift', 'struct Client {}', 'swift'),
  workspaceFile('ios/Tests/MobileCoreTests/ClientTests.swift', 'struct ClientTests {}', 'swift'),
] as const;

const permutedFiles = FC.array(FC.integer({max: 10_000, min: -10_000}), {
  maxLength: files.length,
  minLength: files.length,
}).map(priorities =>
  files
    .map((file, index) => ({file, index, priority: priorities[index]!}))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(item => item.file),
);

const shortText = FC.array(FC.constantFrom('a', 'Z', '0', '-', '_', 'é', '漢', '🙂'), {
  maxLength: 8,
  minLength: 1,
}).map(characters => characters.join(''));

const dependencyArbitrary = FC.record({
  evidence: FC.oneof(FC.constant(undefined), shortText),
  provenance: FC.constantFrom<'declared' | 'inferred'>('declared', 'inferred'),
  targetId: FC.constantFrom('cgp_shared', 'cgp_a', 'cgp_b'),
}).map(
  value =>
    ({
      ...(value.evidence === undefined ? {} : {evidence: value.evidence}),
      provenance: value.provenance,
      targetId: value.targetId,
    }) satisfies CodeGraphWorkspaceDependency,
);

const sharedProjectArbitrary = FC.record({
  buildSystem: FC.constantFrom<CodeGraphWorkspaceProject['buildSystem']>(
    'gradle',
    'inferred',
    'maven',
    'swiftpm',
    'xcode',
  ),
  dependencies: FC.array(FC.constantFrom('cgp_shared', 'cgp_a', 'cgp_b'), {maxLength: 5}),
  dependencyDetails: FC.array(dependencyArbitrary, {maxLength: 5}),
  diagnostics: FC.array(shortText, {maxLength: 4}),
  kind: FC.constantFrom<CodeGraphWorkspaceProject['kind']>('module', 'package', 'project', 'target'),
  languages: FC.array(FC.constantFrom('java', 'kotlin', 'swift'), {maxLength: 5}),
  name: shortText,
  provenance: FC.constantFrom<CodeGraphWorkspaceProject['provenance']>('declared', 'inferred'),
  sourceRoots: FC.array(FC.constantFrom('apps/shared/src', 'apps/shared/Sources', 'apps/shared'), {maxLength: 5}),
  workspaceId: FC.constantFrom('cgw_gradle', 'cgw_maven', 'cgw_swift', 'cgw_xcode'),
  workspaceRoots: FC.array(FC.constantFrom('apps', 'apps/shared'), {maxLength: 4}),
}).map(
  value =>
    ({
      ...value,
      id: 'cgp_shared',
      resolutionDomain: 'shared-domain',
      root: 'apps/shared',
    }) satisfies CodeGraphWorkspaceProject,
);

const workspaceFragmentArbitrary = FC.record({
  diagnostics: FC.array(shortText, {maxLength: 4}),
  fingerprint: shortText,
  project: sharedProjectArbitrary,
}).map(
  ({diagnostics, fingerprint, project}) =>
    ({diagnostics, fingerprint, projects: [project], workspaces: []}) satisfies CodeGraphWorkspace,
);

describe('code graph workspace properties', () => {
  it.prop(
    'discovers identical nested and integrated workspace models regardless of inventory order',
    {permuted: permutedFiles},
    ({permuted}) => {
      expect(discoverManifestWorkspace(permuted)).toEqual(discoverManifestWorkspace(files));
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'merges duplicate detector projects commutatively, associatively, and idempotently',
    {fragments: FC.array(workspaceFragmentArbitrary, {maxLength: 8, minLength: 2})},
    ({fragments}) => {
      const expected = mergeCodeGraphWorkspaces(fragments);
      const midpoint = Math.floor(fragments.length / 2);
      const regrouped = mergeCodeGraphWorkspaces([
        mergeCodeGraphWorkspaces(fragments.slice(0, midpoint)),
        mergeCodeGraphWorkspaces(fragments.slice(midpoint)),
      ]);

      expect(mergeCodeGraphWorkspaces([...fragments].reverse())).toEqual(expected);
      expect(regrouped).toEqual(expected);
      expect(mergeCodeGraphWorkspaces([...fragments, ...fragments])).toEqual(expected);
      expect(mergeCodeGraphWorkspaces([expected])).toEqual(expected);
    },
    {fastCheck: {numRuns: 250}},
  );
});

function workspaceFile(path: string, content: string, language = 'text'): CodeGraphInventoryFile {
  return {
    blobId: `blob:${path}`,
    content,
    contentHash: `hash:${path}`,
    language,
    mode: '100644',
    path,
    size: new TextEncoder().encode(content).byteLength,
    source: 'commit',
  };
}
