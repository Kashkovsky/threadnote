import {Clock, Data, Effect, FileSystem, Path} from 'effect';
import {extractorSetIdentityFromPackProvenance} from '../code_graph/indexer.js';
import {codeGraphLayout} from '../code_graph/layout.js';
import {CodeGraphQueryService} from '../code_graph/query.js';
import {resolveRepositoryIdentity} from '../code_graph/repository.js';
import {CodeGraphStore} from '../code_graph/store.js';
import {createCodeGraphWorksetRoutingProjection} from '../code_graph/workset_catalog/projection.js';
import {
  publishCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGeneration,
} from '../code_graph/workset_catalog/store.js';
import {CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION} from '../code_graph/workset_catalog/types.js';
import {codeGraphWorksetManifestDigest} from '../code_graph/workset_catalog/workset.js';
import type {CodeGraphInventoryFile, CodeGraphSnapshot, CodeGraphStatus} from '../code_graph/types.js';
import {sha256HexSync} from '../crypto/sha256.js';
import {runCommandEffect} from '../effect/command.js';
import {createMemoryCodeCitation, formatMemoryCodeCitationLines} from '../memory_code_citation.js';
import {loadRecallIndexData, recallIndexStatus} from '../recall/index.js';
import type {ProjectManifest, ResolvedWorkset, RuntimeConfig} from '../types.js';
import type {
  ContextBriefCitationScaleBudgetV1,
  ContextBriefCitationScaleProfileId,
  ContextBriefCitationScaleProfileV1,
} from './context-brief-citation-scale-contract.js';

const PROJECT = 'threadnote-scale';
const EXTRACTOR_SET = extractorSetIdentityFromPackProvenance([]);
const FIXED_INSTANT = '2026-08-26T00:00:00.000Z';

class ContextBriefCitationScaleFixtureError extends Data.TaggedError('ContextBriefCitationScaleFixtureError')<{
  readonly message: string;
}> {}

export interface ContextBriefCitationScaleRepositoryFixture {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly name: string;
  readonly repositoryId: string;
  readonly root: string;
  readonly snapshotId: string;
  readonly status: CodeGraphStatus;
  readonly worktreeId: string;
}

export interface ContextBriefCitationScalePreparedProfile {
  readonly generation?: {readonly digest: string; readonly id: string};
  readonly profile: ContextBriefCitationScaleProfileV1;
  readonly repositories: readonly ContextBriefCitationScaleRepositoryFixture[];
  readonly workset?: ResolvedWorkset;
}

export interface ContextBriefCitationScalePreparedFixture {
  readonly config: RuntimeConfig;
  readonly indexedMemoryCandidates: number;
  readonly legacyV1MemoryCandidates: number;
  readonly profiles: ReadonlyMap<ContextBriefCitationScaleProfileId, ContextBriefCitationScalePreparedProfile>;
  readonly readyGraphSetupMilliseconds: number;
  readonly recallIndexBuildMilliseconds: number;
  readonly runToken: (profile: ContextBriefCitationScaleProfileId, ordinal: number) => string;
}

export interface ContextBriefCitationScaleFixtureOptions {
  readonly budget: ContextBriefCitationScaleBudgetV1;
  readonly memoryCandidates: number;
  readonly profileIds: readonly ContextBriefCitationScaleProfileId[];
  readonly runCount: number;
}

/**
 * Build the synthetic scale shape through real Git repositories, prebuilt graph
 * SQLite stores, memory files, recall SQLite, and published workset storage.
 * Snapshot activation is setup work; this deliberately performs no indexing.
 */
