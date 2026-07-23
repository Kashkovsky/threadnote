import {Effect, FileSystem} from 'effect';
import yaml from 'js-yaml';
import type {JsonObject, ProjectManifest, ResolvedWorkset, SeedManifest, WorksetManifest} from './types.js';
import {escapeRegExp, isJsonObject} from './utils.js';

export function uriSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

/**
 * Returns the seed manifest project whose name appears as a token in `query`.
 * Both manifest and query are lowercased before comparison; returns `undefined`
 * when no project matches or the manifest can't be read. Callers use the
 * matched project's `uri` to scope a recall search at the right seeded subtree.
 */
export const inferProjectFromQuery = Effect.fn('manifest.inferProjectFromQuery')(function* (
  manifestPath: string,
  query: string,
) {
  const manifest = yield* readSeedManifest(manifestPath).pipe(Effect.option);
  if (manifest._tag === 'None') {
    return undefined;
  }
  const normalized = query.toLowerCase();
  return manifest.value.projects.find(project => normalized.includes(project.name.toLowerCase()));
});

/**
 * Resolves a workset's member names to their `ProjectManifest` entries, dropping
 * names that do not match a known project. A workset is a named set of manifest
 * projects that recall expands into one multi-repo working set.
 */
function resolveWorksetProjects(manifest: SeedManifest, workset: WorksetManifest): ResolvedWorkset {
  const byName = new Map(manifest.projects.map(project => [project.name.toLowerCase(), project]));
  const projects = workset.projects
    .map(name => byName.get(name.toLowerCase()))
    .filter((project): project is ProjectManifest => project !== undefined);
  return {name: workset.name, projects};
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
    return yield* Effect.fail(new Error(`No workset named "${worksetName}" in ${manifestPath}.`));
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
  const escaped = escapeRegExp(name.toLowerCase());
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(query.toLowerCase());
}

export const readSeedManifest = Effect.fn('manifest.readSeedManifest')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(path);
  return yield* Effect.try({
    try: () => parseSeedManifest(raw, path),
    catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
  });
});

export function parseSeedManifest(raw: string, path: string): SeedManifest {
  const loaded = yaml.load(raw);
  if (!isJsonObject(loaded)) {
    throw new Error(`Manifest must be an object: ${path}`);
  }
  const version = readNumber(loaded, 'version');
  const projectsValue = loaded.projects;
  if (!Array.isArray(projectsValue)) {
    throw new Error(`Manifest projects must be an array: ${path}`);
  }
  const projects: ProjectManifest[] = [];
  for (const projectValue of projectsValue) {
    if (!isJsonObject(projectValue)) {
      throw new Error(`Manifest project must be an object: ${path}`);
    }
    const seed = readStringArray(projectValue, 'seed');
    projects.push({
      name: readString(projectValue, 'name'),
      path: readString(projectValue, 'path'),
      seed,
      uri: readString(projectValue, 'uri'),
    });
  }

  let futureMonorepo: SeedManifest['futureMonorepo'];
  if (isJsonObject(loaded.future_monorepo)) {
    futureMonorepo = {
      pathCandidates: readStringArray(loaded.future_monorepo, 'path_candidates'),
      uri: readString(loaded.future_monorepo, 'uri'),
    };
  }

  let worksets: readonly WorksetManifest[] | undefined;
  if (loaded.worksets !== undefined) {
    if (!Array.isArray(loaded.worksets)) {
      throw new Error(`Manifest worksets must be an array: ${path}`);
    }
    worksets = loaded.worksets.map(worksetValue => {
      if (!isJsonObject(worksetValue)) {
        throw new Error(`Manifest workset must be an object: ${path}`);
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
    throw new Error(`Expected string for ${key}`);
  }
  return value;
}

function readString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string for ${key}`);
  }
  return value;
}

function readNumber(object: JsonObject, key: string): number {
  const value = object[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected number for ${key}`);
  }
  return value;
}

function readStringArray(object: JsonObject, key: string): readonly string[] {
  const value = object[key];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Expected string array for ${key}`);
  }
  return value;
}
