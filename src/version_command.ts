import {Console, Effect, Result} from 'effect';
import {heading, info, keyValue, success, warning, withSpinnerEffect} from './cli_ui.js';
import {applicationError, fromPromise} from './effect/errors.js';
import type {RuntimeConfig, VersionOptions} from './types.js';
import {currentPackageVersion, fetchLatestVersion, resolveUpdateRegistry} from './update.js';
import {compareVersions, errorMessage} from './utils.js';
import {whatsNewLinesForVersion, whatsNewLinesForVersionRange} from './release_notes.js';

export const runVersion = Effect.fn('runVersion')(function* (config: RuntimeConfig, options: VersionOptions) {
  const currentVersion = yield* fromPromise('read current package version', currentPackageVersion);
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

  yield* Console.log(keyValue('Current version', info(currentVersion)));
  yield* Console.log(keyValue('Latest version', latestVersion ? info(latestVersion) : warning('unavailable')));
  if (latestWarning) {
    yield* Console.log(warning(`Warning: ${latestWarning}`));
  }

  if (!latestVersion) {
    return;
  }
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison >= 0) {
    yield* Console.log(
      success(comparison > 0 ? 'Current version is newer than npm latest.' : 'Threadnote is up to date.'),
    );
    yield* Console.log('');
    const whatsNew = yield* withSpinnerEffect('Fetching GitHub release notes', whatsNewLinesForVersion(currentVersion));
    yield* printWhatsNew(whatsNew);
    return;
  }

  yield* Console.log('');
  const whatsNew = yield* withSpinnerEffect(
    'Fetching GitHub release notes',
    whatsNewLinesForVersionRange(currentVersion, latestVersion),
  );
  yield* printWhatsNew(whatsNew);
});

const printWhatsNew = Effect.fn('printWhatsNew')(function* (whatsNew: readonly string[]) {
  for (const line of whatsNew) {
    yield* Console.log(line === "What's new:" ? heading(line) : line);
  }
});