export const prepareContextBriefCitationScaleFixture = Effect.fn('evaluation.prepareContextBriefCitationScaleFixture')(
  function* (root: string, options: ContextBriefCitationScaleFixtureOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(root, 'threadnote-home');
    const manifestPath = path.join(root, 'manifest.json');
    yield* fs.makeDirectory(home, {recursive: true});
    const preparedProfiles = new Map<ContextBriefCitationScaleProfileId, ContextBriefCitationScalePreparedProfile>();
    const projects: ProjectManifest[] = [];
    const worksets: Array<{readonly name: string; readonly projects: readonly string[]}> = [];
    const readyGraphSetupStarted = yield* Clock.currentTimeNanos;
    for (const profile of options.budget.profiles) {
      const repositories = yield* prepareRepositories(fs, path, home, root, profile, options.runCount);
      projects.push(...repositories.map(repositoryProject));
      if (profile.id === 'local-100k') {
        preparedProfiles.set(profile.id, {profile, repositories});
        continue;
      }
      const workset: ResolvedWorkset = {
        name: profile.id,
        projects: repositories.map(repositoryProject),
        unresolvedProjects: [],
      };
      worksets.push({name: workset.name, projects: workset.projects.map(project => project.name)});
      preparedProfiles.set(profile.id, {profile, repositories, workset});
    }
    const query = yield* CodeGraphQueryService;
    yield* Effect.forEach(
      [...preparedProfiles.values()].flatMap(profile => profile.repositories),
      repository =>
        query
          .statusForPublishedIdentity(
            home,
            repository.root,
            {
              checkoutId: repository.checkoutId,
              repositoryId: repository.repositoryId,
              worktreeId: repository.worktreeId,
            },
            {observeWorktree: true, requestMaintenance: false},
          )
          .pipe(
            Effect.flatMap(status =>
              !status.stale && status.freshness === 'current' && status.readySnapshot?.id === repository.snapshotId
                ? Effect.void
                : Effect.fail(
                    new ContextBriefCitationScaleFixtureError({
                      message: `Prebuilt scale graph is not current: ${JSON.stringify({
                        actualSnapshot: status.readySnapshot?.id,
                        expectedSnapshot: repository.snapshotId,
                        extractorSet: status.readySnapshot?.extractorSet,
                        freshness: status.freshness,
                        languagePacks: status.languagePacks.map(pack => pack.id),
                        repository: repository.name,
                        stale: status.stale,
                      })}`,
                    }),
                  ),
            ),
          ),
      {concurrency: 16, discard: true},
    );
    const readyGraphSetupFinished = yield* Clock.currentTimeNanos;
    yield* fs.writeFileString(manifestPath, `${JSON.stringify({projects, version: 1, worksets}, undefined, 2)}\n`);
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'context-brief-citation-scale',
      manifestPath,
      user: 'benchmark',
    };
    for (const profileId of ['workset-50', 'workset-128'] as const) {
      const prepared = preparedProfiles.get(profileId)!;
      const staged = yield* stageCodeGraphWorksetCatalogGeneration(home, {
        manifestDigest: codeGraphWorksetManifestDigest(prepared.workset!),
        members: prepared.repositories.map((repository, ordinal) => ({
          projection: createCodeGraphWorksetRoutingProjection({
            checkoutId: repository.checkoutId,
            commitId: repository.status.identity.headCommit,
            componentCount: 0,
            extractorGeneration: 1,
            projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
            repositoryId: repository.repositoryId,
            snapshotDigest: sha256HexSync(`scale-snapshot-digest\0${profileId}\0${ordinal}`),
            snapshotId: repository.snapshotId,
            symbols: [],
            worktreeId: repository.worktreeId,
          }),
          repositoryKey: repository.name,
        })),
        worksetName: prepared.workset!.name,
      });
      yield* publishCodeGraphWorksetCatalogGeneration<never, never>(home, {
        generationId: staged.id,
        worksetName: prepared.workset!.name,
      });
      preparedProfiles.set(profileId, {...prepared, generation: {digest: staged.digest, id: staged.id}});
    }
    const selectedRecords = options.profileIds.flatMap(profileId => {
      const prepared = preparedProfiles.get(profileId)!;
      return Array.from({length: options.runCount}, (_, ordinal) =>
        selectedMemoryRecords(path, home, prepared, ordinal),
      ).flat();
    });
    if (selectedRecords.length > options.memoryCandidates) {
      return yield* Effect.fail(
        new ContextBriefCitationScaleFixtureError({
          message: `Scale corpus requires at least ${selectedRecords.length} documents for the selected profiles and samples.`,
        }),
      );
    }
    yield* writeRecords(fs, selectedRecords);
    const legacyV1MemoryCandidates = options.memoryCandidates - selectedRecords.length;
    yield* writeLegacyNoise(fs, path, home, legacyV1MemoryCandidates);
    const buildStarted = yield* Clock.currentTimeNanos;
    yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false, limit: 0, query: ''});
    const buildFinished = yield* Clock.currentTimeNanos;
    const status = yield* recallIndexStatus(config);
    if (!status.ready || status.documentCount !== options.memoryCandidates) {
      return yield* Effect.fail(
        new ContextBriefCitationScaleFixtureError({
          message: `Scale recall index contains ${status.documentCount}/${options.memoryCandidates} memory candidates.`,
        }),
      );
    }
    return {
      config,
      indexedMemoryCandidates: status.documentCount,
      legacyV1MemoryCandidates,
      profiles: preparedProfiles,
      readyGraphSetupMilliseconds: Number(readyGraphSetupFinished - readyGraphSetupStarted) / 1_000_000,
      recallIndexBuildMilliseconds: Number(buildFinished - buildStarted) / 1_000_000,
      runToken,
    } satisfies ContextBriefCitationScalePreparedFixture;
  },
);

