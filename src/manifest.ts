import {Effect, FileSystem, Schema} from 'effect';
import * as yaml from 'js-yaml';
import type {JsonObject, ProjectManifest, ResolvedWorkset, SeedManifest, WorksetManifest} from './types.js';
import {parseResourceId} from './storage/resource-id.js';
import {escapeRegExp, isJsonObject} from './utils.js';

export function uriSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

class ManifestOperationError extends Schema.TaggedError<ManifestOperationError>()('ManifestOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const GENERIC_PROJECT_NAME_SEGMENTS = new Set([
  'application',
  'front',
  'monorepo',
  'native',
  'repo',
  'repository',
  'service',
  'web',
]);

/**
 * Returns the seed manifest project named by `query`. An exact project name
 * wins; otherwise a unique, non-generic segment can identify a compound name
 * (`worker` → `orion-worker`). Ambiguous or generic segments do not scope
 * recall.
 */
export const inferProjectFromQuery = Effect.fn('manifest.inferProjectFromQuery')(function* (
  manifestPath: string,
  query: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  const exactMentions = manifest.value.projects.flatMap(project =>
    nameTokenSpans(query, project.name).map(span => ({...span, project})),
  );
  const maximalMentions = exactMentions.filter(
    mention =>
      !exactMentions.some(
        other =>
          other.project !== mention.project &&
          other.start <= mention.start &&
          other.end >= mention.end &&
          other.end - other.start > mention.end - mention.start,
      ),
  );
  const exactProjects = new Set(maximalMentions.map(mention => mention.project));
  if (exactProjects.size > 0) {
    return exactProjects.size === 1 ? [...exactProjects][0] : undefined;
  }
  const queryTerms = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const projectsBySegment = new Map<string, ProjectManifest[]>();
  for (const project of manifest.value.projects) {
    for (const segment of new Set(project.name.toLowerCase().split(/[^a-z0-9]+/))) {
      if (segment.length < 4 || GENERIC_PROJECT_NAME_SEGMENTS.has(segment)) {
        continue;
      }
      const projects = projectsBySegment.get(segment);
      if (projects) {
        projects.push(project);
      } else {
        projectsBySegment.set(segment, [project]);
      }
    }
  }
  const matches = new Set<ProjectManifest>();
  for (const [segment, projects] of projectsBySegment) {
    if (projects.length === 1 && projects[0] && queryTerms.has(segment)) {
      matches.add(projects[0]);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
});

/**
 * Resolves a workset's member names to their `ProjectManifest` entries, dropping
 * names that do not match a known project. A workset is a named set of manifest
 * projects that recall expands into one multi-repo working set.
 */
function resolveWorksetProjects(manifest: SeedManifest, workset: WorksetManifest): ResolvedWorkset {
  const byName = new Map(manifest.projects.map(project => [project.name.toLowerCase(), project]));
  const projects: ProjectManifest[] = [];
  const unresolvedProjects: string[] = [];
  for (const name of workset.projects) {
    const project = byName.get(name.toLowerCase());
    if (project === undefined) unresolvedProjects.push(name);
    else projects.push(project);
  }
  return {name: workset.name, projects, unresolvedProjects};
}

/** Looks up a workset by exact (case-insensitive) name; undefined when unknown or unreadable. */
export const resolveWorkset = Effect.fn('manifest.resolveWorkset')(function* (
  manifestPath: string,
  worksetName: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  const workset = manifest.value.worksets?.find(entry => entry.name.toLowerCase() === worksetName.toLowerCase());
  return workset ? resolveWorksetProjects(manifest.value, workset) : undefined;
});

/** Resolves an explicit workset name; throws when the manifest is readable but no such workset exists. */
export const requireWorkset = Effect.fn('manifest.requireWorkset')(function* (
  manifestPath: string,
  worksetName: string,
) {
  const manifest = yield* readSeedManifest(manifestPath);
  const workset = manifest.worksets?.find(entry => entry.name.toLowerCase() === worksetName.toLowerCase());
  if (!workset) {
    return yield* ManifestOperationError.make({message: `No workset named "${worksetName}" in ${manifestPath}.`});
  }
  return resolveWorksetProjects(manifest, workset);
});

/** Returns the workset whose name appears as a token in `query`, or undefined. */
export const inferWorksetFromQuery = Effect.fn('manifest.inferWorksetFromQuery')(function* (
  manifestPath: string,
  query: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  if (!manifest.value.worksets || manifest.value.worksets.length === 0) {
    return undefined;
  }
  const workset = manifest.value.worksets.find(entry => containsNameToken(query, entry.name));
  return workset ? resolveWorksetProjects(manifest.value, workset) : undefined;
});

function containsNameToken(query: string, name: string): boolean {
  return nameTokenSpans(query, name).length > 0;
}

function nameTokenSpans(query: string, name: string): readonly {readonly end: number; readonly start: number}[] {
  const escaped = escapeRegExp(name.toLowerCase());
  const spans: Array<{end: number; start: number}> = [];
  for (const match of query.toLowerCase().matchAll(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'g'))) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    spans.push({end: start + name.length, start});
  }
  return spans;
}

