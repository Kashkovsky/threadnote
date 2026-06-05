import {heading, info, keyValue, success, warning, withSpinner} from './cli_ui.js';
import type {RuntimeConfig, VersionOptions} from './types.js';
import {currentPackageVersion, fetchLatestVersion, normalizeRegistry, updateRegistry} from './update.js';
import {compareVersions, errorMessage} from './utils.js';
import {whatsNewLinesForVersionRange} from './release_notes.js';

export async function runVersion(config: RuntimeConfig, options: VersionOptions): Promise<void> {
  const currentVersion = await currentPackageVersion();
  const registry = normalizeRegistry(options.registry ?? updateRegistry());
  let latestVersion: string | undefined;
  let latestWarning: string | undefined;

  try {
    latestVersion = await withSpinner('Checking npm for latest threadnote version', () => fetchLatestVersion(registry));
  } catch (err: unknown) {
    latestWarning = errorMessage(err);
  }

  console.log(keyValue('Current version', info(currentVersion)));
  console.log(keyValue('Latest version', latestVersion ? info(latestVersion) : warning('unavailable')));
  if (latestWarning) {
    console.log(warning(`Warning: ${latestWarning}`));
  }

  if (!latestVersion) {
    return;
  }
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison >= 0) {
    console.log(success(comparison > 0 ? 'Current version is newer than npm latest.' : 'Threadnote is up to date.'));
    return;
  }

  console.log('');
  const whatsNew = await withSpinner('Fetching GitHub release notes', () =>
    whatsNewLinesForVersionRange(currentVersion, latestVersion),
  );
  for (const line of whatsNew) {
    console.log(line === "What's new:" ? heading(line) : line);
  }
}