function prepareRepositories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  root: string,
  profile: ContextBriefCitationScaleProfileV1,
  runCount: number,
) {
  return Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    return yield* Effect.forEach(
      Array.from({length: profile.worksetMembers}, (_, ordinal) => ordinal),
      ordinal =>
        Effect.gen(function* () {
          const name = `${profile.id}-repo-${String(ordinal).padStart(3, '0')}`;
          const repositoryRoot = path.join(root, 'repositories', name);
          const sourcePaths = repositorySourcePaths(profile, ordinal, runCount);
          yield* fs.makeDirectory(repositoryRoot, {recursive: true});
          yield* fs.writeFileString(path.join(repositoryRoot, '.threadnote-scale-fixture'), `${name}\n`);
          yield* Effect.forEach(
            sourcePaths,
            repositoryPath =>
              fs
                .makeDirectory(path.dirname(path.join(repositoryRoot, repositoryPath)), {recursive: true})
                .pipe(Effect.andThen(fs.writeFileString(path.join(repositoryRoot, repositoryPath), repositoryPath))),
            {concurrency: 32, discard: true},
          );
          yield* runCommandEffect('git', ['init', '--quiet', repositoryRoot], {timeoutMs: 30_000});
          yield* runCommandEffect(
            'git',
            ['-C', repositoryRoot, 'remote', 'add', 'origin', `https://example.invalid/threadnote/${name}.git`],
            {timeoutMs: 30_000},
          );
          yield* runCommandEffect('git', ['-C', repositoryRoot, 'add', '.'], {timeoutMs: 30_000});
          yield* runCommandEffect(
            'git',
            [
              '-C',
              repositoryRoot,
              '-c',
              'user.name=Threadnote Scale',
              '-c',
              'user.email=scale@example.invalid',
              'commit',
              '--quiet',
              '-m',
              'Prepare ready graph fixture',
            ],
            {timeoutMs: 30_000},
          );
          const identity = yield* resolveRepositoryIdentity(repositoryRoot);
          const snapshotId = `cgsn_${sha256HexSync(`scale-snapshot\0${name}`).slice(0, 40)}`;
          const databasePath = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId).databasePath;
          const files = sourcePaths.map(codeGraphInventoryFile);
          const snapshot = {
            commit: identity.headCommit,
            completedAt: FIXED_INSTANT,
            dirty: false,
            edgeCount: 0,
            extractorSet: EXTRACTOR_SET,
            fileCount: files.length,
            graphContentId: `cgc_${sha256HexSync(`scale-graph-content\0${name}`).slice(0, 40)}`,
            id: snapshotId,
            repositoryId: identity.repositoryId,
            state: 'ready',
            symbolCount: 0,
            worktreeId: identity.worktreeId,
          } satisfies CodeGraphSnapshot;
          yield* store.activate(databasePath, identity, snapshot, files, [], [], []);
          yield* store.promote(databasePath, identity, snapshot.id);
          const status = {
            databasePath,
            freshness: 'current',
            identity,
            languagePacks: [],
            readySnapshot: snapshot,
            stale: false,
          } satisfies CodeGraphStatus;
          return {
            checkoutId: identity.checkoutId,
            databasePath,
            name,
            repositoryId: identity.repositoryId,
            root: repositoryRoot,
            snapshotId,
            status,
            worktreeId: identity.worktreeId,
          };
        }),
      {concurrency: 16},
    );
  });
}

function repositorySourcePaths(
  profile: ContextBriefCitationScaleProfileV1,
  repositoryOrdinal: number,
  runCount: number,
): readonly string[] {
  if (repositoryOrdinal >= profile.citedRepositories) return [];
  return Array.from({length: runCount}, (_, runOrdinal) =>
    Array.from({length: profile.citationCount}, (_, citationOrdinal) => citationOrdinal)
      .filter(citationOrdinal => citationOrdinal % profile.citedRepositories === repositoryOrdinal)
      .map(citationOrdinal => citationRepositoryPath(profile.id, runToken(profile.id, runOrdinal), citationOrdinal)),
  ).flat();
}

function codeGraphInventoryFile(repositoryPath: string): CodeGraphInventoryFile {
  return {
    blobId: sha256HexSync(`scale-blob\0${repositoryPath}`).slice(0, 40),
    contentHash: sha256HexSync(repositoryPath),
    language: 'typescript',
    mode: '100644',
    path: repositoryPath,
    size: new TextEncoder().encode(repositoryPath).byteLength,
    source: 'commit',
  };
}

function repositoryProject(repository: ContextBriefCitationScaleRepositoryFixture): ProjectManifest {
  return {
    name: repository.name,
    path: repository.root,
    seed: [],
    uri: `threadnote://resources/repos/${repository.name}`,
  };
}