export const readSeedManifest = Effect.fn('manifest.readSeedManifest')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseSeedManifest(raw, path),
    catch: cause =>
      Schema.is(ManifestOperationError)(cause)
        ? cause
        : ManifestOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
  });
});

export function parseSeedManifest(raw: string, path: string): SeedManifest {
  const loaded = yaml.load(raw);
  if (!isJsonObject(loaded)) {
    throw ManifestOperationError.make({message: `Manifest must be an object: ${path}`});
  }
  const version = readNumber(loaded, 'version');
  const projectsValue = loaded.projects;
  if (!Array.isArray(projectsValue)) {
    throw ManifestOperationError.make({message: `Manifest projects must be an array: ${path}`});
  }
  const projects: ProjectManifest[] = [];
  for (const projectValue of projectsValue) {
    if (!isJsonObject(projectValue)) {
      throw ManifestOperationError.make({message: `Manifest project must be an object: ${path}`});
    }
    const seed = readStringArray(projectValue, 'seed');
    projects.push({
      name: readString(projectValue, 'name'),
      path: readString(projectValue, 'path'),
      seed,
      uri: parseResourceId(readString(projectValue, 'uri')).canonicalUri,
    });
  }

  let futureMonorepo: SeedManifest['futureMonorepo'];
  if (isJsonObject(loaded.future_monorepo)) {
    futureMonorepo = {
      pathCandidates: readStringArray(loaded.future_monorepo, 'path_candidates'),
      uri: parseResourceId(readString(loaded.future_monorepo, 'uri')).canonicalUri,
    };
  }

  let worksets: readonly WorksetManifest[] | undefined;
  if (loaded.worksets !== undefined) {
    if (!Array.isArray(loaded.worksets)) {
      throw ManifestOperationError.make({message: `Manifest worksets must be an array: ${path}`});
    }
    worksets = loaded.worksets.map(worksetValue => {
      if (!isJsonObject(worksetValue)) {
        throw ManifestOperationError.make({message: `Manifest workset must be an object: ${path}`});
      }
      return {
        description: readOptionalString(worksetValue, 'description'),
        name: readString(worksetValue, 'name'),
        projects: readStringArray(worksetValue, 'projects'),
      };
    });
  }
  return {futureMonorepo, projects, version, worksets};
}

function readOptionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw ManifestOperationError.make({message: `Expected string for ${key}`});
  }
  return value;
}

function readString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw ManifestOperationError.make({message: `Expected non-empty string for ${key}`});
  }
  return value;
}

function readNumber(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== 'number') {
    throw ManifestOperationError.make({message: `Expected number for ${key}`});
  }
  return value;
}

function readStringArray(object: JsonObject, key: string): readonly string[] {
  const value = object[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw ManifestOperationError.make({message: `Expected string array for ${key}`});
  }
  return value;
}
