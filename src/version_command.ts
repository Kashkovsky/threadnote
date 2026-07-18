import {Effect, Result} from 'effect';
import {heading, info, keyValue, success, warning, withSpinnerEffect} from './cli_ui.js';
import {applicationError} from './effect/errors.js';
import type {RuntimeConfig, VersionOptions} from './types.js';
import {currentPackageVersion, fetchLatestVersion, resolveUpdateRegistry} from './update.js';
import {compareVersions, errorMessage} from './utils.js';
import {whatsNewLinesForVersion, whatsNewLinesForVersionRange} from './release_notes.js';

export const runVersion = Effect.fn('runVersion')(function* (config: RuntimeConfig, options: VersionOptions) {
  const currentVersion = yield* Effect.tryPromise({
    try: currentPackageVersion,
    catch: cause => applicationError('read current package version', cause),
  });
  const registry = yield* Effect.try({
    try: () => resolveUpdateRegistry(options.registry, options.allowUntrustedRegistry),
    catch: cause => applicationError('resolve update registry', cause),
  });
  const latest = yield* withSpinnerEffect(
    'Checking npm for latest threadnote version',
    fetchLatestVersion(registry),
  ).pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}));
  const latestVersion = Result.isSuccess(latest) ? latest.success : undefined;
  const latestWarning = Result.isFailure(latest) ? errorMessage(latest.failure) : undefined;

  yield* Effect.sync(() => {
    console.log(keyValue('Current version', info(currentVersion)));
    console.log(keyValue('Latest version', latestVersion ? info(latestVersion) : warning('unavailable')));
  });
  if (latestWarning) {
    yield* Effect.sync(() => console.log(warning(`Warning: ${latestWarning}`)));
  }

  if (!latestVersion) {
    return;
  }
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison >= 0) {
    yield* Effect.sync(() => {
      console.log(success(comparison > 0 ? 'Current version is newer than npm latest.' : 'Threadnote is up to date.'));
      console.log('');
    });
    const whatsNew = yield* withSpinnerEffect('Fetching GitHub release notes', whatsNewLinesForVersion(currentVersion));
    yield* Effect.sync(() => printWhatsNew(whatsNew));
    return;
  }

  yield* Effect.sync(() => console.log(''));
  const whatsNew = yield* withSpinnerEffect(
    'Fetching GitHub release notes',
    whatsNewLinesForVersionRange(currentVersion, latestVersion),
  );
  yield* Effect.sync(() => printWhatsNew(whatsNew));
});

function printWhatsNew(whatsNew: readonly string[]): void {
  for (const line of whatsNew) {
    console.log(line === "What's new:" ? heading(line) : line);
  }
}