function selectedMemoryRecords(
  path: Path.Path,
  home: string,
  prepared: ContextBriefCitationScalePreparedProfile,
  ordinal: number,
): readonly {readonly content: string; readonly path: string}[] {
  const token = runToken(prepared.profile.id, ordinal);
  const citationsPerMemory = prepared.profile.citationCount / prepared.profile.selectedMemories;
  if (!Number.isInteger(citationsPerMemory) || citationsPerMemory > 8) {
    throw new Error(`Invalid citation allocation for ${prepared.profile.id}.`);
  }
  const root = path.join(home, 'data', 'local', 'user', 'benchmark', 'memories', 'durable', 'projects', PROJECT);
  return Array.from({length: prepared.profile.selectedMemories}, (_, memoryOrdinal) => {
    const citations = Array.from({length: citationsPerMemory}, (_, citationOrdinal) => {
      const index = memoryOrdinal * citationsPerMemory + citationOrdinal;
      const repository = prepared.repositories[index % prepared.profile.citedRepositories]!;
      const repositoryPath = citationRepositoryPath(prepared.profile.id, token, index);
      return createMemoryCodeCitation({
        extractorSet: EXTRACTOR_SET,
        fileContentHash: {algorithm: 'sha256', value: sha256HexSync(repositoryPath)},
        path: repositoryPath,
        repositoryId: repository.repositoryId,
        repositoryIdentityKind: 'remote',
        sourceCommit: repository.status.identity.headCommit,
        sourceDirty: false,
        sourceGraphContentId: repository.status.readySnapshot!.graphContentId,
        sourceSnapshotId: repository.snapshotId,
        target: {kind: 'file'},
        version: 1,
      });
    });
    const topic = `${prepared.profile.id}-${token}-${String(memoryOrdinal).padStart(2, '0')}`;
    const content = [
      'MEMORY',
      'kind: durable',
      'status: active',
      `project: ${PROJECT}`,
      `topic: ${topic}`,
      'source_agent_client: benchmark',
      `timestamp: ${FIXED_INSTANT}`,
      'schema_version: 4',
      ...formatMemoryCodeCitationLines(citations),
      '',
      `Context Brief citation scale sentinel ${token} preserves bounded ready-graph evidence.`,
    ].join('\n');
    return {content, path: path.join(root, prepared.profile.id, token, `${topic}.md`)};
  });
}

function writeRecords(
  fs: FileSystem.FileSystem,
  records: readonly {readonly content: string; readonly path: string}[],
) {
  return Effect.forEach(
    records,
    record =>
      fs
        .makeDirectory(record.path.replace(/[\\/][^\\/]+$/u, ''), {recursive: true})
        .pipe(Effect.andThen(fs.writeFileString(record.path, record.content))),
    {concurrency: 32, discard: true},
  );
}

function writeLegacyNoise(fs: FileSystem.FileSystem, path: Path.Path, home: string, count: number) {
  const root = path.join(
    home,
    'data',
    'local',
    'user',
    'benchmark',
    'memories',
    'durable',
    'projects',
    PROJECT,
    'noise',
  );
  const content = [
    'MEMORY',
    'kind: durable',
    'status: active',
    `project: ${PROJECT}`,
    'topic: legacy-scale-noise',
    'source_agent_client: benchmark',
    `timestamp: ${FIXED_INSTANT}`,
    'schema_version: 1',
    '',
    'Unrelated legacy memory fixture about ceramic glazing and coastal weather.',
  ].join('\n');
  return Effect.gen(function* () {
    for (let offset = 0; offset < count; offset += 1_000) {
      const end = Math.min(count, offset + 1_000);
      yield* Effect.forEach(
        Array.from({length: end - offset}, (_, index) => offset + index),
        index => {
          const shard = String(Math.floor(index / 1_000)).padStart(3, '0');
          const file = path.join(root, shard, `${String(index).padStart(6, '0')}.md`);
          return fs
            .makeDirectory(path.dirname(file), {recursive: true})
            .pipe(Effect.andThen(fs.writeFileString(file, content)));
        },
        {concurrency: 64, discard: true},
      );
    }
  });
}

function runToken(profile: ContextBriefCitationScaleProfileId, ordinal: number): string {
  return `tnscale${profile.replaceAll('-', '')}run${String(ordinal).padStart(3, '0')}`;
}

function citationRepositoryPath(profile: ContextBriefCitationScaleProfileId, token: string, index: number): string {
  return `src/context-brief-scale/${profile}/${token}/${String(index).padStart(3, '0')}.ts`;
}

export function contextBriefCitationScaleProject(): string {
  return PROJECT;
}

export function contextBriefCitationScaleExtractorSet(): string {
  return EXTRACTOR_SET;
}
