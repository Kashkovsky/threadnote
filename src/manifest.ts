import {readFile} from 'node:fs/promises';
import yaml from 'js-yaml';
import type {JsonObject, ProjectManifest, SeedManifest} from './types.js';
import {isJsonObject} from './utils.js';

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
export async function inferProjectFromQuery(manifestPath: string, query: string): Promise<ProjectManifest | undefined> {
  try {
    const manifest = await readSeedManifest(manifestPath);
    const normalized = query.toLowerCase();
    return manifest.projects.find(project => normalized.includes(project.name.toLowerCase()));
  } catch {
    return undefined;
  }
}

export async function readSeedManifest(path: string): Promise<SeedManifest> {
  const raw = await readFile(path, 'utf8');
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
  return {futureMonorepo, projects, version};
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
